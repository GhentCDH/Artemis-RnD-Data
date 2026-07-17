# Input to output mapping

The pipeline reads the authored `Source/` tree (normally supplied as
`Source.zip` from Zenodo) and produces viewer-ready files in `build/`.

| Source input | What it contains | Pipeline output |
| --- | --- | --- |
| `layers/<LayerId>/<LayerId>.yaml` | Layer/sublayer metadata, localized text, source URLs, citations, downloads, and build routing | Entries in `build/layers.yaml`, including resolved Zenodo download URLs and paths to generated artifacts |
| Sublayer with `kind: iiif` | A remote IIIF collection/manifest source and its georeferencing | `geomaps.json`, `search.json`, `sprites.webp`, `sprites.json`, and, when raster building is enabled, `raster.pmtiles` plus `masks.geojson` under `build/Layers/<LayerId>/` |
| `layers/<LayerId>/toponyms/*.geojson` | Searchable place-name features | `build/Layers/<LayerId>/toponyms.json` |
| `layers/<LayerId>/parcels/*.geojson` | Parcel geometries and properties | `build/Layers/<LayerId>/parcels.pmtiles` |
| Sublayer with `kind: wmts` or `kind: wms` | A remote map-service URL | A passthrough entry in `build/layers.yaml`; no local map artifact |
| `imagecollections/<Id>/<Id>.yml` and `<Id>Collection.json` | Collection metadata, IIIF manifest URLs, and optional `[lon, lat]` coordinates | Collection index and sprite files under `build/Image collections/<Id>/`, registered in `build/imagecollection.yaml` |
| `Baselayer_Water.geojson` and `Baselayer_Border.geojson` | Site-wide water and border features in EPSG:4326 | `build/baselayer.pmtiles` with separate water and border source layers |
| `map-services.yaml` | Default background maps and overlays | `build/map-services.yaml` |

In short, `Source/` holds authoring metadata, GeoJSON, and references to remote
IIIF/map services. `build/` holds the normalized registries, search indexes,
sprites, GeoJSON masks, and PMTiles consumed by the Artemis viewer. Build caches
and temporary files live outside the published output.

## Branches

| Branch | Purpose |
| --- | --- |
| `main` | Stable pipeline code and the default branch. Completed work is merged here. |
| `dev` | Integration branch for pipeline changes before they are merged into `main`. |
| Feature/fix branches | Short-lived branches used to develop and review a specific change before merging into `dev` or `main`. |
| `live` | Generated `build/` output from a published Zenodo record. This is the production data consumed by the viewer. |
| `draft` | Generated `build/` output from an unpublished Zenodo draft, used to preview and verify data before publication. |
| `build-cache` | Pipeline-managed incremental state, mainly per-layer `hashes.txt` files and `ZenodoSource.json`, reused by later CI runs. |

`live`, `draft`, and `build-cache` are output/state branches maintained by the
GitHub Actions pipeline and should not be edited manually. A draft can be
explicitly published to `live`; in that case its download links are resolved
against the latest published Zenodo version when available.

## Pipeline parameters

The GitHub workflow exposes only `zenodo_record`, `force`, `publish_live`, and
`no_raster`. Local builds provide the wider set of CLI and environment options.

### GitHub workflow inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `zenodo_record` | `21219182` | Numeric Zenodo record/draft ID, Zenodo URL, or Zenodo DOI URL. |
| `force` | `false` | Bypass incremental hashes and rebuild cache-aware stages. |
| `publish_live` | `false` | Publish an unpublished draft to `live` instead of `draft`. |
| `no_raster` | `false` | Skip raster warp and tile generation. |

### Building from local

Use a local, extracted or authored `Source/` tree to test changes without
downloading `Source.zip` from Zenodo:

```bash
ARTEMIS_SOURCE_DIR=/path/to/Source \
  bun run src/cli.ts build --local-source
```

`--local-source` skips the Zenodo source sync and reads the directory selected
by `ARTEMIS_SOURCE_DIR`. The pipeline may still contact Zenodo to determine
whether the selected record is a draft and to validate filenames referenced by
`download:` entries; it does not fetch the source data itself.

#### CLI parameters

```text
ARTEMIS_SOURCE_DIR=/path/to/Source \
  bun run src/cli.ts <command> [zenodoRecordId|url] [layerId...] --local-source [flags]
```

For local testing, `<command>` is `build`, `iiif`, `toponyms`, `parcels`,
`imagecollections`, `layers`, `mapservices`, `baselayer`, `source:validate`, or
`help`. For layer commands, positional IDs limit the run to those layers; for
`imagecollections`, they limit it to the named collections.

| Flag | Meaning |
| --- | --- |
| `--zenodo-record <id\|url>` | Select the Zenodo record explicitly instead of using a positional value or `ZENODO_RECORD`. |
| `--force` | Bypass incremental hashes; equivalent to `BUILD_FORCE=1`. |
| `--no-raster` | Skip raster generation; equivalent to `RASTER=0`. |
| `--local-source` | Read an existing local source tree instead of syncing `Source.zip`. |
| `--publish-live` | Treat a draft build as a live publish and resolve downloads against its latest published version where possible. |

#### Local build examples

```bash
# Validate the local source tree
ARTEMIS_SOURCE_DIR=/path/to/Source \
  bun run src/cli.ts source:validate --local-source

# Build only selected layers
ARTEMIS_SOURCE_DIR=/path/to/Source \
  bun run src/cli.ts build Ferraris Popp --local-source

# Fast IIIF smoke test without raster generation
ARTEMIS_SOURCE_DIR=/path/to/Source IIIF_LIMIT=1 \
  bun run src/cli.ts iiif PrimitiefKadaster --local-source --no-raster
```

The separate `source:sync <recordId>` and `source:draft-files <draftId>` utility
commands intentionally access Zenodo and are therefore not local-build
commands.

### Pipeline environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `ZENODO_RECORD` | `21219182` | Record/draft used when none is supplied by flag or position. |
| `ZENODO_TOKEN` | unset | Access token required for unpublished Zenodo drafts. |
| `ARTEMIS_SOURCE_DIR` | `Source` | Local authoring-tree path used with `--local-source`. |
| `SOURCE_DIR` | `Source` | Legacy fallback alias for `ARTEMIS_SOURCE_DIR`. |
| `BUILD_CONCURRENCY` | CPU count, capped at `8` | Parallel manifest/source workers; any positive integer is accepted. CI sets it to `8`. |
| `BUILD_FORCE` | off | `1`, `true`, or `yes` bypasses incremental hashes. |
| `IIIF_LIMIT` | unlimited | Process only the first positive number of IIIF manifests per source; useful for smoke tests. |
| `IIIF_SPRITE_SIZE` | `256` | Maximum sprite long edge in pixels; must be positive. |
| `IIIF_MASK_SIMPLIFY_EPSILON` | `5.5` | Resource-mask simplification tolerance in image pixels; accepts zero or more. |
| `PARCEL_SIMPLIFY_EPSILON` | `5` | Parcel Douglas–Peucker tolerance, in pixels when pixel geometry is available. |
| `VECTOR_TILE_BUFFER` | `64` | Tippecanoe vector-tile buffer; accepts zero or more. |
| `RASTER` | on | `0`, `false`, or `no` disables raster generation. |
| `RASTER_FETCH_WIDTH` | `1024` | Maximum width in pixels of the fetched IIIF warp source; must be positive. |
| `RASTER_TILE_SIZE` | `512` | Raster tile size in pixels; must be positive. |
| `RASTER_TILE_FORMAT` | `webp` | Tile encoding: `webp`, `png`, or `jpeg`. |
| `RASTER_MIN_ZOOM` | `8` | Minimum raster zoom; must be positive. |
| `RASTER_MAX_ZOOM` | `13` | Maximum raster zoom; is raised to at least the selected minimum. |
| `RASTER_WEBP_QUALITY` | `75` | WEBP quality, clamped to `1`–`100`. |

### CI-only settings

These values are currently fixed in `.github/workflows/run-pipeline.yml`, not
exposed in the workflow form or read directly by the TypeScript pipeline.

| Setting | Current value | Purpose |
| --- | --- | --- |
| `IMAGE` | `ghcr.io/ghentcdh/artemis-data:pipeline-v2` | Container image that runs the pipeline. |
| `COMMAND` | `build` | CLI command invoked by CI. |
| `TIMEOUT_MINUTES` | `180` | Timeout applied to the pipeline command inside the container. |
| `BUILD_STATE_BRANCH` | `build-cache` | Branch from which incremental state is restored and to which it is republished. |
| `FORCE` | workflow `force` input | CI wrapper translated to `--force`. |
| `PUBLISH_LIVE` | workflow `publish_live` input | CI wrapper translated to `--publish-live`. |
| `NO_RASTER` | workflow `no_raster` input | CI wrapper translated to `--no-raster`. |

## Mobile behavior

This data pipeline does not produce a separate mobile build. It contains no
device detection, viewport breakpoints, touch handling, or mobile-only source
mapping. Desktop and mobile clients receive the same registries and artifacts.

| Data concern | How mobile uses it |
| --- | --- |
| Raster and vector maps | The same PMTiles files are used. The viewer requests only the tile ranges needed for the current map position and zoom. |
| Preview images | The same WebP sprite sheets and sprite indexes are used, avoiding a separate image request for every result. |
| Search | The same compact `search.json` and `toponyms.json` indexes are used. |
| Layer metadata | The same `layers.yaml`, localized labels, citations, and artifact paths are used. |
| Image collections | The same collection indexes, coordinates, and sprite sheets are used. |
| WMS/WMTS layers | The same remote service configuration is passed through to the viewer. |

Any actual mobile differences—such as layout, controls, touch gestures, result
limits, initial zoom, or when large artifacts are loaded—must be implemented in
the Artemis viewer. They cannot be configured in `Source/` or through this
pipeline's parameters. The viewer repository should be consulted to document
its exact mobile behavior.
