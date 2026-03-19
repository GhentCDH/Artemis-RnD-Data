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

function report(urls, label) {
  console.log("\n=== " + label + " ===");
  const allPixels = [];
  for (const url of urls) {
    const path = "cache/manifests/" + sha1(url) + ".json";
    if (!existsSync(path)) { console.log("NOT CACHED: " + url); continue; }
    const man = JSON.parse(readFileSync(path, "utf8"));
    const canvases = man?.sequences?.[0]?.canvases ?? [];
    const manifestLabel = (man.label ?? url.split("/").pop()).toString().slice(0, 40);
    console.log("\n  Manifest: " + manifestLabel + " (" + canvases.length + " canvas" + (canvases.length > 1 ? "es" : "") + ")");
    for (const c of canvases) {
      const img = c?.images?.[0]?.resource;
      const iw = img?.width ?? "?";
      const ih = img?.height ?? "?";
      const pixels = typeof iw === "number" && typeof ih === "number" ? iw * ih : null;
      if (pixels) allPixels.push(pixels);
      const svcId = (img?.service?.["@id"] ?? "").split("/").slice(-1)[0];
      const clbl = (c.label ?? c["@id"] ?? "").toString().slice(0, 35).padEnd(35);
      const mpx = pixels ? (pixels / 1e6).toFixed(1) + " Mpx" : "?";
      console.log("    " + clbl + " | canvas " + String(c.width).padStart(5) + "x" + String(c.height).padStart(5) + " | image " + String(iw).padStart(5) + "x" + String(ih).padStart(5) + " | " + mpx + " | svc:..." + svcId);
    }
  }
  if (allPixels.length > 0) {
    const avg = allPixels.reduce((a, b) => a + b, 0) / allPixels.length;
    const min = Math.min(...allPixels);
    const max = Math.max(...allPixels);
    console.log("\n  SUMMARY: " + allPixels.length + " canvases | avg " + (avg / 1e6).toFixed(1) + " Mpx | min " + (min / 1e6).toFixed(1) + " Mpx | max " + (max / 1e6).toFixed(1) + " Mpx");
  }
}

report(gered, "Gereduceerd Kadaster");
report(primit, "Primitief Kadaster");
