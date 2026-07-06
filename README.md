# Artemis-RnD-Data

The **v2 Artemis data pipeline**. It compiles per-layer map artifacts — IIIF
georeferencing metadata, warped raster tiles, mask/parcel vector tiles, thumbnail
sprites, and toponym search indices — into a single `build/` tree consumed by the
Artemis viewer (`../Artemis-RnD`).

One runtime, one language: **Bun + TypeScript**. Docker exists only to carry the
geo binary toolchain (GDAL, tippecanoe, pmtiles), not a second app runtime. There
is no Python in this repo.

## Stack

- Runtime: **Bun**
- Language: **TypeScript**
- Binary tools (via Docker): `gdal-bin`, `proj-bin`, `tippecanoe`, `pmtiles`
- Key libraries: `@allmaps/analyze`, `@allmaps/annotation`, `@allmaps/iiif-parser`, `sharp`, `yaml`

## Setup

The pipeline needs GDAL, tippecanoe, and pmtiles, so it always runs inside the
prebuilt Docker image (`ghcr.io/ghentcdh/artemis-data`, which bundles them with
Bun). Get a shell in the container:

```bash
docker compose pull                     # fetch the image
docker compose up -d                    # start the container (stays running)
docker compose exec artemis-data bash   # shell into it
bun install                             # first time only
```

**Run every pipeline command below from inside that container shell.** Stop the
container with `docker compose down` when you're done. To run a single command
without keeping a shell open, prefix it with `docker compose exec artemis-data`
(e.g. `docker compose exec -e RASTER=0 artemis-data bun run src/cli.ts iiif Popp`).

## Running the pipeline

Inside the container shell:

```bash
bun run src/cli.ts <command> [layerId...] [--no-raster]
```

| Command                              | What it does                                                          |
| ------------------------------------ | --------------------------------------------------------------------- |
| `build [layerId...]`                 | Build everything (IIIF + toponyms + parcels) for all or the given layers |
| `iiif [layerId...]`                  | Build IIIF geomaps, sprites, and (by default) raster + masks tiles    |
| `toponyms [layerId...]`              | Build Brotli-compressed toponym search JSON                           |
| `parcels [layerId...]`               | Build parcel PMTiles                                                   |
| `help`                               | Show usage and the full flag/env reference                            |

With no `layerId` arguments, a command runs over **every** discovered layer.
Pass one or more layer ids to scope a run to just those layers.

Package script aliases (`package.json`): `bun run build`, `bun run iiif`,
`bun run toponyms`, `bun run parcels`, `bun run typecheck`.

### Flags

| Flag          | Applies to     | Effect                                                             |
| ------------- | -------------- | ------------------------------------------------------------------ |
| `--no-raster` | `build`, `iiif` | Skip the GDAL raster warp — build geomaps + sprites only (fast).  |

Anything not starting with `-` is treated as a layer id, so flags and layer ids
can be mixed in any order.

### Worked examples

```bash
# Build every layer, end to end (IIIF + raster + toponyms + parcels)
bun run src/cli.ts build
# or the script alias:
bun run build

# Build a single layer, all stages
bun run src/cli.ts build PrimitiefKadaster

# Build a few layers
bun run src/cli.ts build Ferraris Popp Vandermaelen

# Fast metadata iteration — geomaps + sprites, skip the raster warp
bun run src/cli.ts iiif PrimitiefKadaster --no-raster
RASTER=0 bun run src/cli.ts iiif PrimitiefKadaster        # equivalent

# Smoke test — only the first IIIF manifest per source
IIIF_LIMIT=1 bun run src/cli.ts iiif GereduceerdeKadaster

# Higher-resolution raster tiles (wider warp source + deeper zoom)
RASTER_FETCH_WIDTH=2048 RASTER_MAX_ZOOM=14 bun run src/cli.ts iiif Popp

# Single-stage runs
bun run src/cli.ts toponyms Ferraris
bun run src/cli.ts parcels PrimitiefKadaster

# Also emit uncompressed .json next to .json.br for inspection
WRITE_PLAIN_JSON=1 bun run src/cli.ts iiif Ferraris --no-raster
```

### Raster stage

The IIIF stage warps each georeferenced canvas with GDAL (order-1 polynomial, or
`-tps` for thin-plate-spline georeferencing), mosaics the results into an XYZ
pyramid, and packs it into `raster.pmtiles`; the per-canvas geo footprints become
`masks.pmtiles`. **The raster warp runs by default** as part of `build` and
`iiif`. It is the slow part of the pipeline, so skip it with `--no-raster` (or
`RASTER=0`) while iterating on metadata. Tune resolution/output with the
`RASTER_*` environment variables (see below).

## Inputs

Authoring source root is `Source/`:

```text
Source/
├── site.json                       # site-level config
├── ImageCollectionConfig.yaml      # non-georeferenced image collections
├── Baselayer.geojson
├── attribution-logos/              # logo image files + logos.yaml
└── layers/
    └── <LayerId>/
        ├── <LayerId>.yaml          # layer config (source of truth), in git
        ├── toponyms/*.geojson      # raw toponym source — local only, git-ignored
        └── parcels/*.geojson       # raw parcel source — local only, git-ignored
```

Each `<LayerId>.yaml` is the source of truth for the layer's label, timeframe,
sublayers, source URLs, attribution, and citation. A sublayer's `kind`
(`iiif` / `geojson` / `searchable`) and `source` (`remote` / `generated` /
`planned`) select which build stage consumes it.

Committed layers: `Ferraris`, `Frickx`, `GereduceerdeKadaster`,
`HanddrawnCollection`, `NGI1873`, `NGI1904`, `Popp`, `PrimitiefKadaster`,
`Vandermaelen`, `Villaret`.

> **Git policy:** `Source/**/*.geojson` is ignored so large raw geodata stays
> local. A fresh clone cannot reproduce every output without obtaining those raw
> inputs separately.

## Outputs

Everything published lands under `build/`:

```text
build/
├── Build.log                       # per-run timings, stats, layer totals
├── IIIFWarnings.log                # analyzer warnings + applied local fixes
├── .tmp/                           # scratch (intermediate GeoJSON, warped tiles)
│   └── <LayerId>/...
└── Layers/
    └── <LayerId>/
        ├── geomaps.json.br         # compact v1 georeferencing metadata
        ├── sprites.jpg             # packed canvas thumbnail sheet
        ├── sprites.json.br         # sprite rectangles, keyed by Allmaps canvas id
        ├── toponyms.json.br        # toponym search index
        ├── parcels.pmtiles         # vector parcel tiles
        ├── raster.pmtiles          # warped raster tile pyramid
        └── masks.pmtiles           # per-canvas geo footprints
```

Notes:

- **`geomaps.json.br`** — compact v1 shape: `geomapsVersion`, `generatedAt`,
  `id`, `baseImageUrl`, shared `iiifDefaults`, and `maps[]` with image suffixes,
  dimensions, compact transformation codes, flat GCP/mask tuples, and optional
  `iiifOverrides`.
- **`toponyms.json.br`** — `generatedAt`, `map`, `mapLabel`, `itemCount`, and
  `items[]`; each item has `id`, `text`, `lon`, `lat`, `map`, and optional `sheet`.
- **Brotli-only by default.** Set `WRITE_PLAIN_JSON=1` to also emit uncompressed
  `.json` next to each `.json.br` for inspection.
- `build/` (except `.tmp/`) is the deployable public output.

## Environment Variables

| Variable                      | Purpose                                                                     | Default            |
| ----------------------------- | --------------------------------------------------------------------------- | ------------------ |
| `BUILD_CONCURRENCY`           | Concurrent manifest/source workers. Default = `min(CPU count, 8)`; an explicit value is used as-is (uncapped) | `min(CPU, 8)` |
| `IIIF_LIMIT`                  | Process only the first N IIIF manifests per source (test runs)              | all                |
| `IIIF_SPRITE_SIZE`            | Long edge of generated sprites, px                                          | `256`              |
| `IIIF_MASK_SIMPLIFY_EPSILON`  | Resource-mask Douglas–Peucker epsilon, image px                             | `5.5`              |
| `PARCEL_SIMPLIFY_EPSILON`     | Parcel simplify epsilon (pixels when `pixel_geometry` present)              | `5`                |
| `RASTER`                      | Set `0`/`false`/`no` to skip the raster warp (same as `--no-raster`)        | on                 |
| `RASTER_FETCH_WIDTH`          | Capped IIIF warp-source width, px (raise for z14+)                          | `1024`             |
| `RASTER_TILE_SIZE`            | Raster tile size, px                                                        | `512`              |
| `RASTER_TILE_FORMAT`          | Raster tile format: `webp` / `png` / `jpeg`                                 | `webp`             |
| `RASTER_MIN_ZOOM` / `_MAX_ZOOM` | Raster tile zoom range                                                    | `8`–`13`           |
| `RASTER_WEBP_QUALITY`         | WEBP tile quality, 1–100                                                    | `75`               |
| `WRITE_PLAIN_JSON`            | Also write uncompressed `.json` alongside `.json.br`                        | off                |

## Architecture

- `src/cli.ts` — CLI entrypoint and command dispatch.
- `src/lib/layers/discovery.ts` — discovers and parses `Source/layers/<Id>/<Id>.yaml`.
- `src/lib/iiif/**` — IIIF collection/manifest resolution, annotation mirroring,
  `@allmaps/analyze` integration + mask repair, compact geomaps, and sprites.
- `src/lib/raster/**` — capped IIIF warp-source fetch, per-canvas GDAL warp with
  geo cutline, XYZ tile pyramid, and masks feature extraction.
- `src/lib/toponyms/**` — normalize, centroid, and consolidate toponym data.
- `src/lib/parcels/build.ts` — filter parcel polygons, simplify, build PMTiles.
- `src/lib/pmtiles/**` — shells out to tippecanoe / pmtiles for vector, raster,
  and xyz→mbtiles packing.
- `src/lib/build/buildLog.ts` — writes `build/Build.log` with timings and stats.
- `src/lib/paths.ts` — centralized input/output paths.
- `.build-cache/` — persistent fetch/analysis cache across runs (git-ignored).

## Status

This branch (`pipeline-v2`) is an active migration. Implemented: IIIF geomaps,
sprites, toponyms, parcels, and the full raster warp + masks stage. Still pending:
a slim `build/index.json(.br)`. See `CONTEXT.md` for the detailed handoff and
planned output contract.

## Related

- Viewer: `../Artemis-RnD`
- Planning docs: `../DataRepoPlanning/`
