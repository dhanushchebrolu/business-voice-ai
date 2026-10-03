/**
 * Single source of truth for ClickAI's confirmed legal identity and
 * registered/mailing address, taken verbatim from the Certificate of
 * Incorporation. Every page that displays the legal entity name or address
 * reads from here, so a correction never has to be hunted down across the
 * footer, legal pages, and structured data separately.
 *
 * CLICKAI_BRAND is the public-facing product name; CLICKAI_LEGAL_NAME is
 * the entity name used only where a legal/company identity is required
 * (Terms, Privacy Policy, footer company block, JSON-LD). Never swap the
 * two — see each page's own usage for which one applies.
 */
export const CLICKAI_BRAND = "ClickAI";
export const CLICKAI_LEGAL_NAME = "Click AI Solutions Private Limited";

/** Exactly as it appears on the Certificate of Incorporation — do not reformat or abbreviate further. */
export const CLICKAI_ADDRESS_INLINE =
  "303, SreeKrithi Residency, Sri Sai Krishna Colony, Pragatinagar, Hyd, Hyderabad-500090, Telangana";

/** Same address, broken into display lines for the footer/contact card layout. */
export const CLICKAI_ADDRESS_LINES = [
  "303, SreeKrithi Residency,",
  "Sri Sai Krishna Colony,",
  "Pragatinagar, Hyd,",
  "Hyderabad-500090, Telangana",
];

/** Structured breakdown for JSON-LD PostalAddress — parsed directly from CLICKAI_ADDRESS_INLINE, nothing added. */
export const CLICKAI_ADDRESS_JSON_LD = {
  "@type": "PostalAddress",
  streetAddress: "303, SreeKrithi Residency, Sri Sai Krishna Colony, Pragatinagar",
  addressLocality: "Hyderabad",
  addressRegion: "Telangana",
  postalCode: "500090",
  addressCountry: "IN",
};
