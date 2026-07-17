# Artemis Data Pipeline — Data Editor Guide

How to add or update data in the Artemis viewer: prepare a Zenodo draft, run
the GitHub Actions pipeline, inspect its report, and publish the verified
result. This is an editor guide. For pipeline internals and local development,
see [`README.md`](README.md).

## Overview

The pipeline reads its authoring data from the Artemis Zenodo record:
[Zenodo record 21219182](https://zenodo.org/records/21219182). Do not upload
viewer data directly to GitHub.

Always test through an **unpublished Zenodo draft** first. A normal draft build
is written to the `draft` branch and is not shown by the viewer, which currently
serves the `live` branch. Verify draft builds in the GitHub Actions job summary.

The word “publish” has two meanings in this process:

- **Zenodo publishing** turns a draft into a permanent, DOI-backed record.
- **Pipeline publishing** writes built output to either the `draft` or `live`
  branch. The pipeline selects the target from the Zenodo record state, unless
  an editor explicitly force-publishes a draft to `live`.

## 1. Prepare `Source.zip`

The Zenodo record must contain a file named exactly `Source.zip`. It is a ZIP of
the **contents** of `Source/`, not a ZIP containing the `Source` folder itself:

```text
Source/
├── map-services.yaml
├── Baselayer_Water.geojson
├── Baselayer_Border.geojson
├── imagecollections/
│   └── <CollectionId>/
│       ├── <CollectionId>.yaml
│       └── <CollectionId>Collection.json
└── layers/
    └── <LayerId>/
        ├── <LayerId>.yaml
        ├── parcels/*.geojson
        └── toponyms/*.geojson
```

The old `about.json`, `Baselayer.geojson`, `ImageCollectionConfig.yaml`,
combined image-collection files, and `attribution-logos/` output are retired.
About-page and branding content now live in the Artemis Viewer. Baselayer water
and border geometry are separate files.

If you have a local copy of `Source/`, create the archive with:

```bash
cd Source
zip -rXq ../Source.zip . -x ".*" -x "*/.*"
```

Upload `Source.zip` to the Zenodo draft, replacing the previous copy.

### Map layers

Each main layer has its own `layers/<LayerId>/` folder and matching
`<LayerId>.yaml`. The folder name, YAML filename, and YAML `id` must agree.
The main layer groups its `label`, `timeframe`, and `sublayers`; descriptive and
source-specific metadata belongs on each sublayer.

Supported sublayer kinds are:

| `kind` | Purpose | Source |
| --- | --- | --- |
| `iiif` | Georeferenced IIIF map | Remote IIIF collection or manifest |
| `geojson` | Generated vector data, such as parcels | `rawInput` glob in the layer folder |
| `searchable` | Generated searchable toponyms | `rawInput` glob in the layer folder |
| `wmts` | External WMTS tiles, rendered directly | Remote URL |
| `wms` | External WMS overlay, rendered directly | Remote URL |

Start from the [`templates/layer/`](templates/layer/) files. Existing source
layers can provide additional examples, but the maintained templates represent
the current validation schema.

Current metadata rules:

- `name` and `description` are localized objects with non-empty `en` and `nl`
  values.
- `sources` contains one or more citation entries. Every entry has an APA-style
  `citation` and exactly one of `url` or `download`.
- A source can list multiple downloadable record files as a comma-separated
  `download` value.
- `furtherReading` is optional and maps display labels to HTTP(S) links.
- `source.type: remote` plus `source.url` is required for `wmts` and `wms`.
- Generated content uses `source.rawInput`, relative to the layer folder, such
  as `parcels/*.geojson` or `toponyms/*.geojson`.
- The former `attribution`/logo block is no longer part of the authored layer
  contract. Put citation and provider links in `sources`.

Example structure:

```yaml
id: PrimitiefKadaster
label: Primitief kadaster
timeframe:
  startYear: 1808
  endYear: 1834

sublayers:
  - id: PrimitiefKadaster-iiif
    name:
      en: Map
      nl: Kaart
    kind: iiif
    description:
      en: Georeferenced cadastral maps.
      nl: Gegeorefereerde kadasterkaarten.
    source:
      type: remote
      url: https://iiif.example.org/collection
    sources:
      - citation: "Rijksarchief België. (1834). Primitief kadaster [Map]."
        url: https://iiif.example.org/collection

  - id: PrimitiefKadaster-parcels
    name:
      en: Parcels
      nl: Percelen
    kind: geojson
    source:
      type: generated
      rawInput: parcels/*.geojson
    sources:
      - citation: "Rijksarchief België. (1834). Primitief kadaster [Data set]."
        download: Primitief_Kadaster_Parcels.zip
```

There is no separate layer-order file. Main-layer ordering is determined by the
viewer from timeframe and viewer logic. Keep sublayers in the intended display
order; the first is the default sublayer.

### Downloadable datasets

A filename referenced by `sources[].download` is **not** placed inside
`Source.zip`. Upload it separately beside `Source.zip` in the same Zenodo
record. Spelling and capitalization must match exactly. For example:

```text
Zenodo draft files
├── Source.zip
└── Primitief_Kadaster_Parcels.zip
```

For a published record, the pipeline verifies every referenced download. A
missing file blocks publication. A built sublayer with no download is reported
as a non-blocking reminder.

### Image collections

Non-georeferenced image collections now use one folder per collection:

- `<CollectionId>.yaml` contains localized `label` and optional localized
  `description`, plus `sources` and optional `furtherReading`.
- `<CollectionId>Collection.json` maps each IIIF manifest URL to either `null`
  when the manifest supplies `navPlace`, or a `[longitude, latitude]` pair.
- Image-collection sources currently require a direct `url`; `download` is not
  supported there.

Copy the maintained files in
[`templates/imagecollection/`](templates/imagecollection/) when adding one.

### Map services and baselayers

`map-services.yaml` defines viewer basemaps and overlays. Each entry needs an
`id`, `shortLabel`, `longLabel`, and HTTP(S) `url`.

Use [`templates/map-services.yaml`](templates/map-services.yaml) as the
starting point.

`Baselayer_Water.geojson` and `Baselayer_Border.geojson` provide the two custom
baselayer components. Both filenames are exact and both files are required.

## 2. Run the pipeline

After uploading the draft files:

1. Open **Artemis-Data → Actions → Manual - Run data pipeline**.
2. Select **Run workflow**.
3. Enter the Zenodo source and review the optional switches.
4. Start the workflow and wait for the **Data Pipeline** job to finish.

| Input | Normal setting | When to change it |
| --- | --- | --- |
| **Zenodo record/draft ID** | Enter the draft ID | The field accepts a numeric ID, a Zenodo record/draft URL, or a Zenodo DOI URL. Use the draft's own ID, not the previous published version's ID. |
| **Bypass incremental cache** | Unchecked | Check only to force cache-aware stages to rebuild, for example when investigating stale output. |
| **Publish draft to live** | Unchecked | Use only for the minor-fix path in §3. |
| **Skip raster warp + XYZ tiles** | Unchecked | Check for a faster metadata/georeferencing/search test when new raster output is not required. |

The pipeline detects whether the supplied ID is an unpublished draft or a
published record. A normal draft goes to `draft`; a published record goes to
`live`.

Each successful publication is a clean snapshot. Layers or artifacts removed
from `Source.zip` are removed from that target branch too; stale output is not
kept indefinitely.

## 3. Go live

Never start by publishing a Zenodo version. Published versions are permanent,
so first validate every change through a draft:

1. Create or edit the Zenodo draft.
2. Upload `Source.zip` and any separately downloadable datasets.
3. Run the pipeline against the draft's own ID with **Publish draft to live**
   unchecked.
4. Read the complete job summary (§4).
5. Choose one of the following release paths.

### A. Significant update: publish on Zenodo

For a substantial, verified dataset update that deserves a permanent version,
publish the draft on Zenodo. Re-run the pipeline using that published record.
The result is written to `live` and receives a GitHub Release.

### B. Minor fix: force-publish the draft

For a small correction that does not justify a new Zenodo version, run the
verified draft again with **Publish draft to live** checked. The result is
written to `live` and clearly marked as having been built from a draft.

Draft files have no public download URLs. During a forced draft-to-live build,
the pipeline therefore resolves downloadable filenames against the draft's
latest published sibling version. If a downloadable file changed in the draft,
the live link still points to the older published copy. If no published sibling
exists, downloads remain unresolved. Check the job summary carefully before
using this path.

## 4. Read the job summary — every time

Open the workflow run and select the **Data Pipeline** job. Do not rely only on
the green/red check: content problems deliberately block publication while the
workflow can remain green, because the pipeline itself completed correctly.

Check these sections:

- **Publish target**: source record state and intended `draft`/`live` branch.
- **Build issues**: blocking problems. If present, nothing was published.
- **Sublayers without a download**: non-blocking reminders.
- **Sublayers built**: every sublayer, its kind, generated artifacts, and
  download status.
- **Image collections**: collection and coordinate/navPlace results.
- **Pipeline logs**: IIIF georeferencing warnings. These are informational and
  do not block publication.

Typical blocking issues include:

- a required source file or folder is absent or misnamed;
- invalid YAML, GeoJSON, localized fields, URLs, IDs, or collection coordinates;
- a published-record download is missing;
- a non-remote sublayer is configured but produces no content.

The run also uploads the diagnostic logs as an artifact for 14 days, including
`Build.log`, `BuildIssues.log`, `DownloadReminders.log`, `IIIFWarnings.log`,
`Sublayers.md`, and `ImageCollections.md` when produced.

## 5. Check what is currently published

Every successful build is tagged with its Zenodo source:

- published source: `zenodo-<record-id>`;
- unpublished source: `zenodo-<record-id>-draft`.

A `live` publication creates a GitHub Release. Its notes identify the Zenodo
record, output commit, whether the source was a forced draft, the sublayers
built, and the image collections included. The automatically attached “Source
code” archives contain that tagged build snapshot (`build/` and, when present,
`static/`), not the TypeScript pipeline source.

A normal `draft` publication receives a traceability tag but no public GitHub
Release. The viewer continues to serve the latest `live` branch.
