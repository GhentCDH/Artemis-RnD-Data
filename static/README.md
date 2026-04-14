## Static Runtime Content

Files in `static/` are edited manually and consumed by the viewer at runtime.

- Do not write pipeline output here
- Do not depend on a preprocessing rerun for changes here to take effect
- Keep the shape simple: title fields, freeform info text, and logo references
- Missing layer metadata should warn in development and fall back safely in the viewer

Current contents:

- `Baselayer/`: manually maintained baselayer geometry
- `layers.json`: hand-edited layer metadata keyed by viewer layer key or compiled render-layer id
- `site.json`: hand-edited site title, freeform info text, attribution text, and logo references
- `attribution-logos/`: image assets referenced from `site.json`
