import { readFile } from "node:fs/promises";

type IIIFv2Collection = {
  "@context"?: string;
  "@id"?: string;
  "@type"?: string;
  label?: string;
  manifests?: Array<{ "@id": string; label?: string }>;
};

function parseLines(txt: string): string[] {
  return txt
    .split(/\r?\n/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"));
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  return await res.json();
}

function listManifestUrlsFromV2Collection(col: IIIFv2Collection): string[] {
  if (!Array.isArray(col.manifests)) return [];
  return col.manifests.map((m) => m["@id"]).filter(Boolean);
}

async function main() {
  const sourcesTxt = await readFile("data/sources/collections.txt", "utf-8");
  const collectionUrls = parseLines(sourcesTxt);

  console.log(`Collections: ${collectionUrls.length}`);

  for (const url of collectionUrls) {
    console.log(`\n[Collection] ${url}`);
    const col = (await fetchJson(url)) as IIIFv2Collection;

    console.log(`  @type: ${col["@type"] ?? "(no @type)"}`);
    console.log(`  @context: ${col["@context"] ?? "(no @context)"}`);

    const manifestUrls = listManifestUrlsFromV2Collection(col);
    console.log(`  manifests: ${manifestUrls.length}`);

    for (const m of manifestUrls.slice(0, 5)) console.log(`   - ${m}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
