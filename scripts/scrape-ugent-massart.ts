/**
 * Scrapes the UGent library catalog for Massart digitized photographs and
 * produces a IIIF v2 Collection JSON at data/sources/ugent-massart.json.
 *
 * API discovered via container-based network interception (no permanent
 * browser dependency — pure fetch).
 *
 * Usage: bun run scripts/scrape-ugent-massart.ts
 */

import { writeFile, mkdir } from "node:fs/promises";

const BASE = "https://libcatalog.ugent.be/primaws/rest/pub";
const IIIF_BASE = "https://libcatalog.ugent.be";
const LIMIT = 10;

const SHARED_PARAMS = new URLSearchParams({
  citationTrailFilterByAvailability: "true",
  limit: String(LIMIT),
  newspapersActive: "false",
  newspapersSearch: "false",
  pcAvailability: "false",
  scope: "MyInst_and_CI",
  searchInFulltextUserSelection: "false",
  disableCache: "false",
  skipDelivery: "N",
  sort: "rank",
  tab: "Everything",
  inst: "32RUG_INST",
  rapido: "true",
  refEntryActive: "true",
  rtaLinks: "true",
  qInclude: "",
  qExclude: "",
  multiFacets: "facet_rtype,include,images",
  mode: "advanced",
  q: "creator,contains,Massart, Jean",
  isCDSearch: "false",
  featuredNewspapersIssnList: "",
  lang: "en",
  explain: "",
  otbRanking: "",
  isRelatedItems: "false",
  vid: "32RUG_INST:32RUG_INST",
});

async function fetchJson(url: string, method = "GET"): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      Origin: "https://libcatalog.ugent.be",
      Referer: "https://libcatalog.ugent.be/nde/search",
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function parseYear(creationdate: string[] | undefined): string | undefined {
  if (!creationdate?.length) return undefined;
  // e.g. "14/07/1911" or "1911"
  const match = creationdate[0].match(/\b(\d{4})\b/);
  return match?.[1];
}

function parseLocation(subject: string[] | undefined): string | undefined {
  if (!subject?.length) return undefined;
  const geo = subject.find((s) => s.startsWith("België "));
  if (geo) return geo.replace("België ", "").trim();
  const nonGeneric = subject.find(
    (s) => !["Landscapes", "Photographs", "Catalogs", "Exhibition catalogs"].includes(s)
  );
  return nonGeneric;
}

// Parse DMS coordinates from Primo title.
// Format: "51°10'11" NB 04°11'51" OL" (NB=lat N, ZB=lat S, OL=lon E, WL=lon W)
function parseDmsFromTitle(title: string): { lat: number; lon: number } | null {
  const m = title.match(/(\d+)°(\d+)'(\d+)[""″]\s*(NB|ZB)\s+(\d+)°(\d+)'(\d+)[""″]\s*(OL|WL)/);
  if (!m) return null;
  const lat = parseInt(m[1]) + parseInt(m[2]) / 60 + parseInt(m[3]) / 3600;
  const lon = parseInt(m[5]) + parseInt(m[6]) / 60 + parseInt(m[7]) / 3600;
  return { lat: m[4] === "ZB" ? -lat : lat, lon: m[8] === "WL" ? -lon : lon };
}

interface RecordMeta {
  mmsId: string;
  title: string;
  year?: string;
  location?: string;
}

interface RepInfo {
  ilsApiId: string; // rep ID → manifest URL
}

async function fetchPage(offset: number): Promise<{ docs: any[]; total: number }> {
  const params = new URLSearchParams(SHARED_PARAMS);
  params.set("offset", String(offset));
  const data = await fetchJson(`${BASE}/pnxs?${params}`);
  return { docs: data.docs ?? [], total: data.info?.total ?? 0 };
}

// Fetch rep IDs via directLink — one call per MMS record ID.
// edelivery returns 405 (POST-only); directLink is GET and returns redirect_to with repId.
async function fetchRepId(almaRecordId: string): Promise<string | undefined> {
  const url = `${BASE}/directLink/${almaRecordId}?lang=en&vid=32RUG_INST:32RUG_INST`;
  const data = await fetchJson(url, "POST");
  // e.g. { full_text_do_redirect: "true", redirect_to: "/view/delivery/32RUG_INST/12291851120009161" }
  if (data?.full_text_do_redirect === "true" && data?.redirect_to) {
    const match = (data.redirect_to as string).match(/\/(\d+)$/);
    return match?.[1];
  }
  return undefined;
}

async function main() {
  console.log("Fetching first page to determine total...");
  const first = await fetchPage(0);
  const total = first.total;
  console.log(`  Total results: ${total}`);

  const offsets = Array.from({ length: Math.ceil(total / LIMIT) }, (_, i) => i * LIMIT);

  // Fetch all pages of pnxs in parallel
  console.log(`Fetching ${offsets.length} pages...`);
  const allDocs: any[] = [...first.docs];
  const restPages = await Promise.all(offsets.slice(1).map((offset) => fetchPage(offset)));
  for (const p of restPages) allDocs.push(...p.docs);

  // Extract metadata from pnxs
  const records: RecordMeta[] = allDocs.map((doc) => {
    const display = doc.pnx?.display ?? {};
    const title = display.title?.[0] ?? "(no title)";
    return {
      mmsId: doc.pnx?.control?.recordid?.[0] ?? "",
      title,
      year: parseYear(display.creationdate),
      location: parseLocation(display.subject),
      coords: parseDmsFromTitle(title),
    };
  }).filter((r) => r.mmsId);

  console.log(`Fetching rep IDs for ${records.length} records via directLink...`);
  const manifests: Array<{
    manifestUrl: string;
    label: string;
    year?: string;
    lat?: number;
    lon?: number;
    location?: string;
    mmsId: string;
    repId: string;
  }> = [];

  // Fetch in small batches to be polite
  const BATCH = 5;
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const results = await Promise.all(batch.map((r) => fetchRepId(r.mmsId)));
    for (let j = 0; j < batch.length; j++) {
      const repId = results[j];
      if (!repId) continue;
      const r = batch[j];
      manifests.push({
        manifestUrl: `${IIIF_BASE}/view/iiif/presentation/32RUG_INST/${repId}/manifest?iiifVersion=2&updateStatistics=false`,
        label: r.title,
        year: r.year,
        location: r.location,
        lat: (r as any).coords?.lat,
        lon: (r as any).coords?.lon,
        mmsId: r.mmsId,
        repId,
      });
    }
    if (i + BATCH < records.length) await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`Found ${manifests.length} digitized records with IIIF manifests.`);

  // Build IIIF v2 Collection
  const collection = {
    "@context": "http://iiif.io/api/presentation/2/context.json",
    "@id": "data/sources/ugent-massart.json",
    "@type": "sc:Collection",
    label: "Jean Massart photographs — Universiteit Gent",
    description: "Digitized photographs by Jean Massart from the UGent library catalog.",
    manifests: manifests.map((m) => ({
      "@id": m.manifestUrl,
      "@type": "sc:Manifest",
      label: m.label,
      ...(m.year ? { metadata: [{ label: "Year", value: m.year }] } : {}),
      ...(m.location ? { metadata: [{ label: "Location", value: m.location }] } : {}),
      _mmsId: m.mmsId,
      _repId: m.repId,
    })),
  };

  await mkdir("data/sources", { recursive: true });
  await writeFile("data/sources/ugent-massart.json", JSON.stringify(collection, null, 2), "utf-8");
  console.log(`Written to data/sources/ugent-massart.json`);

  // Summary
  const years = [...new Set(manifests.map((m) => m.year).filter(Boolean))].sort();
  const locations = [...new Set(manifests.map((m) => m.location).filter(Boolean))].sort();
  console.log(`Years: ${years.join(", ")}`);
  console.log(`Locations (${locations.length}): ${locations.slice(0, 10).join(", ")}${locations.length > 10 ? "..." : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
