import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CLICKAI_BRAND,
  CLICKAI_LEGAL_NAME,
  CLICKAI_ADDRESS_INLINE,
  CLICKAI_ADDRESS_LINES,
  CLICKAI_ADDRESS_JSON_LD,
} from "./company-info.ts";

describe("company-info holds the exact confirmed legal identity and address from the Certificate of Incorporation", () => {
  test("brand and legal name are exactly as confirmed, not an earlier incorrect variant", () => {
    assert.equal(CLICKAI_BRAND, "ClickAI");
    assert.equal(CLICKAI_LEGAL_NAME, "Click AI Solutions Private Limited");
  });

  test("inline address matches the Certificate of Incorporation verbatim", () => {
    assert.equal(
      CLICKAI_ADDRESS_INLINE,
      "303, SreeKrithi Residency, Sri Sai Krishna Colony, Pragatinagar, Hyd, Hyderabad-500090, Telangana",
    );
  });

  test("display lines join back into the exact confirmed inline address (no dropped/altered words)", () => {
    const joined = CLICKAI_ADDRESS_LINES.join(" ").replace(/\s+/g, " ");
    const inlineNormalized = CLICKAI_ADDRESS_INLINE.replace(/\s+/g, " ");
    assert.equal(joined, inlineNormalized);
  });

  test("JSON-LD address fields are derived only from the confirmed address — no invented locality/region/postal code", () => {
    assert.equal(CLICKAI_ADDRESS_JSON_LD.addressLocality, "Hyderabad");
    assert.equal(CLICKAI_ADDRESS_JSON_LD.addressRegion, "Telangana");
    assert.equal(CLICKAI_ADDRESS_JSON_LD.postalCode, "500090");
    assert.equal(CLICKAI_ADDRESS_JSON_LD.addressCountry, "IN");
    assert.match(CLICKAI_ADDRESS_INLINE, new RegExp(CLICKAI_ADDRESS_JSON_LD.streetAddress));
  });

  test("does not contain the previously considered Rajahmundry address", () => {
    assert.doesNotMatch(CLICKAI_ADDRESS_INLINE, /rajahmundry/i);
  });
});
