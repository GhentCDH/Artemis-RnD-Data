# Artemis-RnD-Data

Compiled IIIF + Allmaps data pipeline for Artemis.

Crawls source IIIF collections, mirrors Allmaps georeferencing annotations, bundles published artifacts per map, and builds search artifacts used by the viewer.

## Stack

- Runtime: Bun
- Language: TypeScript
- Core dependency: `@allmaps/id`

## Output Structure

The `build/` directory contains all published artifacts:

```
build/
├── index.json                           # Main entrypoint: domains, image services
├── IIIF/                                # Per-map IIIF bundles
│   ├── PrimitiefKadaster_manifests.json # Actual IIIF manifest objects
│   ├── PrimitiefKadaster_info.json      # IIIF Image API info.json responses
│   ├── PrimitiefKadaster_geomaps.json   # Georeferenced maps + inline sprite references
│   ├── GereduceerdeKadaster_manifests.json
│   ├── GereduceerdeKadaster_info.json
│   ├── PrimitiefKadaster/
│   │   └── sprites/
│   │       ├── sprites.jpg              # Shared spritesheet for all canvases in the map bundle
│   │       └── sprites.json             # Sprite positions keyed by Allmaps image ID
│   └── georef/                          # Consolidated canvas annotations
│       ├── PrimitiefKadaster.json       # Georeferencing by canvas ID
│       └── GereduceerdeKadaster.json
├── Image collections/                  # Non-georeferenced image collections
│   └── Massart/index.json              # Jean Massart photograph metadata
├── Toponyms/                           # Per-map toponym search indices
│   ├── PrimitiefKadaster/PrimitiefKadasterToponyms.json
│   └── Ferraris/FerrarisToponyms.json
└── Parcels/                            # Per-map historical parcel data
    └── PrimitiefKadaster/PrimitiefKadasterParcels.geojson
```

## Quick Start

```bash
bun install
```

## Commands

```bash
# full pipeline (all manifests)
bun run crawl

# limited crawl (first N manifests per source)
bun run crawl10   # first 10
bun run crawl1    # first 1

# include non-georeferenced manifests in output
bun run crawl:all

# build toponym search indices only
bun run buildSearch   # alias: bun run toponyms

# recommended: keep masks as-is (no simplification)
MASK_SIMPLIFY_ALGORITHM=none bun run crawl

# recommended: Douglas–Peucker simplification (epsilon 5.5)
MASK_SIMPLIFY_ALGORITHM=douglas-peucker MASK_SIMPLIFY_EPSILON=5.5 bun run crawl
```

## Inputs

- `data/sources/registry.json`: source registry for IIIF collections and service-backed layers
- `data/sources/Toponyms/`: raw toponym source files (local-only, not in git)
- `data/sources/Parcels/`: raw parcel GeoJSON files (local-only, not in git)
- `static/`: hand-edited runtime assets and metadata for the viewer

`ugent://massart` is resolved at crawl time via UGent Primo catalog API — no pre-generated file required.

## Implementation Notes

### Architecture
- `src/pipeline.ts` (main): crawl → mirror annotations → QA → compile → bundle per-map
- `src/parcels.ts`: consolidate parcel GeoJSON files per map
- `src/toponyms.ts`: filter and consolidate toponym data per map
- `cache/`: persistent fetch cache across runs
- `.build-cache/`: internal artifacts (individual canvas annotations, compiled manifests before bundling)
- `build/`: published public output

### Output Design
- **Per-map IIIF bundles**: All manifests and image service info are bundled by map for efficient bulk loading
- **Consolidated georeferencing**: Canvas annotations are consolidated in `georef/<map>.json` keyed by canvas ID
- **Spritesheets for Allmaps**: Each `IIIF/<map>/sprites/` directory contains a shared `sprites.jpg` and `sprites.json` manifest; canvas records in `*_geomaps.json` point into that shared sheet
- **No broken references**: All paths in public output are resolvable; internal canvas annotation files stay in `.build-cache/`
- **Minimal schema**: Published data includes only fields the viewer needs

### Configuration
- `LIMIT`: process first N manifests per source (e.g., `LIMIT=10 bun run crawl`)
- `INCLUDE_NON_GEOREF=1`: include non-georeferenced manifests in compiled output
- `BUILD_BASE_URL`: generate absolute URLs if hosting elsewhere

### Persistence
- `cache/`: kept across runs for efficiency
- `.build-cache/`: internal cache and QA artifacts, kept out of git
- `build/`: wiped and regenerated each full pipeline run
- QA report written to `logs/report.log` (git-ignored)

## Static Runtime Content

Files in `static/` are hand-edited and consumed directly by the viewer at runtime:

- Do not write pipeline output to `static/`
- The pipeline must not overwrite hand-edited content
- The viewer should load `static/` files directly without rerunning the pipeline
- Missing runtime metadata should fall back gracefully, not error

## Related Repo

- Viewer: `../Artemis-RnD`
