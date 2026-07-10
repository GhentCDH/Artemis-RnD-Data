# Artemis Data

TypeScript/Bun data pipeline for the Artemis viewer. It reads a versioned
`Source.zip` from Zenodo, builds viewer-ready map data, and publishes a single
`build/` tree containing layer metadata, IIIF georeferencing, raster PMTiles,
mask GeoJSON, parcel PMTiles, toponym search, image collections, the baselayer, and
the about-page configuration.

The viewer consumes the published output from this repository; the raw authoring
source is not committed here.

## Stack

- Runtime: Bun
- Language: TypeScript
- Container toolchain: GDAL/PROJ, tippecanoe, `pmtiles`, `jq`
- Main libraries: `@allmaps/analyze`, `@allmaps/annotation`,
  `@allmaps/iiif-parser`, `sharp`, `yaml`

Docker is the supported runtime because the pipeline depends on native geo
tools. There is no Python runtime in this repo.

## Normal Operation

This repository is designed to be run through the GitHub Actions workflow, not
as a regular local application. Use **Run data pipeline**
(`.github/workflows/run-pipeline.yml`) and provide the Zenodo record or draft id.
The workflow runs the containerized pipeline, restores build/cache state,
publishes the generated `build/` output to the correct branch, and records logs
and release metadata.

Local runs are mainly for debugging pipeline code or testing source changes
before creating a Zenodo draft. When running locally, provide an explicit source
tree with `ARTEMIS_SOURCE_DIR=/path/to/Source` and pass `--local-source`; a fresh
checkout does not contain `Source/`.

## Quick Start

For local debugging:

```bash
docker compose pull
docker compose up -d
docker compose exec artemis-data bash
bun install
bun run src/cli.ts help
```

Run pipeline commands from inside the container shell. To run a one-off command
from the host, prefix it with `docker compose exec artemis-data`. Local pipeline
runs should point at an extracted or authored source tree:

```bash
docker compose exec -e ARTEMIS_SOURCE_DIR=/path/to/Source artemis-data \
  bun run src/cli.ts build --local-source --no-raster
```

Stop the dev container with:

```bash
docker compose down
```

The compose service uses `ghcr.io/ghentcdh/artemis-data:latest` by default. The
GitHub Actions pipeline currently pulls `ghcr.io/ghentcdh/artemis-data:pipeline-v2`.

## Commands

```bash
bun run src/cli.ts <command> [zenodoRecordId] [layerId...] [flags]
```

| Command | Purpose |
| --- | --- |
| `build [layerId...]` | Full build: IIIF, raster/masks, toponyms, parcels, image collections, baselayer, layers registry, about config |
| `iiif [layerId...]` | Build geomaps, search, sprites, and by default raster PMTiles plus mask GeoJSON |
| `toponyms [layerId...]` | Build `toponyms.json` search indexes |
| `parcels [layerId...]` | Build parcel PMTiles |
| `imagecollections [collectionId...]` | Build non-georeferenced image collection indexes and sprites |
| `layers` | Publish the full merged `build/layers.yaml` registry |
| `about` | Publish `about.json` and attribution-logo assets |
| `baselayer` | Convert `Baselayer.geojson` to `build/baselayer.pmtiles` |
| `source:sync <recordId>` | Download, verify, and extract `Source.zip` into `.build-cache/zenodo-source/` |
| `source:validate` | Validate source structure, layer YAML, and attribution logo references before building |
| `source:draft-files <draftId>` | List files in an unpublished Zenodo draft; requires `ZENODO_TOKEN` |
| `help` | Print CLI help, flags, and environment variables |

Package aliases exist for the common commands:

```bash
bun run build
bun run iiif
bun run toponyms
bun run parcels
bun run typecheck
```

## Common Runs

These examples are for local debugging from inside the container. In normal
operation, run the GitHub workflow with the target Zenodo record or draft id.

```bash
# Full local build from an explicit source tree
ARTEMIS_SOURCE_DIR=/path/to/Source bun run src/cli.ts build --local-source

# Validate a local source tree before uploading Source.zip
ARTEMIS_SOURCE_DIR=/path/to/Source bun run src/cli.ts source:validate --local-source

# Build from local source while checking download filenames against a record
ARTEMIS_SOURCE_DIR=/path/to/Source bun run src/cli.ts build --local-source --zenodo-record 21219182

# Fast metadata iteration: skip GDAL raster warp and mask GeoJSON
ARTEMIS_SOURCE_DIR=/path/to/Source bun run src/cli.ts iiif PrimitiefKadaster --local-source --no-raster
ARTEMIS_SOURCE_DIR=/path/to/Source RASTER=0 bun run src/cli.ts iiif PrimitiefKadaster --local-source

# Build only selected layers
ARTEMIS_SOURCE_DIR=/path/to/Source bun run src/cli.ts build --local-source Ferraris Popp Vandermaelen

# Smoke-test the first IIIF manifest per source
ARTEMIS_SOURCE_DIR=/path/to/Source IIIF_LIMIT=1 bun run src/cli.ts iiif GereduceerdeKadaster --local-source

# Force cache-aware stages to rebuild
ARTEMIS_SOURCE_DIR=/path/to/Source bun run src/cli.ts build --local-source --force
ARTEMIS_SOURCE_DIR=/path/to/Source BUILD_FORCE=1 bun run src/cli.ts build --local-source
```

## Flags

| Flag | Effect |
| --- | --- |
| `--no-raster` | Skip the GDAL raster warp in `build` and `iiif`; produces geomaps/search/sprites only |
| `--force` | Bypass the incremental hash cache for cache-aware stages |
| `--local-source` | Read from `ARTEMIS_SOURCE_DIR` instead of synced `.build-cache/zenodo-source/.../Source` |
| `--zenodo-record <id>` | Use a specific Zenodo record or draft id |
| `--publish-live` | For draft records, publish as live and resolve `download:` links against the latest published version |

Positional numeric arguments are treated as the Zenodo record id. Other
positional arguments are layer or collection ids, depending on the command.

## Source Data

The authoring tree is `Source/`, but `Source/` is git-ignored. A fresh checkout
does not contain source data. Normal builds sync `Source.zip` from Zenodo into
`.build-cache/zenodo-source/<recordId>/Source` and build from that mirror.
For local debugging, point `ARTEMIS_SOURCE_DIR` at an extracted or authored
source tree and pass `--local-source`.

Expected source shape:

```text
Source/
├── about.json
├── ImageCollectionConfig.yaml
├── Baselayer.geojson
├── attribution-logos/
│   └── logos.yaml
└── layers/
    └── <LayerId>/
        ├── <LayerId>.yaml
        ├── toponyms/*.geojson
        └── parcels/*.geojson
```

Each layer YAML defines the layer label, timeframe, sublayers, source URLs,
attribution, citation, and optional `download:` filenames. Sublayer `kind`
controls what builds:

- `iiif`: georeferenced maps, geomaps/search/sprites, raster PMTiles, mask GeoJSON
- `searchable`: toponym search from generated GeoJSON
- `geojson`: generated vector data such as parcels
- `wmts` / `wms`: remote passthrough rendered by the viewer; no local artifact

`source.type` is usually `remote` for IIIF/WMTS/WMS endpoints and `generated`
for data built from `rawInput` globs.

## Zenodo Records

The pipeline source of truth is a Zenodo record or draft containing:

1. `Source.zip`: required, exact filename. This is the zip of the contents of
   `Source/`; the pipeline downloads, verifies, extracts, and builds from it.
2. Optional downloadable dataset files, such as parcel exports. The pipeline
   does not open these files; it only resolves layer `download:` filenames to
   public URLs for the viewer.

Create `Source.zip` by zipping the contents of `Source/`, not the folder itself:

```bash
cd Source
zip -rXq ../Source.zip . -x ".*" -x "*/.*"
```

Example sublayer download:

```yaml
- id: PrimitiefKadaster-parcels
  name: Parcels
  kind: geojson
  download: Primitief_Kadaster_Parcels.zip
  source:
    type: generated
    rawInput: parcels/*.geojson
```

For published records, `download:` filenames must match files in the same
Zenodo record. Missing files are build issues and block publishing. For drafts,
public file URLs cannot be verified, so downloads remain unresolved unless
`--publish-live` is used. With `--publish-live`, the build is published to the
live target and downloads are resolved against the record's latest published
version when one exists.

Use `ZENODO_TOKEN` when building from unpublished drafts or listing draft files.

## Outputs

All deployable output is written under `build/`:

```text
build/
├── Build.log
├── IIIFWarnings.log
├── BuildIssues.log
├── DownloadReminders.log
├── Sublayers.md
├── ZenodoSource.json
├── about.json
├── baselayer.pmtiles
├── imagecollection.yaml
├── attribution-logos/
├── Image collections/
│   └── <CollectionId>/
│       ├── <collection>_index.json
│       ├── <collection>_sprites.json
│       ├── <collection>_sprites.webp
│       └── hashes.txt
├── .tmp/
└── Layers/
    └── <LayerId>/
        ├── geomaps.json
        ├── search.json
        ├── hashes.txt
        ├── sprites.webp
        ├── sprites.json
        ├── toponyms.json
        ├── parcels.pmtiles
        ├── raster.pmtiles
        └── masks.geojson
```

`build/.tmp/` is scratch space and is stripped before publishing deploy output.
`.build-cache/` is a private local/CI cache and is never deployed.

Important artifacts:

- `layers.yaml`: merged viewer registry with per-sublayer artifacts,
  resolved logos, resolved downloads, and hardcoded verzamelblad splits.
- `geomaps.json`: compact Allmaps-style georeferencing metadata.
- `search.json`: manifest/canvas search and fly-to index.
- `raster.pmtiles`: warped raster XYZ pyramid packed as PMTiles.
- `masks.geojson`: per-canvas geospatial footprints.
- `parcels.pmtiles`: generated parcel vector tiles.
- `toponyms.json`: toponym search index.
- `about.json` and `attribution-logos/`: site/about metadata and shared logo assets.

## Raster And Caching

Raster generation is the slowest stage. It fetches capped IIIF source images,
warps each canvas with GDAL, cuts masks, builds an XYZ pyramid, and packs it into
PMTiles. It runs by default for `build` and `iiif`; use `--no-raster` or
`RASTER=0` while iterating on metadata.

Incremental rebuild state is stored in each layer's `build/Layers/<LayerId>/hashes.txt`.
Partial runs preserve unrelated hash categories, so a `parcels` run does not
invalidate raster hashes. Fetch and warp caches live under `.build-cache/`.

## Environment

| Variable | Purpose | Default |
| --- | --- | --- |
| `ARTEMIS_SOURCE_DIR` | Local source root used with `--local-source` | `Source` |
| `ZENODO_RECORD` | Default source record id | `21219182` |
| `ZENODO_TOKEN` | Token for unpublished Zenodo drafts | unset |
| `BUILD_FORCE` | Set `1`/`true`/`yes` to bypass incremental hashes | off |
| `BUILD_CONCURRENCY` | Concurrent manifest/source workers; explicit values are uncapped | `min(CPU, 8)` |
| `IIIF_LIMIT` | Process only the first N IIIF manifests per source | all |
| `IIIF_SPRITE_SIZE` | Long edge of generated sprites in pixels | `256` |
| `IIIF_MASK_SIMPLIFY_EPSILON` | Resource-mask simplification epsilon in image pixels | `5.5` |
| `PARCEL_SIMPLIFY_EPSILON` | Parcel simplification epsilon; pixels when `pixel_geometry` exists | `5` |
| `VECTOR_TILE_BUFFER` | Tippecanoe buffer for parcel PMTiles | `64` |
| `RASTER` | Set `0`/`false`/`no` to skip raster generation | on |
| `RASTER_FETCH_WIDTH` | Capped IIIF warp-source width in pixels | `1024` |
| `RASTER_TILE_SIZE` | Raster tile size in pixels | `512` |
| `RASTER_TILE_FORMAT` | `webp`, `png`, or `jpeg` | `webp` |
| `RASTER_MIN_ZOOM` / `RASTER_MAX_ZOOM` | Raster zoom range | `8` / `13` |
| `RASTER_WEBP_QUALITY` | WEBP quality from 1 to 100 | `75` |

## CI Publishing

`.github/workflows/run-pipeline.yml` runs the full pipeline manually from a
Zenodo record or draft id. It restores build state from the `build-cache`
branch, restores `.build-cache` entries from GitHub Actions cache, runs the
containerized pipeline, uploads logs, and publishes output.

Publish targets:

- Published Zenodo record: publish deploy output to `live`
- Unpublished Zenodo draft: publish deploy output to `draft`
- Draft with `publish_live` checked: publish deploy output to `live`, resolving
  downloads from the latest published version when available
- Build state: always updates the `build-cache` branch when publishing is allowed

The CLI exits with code `2` when the pipeline ran successfully but found
blocking content issues such as missing downloads, unknown logos, or empty
sublayers. CI keeps that run green, uploads logs, and skips publishing. IIIF
warnings are logged but do not block publication.

`.github/workflows/docker-image.yml` publishes the GHCR image when Dockerfile,
dependency, or source files change.

## Code Map

- `src/cli.ts`: CLI parsing, command dispatch, Zenodo source selection
- `src/lib/source/zenodo.ts`: Zenodo record/draft detection, `Source.zip` sync,
  checksum validation, download file indexes
- `src/lib/layers/discovery.ts`: layer YAML discovery
- `src/lib/layers/publish.ts`: `layers.yaml` merge, artifact attachment,
  logo/download resolution, build issue detection, sublayer summary
- `src/lib/iiif/**`: IIIF collection/manifest resolution, Allmaps analysis,
  geomaps/search/sprites
- `src/lib/raster/**`: IIIF image fetch, GDAL warp, XYZ tiles, masks
- `src/lib/toponyms/**`: toponym normalization and search index output
- `src/lib/parcels/build.ts`: parcel filtering, simplification, PMTiles output
- `src/lib/geojson/**`: shared geometry and simplification helpers
- `src/lib/imageCollections/**`: non-georeferenced collection indexing/sprites
- `src/lib/about/publish.ts`: about-page JSON and logo asset publication
- `src/lib/baselayer/build.ts`: baselayer PMTiles publication
- `src/lib/attribution/logos.ts`: shared logo registry and resolver
- `src/lib/pmtiles/**`: tippecanoe, MBTiles, and PMTiles shell wrappers
- `src/lib/build/**`: build logs and incremental hash registry
- `src/lib/paths.ts`: centralized source, cache, and output paths

## Related

- Viewer: `../Artemis-Viewer`
