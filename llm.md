# Artemis-RnD-Data — LLM Context

## Purpose

A data pipeline that crawls IIIF v2 collections, mirrors Allmaps georeferencing annotations (canvas-level), and produces a compiled build suitable for hosting on GitHub Pages (or similar static hosting).

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
| `bun run crawl:all` | `src/pipeline.ts` | pipeline with INCLUDE_NON_GEOREF=1 |
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
   - Extracts canvas IDs from the IIIF v2 manifest and checks **each canvas** at `https://annotations.allmaps.org/canvases/<canvas-id-hash>`
   - Mirrors available annotation JSONs to `build/allmaps/canvases/<id>.json` (canvas-level only — manifest-level mirroring is deprecated)
   - **Annotation source priority**: canvas endpoints are the sole source. `georefDetectedBy` is set to `"canvas"`, `"manifest"`, or `"both"` when georeferencing is detected.
   - **QA gate**: Analyzes mirrored annotations for issues; applies auto-fixes; skips manifest if issues persist after fixing:
     - `mask-out-of-bounds` — resource mask points outside image bounds (clamp fix)
     - `self-intersecting-mask` — polygon has self-intersections (convex hull fallback)
     - `duplicate-geo-gcp` — duplicate geographic control points (deduplication fix, confirmed root cause of viewer rendering failures)
     - `tps-low-gcp` — thinPlateSpline with <5 GCPs (downgrade to polynomial)
   - Compiles the manifest: injects `otherContent` on every georeffed canvas pointing to its mirrored annotation
   - **All manifests are compiled** (georef or not). Non-georef manifests are compiled unmodified. Collections only include entries with a compiled manifest path.
   - Writes compiled manifest to `build/manifests/<sha1-slug>.json`
4. Writes one `build/collections/<sha1(sourceUrl)>.json` per source — a IIIF v2 Collection listing only that source's compiled (georef) manifests
5. Writes per-source render-layer collections (up to 2 per source):
   - `default` — all non-`verzamelblad` entries
   - `verzamelblad` — entries identified as verzamelblad
   - Empty layers are skipped
6. Writes `build/index.json` — stats + `layers` + `renderLayers` + full flat `index` array for tooling
7. Writes `build/collection.json` — top-level IIIF v2 Collection referencing render-layer sub-collections
8. Writes `logs/report.log` — QA report (fixed + excluded manifests); git-ignored

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
- For georef readiness: use `georefDetectedBy` being present/truthy. Do not rely solely on `manifestAllmapsStatus` — that field no longer exists on `IndexEntry`.
- `isVerzamelblad === true` → entry belongs to the `verzamelblad` visible render layer.
- `renderLayers` contains only visible UI layers (`default`, `verzamelblad`).
- Per-entry `annotSource` (`"single"` / `"multi"`) and counts on each layer carry canvas-count information — no separate sub-layer collection files are needed.
- The compiled manifest already has `otherContent` on every canvas pointing to the correct mirrored annotation — the viewer does not need `annotSource` for rendering, it just follows `otherContent`.
- Build output dirs (`build/manifests/`, `build/collections/`, `build/allmaps/canvases/`) are wiped at the start of each pipeline run. Only `cache/` and `build/iiif/info/` persist across runs.

## Directory Layout

```
data/sources/collections.txt      # input: one IIIF collection URL per line
data/sources/Toponyms/README.txt  # note about local-only toponym source files
cache/collections/                # disk cache for fetched collections
cache/manifests/                  # disk cache for fetched manifests
logs/
  report.log                      # QA report (fixed + excluded manifests) — git-ignored
build/
  collection.json                 # top-level IIIF v2 Collection of sub-collections
  collections/<sha1>.json         # compiled IIIF v2 Collections (source-level + render-layer splits)
  index.json                      # { layers, renderLayers, index, stats } — layer lists + per-manifest metadata
  Toponyms/index.json             # toponym search index for viewer/GitHub Pages
  Parcels/                        # historical parcel polygon data
  manifests/<slug>.json           # compiled manifests with Allmaps otherContent injected
  allmaps/canvases/<id>.json      # mirrored Allmaps canvas annotation JSONs (canvas-level only)
  iiif/info/index.json            # IIIF image info.json cache — keyed by image service URL; NOT wiped between runs
src/
  pipeline.ts                     # main pipeline
  toponyms.ts                     # toponym search index builder
  index.ts                        # placeholder
scripts/
  canvas-report.mjs               # analysis: canvas pixel dimensions
  tile-report.mjs                 # analysis: IIIF tile config + estimated tile counts
```

**Deprecated / removed**: `build/allmaps/manifests/` — manifest-level annotation mirroring is gone; annotations are canvas-level only.

## Key Environment Variables

| Variable | Effect |
|---|---|
| `LIMIT=N` | Process only the first N manifests **per source** |
| `INCLUDE_NON_GEOREF=1` | Also compile and include non-georeferenced manifests in collections |
| `BUILD_BASE_URL` | Prefix for absolute URLs in compiled manifests/collections (e.g. GitHub Pages root) |

## Data Types

- **SourceGroup**: `{ sourceCollectionUrl, sourceCollectionLabel, refs[] }` — one per source URL
- **CanvasAnnotationHit**: `{ canvasId, canvasAllmapsId, mirroredAllmapsAnnotationPath }` — one entry per georeffed canvas
- **IndexEntry**: per-manifest record including:
  - `label`, `sourceManifestUrl`, `sourceCollectionUrl`
  - `compiledManifestPath` — `build/manifests/<slug>.json` (relative to build/); empty string when non-georef and not included
  - `canvasCount`, `isVerzamelblad`
  - Present only for georef manifests:
    - `centerLon?`, `centerLat?` — optional map center derived from mirrored canvas annotation geo points
    - `manifestAllmapsId?` — Allmaps ID for the manifest
    - `canvasAllmapsHits?`: `CanvasAnnotationHit[]` — per-canvas georef hits
    - `georefDetectedBy?`: `"canvas" | "manifest" | "both"` — how georef was detected
    - `annotSource?`: `"single" | "multi"` — single-canvas or multi-canvas georeffed manifest
- **renderLayerMeta entry** fields:
  - `renderLayerKey`: `"default" | "verzamelblad"`
  - `manifestCount`, `georefCount`, `singleCanvasGeorefCount`, `multiCanvasGeorefCount`
- **index.json top-level** fields: `generatedAt`, `totalManifests`, `georefManifests`, `compiledOk`, `layers`, `renderLayers`, `index`
  - Note: `mirroredOk`, `fixedManifests`, `problematicManifests` are **not** in `index.json` — QA data goes to `logs/report.log` only
- **V2Collection / V2Manifest**: typed IIIF v2 shapes (permissive `Record<string, any>` for manifests)

## Current Data Sources

`data/sources/collections.txt` currently points to two collections:
- `https://raw.githubusercontent.com/RDebrulle/AllmapsTests/refs/heads/main/Gereduceerd_Kadaster.json` (Gereduceerd Kadaster)
- `https://iiif.ghentcdh.ugent.be/iiif/collections/primitief_kadaster` (Primitief Kadaster)

## Notes

- Cache is never invalidated automatically — delete `cache/` to force re-fetch
- Manifests without detected georeferencing are compiled but not included in collections by default (use `INCLUDE_NON_GEOREF=1` to include them)
- `verzamelblad` detection is string-based against URL/label/identifier/metadata in the source manifest; if present, it is split into a dedicated render layer
- `build/` is committed to the repo (acts as the published artifact); `logs/` is git-ignored
- `build/iiif/info/index.json` is keyed by image service base URL (trailing slash stripped) — this matches `wm.georeferencedMap?.resource?.id` in the viewer for a direct lookup. On startup the pipeline migrates any legacy entries that were keyed by canvas URL (containing `/canvas/`).

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

---

## Toponym Search Build (`src/toponyms.ts`)

Builds `build/Toponyms/index.json` from local GeoJSON/JSON source files under `data/sources/Toponyms/`. Run with `bun run buildSearch` (alias: `bun run toponyms`). Independent from `crawl`.

**Source policy**: Raw toponym source files are local-only and must not be committed. Only `data/sources/Toponyms/README.txt` is in git.

**`build/Toponyms/index.json` contract**:
- Top-level metadata: `generatedAt`, `sourceRoot`, `sourceFileCount`, `itemCount`, `sourceGroups`
- Each `items[]` entry: `id`, `text` (place-prefixed when available, e.g. `Aalst - Cappel`), `textNormalized`, `rawText`, `placeName?`, `sourceGroup`, `sourceFile`, `mapId`, `mapName`, `featureIndex`, `lon`, `lat`

---

## Parcel Dataset (`build/Parcels/`)

- `build/Parcels/Primitive/index.geojson` — unified parcel dataset, parcel polygons only (`properties.type === "parcel"`)
- Feature count: 8538 (text bounding polygons removed in cleanup)
- Viewer-side parcel rendering can assume Primitive parcel dataset is parcel-only
- No dedicated generator in `src/` yet — this was a one-time cleanup on build artifacts

---

## Root Cause Finding — duplicate-geo-gcp (confirmed 2026-03-12)

Testing across all annotation issue types identified `duplicate-geo-gcp` as the root cause of viewer rendering failures. The pipeline's deduplication fix (removing GCPs with identical geographic coordinates) resolves the issue. All fixes and the QA gate are fully restored.

---

## Session Update — 2026-03-19 (IndexEntry Refactor + Pipeline Simplification)

### What Changed

**`IndexEntry` type simplified**:
- Removed fields: `canvasIds`, `manifestAllmapsUrl`, `manifestAllmapsStatus`, `mirroredAllmapsAnnotationPath` (manifest-level path)
- Extracted `CanvasAnnotationHit` as a separate type: `{ canvasId, canvasAllmapsId, mirroredAllmapsAnnotationPath }` (no longer includes `canvasAllmapsUrl` or `canvasAllmapsStatus`)
- Georef-specific fields (`manifestAllmapsId`, `canvasAllmapsHits`, `georefDetectedBy`, `annotSource`, `centerLon`, `centerLat`) are now **optional** — only present on georef manifests
- `georefDetectedBy` type changed from `"none" | "manifest" | "canvas"` to `"canvas" | "manifest" | "both"` (absence means not georef)
- `annotSource` type changed from `"single" | "multi" | "none"` to `"single" | "multi"` (absence means not georef)
- `compiledManifestPath` is empty string `""` when non-georef and not included

**Manifest mirroring simplified — canvas-level only**:
- `build/allmaps/manifests/` is fully removed (wiped each run); manifest-level annotation mirroring is deprecated
- `compileV2ManifestAttachOtherContent` no longer takes a manifest annotation path
- All manifests are compiled regardless of georef status; collections only reference entries with a compiled path

**`deriveAnnotationCenter` simplified**:
- No longer prefers manifest annotation over canvas annotations
- Now merges all canvas annotation paths directly

**QA report moved out of build/**:
- Report written to `logs/report.log` (git-ignored) instead of `build/report.log`
- `fixedManifests` and `problematicManifests` arrays removed from `index.json`
- `mirroredOk` stat removed from `index.json`

**info.json cache key correction**:
- `build/iiif/info/index.json` is now consistently keyed by image service URL (not canvas URL)
- `existingCanvasInfoIds` set tracks service keys (not canvas IDs) to avoid redundant fetches
- Migration logic on startup removes legacy entries keyed by canvas URL (containing `/canvas/`)
