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
- `build/Massart/index.json`: Jean Massart photograph metadata (title, year, location, lat/lon, manifest URL)
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

- `data/sources/collections.txt`: source IIIF collection URLs + `ugent://` special schemes (one per line)
- `data/sources/Toponyms/`: local raw toponym source files (not committed — keep only `README.txt` in git)
- `static/`: hand-edited runtime assets and metadata for the viewer; not written by the pipeline

`ugent://massart` is resolved at crawl time by querying the UGent Primo catalog API directly — no pre-generated file required.

## Notes

- `cache/` and `build/iiif/info/` persist across runs; all other `build/` dirs are wiped and regenerated each run
- By default only georeferenced manifests are included in collections; use `INCLUDE_NON_GEOREF=1` to include all
- Set `BUILD_BASE_URL` to your GitHub Pages root to get absolute URLs in build outputs
- QA report (fixed + excluded manifests) is written to `logs/report.log` (git-ignored)
- `build/index.json` now exposes stable `layerId` values on both `layers` and `renderLayers`; the viewer can use those ids to join runtime content from `static/` without rerunning preprocessing

## Static Runtime Content

- Keep manually maintained viewer content in `static/`, not in `build/`
- The pipeline must not write to `static/`
- The viewer should load files from `static/` directly at runtime and remain resilient when a `layerId` has no matching metadata yet
- Missing `static` metadata should produce a warning in development and fall back to generated labels/default copy, not a runtime error

## Related Repo

- Viewer: `../Artemis-RnD`
