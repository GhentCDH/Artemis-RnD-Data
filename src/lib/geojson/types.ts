export type Position = [number, number];
export type Ring = Position[];
export type PolygonCoordinates = Ring[];
export type MultiPolygonCoordinates = PolygonCoordinates[];

export type PointGeometry = {
  type: "Point";
  coordinates: Position;
};

export type PolygonGeometry = {
  type: "Polygon";
  coordinates: PolygonCoordinates;
};

export type MultiPolygonGeometry = {
  type: "MultiPolygon";
  coordinates: MultiPolygonCoordinates;
};

export type Geometry = PointGeometry | PolygonGeometry | MultiPolygonGeometry;

export type Feature<P extends Record<string, unknown> = Record<string, unknown>, G extends Geometry = Geometry> = {
  type: "Feature";
  geometry: G | null;
  properties?: P | null;
};

export type FeatureCollection<
  P extends Record<string, unknown> = Record<string, unknown>,
  G extends Geometry = Geometry,
> = {
  type: "FeatureCollection";
  name?: string | null;
  features: Array<Feature<P, G>>;
};

