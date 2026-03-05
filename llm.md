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

1. Reads collection URLs from `data/sources/collections.txt` (one URL per line, `#` = comment)
2. Fetches the IIIF v2 Collection JSON (cached to `cache/collections/`)
3. For each manifest in the collection (cached to `cache/manifests/`):
   - Generates an Allmaps ID via `@allmaps/id` from the manifest URL
   - Checks `https://annotations.allmaps.org/manifests/<id>` for georeferencing annotations (HTTP status)
   - If georeferenced (HTTP 200): mirrors the annotation JSON to `build/allmaps/manifests/<id>.json`
   - Compiles the manifest: injects the mirrored annotation as `otherContent` on every canvas, adds provenance metadata
   - Writes compiled manifest to `build/manifests/<sha1-slug>.json`
4. Writes `build/index.json` — full index with stats and per-manifest metadata
5. Writes `build/collection.json` — IIIF v2 Collection pointing to compiled manifests

## Directory Layout

```
data/sources/collections.txt   # input: one IIIF collection URL per line
cache/collections/             # disk cache for fetched collections
cache/manifests/               # disk cache for fetched manifests
build/
  collection.json              # compiled IIIF v2 Collection (publishable)
  index.json                   # metadata index (stats + per-manifest entries)
  manifests/<slug>.json        # compiled manifests with Allmaps otherContent injected
  allmaps/manifests/<id>.json  # mirrored Allmaps annotation JSONs
src/
  pipeline.ts                  # main pipeline
  index.ts                     # placeholder
```

## Key Environment Variables

| Variable | Effect |
|---|---|
| `LIMIT=N` | Process only the first N manifests |
| `BUILD_BASE_URL` | Prefix for absolute URLs in compiled manifests/collection (e.g. GitHub Pages root) |

## Data Types

- **IndexEntry**: per-manifest record in `build/index.json` — label, source URL, compiled path, Allmaps ID/URL/status, canvas IDs
- **V2Collection / V2Manifest**: typed IIIF v2 shapes (permissive `Record<string, any>` for manifests)

## Current Data Source

`data/sources/collections.txt` currently points to:
`https://raw.githubusercontent.com/RDebrulle/AllmapsTests/refs/heads/main/Gereduceerd_Kadaster.json`
(a Belgian cadastral map collection)

## Notes

- Cache is never invalidated automatically — delete `cache/` to force re-fetch
- Manifests without Allmaps georeferencing are still compiled and included (unmodified) to keep the collection complete
- `build/` is committed to the repo (acts as the published artifact)
