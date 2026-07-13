import { describe, expect, test } from "bun:test";
import { extractManifestMetadata } from "./manifestMetadata";

describe("extractManifestMetadata", () => {
  test("extracts Massart year, exact date and representation id without inferring a place", () => {
    const manifest = {
      "@id": "https://libcatalog.ugent.be/view/iiif/presentation/32RUG_INST/12293163240009161/manifest?iiifVersion=2",
      metadata: [
        { label: "Subject", value: "België Genk" },
        { label: "Year", value: "1911" },
        { label: "General note", value: "Datum foto: 14/07/1911" },
      ],
    };

    expect(extractManifestMetadata(manifest, manifest["@id"])).toEqual({
      year: "1911",
      date: "1911-07-14",
      recordId: undefined,
      repId: "12293163240009161",
      manifestId: manifest["@id"],
      yearCandidates: ["1911"],
    });
  });

  test("supports IIIF language maps and reports conflicting candidate years", () => {
    const manifest = {
      id: "https://example.org/item/abc/manifest",
      metadata: [
        { label: { en: ["Year"] }, value: { none: ["1904"] } },
        { label: { nl: ["Datum"] }, value: { nl: ["03/05/1905"] } },
        { label: { en: ["Identifier"] }, value: { none: ["catalog-42"] } },
      ],
    };

    expect(extractManifestMetadata(manifest, manifest.id)).toEqual({
      year: "1904",
      date: "1905-05-03",
      recordId: "catalog-42",
      repId: "abc",
      manifestId: manifest.id,
      yearCandidates: ["1904", "1905"],
    });
  });
});
