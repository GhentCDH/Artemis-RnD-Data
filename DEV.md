# Development

The pipeline runs on **Bun**; Docker carries the geo binary toolchain (GDAL,
tippecanoe, dezoomify-rs, pmtiles). One language, one image.

## Prerequisites

- Docker + Docker Compose
- (optional) Bun locally, if you want to run TS outside the container — but the
  geo binaries only exist inside the image.

## Build the image

```bash
docker compose build          # builds Dockerfile (dezoomify-rs + tippecanoe compile here; first build is slow)
```

## Dev shell

```bash
docker compose run --rm artemis-data          # interactive bash in /app
# inside the container:
bun install                                   # first time (into the node_modules volume)
bun run src/index.ts --help
```

The repo is bind-mounted at `/app`, so edits on the host are live in the
container. `node_modules` is a named volume so container-built native deps
(e.g. sharp) aren't clobbered by the host.

## Run the pipeline

```bash
docker compose run --rm artemis-data bun run src/index.ts build          # all layers
docker compose run --rm artemis-data bun run src/index.ts build Ferraris # one layer
```

## Verify the toolchain

```bash
docker compose run --rm artemis-data bash -lc \
  'bun --version; gdalinfo --version; tippecanoe --version; pmtiles version; dezoomify-rs --version'
```

## Layout

- `Source/` — authoring inputs (config in git; raw geojson local/ignored).
- `src/` — the pipeline (TS). `src/index.ts` is the CLI entrypoint.
- `build/` — generated output (gitignored; see DataRepoPlanning/OutputStructure.md).

## Notes

- `pmtiles` version is pinned in the Dockerfile (`PMTILES_VERSION`); bump against
  the go-pmtiles releases page if needed.
- `@allmaps/transform` will be added when the raster/georeferencing stage lands.
