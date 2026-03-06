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
cache/collections/                # disk cache for fetched collections
cache/manifests/                  # disk cache for fetched manifests
build/
  collection.json                 # top-level IIIF v2 Collection of sub-collections
  collections/<sha1>.json         # compiled IIIF v2 Collections (source-level + render-layer splits)
  index.json                      # { layers, renderLayers, index, stats } — layer lists + per-manifest metadata
  manifests/<slug>.json           # compiled manifests with Allmaps otherContent injected
  allmaps/manifests/<id>.json     # mirrored Allmaps annotation JSONs
  allmaps/canvases/<id>.json      # mirrored Allmaps canvas annotation JSONs
src/
  pipeline.ts                     # main pipeline
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
