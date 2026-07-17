# Data editor templates

Copy these files into the matching location in the `Source/` tree and replace
all placeholder values. Do not include this `templates/` directory itself in
`Source.zip`.

- `layer/LayerId.yaml` → `Source/layers/<LayerId>/<LayerId>.yaml`
- `imagecollection/CollectionId.yaml` →
  `Source/imagecollections/<CollectionId>/<CollectionId>.yaml`
- `imagecollection/CollectionIdCollection.json` →
  `Source/imagecollections/<CollectionId>/<CollectionId>Collection.json`
- `map-services.yaml` → `Source/map-services.yaml`

Folder names, filenames, and configured IDs are case-sensitive. Delete unused
example entries rather than leaving placeholder content in a real dataset.
