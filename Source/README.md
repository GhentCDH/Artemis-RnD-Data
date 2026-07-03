# `Source/` — authoring inputs

The hand-maintained inputs the build consumes. The build reads this tree and
produces `build/` (see [`../OutputStructure.md`](../OutputStructure.md)).

## Layout

```
Source/
├── layers/                       # georeferenced / map layers, one folder each
│   └── <LayerId>/
│       ├── <LayerId>.yaml        # the layer's config (grouping + sublayers)
│       ├── parcels/*.geojson      # raw parcel inputs   (if any)
│       └── toponyms/*.geojson     # raw toponym inputs  (if any)
├── ImageCollectionConfig.yaml    # non-georeferenced image collections (adapter + mapping)
├── attribution-logos/            # logo image assets + logos.yaml registry
│   └── logos.yaml                # logo filename → click-through URL
└── toponyms-format.README.txt     # toponym geojson format reference
```

Adding a map layer = drop a folder under `layers/`. Adding an image collection =
add an entry to `ImageCollectionConfig.yaml`.

## Layers

**One folder per main layer** under `layers/`, co-locating the layer's config
with its raw geodata.

A **main layer** folder holds only grouping config (`id`, `label`, `timeframe`,
`sublayers`). All descriptive / source-bound content — `description`,
`attribution`, `citation` — lives on the **sublayer**, because each sublayer has
its own source and provider.

Raw geodata subfolders map to sublayers by kind:

- `parcels/` → the layer's `geojson` parcels sublayer → built into `parcels.pmtiles`
- `toponyms/` → the layer's `searchable` toponyms sublayer → built into the toponym search index

There is **no layer-order file** — ordering is not driven by this config
anymore; the build simply enumerates the layer folders (the viewer orders by
timeframe / its own logic).

Data present today:

| Layer | parcels | toponyms |
|---|---|---|
| PrimitiefKadaster | 39 | 68 |
| Ferraris | — | 411 |
| GereduceerdeKadaster | — | 1 (WHG gazetteer, 3548 places) |
| 7 others | — | — |

## Image collections

`ImageCollectionConfig.yaml` (sibling of `layers/`) holds non-georeferenced
collections (photographs, etc.). Each collection names a reusable source
`adapter` (code) plus a declarative `map` (field paths + named transforms), so a
new collection on a known adapter needs no new code. See the header of that file
for the adapter/transform catalogue.

## Attribution logos

`attribution-logos/logos.yaml` maps each logo image filename to the URL opened
when it is clicked. A sublayer's / collection's `attribution.logos` lists
filenames from this registry, e.g. `logos: [logo_NGI.png]`.

Data-provider logos (NGI, KBR, Rijksarchief, UAntwerpen, …) live here. Project /
funder branding is a site-level concern.

## Build / merge step

1. Enumerate `layers/*/` and load each `<LayerId>.yaml`; validate; resolve
   `attribution.logos` filenames against `attribution-logos/logos.yaml`.
2. Emit `build/layers.yaml` (all layers merged into one file the viewer fetches).
3. Process each layer's `parcels/` and `toponyms/` inputs into the published
   PMTiles / search artifacts.
4. Run `ImageCollectionConfig.yaml` collections through their adapters to produce
   the image-collection artifacts.

## Note

`registry.json` (old combined config) was superseded by this tree.
`image-collections.json` is superseded by `ImageCollectionConfig.yaml`. Citation
blocks in the layer YAMLs are illustrative and need verifying against the actual
rights holders before publication.
