# Artemis Data context

## Responsibility

Artemis Data is a TypeScript/Bun preprocessing pipeline. It reads an authored
`Source/` tree, normally delivered as `Source.zip` in Zenodo, and generates the
static registries and artifacts consumed by Artemis Viewer.

The repository owns data normalization, validation, IIIF processing, search
indexes, sprites, GeoJSON, and PMTiles. Viewer layout and interaction behavior
belong in Artemis Viewer.

## Runtime and entry points

- Docker is the supported runtime because builds require GDAL, PROJ,
  tippecanoe, PMTiles tooling, and Bun.
- `src/cli.ts` parses commands and coordinates builds.
- `src/lib/source/zenodo.ts` handles records, drafts, `Source.zip`, and download
  resolution.
- `src/lib/layers/` discovers configuration and publishes `layers.yaml`.
- `src/lib/iiif/`, `raster/`, `toponyms/`, `parcels/`, and
  `imageCollections/` build their respective artifacts.
- `src/lib/build/` owns logs and incremental hash state.

Use `bun run src/cli.ts help` as the authoritative command and option reference.
Use `INPUT_OUTPUT_MAPPING.md` for the detailed source-to-output mapping.

## Source and output boundaries

- `Source/` is authoring input and is not committed.
- Normal builds sync `Source.zip` into `.build-cache/zenodo-source/`.
- Local builds require `ARTEMIS_SOURCE_DIR=/path/to/Source` and
  `--local-source`.
- Deployable output is written under `build/`.
- `.build-cache/` contains reusable private caches and is never deployed.
- Per-layer `build/Layers/*/hashes.txt` files drive incremental decisions.

Do not assume an unchanged hash means an output artifact exists. Builders must
also verify required output files before skipping work.

## CI and branches

- `Manual - Run data pipeline` builds a Zenodo record or draft.
- Published records target `live`; unpublished drafts target `draft` unless
  `publish_live` is selected.
- Every run starts with a clean `build/` tree, then restores only incremental
  state from `build-cache`.
- Publication replaces the target branch with the current build snapshot, so
  retired outputs must disappear automatically.
- `OnPR - Publish pipeline image` publishes the GHCR build image after relevant
  pipeline changes reach its configured branch.

Never edit `live`, `draft`, or `build-cache` manually; they are workflow-owned.

## Validation and failure behavior

- Run `bun run typecheck` for TypeScript validation.
- Validate local source with
  `bun run src/cli.ts source:validate --local-source`.
- Exit code `2` represents blocking content issues rather than a pipeline crash;
  CI uploads diagnostics and skips publication.
- IIIF warnings are informational and do not block publication.
- Draft access requires `ZENODO_TOKEN`.

## Change guidance

- Preserve incremental correctness when changing recipes or output formats;
  bump the relevant recipe/hash input when cached results must be invalidated.
- Keep generated artifacts out of source-control branches.
- Treat source validation and publication schemas as contracts with Zenodo and
  Artemis Viewer.
- Update `INPUT_OUTPUT_MAPPING.md` when an input begins producing a different
  output or a branch/workflow responsibility changes.
