import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import YAML from "yaml";
import { discoverLayers } from "./discovery";
import { BUILD_LAYERS_YAML_PATH, BUILD_SUBLAYERS_SUMMARY_PATH, layerOutDir, logosRegistryPath } from "../paths";
import { ensureDir } from "../utils/files";
import { stableStringify } from "../utils/hash";
import { log } from "../log";
import { BUILD_ISSUES_LOG_PATH, BuildLog, DOWNLOAD_REMINDERS_LOG_PATH } from "../build/buildLog";
import { fetchLatestPublishedVersionId, fetchRecordFileIndex } from "../source/zenodo";
import { loadLogoRegistry, resolveLogoFile } from "../attribution/logos";
import { VERZAMELBLAD_SPLITS } from "../iiif/config";

/** Bump to invalidate the merged layers.yaml when the merge/resolution changes. */
const LAYERS_RECIPE = 5;

/**
 * Published per-layer artifact filenames → the registry key the viewer looks up.
 * Only these canonical outputs are registered (debug `.json` twins are ignored);
 * paths in layers.yaml are relative to the deploy root, i.e. `Layers/<id>/<file>`.
 */
const ARTIFACT_KEYS: Record<string, string> = {
  "geomaps.json": "geomaps",
  "search.json": "search",
  "raster.pmtiles": "raster",
  "masks.pmtiles": "masks",
  "parcels.pmtiles": "parcels",
  "sprites.jpg": "sprites",
  "sprites.webp": "sprites",
  "sprites.json": "spritesIndex",
  "toponyms.json": "toponyms",
};

export type PublishLayersOptions = {
  buildLog?: BuildLog;
  force?: boolean;
  /** Zenodo record backing this build, used to resolve sublayer `download:` filenames to real URLs. */
  zenodoRecordId?: string;
  /** Drafts have no public download URL; skip resolving `download:` filenames entirely when true. */
  isDraft?: boolean;
  /**
   * When the source is a draft and this is set, resolve `download:` filenames
   * against the draft's latest *published* sibling version instead of leaving
   * them unresolved - used when a draft build is being force-published to the
   * live branch, so its download links still work.
   */
  resolveDraftDownloadsFromLatestPublished?: boolean;
};

export type MissingDownload = { sublayerId: string; file: string };

/** A sublayer that isn't a remote passthrough (wmts/wms) but produced no build artifact - nothing will render for it. */
export type EmptySublayer = { layerId: string; sublayerId: string; kind: string };

/** A sublayer that built real content but has no `download:` configured - not an error, just worth a nudge. */
export type SublayerWithoutDownload = { layerId: string; sublayerId: string; kind: string };

export type PublishLayersResult = {
  layers: number;
  sublayers: number;
  logosResolved: number;
  unknownLogos: string[];
  downloadsResolved: number;
  missingDownloads: MissingDownload[];
  emptySublayers: EmptySublayer[];
  sublayersWithoutDownload: SublayerWithoutDownload[];
  outputPath: string;
  cached?: boolean;
  /**
   * Which Zenodo record `download:` filenames were actually checked against:
   * `"source"` (the build's own record), `"latest-published-fallback"` (a
   * draft, resolved against its latest published sibling instead), or
   * `"unresolved"` (draft with no verifiable target - left unresolved).
   */
  downloadResolution: "source" | "latest-published-fallback" | "unresolved";
  /** The Zenodo record id actually checked against, when downloadResolution isn't "unresolved". */
  downloadRecordId?: string;
};

/**
 * Unresolved references that must be fixed before publishing - unlike IIIF
 * warnings (georeferencing quality notes), these mean a sublayer will render
 * broken, be entirely empty, or a download link will 404, so callers should
 * fail the build on these rather than merely log them.
 */
export function significantIssues(result: PublishLayersResult): string[] {
  return [
    ...result.missingDownloads.map((m) => `missing sublayer download: ${m.sublayerId} → "${m.file}" not found in the Zenodo record`),
    ...result.unknownLogos.map((file) => `unknown attribution logo: "${file}" not in the logo registry`),
    ...result.emptySublayers.map((s) => {
      const origin = VERZAMELBLAD_SPLIT_IDS.has(s.sublayerId) ? "is a hardcoded verzamelbladen split" : `is defined in layers/${s.layerId}/${s.layerId}.yaml`;
      return `${s.sublayerId} (kind: ${s.kind}) ${origin} but its source data could not be found — nothing will render`;
    }),
  ];
}

type MutableSublayer = {
  id?: string;
  name?: string;
  kind?: string;
  description?: string;
  citation?: string;
  source?: { rawInput?: string };
  attribution?: { logos?: unknown };
  artifacts?: Record<string, string>;
  download?: unknown;
};

type MutableLayer = {
  id?: string;
  label?: string;
  sublayers?: MutableSublayer[];
};

const VERZAMELBLAD_SPLITS_BY_LAYER = new Map<string, typeof VERZAMELBLAD_SPLITS>();
for (const split of VERZAMELBLAD_SPLITS) {
  VERZAMELBLAD_SPLITS_BY_LAYER.set(split.layerId, [...(VERZAMELBLAD_SPLITS_BY_LAYER.get(split.layerId) ?? []), split]);
}
const VERZAMELBLAD_SPLIT_IDS = new Set(VERZAMELBLAD_SPLITS.map((split) => split.id));

/**
 * Injects the hardcoded verzamelbladen split(s) (see VERZAMELBLAD_SPLITS) as
 * regular sublayers of their layer - not authored in Source/layers/*, but
 * published/validated exactly like any real sublayer (logos, downloads,
 * artifacts, empty-sublayer detection) rather than a special case.
 */
function injectVerzamelbladSplits(layerId: string, config: MutableLayer): void {
  const splits = VERZAMELBLAD_SPLITS_BY_LAYER.get(layerId);
  if (!splits) return;
  for (const split of splits) {
    const parent = config.sublayers?.find((sublayer) => sublayer.id === split.parentSublayerId);
    config.sublayers = [
      ...(config.sublayers ?? []),
      { id: split.id, name: split.name, kind: "iiif", description: split.description, attribution: parent?.attribution, citation: parent?.citation },
    ];
  }
}

/** IIIF sublayers own the georeferenced/raster artifacts; each is a single build output. */
const IIIF_ARTIFACT_KEYS = ["geomaps", "search", "raster", "masks", "sprites", "spritesIndex"];

/** Rendered directly from an external tile/WMS endpoint - no local build artifact is ever expected. */
const REMOTE_PASSTHROUGH_KINDS = new Set(["wmts", "wms"]);

/**
 * Which registry keys a sublayer produces, by kind/source — so artifacts attach
 * to the sublayer that generated them, not the whole layer. (Mirrors the build's
 * own sublayer detection in parcels/toponyms.)
 */
function ownedArtifactKeys(sublayer: MutableSublayer): string[] {
  const kind = (sublayer.kind ?? "").toLowerCase();
  const rawInput = sublayer.source?.rawInput ?? "";
  const id = (sublayer.id ?? "").toLowerCase();
  const name = (sublayer.name ?? "").toLowerCase();
  if (kind === "iiif") return IIIF_ARTIFACT_KEYS;
  if (kind === "searchable" || rawInput.startsWith("toponyms/")) return ["toponyms"];
  if (rawInput.startsWith("parcels/") || id.includes("parcel") || name.includes("parcel")) return ["parcels"];
  return [];
}

/**
 * Scans a layer's published output dir and maps the recognized artifacts to
 * deploy-root-relative paths, so layers.yaml doubles as the file registry (which
 * built file belongs to which layer). Absent files are simply omitted, so the
 * registry reflects exactly what was produced.
 */
async function scanArtifacts(layerId: string): Promise<Record<string, string>> {
  let names: string[];
  try {
    names = (await readdir(layerOutDir(layerId), { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return {};
  }
  const artifacts: Record<string, string> = {};
  for (const name of names.sort()) {
    const key = ARTIFACT_KEYS[name];
    if (key) artifacts[key] = `Layers/${layerId}/${name}`;
  }
  return artifacts;
}

/** Replaces each sublayer's `logos: [filename]` with `[{ file, href }]` in place. */
function resolveLogos(layer: MutableLayer, registry: Map<string, string>, unknown: Set<string>): number {
  let resolved = 0;
  for (const sublayer of layer.sublayers ?? []) {
    const logos = sublayer.attribution?.logos;
    if (!Array.isArray(logos)) continue;
    sublayer.attribution!.logos = logos.map((file) => {
      if (typeof file !== "string") return file;
      const resolvedLogo = resolveLogoFile(file, registry);
      if (resolvedLogo.href) resolved++;
      else unknown.add(file);
      return resolvedLogo;
    });
  }
  return resolved;
}

/**
 * Replaces each sublayer's `download: <filename>` with `{ file, url }` in
 * place, resolving against a Zenodo record's file index. Filenames not found
 * in the record collapse to `{ file }` (no url) and are recorded in `missing`
 * so the caller can fail the build on them; when `missing` is undefined
 * (draft/unverifiable builds), the same `{ file }` shape is used but nothing
 * is reported, since there was nothing to check against.
 */
function resolveDownloads(layer: MutableLayer, fileIndex: Map<string, string>, missing: MissingDownload[] | undefined): number {
  let resolved = 0;
  for (const sublayer of layer.sublayers ?? []) {
    const file = sublayer.download;
    if (typeof file !== "string") continue;
    const url = fileIndex.get(file);
    if (url) {
      resolved++;
      sublayer.download = { file, url };
    } else {
      missing?.push({ sublayerId: sublayer.id ?? "(unknown sublayer)", file });
      sublayer.download = { file };
    }
  }
  return resolved;
}

/**
 * Renders a sublayer's `download` field for the summary table: link if
 * resolved, flagged if confirmed missing, noted if never checked. A sublayer
 * that built real content but has no `download:` at all gets "?" rather than
 * "—" - distinct from wmts/wms (or truly empty) sublayers, where no download
 * is simply expected and "—" is the right, unremarkable answer.
 */
function downloadCell(sublayer: MutableSublayer, missingSublayerIds: Set<string>): string {
  const hasArtifacts = sublayer.artifacts !== undefined && Object.keys(sublayer.artifacts).length > 0;
  const noDownloadMarker = hasArtifacts ? "?" : "—";
  const download = sublayer.download;
  if (download === undefined || download === null || typeof download !== "object") return noDownloadMarker;
  const { file, url } = download as { file?: unknown; url?: unknown };
  if (typeof file !== "string") return noDownloadMarker;
  if (typeof url === "string") return `[${file}](${url})`;
  if (sublayer.id && missingSublayerIds.has(sublayer.id)) return `✗ ${file} — not found`;
  return `${file} (unverified)`;
}

/**
 * Renders a Markdown table of every sublayer (layer, sublayer, kind, which
 * artifacts it produced, and download status) for the CI job summary and
 * release notes - the human-facing answer to "what did this build actually
 * contain?".
 */
function buildSublayersMarkdown(layers: MutableLayer[], missingDownloads: MissingDownload[]): string {
  const missingSublayerIds = new Set(missingDownloads.map((m) => m.sublayerId));
  const rows = layers.flatMap((layer) =>
    (layer.sublayers ?? []).map((sublayer) => {
      const artifactKeys = sublayer.artifacts ? Object.keys(sublayer.artifacts) : [];
      return `| ${layer.label ?? layer.id ?? "—"} | ${sublayer.name ?? sublayer.id ?? "—"} | ${sublayer.kind ?? "—"} | ${artifactKeys.length > 0 ? artifactKeys.join(", ") : "—"} | ${downloadCell(sublayer, missingSublayerIds)} |`;
    }),
  );
  if (rows.length === 0) return "_No sublayers found._\n";
  return `| Layer | Sublayer | Kind | Artifacts built | Download |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`;
}

/**
 * Merges every `Source/layers/<LayerId>/<LayerId>.yaml` into a single
 * `build/layers.yaml` the viewer fetches. Always publishes all layers so the
 * registry stays complete regardless of any per-layer build selection.
 */
export async function publishLayers(options: PublishLayersOptions = {}): Promise<PublishLayersResult> {
  const refs = await discoverLayers();
  const registry = await loadLogoRegistry();
  const unknownLogos = new Set<string>();
  let sublayers = 0;
  let logosResolved = 0;

  // Drafts have no public download URL, and without a record id there's
  // nothing to resolve against - in both cases, normalize `download:` to
  // `{ file }` without treating unresolved filenames as an error. Exception:
  // a draft explicitly being force-published to live falls back to its
  // latest published sibling version as the resolution target instead.
  let canResolveDownloads = !options.isDraft && Boolean(options.zenodoRecordId);
  let downloadResolution: PublishLayersResult["downloadResolution"] = canResolveDownloads ? "source" : "unresolved";
  let downloadRecordId = options.zenodoRecordId;

  if (options.isDraft && options.resolveDraftDownloadsFromLatestPublished && options.zenodoRecordId) {
    try {
      const latest = await fetchLatestPublishedVersionId(options.zenodoRecordId);
      if (latest) {
        downloadRecordId = latest;
        canResolveDownloads = true;
        downloadResolution = "latest-published-fallback";
        log.info(`draft ${options.zenodoRecordId}: resolving sublayer downloads against latest published version ${latest} instead`);
      } else {
        log.warn(`draft ${options.zenodoRecordId} has no published version yet; leaving sublayer downloads unresolved`);
      }
    } catch (error) {
      log.warn(`could not look up latest published version for draft ${options.zenodoRecordId}; leaving sublayer downloads unresolved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const wantsDownloads = refs.some((ref) => (ref.config.sublayers ?? []).some((sublayer) => typeof sublayer.download === "string"));
  let downloadIndex = new Map<string, string>();
  if (wantsDownloads && canResolveDownloads && downloadRecordId) {
    try {
      downloadIndex = await fetchRecordFileIndex(downloadRecordId);
    } catch (error) {
      // A Zenodo API hiccup shouldn't fail the whole build, but we can no
      // longer tell "missing" from "unverifiable" - treat as unresolved, same
      // as drafts, rather than falsely reporting every download as missing.
      canResolveDownloads = false;
      downloadResolution = "unresolved";
      log.warn(`could not fetch Zenodo record ${downloadRecordId} file list; leaving sublayer downloads unresolved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (downloadResolution === "unresolved") downloadRecordId = undefined;
  let downloadsResolved = 0;
  const missingDownloads: MissingDownload[] = [];
  const emptySublayers: EmptySublayer[] = [];
  const sublayersWithoutDownload: SublayerWithoutDownload[] = [];

  const layers = await Promise.all(
    refs.map(async (ref) => {
      const config = structuredClone(ref.config) as MutableLayer;
      injectVerzamelbladSplits(ref.id, config);
      sublayers += config.sublayers?.length ?? 0;
      logosResolved += resolveLogos(config, registry, unknownLogos);
      downloadsResolved += resolveDownloads(config, downloadIndex, canResolveDownloads ? missingDownloads : undefined);

      // Attach each produced artifact to the sublayer that owns it, so two
      // sublayers of the same kind stay individually resolvable. A
      // verzamelbladen split publishes from its own output dir (its build
      // group used the split id as its layer id - see VERZAMELBLAD_SPLITS)
      // rather than sharing the parent layer's, so it needs its own scan.
      for (const sublayer of config.sublayers ?? []) {
        const outputId = sublayer.id && VERZAMELBLAD_SPLIT_IDS.has(sublayer.id) ? sublayer.id : ref.id;
        const scanned = await scanArtifacts(outputId);
        const artifacts: Record<string, string> = {};
        for (const key of ownedArtifactKeys(sublayer)) {
          if (scanned[key]) artifacts[key] = scanned[key];
        }
        if (Object.keys(artifacts).length > 0) sublayer.artifacts = artifacts;

        // A remote wmts/wms sublayer renders directly from its own URL and
        // never has a local artifact - anything else with zero artifacts
        // means nothing will render (missing source data, or a new sublayer
        // entry the builder doesn't know how to produce yet).
        const kind = (sublayer.kind ?? "").toLowerCase();
        if (!REMOTE_PASSTHROUGH_KINDS.has(kind) && Object.keys(artifacts).length === 0) {
          emptySublayers.push({ layerId: ref.id, sublayerId: sublayer.id ?? "(unknown sublayer)", kind: sublayer.kind ?? "(unknown kind)" });
        }

        // Built real content but nobody can download it directly - not an
        // error (plenty of sublayers, e.g. toponyms, never need one), just
        // worth flagging so it isn't simply forgotten.
        if (Object.keys(artifacts).length > 0 && sublayer.download === undefined) {
          sublayersWithoutDownload.push({ layerId: ref.id, sublayerId: sublayer.id ?? "(unknown sublayer)", kind: sublayer.kind ?? "(unknown kind)" });
        }
      }
      return config;
    }),
  );

  await ensureDir(dirname(BUILD_SUBLAYERS_SUMMARY_PATH));
  await writeFile(BUILD_SUBLAYERS_SUMMARY_PATH, buildSublayersMarkdown(layers, missingDownloads), "utf-8");

  if (!options.force) {
    try {
      const current = YAML.parse(await readFile(BUILD_LAYERS_YAML_PATH, "utf-8")) as { buildRecipe?: unknown; layers?: unknown };
      if (current?.buildRecipe === LAYERS_RECIPE && stableStringify(current?.layers) === stableStringify(layers)) {
        log.ok(`layers: unchanged — skipped (${BUILD_LAYERS_YAML_PATH})`);
        return {
          layers: layers.length,
          sublayers,
          logosResolved,
          unknownLogos: [...unknownLogos],
          downloadsResolved,
          missingDownloads,
          emptySublayers,
          sublayersWithoutDownload,
          outputPath: BUILD_LAYERS_YAML_PATH,
          cached: true,
          downloadResolution,
          downloadRecordId,
        };
      }
    } catch {
      // Missing or invalid output: rewrite below.
    }
  }

  const header =
    "# build/layers.yaml — merged viewer layer config + published-file registry.\n" +
    "# Generated by `bun run src/cli.ts layers` (runs last in a build); do not edit by hand.\n" +
    "# Config source of truth: Source/layers/<LayerId>/<LayerId>.yaml\n" +
    "# Each sublayer's `artifacts` maps role -> deploy-relative path under Layers/<LayerId>/.\n";
  const body = YAML.stringify({ generatedAt: new Date().toISOString(), buildRecipe: LAYERS_RECIPE, layers }, { lineWidth: 0 });

  await ensureDir(dirname(BUILD_LAYERS_YAML_PATH));
  await writeFile(BUILD_LAYERS_YAML_PATH, `${header}${body}`, "utf-8");

  log.ok(`layers: ${layers.length} layers, ${sublayers} sublayers → ${BUILD_LAYERS_YAML_PATH}`);
  const registryPath = logosRegistryPath();
  for (const file of unknownLogos) log.warn(`unknown logo '${file}' not in ${registryPath}`);

  const result: PublishLayersResult = {
    layers: layers.length,
    sublayers,
    logosResolved,
    unknownLogos: [...unknownLogos],
    downloadsResolved,
    missingDownloads,
    emptySublayers,
    sublayersWithoutDownload,
    outputPath: BUILD_LAYERS_YAML_PATH,
    downloadResolution,
    downloadRecordId,
  };
  const issues = significantIssues(result);
  if (issues.length > 0) {
    const issuesLog = new BuildLog(BUILD_ISSUES_LOG_PATH, "Build Issues Log");
    await issuesLog.reset("layers", []);
    await issuesLog.section("Unresolved references (block publishing)");
    // Prefixed with "- " so CI can reliably count real issues (`grep -c '^- '`)
    // instead of the file's total line count, which also includes this header.
    for (const issue of issues) await issuesLog.info(`- ${issue}`);
    for (const issue of issues) log.warn(`${issue} — see ${BUILD_ISSUES_LOG_PATH}`);
  }

  if (sublayersWithoutDownload.length > 0) {
    const remindersLog = new BuildLog(DOWNLOAD_REMINDERS_LOG_PATH, "Download Reminders Log");
    await remindersLog.reset("layers", []);
    await remindersLog.section("Sublayers built with no download configured (not an error)");
    for (const s of sublayersWithoutDownload) {
      await remindersLog.info(`- ${s.sublayerId} (layer ${s.layerId}, kind: ${s.kind}) built successfully but has no \`download:\` configured`);
    }
  }

  await options.buildLog?.section("Layers");
  await options.buildLog?.fields({
    layers: layers.length,
    sublayers,
    "logos resolved": logosResolved,
    "unknown logos": unknownLogos.size > 0 ? [...unknownLogos].join(", ") : undefined,
    "downloads resolved": downloadsResolved,
    "missing downloads": missingDownloads.length > 0 ? missingDownloads.map((m) => m.file).join(", ") : undefined,
    "empty sublayers": emptySublayers.length > 0 ? emptySublayers.map((s) => s.sublayerId).join(", ") : undefined,
    "sublayers without download": sublayersWithoutDownload.length > 0 ? sublayersWithoutDownload.map((s) => s.sublayerId).join(", ") : undefined,
    "build issues": issues.length > 0 ? `${issues.length} — see ${BUILD_ISSUES_LOG_PATH}` : undefined,
    output: BUILD_LAYERS_YAML_PATH,
  });

  return result;
}
