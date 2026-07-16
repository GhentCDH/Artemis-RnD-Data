import type { LocalizedText } from "../localization";

export const ANNOTATIONS_API = "https://annotations.allmaps.org";
export const SPRITESHEET_MAX_WIDTH = 4096;
export const SKIP_MANIFEST_TERMS = ["verzamelblad", "verzamelplan"];

export type VerzamelbladSplit = {
  /** Layer id (from Source/layers/<id>/<id>.yaml) the synthetic sublayer belongs to. */
  layerId: string;
  /** The existing IIIF sublayer whose collection is being split. */
  parentSublayerId: string;
  /** Synthetic sublayer id - also used as its own build output dir/hashes.txt namespace. */
  id: string;
  name: LocalizedText;
  description: LocalizedText;
};

/**
 * Hardcoded, not source-configured: Primitief Kadaster's IIIF collection
 * interleaves verzamelbladen (index/overview sheets, each covering many
 * detailed sheets) with the actual cadastral plans. Rather than discarding
 * them (SKIP_MANIFEST_TERMS), split them into their own sublayer, built
 * through the exact same IIIF pipeline as any other sublayer - just fed the
 * skip-matched manifests instead of the regular ones. Attribution/rights
 * mirror the parent sublayer's since they come from the same collection.
 */
export const VERZAMELBLAD_SPLITS: VerzamelbladSplit[] = [
  {
    layerId: "PrimitiefKadaster",
    parentSublayerId: "PrimitiefKadaster-iiif",
    id: "PrimitiefKadaster-verzamelbladen",
    name: { nl: "Verzamelbladen", en: "Index sheets" },
    description: {
      nl: "Verzamelbladen (overzichtskaarten) uit de IIIF-collectie van het primitief kadaster, apart van de individuele kadastrale plannen.",
      en: "Index sheets (overview maps) from the primitive cadastre IIIF collection, separated from the individual cadastral plans.",
    },
  },
];

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
