# Artemis Data Context

## 1. Overview

- Repo purpose: Bun/TypeScript data pipeline for Artemis build artifacts.
- Current branch: `master`
- Main pipeline entrypoint: `src/pipeline.ts`
- Search entrypoint: `src/toponyms.ts`
- Main published artifact: `build/index.json`

## 2. Current Architecture (Implemented as of 2026-04-15)

### Build Output Structure

```
build/
├── index.json                                 # Entrypoint: domains, image services, manifest registry
├── IIIF/                                      # Per-map IIIF bundles
│   ├── PrimitiefKadaster_manifests.json       # 327 compiled IIIF manifests (actual objects)
│   ├── PrimitiefKadaster_info.json            # IIIF Image API info.json responses by service URL
│   ├── GereduceerdeKadaster_manifests.json    # 248 compiled manifests
│   ├── GereduceerdeKadaster_info.json
│   └── georef/                                # Consolidated per-canvas georeferencing
│       ├── PrimitiefKadaster.json             # {mapId, georefByCanvas: {canvasId: AnnotationPage}}
│       └── GereduceerdeKadaster.json          # 231 georeferenced canvases total
├── Image collections/                         # Non-georeferenced image collections
│   └── Massart/
│       └── index.json                         # 60 Jean Massart photograph items
├── Toponyms/                                  # Per-map toponym search indices
│   ├── PrimitiefKadaster/
│   │   └── PrimitiefKadasterToponyms.json     # 2,514 toponyms (filtered for OCR artifacts)
│   └── Ferraris/
│       └── FerrarisToponyms.json              # Filtered toponym items
└── Parcels/                                   # Per-map historical parcel data
    └── PrimitiefKadaster/
        └── PrimitiefKadasterParcels.geojson   # 28,207 GeoJSON polygons

Internal caching (.build-cache/, not in build/):
├── manifests/                                 # Compiled manifest objects (before bundling)
├── iiif/                                      # Internal IIIF processing data
└── allmaps/canvases/                          # Individual canvas annotations (QA purposes only)
    └── <id>.json                              # 423 canvas annotation files (not in public output)
```

### Design Principles

1. **Public vs. Internal**: `build/` contains all public artifacts; `.build-cache/` holds internal processing state
2. **Consolidated Bundles**: Instead of scattered files per manifest, IIIF output is bundled per-map
3. **No Broken References**: All paths in public output are resolvable; internal canvas files aren't exposed
4. **Minimal Schema**: Published data includes only fields the viewer actually needs
5. **Per-Map Organization**: Toponyms, Parcels, and Manifests are organized per map ID for clarity

## 3. Implementation Details

### Phase A: Source Resolution
- Reads from registry.json and direct IIIF/Primo APIs
- Crawls manifests, deduplicates, filters by limit (if set)
- Caches at fetch time to `cache/collections/` and `cache/manifests/`

### Phase B: Manifest Processing  
- Mirrors canvas-level Allmaps annotations to `.build-cache/allmaps/canvases/`
- For missing canvas annotations, extracts from manifest-level annotations
- Validates and sanitizes all annotations (QA step)
- Compiles manifests with pipeline metadata
- Stores compiled manifests in `.build-cache/manifests/`

### Phase C: Bundling & Publishing
- Groups manifests by map ID derived from source collection
- Generates three bundles per map:
  - `<mapId>_manifests.json`: actual manifest objects keyed by label
  - `<mapId>_info.json`: IIIF Image API responses keyed by service URL
  - `georef/<mapId>.json`: consolidated canvas annotations keyed by canvas ID
- Generates Massart index and places under `Image collections/`
- Publishes to `build/IIIF/`, `build/Image collections/`, `build/Toponyms/`, `build/Parcels/`

### Phase D: Search Artifacts
- Generates per-map toponym indices (filtered for OCR artifacts)
- Consolidates parcel GeoJSON files per map
- Publishes to respective directories

### Phase E: Publishing
- Writes `build/index.json` with:
  - `domains`: list of maps with georeferenced content
  - `imageServices`: canvas URL → image service URL mapping for all maps
  - `generatedAt`, `totalManifests`, `georefManifests`, `compiledOk`: stats

## 4. Configuration

- `LIMIT`: process first N manifests per source (e.g., `LIMIT=10 bun run crawl`)
- `INCLUDE_NON_GEOREF=1`: include non-georeferenced manifests in compiled output
- `BUILD_BASE_URL`: generate absolute URLs if hosting elsewhere

### Persistence

- `cache/`: fetch cache (kept across runs)
- `.build-cache/`: internal artifacts (wiped and regenerated each run)
- `build/`: published output (wiped and regenerated each run)
- `logs/report.log`: QA report (git-ignored)

## 5. Key Decisions

- **Canvas Annotations**: Client-side lookup from consolidated `georef/<mapId>.json` instead of individual file references
- **Map IDs**: PascalCase without spaces (PrimitiefKadaster, GereduceerdeKadaster, Ferraris, etc.)
- **Manifest Bundling**: All manifests for a map in one `<mapId>_manifests.json` file (keyed by label)
- **Georeferencing**: Consolidated by canvas ID in `<mapId>.json` under `georef/`
- **Published Data**: Only georeferenced manifests; non-georeferenced manifests are compiled internally but not exposed
- **Entrypoint**: Single `build/index.json` acts as the registry
- **Massart**: Stored under `Image collections/` since it has no Allmaps georeferencing

## 6. Search Contract

### Toponyms

- **Output location**: `build/Toponyms/<mapId>/<mapId>Toponyms.json`
- **Schema**: Minimal, with fields viewer needs:
  - `text`: toponym name
  - `lon`, `lat`: coordinates
  - `map`: map identifier (PascalCase)
  - `sheet`: source sheet/file identifier
  - `id`: optional internal identifier
- **Filtering**: Removes OCR artifacts (single letters, pure numbers, 20%+ special chars, ### patterns, 4+ repeated chars, etc.)
- **Example**: `"à Anvers"` at coordinates from sheet `1851.geojson`

### Parcels

- **Output location**: `build/Parcels/<mapId>/<mapId>Parcels.geojson`
- **Schema**: Standard GeoJSON FeatureCollection
  - Features have `type: "Feature"`, empty `properties`, and `Polygon` geometry
  - Coordinates are [lon, lat] pairs
  - Only georeferenced parcel polygons included
- **Data drop**: OCR artifacts, text polygons, confidence fields, extraction metadata
- **Example**: 28,207 polygons from Primitief Kadaster

### Image Collections (Massart)

- **Output location**: `build/Image collections/Massart/index.json`
- **Schema**: Object with:
  - `generatedAt`: ISO timestamp
  - `totalItems`: count of records
  - `coordsAvailable`: count with lat/lon
  - `items[]`: array with fields:
    - `title`, `year`, `location`, `lat`, `lon`
    - `manifestUrl`: IIIF manifest URL
    - `mmsId`, `repId`: UGent identifiers
- **Source**: Resolved dynamically from UGent Primo API (ugent://massart)

## 7. Viewer Integration

### Changed Contract from Previous Refactor

The refactor on 2026-04-15 changed the following paths:

| Previous | Current | Notes |
|----------|---------|-------|
| `build/collection.json` | removed | Not used by viewer |
| `build/collections/*.json` | `build/IIIF/<map>_manifests.json` | Consolidated per-map |
| `build/manifests/*.json` | removed | Manifests now in consolidated bundles |
| `build/allmaps/canvases/*.json` | `build/IIIF/georef/<map>.json` | Canvas annotations consolidated per-map |
| `build/iiif/info/index.json` | `build/IIIF/<map>_info.json` | Split per-map |
| `build/Toponyms/index.json` | `build/Toponyms/<map>/<map>Toponyms.json` | Split per-map |
| `build/Parcels/Primitive/index.geojson` | `build/Parcels/PrimitiefKadaster/PrimitiefKadasterParcels.geojson` | PascalCase naming |
| `build/Massart/index.json` | `build/Image collections/Massart/index.json` | Moved out of root |

### Current Viewer Consumption

The viewer still uses:
- `build/index.json`: entrypoint (required)
- `build/IIIF/<map>_manifests.json`: manifest objects per map (computed via hardcoded map label matching)
- `build/IIIF/georef/<map>.json`: canvas-level georeferencing (client-side lookup via canvas ID)
- `build/Toponyms/<map>/<map>Toponyms.json`: toponym search (if implemented)
- `build/Parcels/Primitive/PrimitiefParcels.geojson`: parcel display (hardcoded path — not yet updated)
- `build/Image collections/Massart/index.json`: Massart photos
- `static/site.json`, `static/layers.json`: runtime metadata (hand-edited, not written by pipeline)

### Known Limitations

- **Hardcoded Paths**: Viewer still uses hardcoded path `build/Parcels/Primitive/` instead of `PrimitiefKadaster/`
- **Layer Matching**: Viewer matches maps by hardcoded label matching (e.g., "Primitief Kadaster") rather than explicit layer IDs
- **Service-Backed Layers**: Ferraris, Villaret, Popp, etc. still hardcoded in viewer (not data-driven)
- **Massart Rendering**: Massart items have no Allmaps annotations, so they don't produce render layers

## 8. Known Issues

- **Primitief Single-Canvas Rendering**: Intermittent flicker for a small set of single-canvas manifests
- **Cache Staleness**: No automatic cache invalidation for upstream collections/manifests
- **Hardcoded Viewer Paths**: Some paths are still hardcoded in viewer and need manual updates

## 9. Future Work

- **Sprite Generation**: Add sprite-generation step for per-map raster layers
- **Viewer Updates**: Update viewer to use new path structure (especially Parcels)
- **Service-Backed Layers**: Move WMTS/WMS layer definitions from viewer hardcode to registry
- **Timeline Integration**: Add timeframe metadata to enable viewer timeline features
- **Parcel Sublayers**: Implement Gereduceerd and Hand drawn parcels
- **Cache Strategy**: Add automatic cache invalidation

## 10. Static Runtime Content

Files in `static/` are hand-edited and consumed directly by the viewer at runtime:

- `site.json`: site title, info text, attribution, logo references
- `layers.json`: runtime metadata keyed by viewer layer identifiers  
- `attribution-logos/`: image assets referenced from `site.json`
- `Baselayer/`: manually maintained baselayer geometry

The pipeline must NOT write to `static/`. The viewer loads these files directly without rerunning the pipeline.

## 11. Related Repos

- Viewer: `../Artemis-RnD`
- Specs: `/home/alexander/Documents/Artemis-RnD/` (external reference documents)
