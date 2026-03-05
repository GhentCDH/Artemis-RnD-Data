# Artemis-RnD-Data — LLM Context

## Purpose

A data pipeline that crawls IIIF v2 collections, mirrors Allmaps georeferencing annotations, and produces a compiled build suitable for hosting on GitHub Pages (or similar static hosting).

## Stack

- **Runtime**: Bun
- **Language**: TypeScript
- **Key dependency**: `@allmaps/id` — generates deterministic IDs from IIIF manifest URLs to look up annotations on `annotations.allmaps.org`

## Entrypoints

| Script | File | Description |
|---|---|---|
| `bun run dev` | `src/index.ts` | placeholder / scratch |
| `bun run crawl` | `src/pipeline.ts` | full pipeline run |
| `bun run crawl10` | `src/pipeline.ts` | pipeline with LIMIT=10 |
| `bun run crawl1` | `src/pipeline.ts` | pipeline with LIMIT=1 |

## Pipeline (`src/pipeline.ts`)

Each source collection URL is treated as a distinct **layer** — manifests from different source URLs are never mixed into a single flat list. This maps directly to separate layers in the viewer.

1. Reads collection URLs from `data/sources/collections.txt` (one URL per line, `#` = comment)
2. Resolves each URL into a `SourceGroup` (fetches IIIF v2 Collection, cached to `cache/collections/`); deduplication happens within each source independently
3. For each source group, processes its manifests (cached to `cache/manifests/`):
   - Generates an Allmaps ID via `@allmaps/id` from the manifest URL
   - Checks `https://annotations.allmaps.org/manifests/<id>` for georeferencing annotations (HTTP status)
   - If georeferenced (HTTP 200): mirrors the annotation JSON to `build/allmaps/manifests/<id>.json`
   - Compiles the manifest: injects the mirrored annotation as `otherContent` on every canvas, adds provenance metadata
   - Writes compiled manifest to `build/manifests/<sha1-slug>.json`
4. Writes one `build/collections/<sha1(sourceUrl)>.json` per source — a IIIF v2 Collection listing only that source's compiled manifests (this is the unit the viewer loads per layer)
5. Writes `build/index.json` — stats + `layers` array (one entry per source) + full flat `index` array for tooling
6. Writes `build/collection.json` — top-level IIIF v2 Collection referencing the per-source sub-collections via `collections: [...]`

### Viewer loading pattern
```
index.json            ← fetch once to enumerate layers (small)
  └─ layers[n].compiledCollectionPath
       └─ collections/<hash>.json   ← fetch per active layer
            └─ manifests[n]["@id"]
                 └─ manifests/<slug>.json  ← fetch on demand
```

## Directory Layout

```
data/sources/collections.txt      # input: one IIIF collection URL per line
cache/collections/                # disk cache for fetched collections
cache/manifests/                  # disk cache for fetched manifests
build/
  collection.json                 # top-level IIIF v2 Collection of sub-collections
  collections/<sha1>.json         # one compiled IIIF v2 Collection per source URL (= viewer layer)
  index.json                      # { layers, index, stats } — layer list + per-manifest metadata
  manifests/<slug>.json           # compiled manifests with Allmaps otherContent injected
  allmaps/manifests/<id>.json     # mirrored Allmaps annotation JSONs
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
- **IndexEntry**: per-manifest record — label, `sourceManifestUrl`, `sourceCollectionUrl`, compiled path, Allmaps ID/URL/status, canvas IDs
- **V2Collection / V2Manifest**: typed IIIF v2 shapes (permissive `Record<string, any>` for manifests)

## Current Data Sources

`data/sources/collections.txt` currently points to two collections:
- `https://raw.githubusercontent.com/RDebrulle/AllmapsTests/refs/heads/main/Gereduceerd_Kadaster.json` (Gereduceerd Kadaster)
- `https://iiif.ghentcdh.ugent.be/iiif/collections/primitief_kadaster` (Primitief Kadaster)

## Notes

- Cache is never invalidated automatically — delete `cache/` to force re-fetch
- Manifests without Allmaps georeferencing are still compiled and included (unmodified) to keep the collection complete
- `build/` is committed to the repo (acts as the published artifact)
