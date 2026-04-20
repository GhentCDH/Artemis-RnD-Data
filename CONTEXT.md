# Artemis Data Context

## 1. Overview

- Repo purpose: Bun/TypeScript pipeline that compiles Artemis data artifacts for the viewer
- Main entrypoint: `src/pipeline.ts`
- Search entrypoint: `src/toponyms.ts`
- Public registry: `build/index.json`
- Related viewer repo: `../Artemis-RND/app`

## 2. Current Architecture (Implemented as of 2026-04-16, partially outdated)

### Build Output Structure

Note: the sprite layout described below reflects the current `dev` branch output, but it is not the desired final contract. See the TODOs and known issues sections for the required fixes.

```text
build/
├── index.json                                 # Entrypoint: domains, render layers, manifest registry
├── IIIF/
│   ├── PrimitiefKadaster_manifests.json       # Compiled IIIF manifest objects
│   ├── PrimitiefKadaster_info.json            # IIIF Image API info.json responses by service URL
│   ├── PrimitiefKadaster_geomaps.json         # Georeferenced maps + bundle-level sprite metadata
│   ├── PrimitiefKadaster/
│   │   └── sprites/
│   │       ├── sprites.jpg                    # Shared spritesheet for the map bundle
│   │       └── sprites.json                   # Sprite rectangles keyed by Allmaps image ID
│   ├── GereduceerdeKadaster_manifests.json
│   ├── GereduceerdeKadaster_info.json
│   ├── GereduceerdeKadaster_geomaps.json
│   └── georef/
│       ├── PrimitiefKadaster.json             # Consolidated georeferencing by canvas ID
│       └── GereduceerdeKadaster.json
├── Image collections/
│   └── Massart/
│       └── index.json                         # UGent Massart photo metadata
├── Toponyms/
│   ├── PrimitiefKadaster/
│   └── Ferraris/
└── Parcels/
    └── PrimitiefKadaster/
```

### Internal Working State

```text
cache/                                          # Persistent upstream fetch cache
.build-cache/
├── manifests/                                 # Compiled manifests before final bundling
├── iiif/                                      # Internal IIIF processing data
├── allmaps/canvases/                          # Mirrored canvas-level annotations for QA/debug
└── sprites/<mapId>/                           # Cached fetched/downscaled sprite rasters
logs/report.log                                # Annotation QA + sprite failure report
```

## 3. Pipeline Phases

### Phase A: Source Resolution

- Reads configured IIIF collections from `data/sources/registry.json`
- Resolves `ugent://massart` dynamically from the UGent Primo API
- Deduplicates manifests and applies `LIMIT` if set
- Uses `cache/` for collection and manifest fetch reuse

### Phase B: Manifest Processing

- Mirrors canvas-level Allmaps annotations into `.build-cache/allmaps/canvases/`
- Falls back to manifest-level annotation extraction when canvas-level annotation is absent
- Validates and sanitizes georeferencing
- Stores compiled manifests in `.build-cache/manifests/`
- Builds `canvasInfoIndex` keyed by normalized image service URL

### Phase C: Per-Map IIIF Bundling

For each map ID:

- writes `<mapId>_manifests.json`
- writes `<mapId>_info.json`
- writes `<mapId>_geomaps.json`
- writes `IIIF/<mapId>/sprites/sprites.jpg`
- writes `IIIF/<mapId>/sprites/sprites.json`

`*_geomaps.json` now contains:

- `generatedAt`
- `mapId`
- `sprites`: `{ image, json, imageSize, count } | null`
- `maps[]`: manifest-level entries with `id`, `label`, `isVerzamelblad`, and `canvases[]`

Each canvas entry now keeps only:

- `id`
- `canvasAllmapsId`
- `info`
- `georeferencedMap`

Per-canvas sprite rectangles are no longer duplicated inside `geomaps`; the canonical sprite rectangle data lives only in `sprites.json`.

### Phase D: Search/Parcel Artifacts

- Generates per-map toponym indices
- Consolidates parcel GeoJSON by map
- Publishes to `build/Toponyms/` and `build/Parcels/`

### Phase E: Final Registry

`build/index.json` includes:

- `generatedAt`
- `totalManifests`
- `georefManifests`
- `compiledOk`
- `domains`
- `layers`
- `renderLayers`
- `index`

## 4. Sprite Generation Contract

### Current Allmaps-Oriented Design

- Sprites are generated per map bundle, not per canvas file
- The shared spritesheet lives at `build/IIIF/<mapId>/sprites/sprites.jpg`
- The sprite manifest lives at `build/IIIF/<mapId>/sprites/sprites.json`
- `sprites.json` entries use the Allmaps render shape:
  - `imageId`
  - `scaleFactor`
  - `x`
  - `y`
  - `width`
  - `height`

### Generation Logic

- Target sprite thumbnail size is bounded by `ALLMAPS_SPRITE_MAX_SIZE = 128`
- Individual sprites are fetched from the IIIF service and cached in `.build-cache/sprites/`
- Shared sheets are packed with a simple row-based packer capped by `ALLMAPS_SPRITESHEET_MAX_WIDTH = 4096`
- Output sheet image is composed with `sharp`

### Resilience / Failure Handling

Sprite fetch attempts use:

1. IIIF resized request
2. alternative confined-size request
3. parser-generated canonical request
4. fallback full-image fetch (`full/full`, `full/max`, `native`) with local resize via `sharp`

Retry/backoff is applied for `429`, `500`, `502`, `503`, `504`.

If a canvas still cannot produce a sprite:

- it is recorded in `logs/report.log` under `Sprite failures`
- the build emits a warning
- the build does **not** fail anymore

This tolerance exists because some upstream IIIF services appear to be fundamentally inaccessible for those canvases, even outside Artemis.

## 5. Key Decisions

- **Public vs internal separation**: `build/` is publishable output; `.build-cache/` is private processing state
- **Per-map bundling**: Manifests, info responses, geomaps, and sprites are grouped by map ID
- **Single source of sprite truth**: Per-canvas sprite coordinates are stored only in `sprites.json`
- **Viewer compatibility**: The viewer resolves sprite rectangles by `georeferencedMap.resource.id`
- **Logged tolerance**: Missing sprites are tolerated only when logged explicitly
- **Massart isolation**: Massart remains under `Image collections/` because it does not use Allmaps georeferencing

## 6. Viewer-Facing Contract

The data repo currently publishes:

- `build/index.json`
- `build/IIIF/<mapId>_manifests.json`
- `build/IIIF/<mapId>_info.json`
- `build/IIIF/<mapId>_geomaps.json`
- `build/IIIF/<mapId>/sprites/sprites.jpg`
- `build/IIIF/<mapId>/sprites/sprites.json`
- `build/IIIF/georef/<mapId>.json`
- `build/Toponyms/<mapId>/<mapId>Toponyms.json`
- `build/Parcels/<mapId>/<mapId>Parcels.geojson`
- `build/Image collections/Massart/index.json`

The viewer now expects `*_geomaps.json` bundle-level sprite metadata plus `sprites.json` lookup, rather than per-canvas `allmapsSprite` duplication.

## 7. Current Constraints / Known Issues

- Some Ghent IIIF image services consistently return `502` or fail even on full-image endpoints
- Those canvases are logged as sprite failures and omitted from the spritesheet
- Cache invalidation is still manual
- Some viewer behavior still depends on layer conventions outside the pipeline
- Confirmed bug: many georeferenced entries in `build/index.json` now lose `centerLon` / `centerLat`
- Root cause: `deriveAnnotationCenter()` still expects georeferenced-map-shaped JSON with top-level `gcps`, but the pipeline now often reads raw Allmaps annotation pages from `.build-cache/allmaps/canvases/`
- Confirmed bug: Massart title normalization is too aggressive and corrupts some titles by splitting on the first colon
- Confirmed contract bug: the current shared-spritesheet output is not the required final direction; Artemis must publish one sprite image per canvas again

## 7.1 Confirmed TODOs

- Restore one sprite image per canvas in `build/IIIF/<mapId>/sprites/`; do not rely on a shared bundle spritesheet as the canonical output contract
- Update `*_geomaps.json` generation to keep per-canvas sprite references stable for the viewer
- Fix `deriveAnnotationCenter()` so `build/index.json` reliably emits `centerLon` / `centerLat` from the current annotation cache format
- Fix Massart title cleanup so it removes catalog suffix noise without truncating legitimate title text

## 8. Configuration

- `LIMIT`: process first N manifests per source
- `INCLUDE_NON_GEOREF=1`: include non-georeferenced manifests in compiled output
- `BUILD_BASE_URL`: optional absolute URL generation

## 9. Static Runtime Content

Files in `static/` are hand-maintained runtime inputs and must not be overwritten by the pipeline:

- `site.json`
- `layers.json`
- `attribution-logos/`
- `Baselayer/`

## 10. Related Repos

- Viewer: `../Artemis-RND/app`
- Workspace root: `/home/alexander/Documents/Artemis-RnD`
