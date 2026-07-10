import type { AnalysisItem } from "@allmaps/analyze";
import type { BuildLog } from "../build/buildLog";
import type { HashRegistry } from "../build/hashRegistry";
import type { LayerRef } from "../layers/discovery";
import type { MaskFeature } from "../raster/warp";

export type IiifBuildOptions = {
  layers: LayerRef[];
  concurrency: number;
  limit?: number;
  /** Warp canvases into raster.pmtiles + masks.geojson (default on; --no-raster skips). */
  raster?: boolean;
  buildLog?: BuildLog;
  /** Committed source-hash registry; when set, unchanged stages are skipped. */
  registry?: HashRegistry;
};

export type IiifSublayer = {
  id: string;
  url: string;
};

export type ManifestRef = {
  url: string;
  label: string;
};

export type SourceGroup = {
  layer: LayerRef;
  sublayer: IiifSublayer;
  collectionUrl: string;
  collectionLabel: string;
  refs: ManifestRef[];
};

export type ProcessedManifest = {
  manifestUrl: string;
  manifestLabel: string;
  manifestAllmapsId: string;
  isVerzamelblad: boolean;
  canvases: ProcessedCanvas[];
};

export type ProcessedCanvas = {
  id: string;
  canvasAllmapsId: string;
  info: Record<string, unknown> | null;
  georeferencedMap: Record<string, unknown>;
  serviceId: string;
  analysis: MapAnalysis;
  sprite?: SpriteSource;
  /** Warp inputs carried from the metadata phase into the (gated) raster phase. */
  imageId?: string;
  manifestUrl?: string;
  transformationType?: string;
  /** Content signature of this canvas's warp inputs; drives the warp cache. */
  warpSig?: string;
  /** Warped EPSG:3857 GeoTIFF path (raster stage only, kept until tiling). */
  geotiffPath?: string;
  /** Canvas geo footprint for masks.geojson (raster stage only). */
  maskFeature?: MaskFeature;
};

export type SpriteSource = {
  canvasAllmapsId: string;
  imageId: string;
  fullWidth: number;
  fullHeight: number;
  spriteWidth: number;
  spriteHeight: number;
  buffer: Buffer;
};

export type SpritePlacement = SpriteSource & {
  x: number;
  y: number;
};

export type IiifBuildResult = {
  layerId: string;
  manifests: number;
  canvases: number;
  sprites: number;
  analysisErrors: number;
  analysisWarnings: number;
  fixedMaps: number;
  simplifiedMasks: number;
  simplifiedMaskPointsBefore: number;
  simplifiedMaskPointsAfter: number;
  warpedCanvases: number;
  masks: number;
  warningLogPath?: string;
  geomapsPath?: string;
  searchPath?: string;
  spritesJsonPath?: string;
  spritesImagePath?: string;
  rasterPmtilesPath?: string;
  masksGeojsonPath?: string;
};

export type MapAnalysis = {
  before: AnalysisSummary;
  after: AnalysisSummary;
  fixes: string[];
};

export type AnalysisSummary = {
  info: AnalysisItem[];
  warnings: AnalysisItem[];
  errors: AnalysisItem[];
};

export type CompactGeomap = {
  id: string;
  label: string;
  imageId: string;
  width: number;
  height: number;
  transformation: string;
  gcps: Array<[number, number, number, number]>;
  resourceMask?: number[];
  iiifOverrides?: Record<string, unknown>;
};
