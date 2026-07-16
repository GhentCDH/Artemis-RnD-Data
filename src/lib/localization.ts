export type SupportedLocale = "en" | "nl";

export type LocalizedText = {
  en: string;
  nl: string;
};

/** Returns localized text with an English fallback for incomplete external data. */
export function localize(value: LocalizedText, locale: SupportedLocale): string {
  return value[locale] || value.en;
}
