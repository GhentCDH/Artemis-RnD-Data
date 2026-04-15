# Artemis-RnD-Data — LLM Context

## Purpose

A Bun/TypeScript data pipeline that crawls IIIF v2 collections, mirrors Allmaps georeferencing annotations into internal cache files, and publishes bundled Artemis data under `build/`.

## Stack

- Runtime: Bun
- Language: TypeScript
- Key dependency: `@allmaps/id`

## Entrypoints

| Script | File | Description |
|---|---|---|
| `bun run dev` | `src/index.ts` | placeholder / scratch |
| `bun run crawl` | `src/pipeline.ts` | full pipeline run |
| `bun run crawl10` | `src/pipeline.ts` | pipeline with `LIMIT=10` |
| `bun run crawl1` | `src/pipeline.ts` | pipeline with `LIMIT=1` |
| `bun run crawl:all` | `src/pipeline.ts` | pipeline with `INCLUDE_NON_GEOREF=1` |
| `bun run buildSearch` | `src/toponyms.ts` | builds per-map toponym indices only |
| `bun run toponyms` | `src/toponyms.ts` | alias of `buildSearch` |

## Published Output

```
build/
  index.json
  IIIF/
    <mapId>_manifests.json
    <mapId>_info.json
    georef/<mapId>.json
  Image collections/
    Massart/index.json
  Toponyms/
    <mapId>/<mapId>Toponyms.json
  Parcels/
    <mapId>/<mapId>Parcels.geojson
```

`build/index.json` is the public entrypoint. Internal processing artifacts live in `.build-cache/`, not in `build/`.

## Pipeline Summary (`src/pipeline.ts`)

1. Read IIIF-capable sources from `data/sources/registry.json`.
2. Resolve each source collection and cache raw responses in `cache/collections/` and `cache/manifests/`.
3. Mirror canvas-level Allmaps annotations to `.build-cache/allmaps/canvases/`.
4. Run QA and auto-fixes on mirrored annotations:
   - `mask-out-of-bounds`
   - `self-intersecting-mask`
   - `duplicate-geo-gcp`
   - `tps-low-gcp`
5. Compile manifests and bundle public output per map:
   - `build/IIIF/<mapId>_manifests.json`
   - `build/IIIF/<mapId>_info.json`
   - `build/IIIF/georef/<mapId>.json`
6. Generate non-IIIF outputs:
   - `build/Image collections/Massart/index.json`
   - `build/Toponyms/<mapId>/<mapId>Toponyms.json`
   - `build/Parcels/<mapId>/<mapId>Parcels.geojson`
7. Write `logs/report.log` for QA reporting.

## Cache And Persistence

- `cache/`: persistent fetch cache, kept across runs
- `.build-cache/`: internal build cache, info.json cache, and QA artifacts
- `build/`: public output, regenerated on pipeline runs
- `logs/report.log`: QA report, git-ignored

Delete `cache/` to force remote refetches. Delete `.build-cache/` to force regeneration of internal derived artifacts.

## Directory Layout

```
data/sources/registry.json
data/sources/Toponyms/README.txt
cache/collections/
cache/manifests/
.build-cache/
  allmaps/canvases/
  iiif/info/index.json
  manifests/
logs/report.log
build/
  index.json
  IIIF/
  Image collections/
  Toponyms/
  Parcels/
src/
  pipeline.ts
  toponyms.ts
  parcels.ts
  registry.ts
scripts/
  canvas-report.mjs
  tile-report.mjs
  scrape-ugent-massart.ts
```

## Key Environment Variables

| Variable | Effect |
|---|---|
| `LIMIT=N` | Process only the first N manifests per source |
| `INCLUDE_NON_GEOREF=1` | Include non-georeferenced manifests in compiled output |
| `BUILD_BASE_URL` | Prefix published paths with an absolute base URL |

## Data Notes

- `IndexEntry` records in `build/index.json` point to bundled public artifacts, not per-manifest files.
- `georefDetectedBy` is present only for georeferenced manifests and is one of `"canvas"`, `"manifest"`, or `"both"`.
- Massart is resolved from `ugent://massart` via the UGent Primo API and published under `build/Image collections/Massart/`.
- Parcel and toponym outputs are organized per map ID.

## Current IIIF Sources

- `https://raw.githubusercontent.com/RDebrulle/AllmapsTests/refs/heads/main/Gereduceerd_Kadaster.json`
- `https://iiif.ghentcdh.ugent.be/iiif/collections/primitief_kadaster`
- `ugent://massart`

The registry also includes service-backed viewer layers and timeframe metadata, but those are not crawled as IIIF collections.

## Operational Notes

- `build/` is committed and acts as the published artifact.
- `cache/` and `.build-cache/` are local-only.
- The info cache is stored at `.build-cache/iiif/info/index.json`, keyed by image service URL.
