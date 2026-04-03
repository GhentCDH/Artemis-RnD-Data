# Artemis Data Context

## 1. Overview

- Repo purpose: Bun/TypeScript data pipeline for Artemis build artifacts.
- Current branch: `master`
- Main pipeline entrypoint: `src/pipeline.ts`
- Search entrypoint: `src/toponyms.ts`
- Main published artifact: `build/index.json`

## 2. Features

- Crawls IIIF v2 collections listed in `data/sources/collections.txt`.
- Mirrors Allmaps georeferencing annotations at canvas level into `build/allmaps/canvases/`.
- Compiles IIIF manifests and collections for static hosting under `build/manifests/` and `build/collections/`.
- Produces viewer-facing layer metadata in `build/index.json` and a top-level IIIF collection in `build/collection.json`.
- Builds toponym search output in `build/Toponyms/index.json`.
- Builds Jean Massart photograph metadata in `build/Massart/index.json`.
- Includes historical parcel GeoJSON under `build/Parcels/`.

## 3. Architecture

- `src/pipeline.ts`: crawl pipeline, caching, Allmaps mirroring, QA fixes, compiled output writing.
- `src/toponyms.ts`: local toponym source ingestion and search-index generation.
- `data/sources/collections.txt`: source-of-truth list of IIIF collection URLs and `ugent://` special schemes.
- `cache/collections/` and `cache/manifests/`: fetch cache reused across runs.
- `build/`: committed output consumed by the viewer repo.

## 4. Configuration

- `LIMIT` restricts how many manifests per source are processed (`bun run crawl10`, `bun run crawl1`).
- `INCLUDE_NON_GEOREF=1` includes non-georeferenced manifests in compiled collections.
- `BUILD_BASE_URL` switches generated build URLs from relative to absolute.
- `cache/` and `build/iiif/info/` persist across runs; most other `build/` output is wiped and regenerated.
- `ugent://massart` is resolved dynamically from the UGent Primo API at crawl time.

## 5. Decisions

- Canvas-level Allmaps annotations are the authoritative annotation source; manifest-level mirroring is deprecated.
- Viewer-facing visible layers come from `renderLayers` in `build/index.json`; `layers` is for stats/debug.
- By default collections include only georeferenced manifests, even though non-georef manifests are still compiled.
- `verzamelblad` manifests are split into their own render layer when detected.
- Raw toponym source files are intentionally local-only and should not be committed.

## 6. Todos

- Re-check the known Primitief single-canvas rendering issue outside the Artemis viewer, ideally in the Allmaps viewer.
- Decide whether parcel data generation should move into a tracked script instead of remaining a one-off build artifact cleanup.
- Add a cleaner cache invalidation story; cache is currently manual.
- Add a sprite-generation build step after `build/index.json` is written.
  Goal: for each manifest in `build/index.json`, fetch a low-resolution IIIF Image API thumbnail, convert it to WebP, and write `build/sprites/<stable-manifest-id>.webp` plus `build/sprites/index.json`.
  Constraints: no GDAL, no warping, no full-resolution intermediates on disk, output small enough for GitHub Pages, intended to run in CI and publish with the rest of `build/`.
  Regeneration rule: do not rely on "file exists" skipping alone; sprite output may need to be refreshed when manifest metadata or georeferencing annotations change.
  Linking rule: sprites should be keyed by the same stable manifest identifier already present in `build/index.json`, preferably `manifestAllmapsId` when available, so the relationship is `index.json` entry -> stable manifest id -> `build/sprites/<id>.webp`.
  Index contract: `build/sprites/index.json` should map manifest ID to sprite path and should likely also include source manifest URL and/or compiled manifest path for traceability.
- Keep `CONTEXT.md` and `llm.md` aligned when pipeline behavior changes.

## 7. Bugs

- `Primitief single-canvas rendering remains unreliable`
  The data notes in `llm.md` still describe intermittent flicker and partial rendering for a small set of Primitief single-canvas manifests.
- `Massart does not surface in viewer layers yet`
  Massart metadata is built, but there are currently no Allmaps georeferencing annotations, so those items do not produce render layers.
- `Cache can preserve stale upstream data`
  There is no automatic cache invalidation for fetched collections or manifests.

## 8. Verification

- No dedicated test suite or `check` script is configured in `package.json`.
- Primary verification commands are `bun run crawl`, `bun run crawl10`, `bun run crawl1`, and `bun run buildSearch`.
- Detailed pipeline behavior and known caveats are documented more fully in `llm.md`.

## 9. Next Actions

1. Use `CONTEXT.md` for the short repo summary and `llm.md` for implementation detail.
2. Validate whether the Primitief single-canvas bug is caused by source annotations or viewer/runtime behavior.
3. Design and implement the sprite-generation step so it runs after `build/index.json`, regenerates deterministically from current manifest state, and writes `build/sprites/` plus an explicit sprite index.
