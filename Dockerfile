# Artemis data pipeline (v2) image.
#
# Runtime = Bun (the one app language). Docker exists to carry the geo binary
# toolchain — GDAL, tippecanoe, dezoomify-rs, pmtiles — not a second language.
# See DataRepoPlanning/RuntimeConsolidation.md for why we consolidate on TS/Bun.

# --- dezoomify-rs (Rust): full-res IIIF tile fetch ---
FROM rust:1-slim AS dezoomify-builder
ARG DEZOOMIFY_RS_VERSION=2.9.4
RUN cargo install --locked --version ${DEZOOMIFY_RS_VERSION} dezoomify-rs

# --- tippecanoe (C++): geojson -> vector tiles / PMTiles ---
FROM debian:bookworm-slim AS tippecanoe-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git build-essential libsqlite3-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/felt/tippecanoe.git /tippecanoe \
 && make -C /tippecanoe -j"$(nproc)"

# --- go-pmtiles CLI: raster/vector XYZ -> single .pmtiles archive ---
FROM debian:bookworm-slim AS pmtiles-builder
# NOTE: verify/bump against https://github.com/protomaps/go-pmtiles/releases
ARG PMTILES_VERSION=1.22.1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz" \
      | tar -xz -C /usr/local/bin pmtiles \
 && chmod +x /usr/local/bin/pmtiles

# --- runtime: Bun + GDAL + the copied binaries ---
FROM oven/bun:1 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      gdal-bin proj-bin libsqlite3-0 zlib1g curl jq ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=dezoomify-builder /usr/local/cargo/bin/dezoomify-rs /usr/local/bin/dezoomify-rs
COPY --from=tippecanoe-builder /tippecanoe/tippecanoe /usr/local/bin/tippecanoe
COPY --from=pmtiles-builder /usr/local/bin/pmtiles /usr/local/bin/pmtiles

WORKDIR /app
# Dependency layer first for build caching (native deps like sharp build here).
COPY package.json bun.lock* ./
RUN bun install
# App source copied last; in dev it's bind-mounted over this by docker-compose.
COPY . .

ENTRYPOINT ["bun"]
CMD ["run", "src/index.ts", "--help"]
