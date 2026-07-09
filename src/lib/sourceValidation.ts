import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { aboutJsonPath, imageCollectionConfigPath, logosRegistryPath, sourceBaselayerPath, sourceDir, sourceLayersDir } from "./paths";

export type LayerConfig = {
  id: string;
  label: string;
  timeframe?: unknown;
  sublayers?: Array<{
    id: string;
    name?: string;
    kind?: string;
    description?: string;
    citation?: string;
    attribution?: {
      logos?: string[];
    };
    source?: {
      type?: string;
      rawInput?: string;
      url?: string;
    };
    /** Filename of a standalone file in the Zenodo record (alongside Source.zip) offered as an end-user download. */
    download?: string;
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
  logoReferences: number;
};

export class SourceValidationError extends Error {
  constructor(public readonly result: SourceValidationResult) {
    super(formatSourceValidationIssues(result.issues));
  }
}

type LogoReference = {
  file: string;
  path: string;
  value: string;
};

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

function validateSourceObject(value: unknown, file: string, basePath: string, issues: SourceValidationIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push(issue(file, basePath, "must be an object"));
    return;
  }
  requireString(value, "type", file, `${basePath}.type`, issues);
  requireString(value, "rawInput", file, `${basePath}.rawInput`, issues);
  requireString(value, "url", file, `${basePath}.url`, issues);
}

function validateAttributionObject(value: unknown, file: string, basePath: string, issues: SourceValidationIssue[], logoReferences: LogoReference[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push(issue(file, basePath, "must be an object"));
    return;
  }
  const logos = value.logos;
  if (logos === undefined) return;
  if (!Array.isArray(logos)) {
    issues.push(issue(file, `${basePath}.logos`, "must be an array of logo filenames"));
    return;
  }
  for (let index = 0; index < logos.length; index++) {
    const path = `${basePath}.logos[${index}]`;
    const logo = logos[index];
    if (typeof logo !== "string" || logo.trim() === "") {
      issues.push(issue(file, path, "must be a non-empty string"));
      continue;
    }
    logoReferences.push({ file, path, value: logo });
  }
}

function validateSublayers(value: unknown, file: string, issues: SourceValidationIssue[], logoReferences: LogoReference[]): void {
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
    requireString(sublayer, "name", file, `${path}.name`, issues);
    requireString(sublayer, "kind", file, `${path}.kind`, issues);
    requireString(sublayer, "description", file, `${path}.description`, issues);
    requireString(sublayer, "citation", file, `${path}.citation`, issues);
    requireString(sublayer, "download", file, `${path}.download`, issues);
    validateSourceObject(sublayer.source, file, `${path}.source`, issues);
    validateAttributionObject(sublayer.attribution, file, `${path}.attribution`, issues, logoReferences);
    if (typeof sublayer.id === "string") {
      if (ids.has(sublayer.id)) issues.push(issue(file, `${path}.id`, `duplicate sublayer id "${sublayer.id}"`));
      ids.add(sublayer.id);
    }
  }
}

export function validateLayerConfig(value: unknown, file: string, expectedId?: string, logoReferences: LogoReference[] = []): SourceValidationIssue[] {
  const issues: SourceValidationIssue[] = [];
  if (!isRecord(value)) return [issue(file, "", "must be a YAML object")];
  requireString(value, "id", file, "id", issues, true);
  requireString(value, "label", file, "label", issues, true);
  if (expectedId && typeof value.id === "string" && value.id !== expectedId) {
    issues.push(issue(file, "id", `must match containing layer directory "${expectedId}"`));
  }
  validateSublayers(value.sublayers, file, issues, logoReferences);
  return issues;
}

function assertLayerConfig(value: unknown, file: string): asserts value is LayerConfig {
  const issues = validateLayerConfig(value, file);
  if (issues.length > 0) throw new SourceValidationError({ ok: false, issues, layers: 0, logoReferences: 0 });
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

async function readLogoRegistry(issues: SourceValidationIssue[]): Promise<Set<string>> {
  const registryPath = logosRegistryPath();
  if (!(await isFile(registryPath))) return new Set();
  const parsed = await parseYamlFile(registryPath, "attribution-logos/logos.yaml", issues);
  if (parsed === undefined) return new Set();
  if (!isRecord(parsed)) {
    issues.push(issue("attribution-logos/logos.yaml", "", "must be a YAML object mapping logo filenames to URLs"));
    return new Set();
  }
  const files = new Set<string>();
  for (const [file, href] of Object.entries(parsed)) {
    if (typeof href !== "string" || href.trim() === "") {
      issues.push(issue("attribution-logos/logos.yaml", file, "must map to a non-empty URL string"));
      continue;
    }
    files.add(file);
  }
  return files;
}

export async function validateSource(options: { layerIds?: string[] } = {}): Promise<SourceValidationResult> {
  const issues: SourceValidationIssue[] = [];
  const logoReferences: LogoReference[] = [];
  const requiredFiles = [
    { path: aboutJsonPath(), file: "about.json" },
    { path: sourceBaselayerPath(), file: "Baselayer.geojson" },
    { path: imageCollectionConfigPath(), file: "ImageCollectionConfig.yaml" },
  ];
  for (const required of requiredFiles) {
    if (!(await isFile(required.path))) issues.push(issue(required.file, "", `required file is missing from ${sourceDir()}`));
  }

  if (!(await isDirectory(sourceLayersDir()))) {
    issues.push(issue("layers", "", `required directory is missing from ${sourceDir()}`));
  }

  if (await isFile(aboutJsonPath())) {
    try {
      JSON.parse(await readFile(aboutJsonPath(), "utf-8"));
    } catch (err) {
      issues.push(issue("about.json", "", err instanceof Error ? err.message : "could not parse JSON"));
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
      if (parsed !== undefined) issues.push(...validateLayerConfig(parsed, file, layerId, logoReferences));
    }
  }

  const logoRegistry = await readLogoRegistry(issues);
  for (const ref of logoReferences) {
    if (!logoRegistry.has(ref.value)) {
      issues.push(issue(ref.file, ref.path, `"${ref.value}" is not listed in attribution-logos/logos.yaml`));
    }
  }

  return { ok: issues.length === 0, issues, layers: layerCount, logoReferences: logoReferences.length };
}

export async function assertValidSource(options: { layerIds?: string[] } = {}): Promise<SourceValidationResult> {
  const result = await validateSource(options);
  if (!result.ok) throw new SourceValidationError(result);
  return result;
}
