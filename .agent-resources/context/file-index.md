# Artemis Data file index

Use this index to locate the owner of a behavior before searching broadly.

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | CLI arguments, command dispatch, build ordering, and Zenodo source selection |
| `src/lib/paths.ts` | Canonical source, output, cache, and diagnostic paths |
| `src/lib/sourceValidation.ts` | Authored source schema and cross-file validation |
| `src/lib/source/zenodo.ts` | Record/draft detection, `Source.zip` sync, checksums, and download indexes |
| `src/lib/layers/discovery.ts` | Layer directory and YAML discovery |
| `src/lib/layers/publish.ts` | Viewer registry generation, artifact ownership, downloads, and stale-layer pruning |
| `src/lib/iiif/analysis.ts` | IIIF georeferencing analysis |
| `src/lib/iiif/manifests.ts` | IIIF collection and manifest resolution |
| `src/lib/iiif/geomaps.ts` | Compact viewer geomaps output |
| `src/lib/iiif/sprites.ts` | Layer sprite images and indexes |
| `src/lib/iiif/build.ts` | IIIF stage orchestration and hash updates |
| `src/lib/raster/fetch.ts` | IIIF image acquisition and fetch caching |
| `src/lib/raster/warp.ts` | GDAL geospatial warping |
| `src/lib/raster/tiles.ts` | Raster XYZ and PMTiles generation |
| `src/lib/raster/masks.ts` | Georeferenced mask GeoJSON generation |
| `src/lib/raster/config.ts` | Raster environment settings and defaults |
| `src/lib/toponyms/build.ts` | Place-name search index generation |
| `src/lib/toponyms/normalize.ts` | Toponym text and property normalization |
| `src/lib/parcels/build.ts` | Parcel filtering, simplification, and PMTiles output |
| `src/lib/imageCollections/build.ts` | Image collection manifests, coordinates, sprites, and registry entries |
| `src/lib/baselayer/build.ts` | Water and border baselayer PMTiles |
| `src/lib/baselayer/validate.ts` | Baselayer CRS and coordinate validation |
| `src/lib/mapServices/publish.ts` | Map-service configuration publication |
| `src/lib/pmtiles/` | Shared tippecanoe, MBTiles, and PMTiles execution helpers |
| `src/lib/build/hashRegistry.ts` | Incremental hash state and category preservation |
| `src/lib/build/buildLog.ts` | Build logs, warnings, issues, and summaries |
| `src/lib/pruneRetiredOutputs.ts` | Removal of retired root-level outputs |
| `src/lib/utils/` | Shared file, hashing, and subprocess utilities |
| `.github/workflows/run-pipeline.yml` | Manual Zenodo build, caching, diagnostics, and branch publication |
| `.github/workflows/docker-image.yml` | Pipeline container build and GHCR publication |
| `Dockerfile` | Reproducible native geospatial build environment |
| `docker-compose.yml` | Local development container |
| `INPUT_OUTPUT_MAPPING.md` | Detailed input/output, branch, and parameter reference |
| `README.md` | Concise operator and contributor guide |

Generated or local-only paths:

| Path | Responsibility |
| --- | --- |
| `Source/` | Authored or extracted input; never commit |
| `build/` | Deployable output snapshot; generated |
| `.build-cache/` | Source, fetch, analysis, and warp caches; generated |
| `node_modules/` | Installed dependencies; generated |
