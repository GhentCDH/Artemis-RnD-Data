This folder is for local/raw toponym source exports (GeoJSON/JSON).

Policy:
- Keep raw source files out of git.
- Use `bun run toponyms` to compile a clean searchable artifact to:
  - build/Toponyms/index.json

Expected source layout:
- data/sources/Toponyms/<SourceGroup>/*.geojson
- data/sources/Toponyms/<SourceGroup>/*.json
