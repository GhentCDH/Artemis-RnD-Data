# Artemis-RnD-Data

The **v2 Artemis data pipeline**. It compiles per-layer map artifacts — IIIF
georeferencing metadata, warped raster tiles, mask/parcel vector tiles,
thumbnail sprites, toponym search indices, and non-georeferenced image
collections — into a single `build/` tree consumed by the Artemis viewer
(`../Artemis-RnD`).

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
bun run src/cli.ts <command> [zenodoRecordId] [layerId...] [--no-raster] [--force] [--local-source]
```

| Command                              | What it does                                                          |
| ------------------------------------ | --------------------------------------------------------------------- |
| `build [layerId...]`                 | Build everything: IIIF, toponyms, parcels, image collections, layer registry |
| `iiif [layerId...]`                  | Build IIIF geomaps, sprites, and (by default) raster + masks tiles    |
| `toponyms [layerId...]`              | Build toponym search JSON                                             |
| `parcels [layerId...]`               | Build parcel PMTiles                                                   |
| `imagecollections [collectionId...]` | Build non-georeferenced image collection artifacts                     |
| `layers`                             | Merge source layer config and published-file registry into `build/layers.yaml` |
| `about`                              | Publish `about.json` + attribution-logo image assets into `build/`      |
| `baselayer`                          | Publish `Baselayer.geojson` as `build/baselayer.pmtiles`               |
| `source:sync <recordId>`             | Download, verify, and extract `Source.zip` from a pinned Zenodo record into `.build-cache/zenodo-source/` |
| `help`                               | Show usage and the full flag/env reference                            |

By default, build commands sync and verify `Source.zip` from the pinned Zenodo
record, then build from `.build-cache/zenodo-source/<recordId>/Source`. With no
`layerId` arguments, a command runs over **every** discovered layer. Pass one or
more layer ids to scope a run to just those layers.

Package script aliases (`package.json`): `bun run build`, `bun run iiif`,
`bun run toponyms`, `bun run parcels`, `bun run typecheck`.

### Flags

| Flag          | Applies to     | Effect                                                             |
| ------------- | -------------- | ------------------------------------------------------------------ |
| `--no-raster` | `build`, `iiif` | Skip the GDAL raster warp — build geomaps + sprites only (fast).  |
| `--force`     | cache-aware commands | Bypass the incremental cache for that run. |
| `--local-source` | build commands | Read from local `Source/` instead of the Zenodo mirror. |
| `--zenodo-record <id>` | build commands | Explicit alternative to positional `zenodoRecordId`. |
| `--publish-live` | build commands | Publish a draft build to `live` anyway; resolves `download:` against the record's latest published version instead of leaving it unresolved. See [Publishing a draft build to live anyway](#publishing-a-draft-build-to-live-anyway). |

Anything not starting with `-` is treated as a layer id, so flags and layer ids
can be mixed in any order.

### Worked examples

```bash
# Build every layer, end to end
bun run src/cli.ts build
# or the script alias:
bun run build

# Build from a pinned Zenodo source record
bun run src/cli.ts build 21219182

# Build from local Source/ instead of Zenodo
bun run src/cli.ts build --local-source

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
bun run src/cli.ts imagecollections massart
bun run src/cli.ts layers

# Tune vector-tile overlap for parcel/mask outlines at tile borders
VECTOR_TILE_BUFFER=128 bun run src/cli.ts parcels PrimitiefKadaster
```

### Raster stage

The IIIF stage warps each georeferenced canvas with GDAL (order-1 polynomial, or
`-tps` for thin-plate-spline georeferencing), mosaics the results into an XYZ
pyramid, and packs it into `raster.pmtiles`; the per-canvas geo footprints become
`masks.pmtiles`. **The raster warp runs by default** as part of `build` and
`iiif`. It is the slow part of the pipeline, so skip it with `--no-raster` (or
`RASTER=0`) while iterating on metadata. Tune resolution/output with the
`RASTER_*` environment variables (see below). Mask PMTiles are generated by this
same stage, so changes to mask vector-tile settings require an `iiif` run with
raster enabled.

### Incremental hashes

Each layer keeps a merged `build/Layers/<LayerId>/hashes.txt` registry. Entries
are grouped by stage (`canvas`, `raster`, `toponyms`, `parcels`), so partial
runs preserve untouched categories. For example, a `parcels` run updates only
parcel hashes and leaves existing raster/mask hashes intact.

## Inputs

Authoring source root is `Source/`:

```text
Source/
├── about.json                       # site-level "about" config (title, blurb, team, logos)
├── ImageCollectionConfig.yaml      # non-georeferenced image collections
├── Baselayer.geojson                # site-wide reference boundary layer, published as pmtiles
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

## Zenodo record structure

The pipeline's actual source of truth isn't the local `Source/` folder — it's a
Zenodo record (draft or published), identified by its numeric id. That record
holds two different kinds of files:

1. **`Source.zip`** (required, exact filename) — a zip of the *contents* of the
   `Source/` tree above (`about.json`, `ImageCollectionConfig.yaml`,
   `Baselayer.geojson`, `attribution-logos/`, `layers/<LayerId>/<LayerId>.yaml`
   + their raw `parcels/`/`toponyms/` geojson). This is the **only** file the pipeline
   itself reads/extracts/builds from.
2. **Anything else** — optional, per-sublayer downloadable data for end users
   (e.g. `Primitief_Kadaster_Parcels.zip`). The pipeline never opens these; it
   only confirms they exist in the record and links to them (see below).

### Building `Source.zip`

Zip the *contents* of `Source/`, not the folder itself — the pipeline
tolerates a zip that wraps everything in one extra folder and strips common OS
junk (`__MACOSX/`, `.DS_Store`, AppleDouble `._*` files) automatically, but a
clean zip avoids depending on that:

```bash
cd Source
zip -rXq ../Source.zip . -x ".*" -x "*/.*"
```

### Linking a downloadable file to a sublayer

Add a `download:` key to a sublayer, naming a file uploaded to the **same**
Zenodo record (not inside `Source.zip` — a sibling file in the record):

```yaml
- id: PrimitiefKadaster-parcels
  name: Parcels
  kind: geojson
  download: Primitief_Kadaster_Parcels.zip   # a file in the Zenodo record, not in Source.zip
  source:
    type: generated
    rawInput: parcels/*.geojson
```

At build time, `download:` filenames are looked up against the record's file
list and resolved to a public download URL for the viewer
(`{ file, url }` in `build/layers.yaml`). A filename that doesn't match any
file in the record is **never** silently ignored — it's reported as a build
issue (see the CI job summary's "Build issues" section) and fails the build for
a published record. Sublayers that build real content but have no `download:`
at all are flagged separately, as a non-blocking reminder.

### Draft vs. published

The pipeline auto-detects whether a record id is a draft or published —
Zenodo's public API 404s for anything unpublished, so this needs no manual
flag. This changes `download:` behavior specifically:

- **Draft** — `download:` filenames can't be verified (drafts require
  authenticated access to even list their files as far as a public link is
  concerned), so they're left unresolved rather than checked or flagged. Always
  test a dataset as a draft first.
- **Published** — filenames are checked for real; a mismatch is a build issue,
  not a silent gap.

#### Publishing a draft build to live anyway

Pass `--publish-live` (workflow: check "Publish to live" on the manual run) to
publish a draft build to the `live` branch/release instead of `draft`. Since a
draft's own files aren't publicly reachable, `download:` filenames are instead
resolved against **the record's latest published version** (its most recent
prior release) rather than left unresolved. If the record has no published
version yet, downloads simply stay unresolved, same as an ordinary draft
build. The CI job summary and release notes call out whenever this fallback
was used, since the resolved links describe the previous release's files, not
necessarily this draft's.

## Outputs

Everything published lands under `build/`:

```text
build/
├── Build.log                       # per-run timings, stats, layer totals
├── IIIFWarnings.log                # analyzer warnings + applied local fixes
├── about.json                       # site-level "about" config, logos[] resolved (see below)
├── baselayer.pmtiles                # site-wide reference boundary layer
├── attribution-logos/              # logo image assets, copied as-is from Source/
│   └── <file>.png / .jpg / .webp / .svg / .gif
├── imagecollection.yaml            # published non-georeferenced collection registry
├── Image collections/
│   └── <CollectionId>/
│       ├── <collection>_index.json
│       ├── <collection>_sprites.json
│       ├── <collection>_sprites.webp
│       └── hashes.txt
├── .tmp/                           # scratch (intermediate GeoJSON, warped tiles)
│   └── <LayerId>/...
└── Layers/
    └── <LayerId>/
        ├── geomaps.json            # compact v1 georeferencing metadata
        ├── search.json             # manifest-level IIIF search/fly-to index
        ├── hashes.txt              # merged incremental-build registry
        ├── sprites.webp            # packed canvas thumbnail sheet
        ├── sprites.json            # sprite rectangles, keyed by Allmaps canvas id
        ├── toponyms.json           # toponym search index
        ├── parcels.pmtiles         # vector parcel tiles
        ├── raster.pmtiles          # warped raster tile pyramid
        └── masks.pmtiles           # per-canvas geo footprints
```

Notes:

- **`geomaps.json`** — compact v1 shape: `geomapsVersion`, `generatedAt`,
  `id`, `baseImageUrl`, shared `iiifDefaults`, and `maps[]` with image suffixes,
  dimensions, compact transformation codes, flat GCP/mask tuples, and optional
  `iiifOverrides`.
- **`search.json`** — manifest-level IIIF search index: `label`,
  `manifestUrl`, `canvasCount`, `isVerzamelblad`, and optional `lon`/`lat` +
  `bounds` for fly-to navigation.
- **`toponyms.json`** — `generatedAt`, `map`, `mapLabel`, `itemCount`, and
  `items[]`; each item has `id`, `text`, `lon`, `lat`, `map`, and optional `sheet`.
- **`parcels.pmtiles` / `masks.pmtiles`** — vector tiles built through
  tippecanoe and packed as PMTiles. A tile buffer is enabled by default to reduce
  outline artifacts at tile boundaries.
- **Image collections** — non-georeferenced browse/search artifacts written as
  plain JSON plus WEBP sprites under `build/Image collections/`.
- **Logos** — every logo reference, whether a sublayer's `attribution.logos` or
  `about.json`'s `logos[]`, resolves through the same registry
  (`attribution-logos/logos.yaml`) to the same shape:
  `{ file, href, src }` — `href` is the click-through URL, `src` is the
  deploy-root-relative path to the copied image (`attribution-logos/<file>`).
  A filename not in the registry keeps `{ file, src }` (no `href`) and is
  logged as an unknown logo. There is no second, hand-maintained copy of a
  logo's URL or image path anywhere — `logos.yaml` is the only source of truth.
- `build/` (except `.tmp/`) is the deployable public output.

## Environment Variables

| Variable                      | Purpose                                                                     | Default            |
| ----------------------------- | --------------------------------------------------------------------------- | ------------------ |
| `ARTEMIS_SOURCE_DIR`          | Local source root used with `--local-source`                                | `Source`           |
| `ZENODO_RECORD`               | Default source record id                                                    | `21219182`         |
| `BUILD_CONCURRENCY`           | Concurrent manifest/source workers. Default = `min(CPU count, 8)`; an explicit value is used as-is (uncapped) | `min(CPU, 8)` |
| `IIIF_LIMIT`                  | Process only the first N IIIF manifests per source (test runs)              | all                |
| `IIIF_SPRITE_SIZE`            | Long edge of generated sprites, px                                          | `256`              |
| `IIIF_MASK_SIMPLIFY_EPSILON`  | Resource-mask Douglas–Peucker epsilon, image px                             | `5.5`              |
| `PARCEL_SIMPLIFY_EPSILON`     | Parcel simplify epsilon (pixels when `pixel_geometry` present)              | `5`                |
| `VECTOR_TILE_BUFFER`          | Tippecanoe buffer for vector PMTiles, used by parcels and masks             | `64`               |
| `RASTER`                      | Set `0`/`false`/`no` to skip the raster warp (same as `--no-raster`)        | on                 |
| `RASTER_FETCH_WIDTH`          | Capped IIIF warp-source width, px (raise for z14+)                          | `1024`             |
| `RASTER_TILE_SIZE`            | Raster tile size, px                                                        | `512`              |
| `RASTER_TILE_FORMAT`          | Raster tile format: `webp` / `png` / `jpeg`                                 | `webp`             |
| `RASTER_MIN_ZOOM` / `_MAX_ZOOM` | Raster tile zoom range                                                    | `8`–`13`           |
| `RASTER_WEBP_QUALITY`         | WEBP tile quality, 1–100                                                    | `75`               |

## Architecture

- `src/cli.ts` — CLI entrypoint and command dispatch.
- `src/lib/layers/discovery.ts` — discovers and parses `Source/layers/<Id>/<Id>.yaml`.
- `src/lib/iiif/**` — IIIF collection/manifest resolution, annotation mirroring,
  `@allmaps/analyze` integration + mask repair, compact geomaps, and sprites.
- `src/lib/raster/**` — capped IIIF warp-source fetch, per-canvas GDAL warp with
  geo cutline, XYZ tile pyramid, and masks feature extraction.
- `src/lib/toponyms/**` — normalize, centroid, and consolidate toponym data.
- `src/lib/parcels/build.ts` — filter parcel polygons, simplify, build PMTiles.
- `src/lib/imageCollections/**` — fetch, normalize, sprite, and index
  non-georeferenced image collections.
- `src/lib/pmtiles/**` — shells out to tippecanoe / pmtiles for vector, raster,
  and xyz→mbtiles packing.
- `src/lib/build/buildLog.ts` — writes `build/Build.log` with timings and stats.
- `src/lib/build/hashRegistry.ts` — per-layer incremental hash registry with
  category-preserving partial flushes.
- `src/lib/paths.ts` — centralized input/output paths.
- `.build-cache/` — persistent fetch/analysis cache across runs (git-ignored).

## Status

Current implemented pipeline: IIIF geomaps, WEBP sprites, toponyms, parcels,
full raster warp + masks, image collections, merged `layers.yaml`, and merged
per-layer incremental hashes. The raw GeoJSON source files remain local-only, so
a fresh clone still needs those inputs before it can reproduce every artifact.

## Related

- Viewer: `../Artemis-RnD`
- Planning docs: `../DataRepoPlanning/`
