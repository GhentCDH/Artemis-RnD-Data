import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";

function sha1(s) { return createHash("sha1").update(s).digest("hex"); }

const gered = [
  "https://iiif.ghentcdh.ugent.be/iiif/manifests/gereduceerd_kadaster:Termonde:Appels",
  "https://iiif.ghentcdh.ugent.be/iiif/manifests/gereduceerd_kadaster:Termonde:Audeghem",
  "https://iiif.ghentcdh.ugent.be/iiif/manifests/gereduceerd_kadaster:Termonde:Baesrode",
  "https://iiif.ghentcdh.ugent.be/iiif/manifests/gereduceerd_kadaster:Termonde:Berlaere",
  "https://iiif.ghentcdh.ugent.be/iiif/manifests/gereduceerd_kadaster:Termonde:Buggenhout",
  "https://iiif.ghentcdh.ugent.be/iiif/manifests/gereduceerd_kadaster:Termonde:Calcken",
  "https://iiif.ghentcdh.ugent.be/iiif/manifests/gereduceerd_kadaster:Termonde:Cherscamp",
  "https://iiif.ghentcdh.ugent.be/iiif/manifests/gereduceerd_kadaster:Termonde:Denderbelle",
  "https://iiif.ghentcdh.ugent.be/iiif/manifests/gereduceerd_kadaster:Termonde:Grembergen",
  "https://iiif.ghentcdh.ugent.be/iiif/manifests/gereduceerd_kadaster:Termonde:Hamme",
];
const primit = [
  "https://iiif.ghentcdh.ugent.be/iiif/manifests/primitief_kadaster:550_0001_000_01588_000",
  "https://iiif.ghentcdh.ugent.be/iiif/manifests/primitief_kadaster:550_0001_000_02553_000",
  "https://iiif.ghentcdh.ugent.be/iiif/manifests/primitief_kadaster:550_0001_000_02554_000",
  "https://iiif.ghentcdh.ugent.be/iiif/manifests/primitief_kadaster:550_0001_000_02555_000",
  "https://iiif.ghentcdh.ugent.be/iiif/manifests/primitief_kadaster:550_0001_000_02556_000",
  "https://iiif.ghentcdh.ugent.be/iiif/manifests/primitief_kadaster:550_0001_000_02559_000",
  "https://iiif.ghentcdh.ugent.be/iiif/manifests/primitief_kadaster:550_0001_000_02595_000",
  "https://iiif.ghentcdh.ugent.be/iiif/manifests/primitief_kadaster:550_0001_000_02692_000",
  "https://iiif.ghentcdh.ugent.be/iiif/manifests/primitief_kadaster:550_0001_000_02693_000",
  "https://iiif.ghentcdh.ugent.be/iiif/manifests/primitief_kadaster:550_0001_000_03017_000",
];

// Load cached info index (keyed by image service URL)
const infoIndex = JSON.parse(readFileSync(".build-cache/iiif/info/index.json", "utf8"));

function describeTiles(info) {
  // IIIF Image API 2: info.tiles = [{ width, height?, scaleFactors }]
  // IIIF Image API 3: same structure
  const tiles = info.tiles ?? [];
  if (tiles.length === 0) return "NO TILES (level0/full only)";
  return tiles.map(t => {
    const w = t.width;
    const h = t.height ?? t.width; // height defaults to width if omitted
    const scales = (t.scaleFactors ?? []).join(",");
    return `${w}x${h} scales:[${scales}]`;
  }).join(" | ");
}

function tileCountEstimate(imageW, imageH, info) {
  const tiles = info.tiles ?? [];
  if (tiles.length === 0) return null; // full image only
  let total = 0;
  for (const t of tiles) {
    const tw = t.width;
    const th = t.height ?? t.width;
    for (const sf of (t.scaleFactors ?? [1])) {
      const scaledW = Math.ceil(imageW / sf);
      const scaledH = Math.ceil(imageH / sf);
      const cols = Math.ceil(scaledW / tw);
      const rows = Math.ceil(scaledH / th);
      total += cols * rows;
    }
  }
  return total;
}

function report(urls, label) {
  console.log("\n=== " + label + " ===");
  let allTileCounts = [];
  for (const url of urls) {
    const path = "cache/manifests/" + sha1(url) + ".json";
    if (!existsSync(path)) { console.log("NOT CACHED: " + url); continue; }
    const man = JSON.parse(readFileSync(path, "utf8"));
    const canvases = man?.sequences?.[0]?.canvases ?? [];
    const manifestLabel = (man.label ?? url.split("/").pop()).toString().slice(0, 40);
    console.log("\n  Manifest: " + manifestLabel + " (" + canvases.length + " canvas" + (canvases.length > 1 ? "es" : "") + ")");
    for (const c of canvases) {
      const img = c?.images?.[0]?.resource;
      const iw = img?.width;
      const ih = img?.height;
      const svcUrl = (img?.service?.["@id"] ?? "").replace(/\/+$/, "");
      const info = infoIndex[svcUrl];
      const clbl = (c.label ?? "").toString().slice(0, 32).padEnd(32);
      if (!info) {
        console.log("    " + clbl + " | NO INFO.JSON CACHED");
        continue;
      }
      const tileDesc = describeTiles(info);
      const count = tileCountEstimate(iw, ih, info);
      const countStr = count !== null ? " | ~" + count + " tiles total" : "";
      console.log("    " + clbl + " | " + iw + "x" + ih + " | " + tileDesc + countStr);
      if (count !== null) allTileCounts.push(count);
    }
  }
  if (allTileCounts.length > 0) {
    const avg = Math.round(allTileCounts.reduce((a, b) => a + b, 0) / allTileCounts.length);
    const min = Math.min(...allTileCounts);
    const max = Math.max(...allTileCounts);
    console.log("\n  TILE SUMMARY (" + allTileCounts.length + " canvases): avg ~" + avg + " tiles | min " + min + " | max " + max);
  }
}

report(gered, "Gereduceerd Kadaster");
report(primit, "Primitief Kadaster");
