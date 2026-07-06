export const ANNOTATIONS_API = "https://annotations.allmaps.org";
export const SPRITESHEET_MAX_WIDTH = 4096;
export const SKIP_MANIFEST_TERMS = ["verzamelblad", "verzamelplan"];

const DEFAULT_SPRITE_MAX_SIZE = 256;
const DEFAULT_MASK_SIMPLIFY_EPSILON = 5.5;

export function spriteMaxSize(): number {
  const parsed = Number.parseInt(process.env.IIIF_SPRITE_SIZE ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SPRITE_MAX_SIZE;
}

export function maskSimplifyEpsilon(): number {
  const parsed = Number.parseFloat(process.env.IIIF_MASK_SIMPLIFY_EPSILON ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MASK_SIMPLIFY_EPSILON;
}
