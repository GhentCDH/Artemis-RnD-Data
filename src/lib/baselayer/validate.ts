import { open, readFile } from "node:fs/promises";

export type BaselayerGeoJsonIssue = { path: string; message: string };

/** Checks the fixed PMTiles magic bytes without loading the archive into memory. */
export async function validateBaselayerPmtiles(path: string): Promise<BaselayerGeoJsonIssue[]> {
  let handle;
  try {
    handle = await open(path, "r");
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < header.length || header.subarray(0, 7).toString("ascii") !== "PMTiles") {
      return [{ path: "", message: "must be a PMTiles archive" }];
    }
    if (header[7] !== 3) return [{ path: "", message: `uses unsupported PMTiles version ${header[7]} (expected 3)` }];
    return [];
  } catch (error) {
    return [{ path: "", message: error instanceof Error ? error.message : "could not read PMTiles header" }];
  } finally {
    await handle?.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function declaredCrs(value: Record<string, unknown>): string | undefined {
  if (!isRecord(value.crs) || !isRecord(value.crs.properties)) return undefined;
  return typeof value.crs.properties.name === "string" ? value.crs.properties.name : undefined;
}

function isLongitudeLatitudeCrs(crs: string): boolean {
  return /(?:CRS:?84|EPSG(?::|::)?4326)$/i.test(crs);
}

/** Validates the longitude/latitude GeoJSON contract required by tippecanoe. */
export async function validateBaselayerGeoJson(path: string): Promise<BaselayerGeoJsonIssue[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
  } catch (error) {
    return [{ path: "", message: error instanceof Error ? error.message : "could not parse JSON" }];
  }

  if (!isRecord(parsed)) return [{ path: "", message: "must be a GeoJSON object" }];
  const issues: BaselayerGeoJsonIssue[] = [];
  if (parsed.type !== "FeatureCollection") issues.push({ path: "type", message: 'must be "FeatureCollection"' });

  const crs = declaredCrs(parsed);
  if (crs && !isLongitudeLatitudeCrs(crs)) {
    issues.push({
      path: "crs.properties.name",
      message: `declares ${crs}; baselayer input must be EPSG:4326/CRS84 longitude-latitude GeoJSON (reproject it before building)`,
    });
  }

  if (!Array.isArray(parsed.features) || parsed.features.length === 0) {
    issues.push({ path: "features", message: "must contain at least one feature" });
    return issues;
  }

  let coordinateCount = 0;
  let invalidCoordinate: BaselayerGeoJsonIssue | undefined;
  const visitCoordinates = (value: unknown, pathPrefix: string): void => {
    if (invalidCoordinate || !Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      coordinateCount++;
      const [longitude, latitude] = value;
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
        invalidCoordinate = { path: pathPrefix, message: "contains a non-finite coordinate" };
      } else if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
        invalidCoordinate = {
          path: pathPrefix,
          message: `coordinate [${longitude}, ${latitude}] is outside longitude/latitude bounds; the file may still be in a projected CRS such as EPSG:3812`,
        };
      }
      return;
    }
    value.forEach((part, index) => visitCoordinates(part, `${pathPrefix}[${index}]`));
  };

  parsed.features.forEach((feature, index) => {
    if (invalidCoordinate || !isRecord(feature) || !isRecord(feature.geometry)) return;
    visitCoordinates(feature.geometry.coordinates, `features[${index}].geometry.coordinates`);
  });
  if (invalidCoordinate) issues.push(invalidCoordinate);
  if (coordinateCount === 0) issues.push({ path: "features", message: "contains no geometry coordinates" });
  return issues;
}
