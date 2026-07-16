import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { validateBaselayerGeoJson } from "./baselayer/validate";
import type { LocalizedText } from "./localization";
import {
  mapServicesYamlPath,
  sourceBaselayerBorderPath,
  sourceBaselayerWaterPath,
  sourceDir,
  sourceImageCollectionsDir,
  sourceLayersDir,
} from "./paths";

export type LayerConfig = {
  id: string;
  label: string;
  timeframe?: unknown;
  sublayers?: Array<{
    id: string;
    name?: LocalizedText;
    kind?: string;
    description?: LocalizedText;
    /** Further-reading links shown with the sublayer: display label → URL. */
    furtherReading?: Record<string, string>;
    sources?: Array<{
      citation: string;
      url?: string;
      download?: string;
    }>;
    source?: {
      type?: string;
      rawInput?: string;
    };
  }>;
};

export type SourceValidationIssue = {
  file: string;
  path: string;
  message: string;
};

export type SourceValidationResult = {
  ok: boolean;
  issues: SourceValidationIssue[];
  layers: number;
  imageCollections: number;
};

export class SourceValidationError extends Error {
  constructor(public readonly result: SourceValidationResult) {
    super(formatSourceValidationIssues(result.issues));
  }
}

function issue(file: string, path: string, message: string): SourceValidationIssue {
  return { file, path, message };
}

function displayPath(file: string, path: string): string {
  return path ? `${file}:${path}` : file;
}

export function formatSourceValidationIssues(issues: SourceValidationIssue[]): string {
  if (issues.length === 0) return "source validation passed";
  return `${issues.length} source validation issue(s):\n  - ${issues.map((entry) => `${displayPath(entry.file, entry.path)}: ${entry.message}`).join("\n  - ")}`;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string, file: string, path: string, issues: SourceValidationIssue[], required = false): void {
  if (value[key] === undefined) {
    if (required) issues.push(issue(file, path, "required string is missing"));
    return;
  }
  if (typeof value[key] !== "string" || value[key].trim() === "") issues.push(issue(file, path, "must be a non-empty string"));
}

/** Validates text that must remain available to both supported viewer locales. */
function validateLocalizedText(value: unknown, file: string, path: string, issues: SourceValidationIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push(issue(file, path, 'must be an object with non-empty "en" and "nl" strings'));
    return;
  }
  requireString(value, "en", file, `${path}.en`, issues, true);
  requireString(value, "nl", file, `${path}.nl`, issues, true);
}

function validateSourceObject(value: unknown, file: string, basePath: string, issues: SourceValidationIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push(issue(file, basePath, "must be an object"));
    return;
  }
  requireString(value, "type", file, `${basePath}.type`, issues);
  requireString(value, "rawInput", file, `${basePath}.rawInput`, issues);
}

function validateSources(value: unknown, file: string, basePath: string, issues: SourceValidationIssue[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(issue(file, basePath, "must contain at least one source entry"));
    return;
  }
  value.forEach((entry, index) => {
    const path = `${basePath}[${index}]`;
    if (!isRecord(entry)) {
      issues.push(issue(file, path, "must be an object"));
      return;
    }
    requireString(entry, "citation", file, `${path}.citation`, issues, true);
    const hasUrl = entry.url !== undefined;
    const hasDownload = entry.download !== undefined;
    if (hasUrl === hasDownload) {
      issues.push(issue(file, path, "must define exactly one of url or download"));
      return;
    }
    if (hasUrl) {
      requireString(entry, "url", file, `${path}.url`, issues, true);
      if (typeof entry.url === "string" && !/^https?:\/\//i.test(entry.url)) {
        issues.push(issue(file, `${path}.url`, "must be an HTTP(S) URL"));
      }
    }
    if (hasDownload) {
      requireString(entry, "download", file, `${path}.download`, issues, true);
      if (typeof entry.download === "string" && entry.download.split(",").some((name) => name.trim() === "")) {
        issues.push(issue(file, `${path}.download`, "must be a comma-separated list of non-empty filenames"));
      }
    }
  });
}

/** Validates a link map (display label → http(s) URL), as used by furtherReading. */
function validateLinkMap(value: unknown, file: string, basePath: string, issues: SourceValidationIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push(issue(file, basePath, "must be an object mapping link labels to URLs"));
    return;
  }
  for (const [label, url] of Object.entries(value)) {
    const path = `${basePath}["${label}"]`;
    if (label.trim() === "") issues.push(issue(file, path, "link label must not be empty"));
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      issues.push(issue(file, path, "must map to an http(s) URL"));
    }
  }
}

function validateSublayers(value: unknown, file: string, issues: SourceValidationIssue[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push(issue(file, "sublayers", "must be an array"));
    return;
  }
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const path = `sublayers[${index}]`;
    const sublayer = value[index];
    if (!isRecord(sublayer)) {
      issues.push(issue(file, path, "must be an object"));
      continue;
    }
    requireString(sublayer, "id", file, `${path}.id`, issues, true);
    validateLocalizedText(sublayer.name, file, `${path}.name`, issues);
    requireString(sublayer, "kind", file, `${path}.kind`, issues);
    validateLocalizedText(sublayer.description, file, `${path}.description`, issues);
    validateSources(sublayer.sources, file, `${path}.sources`, issues);
    validateLinkMap(sublayer.furtherReading, file, `${path}.furtherReading`, issues);
    validateSourceObject(sublayer.source, file, `${path}.source`, issues);
    if (typeof sublayer.id === "string") {
      if (ids.has(sublayer.id)) issues.push(issue(file, `${path}.id`, `duplicate sublayer id "${sublayer.id}"`));
      ids.add(sublayer.id);
    }
  }
}

export function validateLayerConfig(value: unknown, file: string, expectedId?: string): SourceValidationIssue[] {
  const issues: SourceValidationIssue[] = [];
  if (!isRecord(value)) return [issue(file, "", "must be a YAML object")];
  requireString(value, "id", file, "id", issues, true);
  requireString(value, "label", file, "label", issues, true);
  if (expectedId && typeof value.id === "string" && value.id !== expectedId) {
    issues.push(issue(file, "id", `must match containing layer directory "${expectedId}"`));
  }
  validateSublayers(value.sublayers, file, issues);
  return issues;
}

function assertLayerConfig(value: unknown, file: string): asserts value is LayerConfig {
  const issues = validateLayerConfig(value, file);
  if (issues.length > 0) throw new SourceValidationError({ ok: false, issues, layers: 0, imageCollections: 0 });
}

export function parseLayerConfig(value: unknown, file: string): LayerConfig {
  assertLayerConfig(value, file);
  return value;
}

async function parseYamlFile(path: string, file: string, issues: SourceValidationIssue[]): Promise<unknown> {
  try {
    return YAML.parse(await readFile(path, "utf-8")) as unknown;
  } catch (err) {
    issues.push(issue(file, "", err instanceof Error ? err.message : "could not parse YAML"));
    return undefined;
  }
}

function validateCollectionEntries(parsed: unknown, file: string, issues: SourceValidationIssue[]): void {
  if (!isRecord(parsed)) {
    issues.push(issue(file, "", "must be a JSON object mapping manifest URLs to [lon, lat] or null"));
    return;
  }
  for (const [manifestUrl, coordinates] of Object.entries(parsed)) {
    if (!/^https?:\/\//i.test(manifestUrl)) {
      issues.push(issue(file, manifestUrl, "key must be an http(s) IIIF manifest URL"));
    }
    if (coordinates === null) continue;
    if (!Array.isArray(coordinates) || coordinates.length !== 2 || !coordinates.every((part) => typeof part === "number" && Number.isFinite(part))) {
      issues.push(issue(file, manifestUrl, "must be null (manifest has navPlace) or a [lon, lat] pair"));
      continue;
    }
    const [lon, lat] = coordinates as [number, number];
    if (lon < -180 || lon > 180) issues.push(issue(file, manifestUrl, `longitude ${lon} out of range [-180, 180]`));
    if (lat < -90 || lat > 90) issues.push(issue(file, manifestUrl, `latitude ${lat} out of range [-90, 90]`));
  }
}

async function validateImageCollections(issues: SourceValidationIssue[]): Promise<number> {
  const root = sourceImageCollectionsDir();
  if (!(await isDirectory(root))) {
    issues.push(issue("imagecollections", "", `required directory is missing from ${sourceDir()}`));
    return 0;
  }
  const entries = await readdir(root, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  let count = 0;
  for (const name of dirs) {
    const ymlFile = `imagecollections/${name}/${name}.yml`;
    const ymlPath = join(root, name, `${name}.yml`);
    const yamlPath = join(root, name, `${name}.yaml`);
    const configPath = (await isFile(ymlPath)) ? ymlPath : (await isFile(yamlPath)) ? yamlPath : undefined;
    if (!configPath) {
      issues.push(issue(ymlFile, "", "required image collection config file is missing"));
    } else {
      count++;
      const configFile = configPath === ymlPath ? ymlFile : `imagecollections/${name}/${name}.yaml`;
      const parsed = await parseYamlFile(configPath, configFile, issues);
      if (parsed !== undefined) {
        if (!isRecord(parsed)) {
          issues.push(issue(configFile, "", "must be a YAML object"));
        } else {
          requireString(parsed, "id", configFile, "id", issues, true);
          validateLocalizedText(parsed.label, configFile, "label", issues);
          if (parsed.label === undefined) issues.push(issue(configFile, "label", "required localized text is missing"));
          validateLocalizedText(parsed.description, configFile, "description", issues);
          validateSources(parsed.sources, configFile, "sources", issues);
          if (Array.isArray(parsed.sources)) {
            parsed.sources.forEach((source, index) => {
              if (isRecord(source) && source.download !== undefined) {
                issues.push(issue(configFile, `sources[${index}].download`, "image collection sources currently require a direct url"));
              }
            });
          }
          validateLinkMap(parsed.furtherReading, configFile, "furtherReading", issues);
          if (typeof parsed.id === "string" && parsed.id !== name) {
            issues.push(issue(configFile, "id", `must match containing directory "${name}"`));
          }
        }
      }
    }

    const dataFile = `imagecollections/${name}/${name}Collection.json`;
    const dataPath = join(root, name, `${name}Collection.json`);
    if (!(await isFile(dataPath))) {
      issues.push(issue(dataFile, "", "required manifest list is missing"));
      continue;
    }
    try {
      validateCollectionEntries(JSON.parse(await readFile(dataPath, "utf-8")), dataFile, issues);
    } catch (err) {
      issues.push(issue(dataFile, "", err instanceof Error ? err.message : "could not parse JSON"));
    }
  }
  return count;
}

export async function validateSource(options: { layerIds?: string[] } = {}): Promise<SourceValidationResult> {
  const issues: SourceValidationIssue[] = [];
  const requiredFiles = [
    { path: mapServicesYamlPath(), file: "map-services.yaml" },
    { path: sourceBaselayerWaterPath(), file: "Baselayer_Water.geojson" },
    { path: sourceBaselayerBorderPath(), file: "Baselayer_Border.geojson" },
  ];
  for (const required of requiredFiles) {
    if (!(await isFile(required.path))) issues.push(issue(required.file, "", `required file is missing from ${sourceDir()}`));
  }

  for (const input of [
    { path: sourceBaselayerWaterPath(), file: "Baselayer_Water.geojson" },
    { path: sourceBaselayerBorderPath(), file: "Baselayer_Border.geojson" },
  ]) {
    if (!(await isFile(input.path))) continue;
    const geoJsonIssues = await validateBaselayerGeoJson(input.path);
    issues.push(...geoJsonIssues.map((entry) => issue(input.file, entry.path, entry.message)));
  }

  if (!(await isDirectory(sourceLayersDir()))) {
    issues.push(issue("layers", "", `required directory is missing from ${sourceDir()}`));
  }

  if (await isFile(mapServicesYamlPath())) {
    const parsed = await parseYamlFile(mapServicesYamlPath(), "map-services.yaml", issues);
    if (isRecord(parsed)) {
      for (const section of ["basemaps", "overlays"] as const) {
        const entries = parsed[section];
        if (!Array.isArray(entries)) {
          issues.push(issue("map-services.yaml", section, "must be an array"));
          continue;
        }
        entries.forEach((entry, index) => {
          const path = `${section}[${index}]`;
          if (!isRecord(entry)) {
            issues.push(issue("map-services.yaml", path, "must be an object"));
            return;
          }
          requireString(entry, "id", "map-services.yaml", `${path}.id`, issues, true);
          requireString(entry, "shortLabel", "map-services.yaml", `${path}.shortLabel`, issues, true);
          requireString(entry, "longLabel", "map-services.yaml", `${path}.longLabel`, issues, true);
          requireString(entry, "url", "map-services.yaml", `${path}.url`, issues, true);
          if (typeof entry.url === "string" && !/^https?:\/\//i.test(entry.url)) {
            issues.push(issue("map-services.yaml", `${path}.url`, "must be an HTTP(S) URL"));
          }
        });
      }
    } else if (parsed !== undefined) {
      issues.push(issue("map-services.yaml", "", "must contain a YAML object"));
    }
  }

  let layerCount = 0;
  if (await isDirectory(sourceLayersDir())) {
    const wanted = new Set((options.layerIds ?? []).filter(Boolean));
    const entries = await readdir(sourceLayersDir(), { withFileTypes: true });
    const dirs = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .filter((name) => wanted.size === 0 || wanted.has(name))
      .sort((a, b) => a.localeCompare(b));

    if (wanted.size > 0) {
      for (const layerId of wanted) {
        if (!dirs.includes(layerId)) issues.push(issue(`layers/${layerId}`, "", "requested layer directory is missing"));
      }
    }

    for (const layerId of dirs) {
      const file = `layers/${layerId}/${layerId}.yaml`;
      const path = join(sourceLayersDir(), layerId, `${layerId}.yaml`);
      if (!(await isFile(path))) {
        issues.push(issue(file, "", "required layer config file is missing"));
        continue;
      }
      layerCount++;
      const parsed = await parseYamlFile(path, file, issues);
      if (parsed !== undefined) issues.push(...validateLayerConfig(parsed, file, layerId));
    }
  }

  const imageCollectionCount = await validateImageCollections(issues);

  return { ok: issues.length === 0, issues, layers: layerCount, imageCollections: imageCollectionCount };
}

export async function assertValidSource(options: { layerIds?: string[] } = {}): Promise<SourceValidationResult> {
  const result = await validateSource(options);
  if (!result.ok) throw new SourceValidationError(result);
  return result;
}
