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

Each source collection URL is treated as a distinct logical source. Build outputs now expose both:
- source-level layers (`layers`)
- viewer render layers (`renderLayers`) that can split out `verzamelblad` manifests separately.

1. Reads collection URLs from `data/sources/collections.txt` (one URL per line, `#` = comment)
2. Resolves each URL into a `SourceGroup` (fetches IIIF v2 Collection, cached to `cache/collections/`); deduplication happens within each source independently
3. For each source group, processes its manifests (cached to `cache/manifests/`):
   - Generates an Allmaps ID via `@allmaps/id` from the manifest URL
   - Checks `https://annotations.allmaps.org/manifests/<id>` for georeferencing annotations (HTTP status)
   - Extracts canvas IDs from the IIIF v2 manifest and checks each at `https://annotations.allmaps.org/canvases/<canvas-id-hash>`
   - Mirrors available annotation JSONs:
     - manifest endpoint -> `build/allmaps/manifests/<id>.json`
     - canvas endpoint -> `build/allmaps/canvases/<id>.json`
   - Georef detection is now combined: `manifest OR any canvas`
   - Compiles the manifest:
     - injects `otherContent` on every canvas
     - prefers canvas-specific mirrored annotation when available
     - otherwise falls back to the mirrored manifest annotation
     - adds provenance metadata
   - Writes compiled manifest to `build/manifests/<sha1-slug>.json`
4. Writes one `build/collections/<sha1(sourceUrl)>.json` per source — a IIIF v2 Collection listing only that source's compiled manifests (this is the unit the viewer loads per layer)
5. Writes additional per-source render-layer collections:
   - `default` (non-`verzamelblad`)
   - `verzamelblad` (only manifests identified as `verzamelblad`)
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

### Viewer migration notes (important)
- Use `renderLayers` for layer toggles in the viewer.
- Keep `layers` for source-level stats/debug only.
- For georef readiness:
  - prefer `georefDetectedBy !== "none"`
  - do not rely solely on `manifestAllmapsStatus === 200` anymore.
- For special handling:
  - `isVerzamelblad === true` indicates items meant for the dedicated `verzamelblad` render layer.

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
  - manifest-level Allmaps fields: `manifestAllmapsId`, `manifestAllmapsUrl`, `manifestAllmapsStatus`, `mirroredAllmapsAnnotationPath`
  - canvas-level Allmaps fields: `canvasAllmapsHits[]` with `{ canvasId, canvasAllmapsId, canvasAllmapsUrl, canvasAllmapsStatus, mirroredAllmapsAnnotationPath }`
  - `georefDetectedBy`: `"none" | "manifest" | "canvas"`
  - `isVerzamelblad`: boolean
  - `canvasIds`
- **V2Collection / V2Manifest**: typed IIIF v2 shapes (permissive `Record<string, any>` for manifests)

## Current Data Sources

`data/sources/collections.txt` currently points to two collections:
- `https://raw.githubusercontent.com/RDebrulle/AllmapsTests/refs/heads/main/Gereduceerd_Kadaster.json` (Gereduceerd Kadaster)
- `https://iiif.ghentcdh.ugent.be/iiif/collections/primitief_kadaster` (Primitief Kadaster)

## Notes

- Cache is never invalidated automatically — delete `cache/` to force re-fetch
- Manifests without detected georeferencing are still compiled and included (unmodified) to keep the collection complete
- `verzamelblad` detection is string-based against URL/label/identifier/metadata in the source manifest; if present, it is split into a dedicated render layer.
- `build/` is committed to the repo (acts as the published artifact)
