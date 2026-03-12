# Artemis-RnD-Data — LLM Context

## Purpose

A data pipeline that crawls IIIF v2 collections, mirrors Allmaps georeferencing annotations (manifest + canvas level), and produces a compiled build suitable for hosting on GitHub Pages (or similar static hosting).

## Stack

- **Runtime**: Bun
- **Language**: TypeScript
- **Key dependency**: `@allmaps/id` — generates deterministic IDs from IIIF manifest/canvas URLs to look up annotations on `annotations.allmaps.org`

## Entrypoints

| Script | File | Description |
|---|---|---|
| `bun run dev` | `src/index.ts` | placeholder / scratch |
| `bun run crawl` | `src/pipeline.ts` | full pipeline run |
| `bun run crawl10` | `src/pipeline.ts` | pipeline with LIMIT=10 |
| `bun run crawl1` | `src/pipeline.ts` | pipeline with LIMIT=1 |
| `bun run buildSearch` | `src/toponyms.ts` | builds toponym search index only (`build/Toponyms/index.json`) |
| `bun run toponyms` | `src/toponyms.ts` | alias of `buildSearch` |

## Pipeline (`src/pipeline.ts`)

Each source collection URL is treated as a distinct logical source. Build outputs expose:
- source-level layers (`layers`) — one per source, for stats/debug
- viewer render layers (`renderLayers`) — one entry per rendered layer (`default`, `verzamelblad`)

1. Reads collection URLs from `data/sources/collections.txt` (one URL per line, `#` = comment)
2. Resolves each URL into a `SourceGroup` (fetches IIIF v2 Collection, cached to `cache/collections/`); deduplication happens within each source independently
3. For each source group, processes its manifests (cached to `cache/manifests/`):
   - Generates an Allmaps ID via `@allmaps/id` from the manifest URL
   - Checks `https://annotations.allmaps.org/manifests/<id>` for georeferencing annotations (HTTP status)
   - Extracts canvas IDs from the IIIF v2 manifest and checks **each canvas** at `https://annotations.allmaps.org/canvases/<canvas-id-hash>`
   - Mirrors available annotation JSONs:
     - manifest endpoint → `build/allmaps/manifests/<id>.json`
     - canvas endpoint → `build/allmaps/canvases/<id>.json`
   - **Annotation source priority**: canvas endpoints are checked first. If any canvas returns 200 → `georefDetectedBy = "canvas"`. Only if no canvas hits but manifest returns 200 → `georefDetectedBy = "manifest"`. This correctly handles multi-canvas manifests where the Allmaps manifest endpoint is an aggregation of per-canvas annotations.
   - Compiles the manifest:
     - injects `otherContent` on every canvas
     - prefers canvas-specific mirrored annotation when available
     - otherwise falls back to the mirrored manifest annotation
     - adds provenance metadata
   - Writes compiled manifest to `build/manifests/<sha1-slug>.json`
4. Writes one `build/collections/<sha1(sourceUrl)>.json` per source — a IIIF v2 Collection listing only that source's compiled manifests
5. Writes per-source render-layer collections (up to 2 per source):
   - `default` — all non-`verzamelblad` entries
   - `verzamelblad` — entries identified as verzamelblad
   - Empty layers are skipped
6. Writes `build/index.json` — stats + `layers` + `renderLayers` + full flat `index` array for tooling
7. Writes `build/collection.json` — top-level IIIF v2 Collection referencing render-layer sub-collections (not source-level collections)

### Viewer loading pattern
```
index.json            ← fetch once to enumerate layers (small)
  └─ renderLayers[n].compiledCollectionPath   ← preferred for viewer rendering
       └─ collections/<hash>.json   ← fetch per active layer
            └─ manifests[n]["@id"]
                 └─ manifests/<slug>.json  ← fetch on demand
```

### Viewer notes
- Use `renderLayers` for layer toggles; keep `layers` for source-level stats/debug only.
- For georef readiness: use `georefDetectedBy !== "none"`. Do not rely solely on `manifestAllmapsStatus === 200` — the manifest endpoint is an aggregation and always returns 200 if any canvas is georeferenced.
- `isVerzamelblad === true` → entry belongs to the `verzamelblad` visible render layer.
- `renderLayers` contains only visible UI layers (`default`, `verzamelblad`).
- Per-entry `annotSource` (`"single"` / `"multi"` / `"none"`) and `singleCanvasGeorefCount`/`multiCanvasGeorefCount` on each layer carry all canvas-count information — no separate sub-layer collection files are needed.
- The compiled manifest already has `otherContent` on every canvas pointing to the correct mirrored annotation — the viewer does not need `annotSource` for rendering, it just follows `otherContent`.
- **Annotation loading strategy in viewer** (`getMirroredAnnotationRequests`):
  - Always prefer the manifest annotation (`mirroredAllmapsAnnotationPath`) for all entries — it is the canonical source and ensures a single `addGeoreferenceAnnotation` call regardless of canvas count.
  - Canvas paths (from `canvasAllmapsHits`) are only used as fallback when no manifest annotation was mirrored.
- Build output dirs (`build/manifests/`, `build/collections/`, `build/allmaps/`) are wiped at the start of each pipeline run. Only `cache/` persists.

## Directory Layout

```
data/sources/collections.txt      # input: one IIIF collection URL per line
data/sources/Toponyms/README.txt  # note about local-only toponym source files
cache/collections/                # disk cache for fetched collections
cache/manifests/                  # disk cache for fetched manifests
build/
  collection.json                 # top-level IIIF v2 Collection of sub-collections
  collections/<sha1>.json         # compiled IIIF v2 Collections (source-level + render-layer splits)
  index.json                      # { layers, renderLayers, index, stats } — layer lists + per-manifest metadata
  Toponyms/index.json             # toponym search index for viewer/GitHub Pages
  manifests/<slug>.json           # compiled manifests with Allmaps otherContent injected
  allmaps/manifests/<id>.json     # mirrored Allmaps annotation JSONs
  allmaps/canvases/<id>.json      # mirrored Allmaps canvas annotation JSONs
src/
  pipeline.ts                     # main pipeline
  toponyms.ts                     # toponym search index builder
  index.ts                        # placeholder
```

## Key Environment Variables

| Variable | Effect |
|---|---|
| `LIMIT=N` | Process only the first N manifests **per source** |
| `BUILD_BASE_URL` | Prefix for absolute URLs in compiled manifests/collections (e.g. GitHub Pages root) |

## Data Types

- **SourceGroup**: `{ sourceCollectionUrl, sourceCollectionLabel, refs[] }` — one per source URL
- **IndexEntry**: per-manifest record including:
  - `label`, `sourceManifestUrl`, `sourceCollectionUrl`, `compiledManifestPath`
  - `centerLon?`, `centerLat?` — optional map center derived from mirrored annotation geo points
  - `manifestAllmapsId`, `manifestAllmapsUrl`, `manifestAllmapsStatus`, `mirroredAllmapsAnnotationPath`
  - `canvasAllmapsHits[]`: `{ canvasId, canvasAllmapsId, canvasAllmapsUrl, canvasAllmapsStatus, mirroredAllmapsAnnotationPath }` — one entry per canvas
  - `georefDetectedBy`: `"none" | "manifest" | "canvas"` — canvas hits take priority over manifest
  - `annotSource`: `"single" | "multi" | "none"` — derived from `canvasCount`: georeffed single-canvas → `"single"`, georeffed multi-canvas → `"multi"`, not georeffed → `"none"`
  - `isVerzamelblad`: boolean
  - `canvasCount`, `canvasIds`
- **renderLayerMeta entry** fields:
  - `renderLayerKey`: `"default" | "verzamelblad" | "single-canvas" | "multi-canvas"`
  - `parentRenderLayerKey?`: `"default"` — set on hidden sub-layers
  - `hidden`: boolean — `true` for `single-canvas`/`multi-canvas` debug sub-layers
  - `manifestCount`, `georefCount`, `singleCanvasGeorefCount`, `multiCanvasGeorefCount`
  - Hidden sub-layers exist only for the `default` layer of each source; they split entries by `annotSource` for isolated render testing
- **V2Collection / V2Manifest**: typed IIIF v2 shapes (permissive `Record<string, any>` for manifests)

## Current Data Sources

`data/sources/collections.txt` currently points to two collections:
- `https://raw.githubusercontent.com/RDebrulle/AllmapsTests/refs/heads/main/Gereduceerd_Kadaster.json` (Gereduceerd Kadaster)
- `https://iiif.ghentcdh.ugent.be/iiif/collections/primitief_kadaster` (Primitief Kadaster)

## Known rendering bug — Primitief single-canvas

**Symptom**: Enabling the Primitief `single-canvas` hidden sub-layer causes visual artifacts: maps load intermittently, only a small portion renders, and visible maps flicker. The Gereduceerd `single-canvas` layer (96 maps) renders correctly. Primitief `multi-canvas` (83 manifests) also renders correctly.

**What was ruled out**:
- IIIF server connectivity — all 10 images respond fine: `info.json` <10ms, tiles 130–200ms
- Self-intersecting resource mask polygons — none found (checked all 10 programmatically)
- Polygon complexity — Gereduceerd has masks up to 639 pts and works fine; Primitief single-canvas max is 368 pts
- GCP coordinate errors — all 10 entries have valid Belgium coordinates
- Wrong GCP count — counts range from 4 to 78, mix of polynomial and thinPlateSpline
- Canvas vs manifest annotation format — both are structurally identical; switching to manifest annotations for all entries made no difference
- Layer overlap — bug persists even when Primitief single-canvas is the only active layer

**10 affected manifests** (see also `/home/def/Documents/primitief-single-canvas.txt`):
- Sinaai - Sectie A en B — canvas `2b1590f8e163db39`
- Overmere - Sectie B — canvas `8f02aba1d89c9431`
- Dendermonde - Sectie C — canvas `b68b5cfe7d18ef28`
- Appels - Sectie A — canvas `3c6ce0bee9d63669`
- Sint-Gillis-bij-Dendermonde - Sectie B — canvas `33cf8c20d249c8b4`
- Sint-Gillis-bij-Dendermonde - Sectie C — canvas `e675aa4b2b9ef18f`
- Oudegem - Sectie A — canvas `1822684cedf15b29`
- Heusden - Sectie E — canvas `9a5c1c6984b0e9c9`
- Bazel - Sectie C — canvas `fdb91d7591e7146f`
- Kalken - Sectie C-D — canvas `b6fb234749565370`

**Next debugging step**: Test these manifests directly in the Allmaps viewer (`viewer.allmaps.org`) to see if the same flickering/partial rendering occurs outside our pipeline. If it does, the root cause is in the annotation data itself (GCP quality, mask shape, or transformation parameters) rather than our rendering code.

## Notes

- Cache is never invalidated automatically — delete `cache/` to force re-fetch
- Manifests without detected georeferencing are still compiled and included (unmodified) to keep the collection complete
- `verzamelblad` detection is string-based against URL/label/identifier/metadata in the source manifest; if present, it is split into a dedicated render layer.
- `build/` is committed to the repo (acts as the published artifact)

---

## Session Update — 2026-03-06 (Manifest Center Coordinates)

### What Changed
- `src/pipeline.ts` now derives optional per-manifest center coordinates from mirrored annotation geo GCP points.
- `build/index.json` `index[]` entries can now include:
  - `centerLon`
  - `centerLat`

### Why
- Viewer manifest search requires click-to-location behavior for each manifest result.
- Coordinates are embedded in existing `build/index.json` to avoid extra files/fetches.

### Derivation Strategy
- Prefer center computed from mirrored manifest annotation when available.
- Fall back to merged canvas-level mirrored annotations.
- Center is bbox-center over available geo point features.

---

## Session Update — 2026-03-06 (Toponyms Search Build)

### What Changed
- Added a separate search build script: `bun run buildSearch` (alias: `bun run toponyms`).
- Implemented `src/toponyms.ts` to compile source toponym GeoJSON/JSON files into a single search artifact:
  - `build/Toponyms/index.json`
- Toponym search build is independent from `crawl` and can be run without touching IIIF/Allmaps outputs.

### Toponym Source Policy
- Raw toponym source files are local input only and should not be committed.
- Keep only `data/sources/Toponyms/README.txt` in git; source files are ignored via `.gitignore`.
- Expected local source layout:
  - `data/sources/Toponyms/<SourceGroup>/*.geojson`
  - `data/sources/Toponyms/<SourceGroup>/*.json`

### `build/Toponyms/index.json` Contract
- Top-level metadata includes `generatedAt`, `sourceRoot`, `sourceFileCount`, `itemCount`, and `sourceGroups`.
- Each `items[]` entry contains:
  - `id`, `text`, `textNormalized`
  - `sourceGroup`, `sourceFile`
  - `mapId`, `mapName` where both represent the containing source folder (e.g. `ferarris` / `Ferarris`)
  - `featureIndex`, `lon`, `lat` (centroid from geometry bounds)
- Non-essential source properties (e.g. `pixel_geometry`, bbox-like payloads) are excluded from the index.

---

## Session Update — 2026-03-06 (Parcels Dataset Cleanup)

### What Changed
- Parcel artifacts in `build/Parcels/Primitive/*.geojson` were cleaned to remove OCR text bounding polygons.
- Only actual parcel polygons are now retained (`properties.type === "parcel"`).

### Current Primitive Parcel Dataset State
- Unified file: `build/Parcels/Primitive/index.geojson`
- Feature count is now `8538` (all `parcel`).
- Previously removed from unified file: `19669` `text` features.
- `index.geojson` metadata updated accordingly:
  - `sourceCount: 8538`
  - `featureCount: 8538`

### Notes
- This cleanup was applied directly to built artifacts (not yet wired through a dedicated generator in `src/`).
- Viewer-side parcel rendering can now assume the Primitive parcel dataset is parcel-only.

---

## Session Update — 2026-03-06 (Search Index Hardening + Place Prefix)

### Toponyms Search Build (`src/toponyms.ts`)
- Builder now fails fast if:
  - no source files are found under `data/sources/Toponyms`
  - source files are found but produce zero indexed items
- `build/Toponyms/index.json` is written pretty-printed (readable diff/debug), not minified one-line JSON.

### Toponym Entry Shape Changes
- Added place-aware display/search text for disambiguation:
  - `text` now uses place prefix when available (e.g. `Aalst - Cappel`)
- Preserved original OCR token in:
  - `rawText`
- Added optional:
  - `placeName`
- `mapName` / `mapId` remain source-folder level (`Ferarris`, `Gereduceerd`) to identify dataset origin.

### Manifest Coordinates in Main Index
- `build/index.json` `index[]` entries can include `centerLon` / `centerLat`, derived from mirrored annotation geo points.
- This supports manifest search click-to-location in viewer without introducing extra files or fetches.

---

## TEMPORARY TEST — duplicate-geo-gcp passthrough (updated 2026-03-12)

**Ruled out so far**: `mask-out-of-bounds` (alone), `self-intersecting-mask` (alone), all types combined (viewer broke — root cause narrowed down).

**Current test**: Only `duplicate-geo-gcp` passes through unfixed. All other fixes (clamping, hull repair, tps downgrade) are restored and active. Only the duplicate GCP deduplication is disabled, and `duplicate-geo-gcp` is excluded from the QA blocking gate.

**Affected manifest**: `Kalken - Sectie C-D` (`550_0001_000_06385_000`) — item[0] has 1 duplicate geographic GCP.

**What was changed in `src/pipeline.ts`**:

1. **Duplicate GCP removal disabled** (`sanitizeMirroredAnnotation`) — the deduplication block is commented out. All other fixes are active.

2. **QA gate relaxed for `duplicate-geo-gcp` only** — `blockingIssuesAfterFix` filters out `duplicate-geo-gcp`; all other issue types still block the build.

**To revert** (once confirmed or ruled out):
1. In `sanitizeMirroredAnnotation`: uncomment the deduplication block (search for `[TEST: duplicate-geo-gcp passthrough]`).
2. In the QA gate: remove the `blockingIssuesAfterFix` filter line and rename it back to `issuesAfterFix` in the `if` condition and inside the `problematic` return block.
