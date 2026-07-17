# Artemis Data

Data pipeline for the [Artemis Viewer](https://github.com/GhentCDH/Artemis-Viewer).
It reads a versioned `Source.zip` from Zenodo and produces the map metadata,
search indexes, sprites, GeoJSON, and PMTiles consumed by the viewer.

The pipeline is written in TypeScript and runs on Bun. Docker is the supported
runtime because builds also require GDAL, PROJ, tippecanoe, and PMTiles tooling.

## Normal operation

Production builds run through the **Manual - Run data pipeline** GitHub Actions
workflow. Start it with a Zenodo record or draft ID; optional inputs can bypass
the incremental cache, skip raster generation, or publish a draft build to the
live target.

The workflow:

1. Starts with a clean `build/` output tree and restores incremental hash state.
2. Downloads and validates `Source.zip` from Zenodo.
3. Runs the pipeline in the published container image.
4. Uploads diagnostic logs and publishes a clean output snapshot.

Published Zenodo records go to `live`; unpublished drafts go to `draft` unless
`publish_live` is selected. The viewer reads the published data from
[GitHub Pages](https://ghentcdh.github.io/Artemis-Data/build).

## Local development

Start the development container:

```bash
docker compose pull
docker compose up -d
docker compose exec artemis-data bash
bun install
```

Local builds need an extracted or authored `Source/` tree. Point the pipeline to
it explicitly because source data is not committed to this repository:

```bash
ARTEMIS_SOURCE_DIR=/path/to/Source \
  bun run src/cli.ts build --local-source --no-raster
```

Useful checks:

```bash
bun run typecheck
ARTEMIS_SOURCE_DIR=/path/to/Source \
  bun run src/cli.ts source:validate --local-source
```

Stop the container with `docker compose down`.

## CLI

```bash
bun run src/cli.ts <command> [zenodo-record-or-url] [layer-id...] [flags]
```

| Command | Purpose |
| --- | --- |
| `build` | Run the complete pipeline |
| `iiif` | Build IIIF metadata, search, sprites, masks, and raster tiles |
| `toponyms` | Build place-name search indexes |
| `parcels` | Build parcel PMTiles |
| `imagecollections` | Build image collection indexes and sprites |
| `layers` | Publish the merged viewer layer registry |
| `mapservices` | Publish the map-services configuration |
| `baselayer` | Build the baselayer PMTiles |
| `source:sync` | Download and extract `Source.zip` from Zenodo |
| `source:validate` | Validate source structure and metadata |
| `source:draft-files` | List files in an unpublished Zenodo draft |
| `help` | Show all commands, flags, and environment variables |

Common flags:

- `--local-source` reads from `ARTEMIS_SOURCE_DIR` instead of Zenodo.
- `--no-raster` skips raster warping for faster metadata iteration.
- `--force` bypasses incremental hash checks.
- `--zenodo-record <id|url>` selects a record or draft explicitly.
- `--publish-live` routes a draft build to `live`.

Run `bun run src/cli.ts help` for the complete and current CLI reference.

## Source data

Zenodo records must contain a file named exactly `Source.zip`. It is an archive
of the contents of `Source/`, not the directory itself:

```text
Source/
├── map-services.yaml
├── Baselayer_Water.geojson
├── Baselayer_Border.geojson
├── imagecollections/<CollectionId>/
└── layers/<LayerId>/
```

Layer configuration describes localized metadata, citations, source endpoints,
downloadable Zenodo files, and how each sublayer is built. Image collection
configuration pairs metadata with a collection JSON file containing IIIF
manifest locations.

Create the archive with:

```bash
cd Source
zip -rXq ../Source.zip . -x ".*" -x "*/.*"
```

Published records may also contain downloadable datasets referenced by layer
configuration. Missing referenced files block publication. Accessing an
unpublished draft requires `ZENODO_TOKEN`.

## Outputs and caching

Deployable files are written to `build/`. The main outputs are:

- `layers.yaml` and `imagecollection.yaml` viewer registries
- per-layer IIIF metadata, search indexes, sprites, masks, and PMTiles
- image collection indexes and sprites
- baselayer PMTiles and build diagnostics

`build/` is treated as a clean publication snapshot. Files no longer produced
by the pipeline are therefore removed from `live` or `draft` on the next
successful publication to that target.

Incremental decisions are stored in `build/Layers/*/hashes.txt`. Larger fetch,
warp, and source caches live under `.build-cache/`; they accelerate builds but
are never deployed. Use `--force` when a cache-aware stage must be rebuilt.

## Workflows

- **Manual - Run data pipeline** builds a Zenodo record or draft and publishes
  its output.
- **OnPR - Publish pipeline image** publishes the GHCR pipeline image after
  relevant changes reach the configured branch.
- GitHub's managed Pages workflow deploys the `live` branch.

Content issues such as missing downloads or empty sublayers skip publication
while preserving logs for review. IIIF quality warnings are informational and
do not block a build.
