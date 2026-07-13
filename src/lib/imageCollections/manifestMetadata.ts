type MetadataEntry = {
  labels: string[];
  values: string[];
};

function textValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(textValues);
  return [];
}

function resourceId(value: Record<string, unknown>): string {
  return String(value.id ?? value["@id"] ?? "");
}

export type ExtractedManifestMetadata = {
  year?: string;
  date?: string;
  recordId?: string;
  repId?: string;
  manifestId?: string;
  yearCandidates: string[];
};

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function normalized(value: string): string {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();
}

function metadataEntries(manifest: Record<string, unknown>): MetadataEntry[] {
  if (!Array.isArray(manifest.metadata)) return [];
  return manifest.metadata.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const entry = raw as Record<string, unknown>;
    return [{ labels: textValues(entry.label), values: textValues(entry.value) }];
  });
}

function years(values: string[]): string[] {
  return unique(values.flatMap((value) => [...value.matchAll(/\b(1[5-9]\d{2}|20\d{2})\b/g)].map((match) => match[1])));
}

function exactDate(values: string[]): string | undefined {
  for (const value of values) {
    const dayFirst = value.match(/\b(0?[1-9]|[12]\d|3[01])[\/.\-](0?[1-9]|1[0-2])[\/.\-]((?:1[5-9]|20)\d{2})\b/);
    if (dayFirst) return `${dayFirst[3]}-${dayFirst[2]!.padStart(2, "0")}-${dayFirst[1]!.padStart(2, "0")}`;
    const iso = value.match(/\b((?:1[5-9]|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/);
    if (iso) return iso[0];
  }
  return undefined;
}

function valuesForLabels(entries: MetadataEntry[], pattern: RegExp): string[] {
  return entries
    .filter((entry) => entry.labels.some((label) => pattern.test(normalized(label))))
    .flatMap((entry) => entry.values);
}

function representationId(manifestId: string): string | undefined {
  try {
    const parts = new URL(manifestId).pathname.split("/").filter(Boolean);
    const manifestIndex = parts.findIndex((part) => part.toLowerCase() === "manifest");
    if (manifestIndex > 0) return parts[manifestIndex - 1];
  } catch {
    // Non-URL IIIF identifiers are still valid; they simply have no derivable representation id.
  }
  return undefined;
}

/** Extract non-spatial descriptive fields only. Coordinates remain owned by navPlace/paired source data. */
export function extractManifestMetadata(manifest: Record<string, unknown>, requestedUrl: string): ExtractedManifestMetadata {
  const entries = metadataEntries(manifest);
  const explicitYearValues = valuesForLabels(entries, /^(year|jaar|annee)$/);
  const dateValues = valuesForLabels(entries, /(date|datum|dating|created|creation)/);
  const dateNoteValues = entries
    .flatMap((entry) => entry.values)
    .filter((value) => /\b(date|datum|jaar|annee)\b/i.test(normalized(value)));
  const yearCandidates = unique([
    ...years(explicitYearValues),
    ...years(dateValues),
    ...years(dateNoteValues),
  ]);

  const identifierValues = valuesForLabels(entries, /^(identifier|record id|record identifier|catalog(?:ue)? id|inventory number|call number)$/);
  const manifestId = resourceId(manifest) || requestedUrl;
  const repId = representationId(manifestId) ?? representationId(requestedUrl);

  return {
    year: years(explicitYearValues)[0] ?? years(dateValues)[0] ?? years(dateNoteValues)[0],
    date: exactDate([...dateValues, ...dateNoteValues]),
    recordId: identifierValues.find((value) => value.trim())?.trim(),
    repId,
    manifestId: manifestId || undefined,
    yearCandidates,
  };
}
