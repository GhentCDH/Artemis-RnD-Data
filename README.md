# Artemis-RnD-Data

Compiled IIIF + Allmaps data pipeline for Artemis.

Crawls source IIIF collections, mirrors Allmaps georeferencing annotations (canvas-level), compiles manifests and collections for static hosting, and builds search artifacts used by the viewer.

## Stack

- Runtime: Bun
- Language: TypeScript
- Core dependency: `@allmaps/id`

## What It Produces

- `build/index.json`: main dataset index — layers, render layers, per-manifest entries
- `build/collection.json`: top-level IIIF v2 Collection
- `build/collections/*.json`: per-layer compiled IIIF Collections
- `build/manifests/*.json`: compiled manifests with Allmaps `otherContent` injected
- `build/allmaps/canvases/*.json`: mirrored Allmaps canvas-level annotations
- `build/iiif/info/index.json`: IIIF image info.json cache (keyed by image service URL)
- `build/Toponyms/index.json`: toponym search index
- `build/Parcels/`: historical parcel polygon data

## Quick Start

```bash
bun install
```

## Commands

```bash
# full pipeline
bun run crawl

# limited crawl (first N manifests per source)
bun run crawl10
bun run crawl1

# include non-georeferenced manifests in output
bun run crawl:all

# build toponym search index only
bun run buildSearch   # alias: bun run toponyms
```

## Inputs

- `data/sources/collections.txt`: source IIIF collection URLs (one per line)
- `data/sources/Toponyms/`: local raw toponym source files (not committed — keep only `README.txt` in git)

## Notes

- `cache/` and `build/iiif/info/` persist across runs; all other `build/` dirs are wiped and regenerated each run
- By default only georeferenced manifests are included in collections; use `INCLUDE_NON_GEOREF=1` to include all
- Set `BUILD_BASE_URL` to your GitHub Pages root to get absolute URLs in build outputs
- QA report (fixed + excluded manifests) is written to `logs/report.log` (git-ignored)

## Related Repo

- Viewer: `../Artemis-RnD`
