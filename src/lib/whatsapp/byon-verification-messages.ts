/**
 * Customer-facing wording for BYON verification (shared by the connect UI
 * and its tests). Vobiz documents no delivery confirmation for BYON codes,
 * so nothing here ever says a code was sent or delivered: the strongest
 * statement available is that Vobiz accepted the request.
 */

/** Shown before a code is requested (Vobiz's documented eligibility rules). */
export const BYON_ELIGIBILITY_NOTES = [
  "Connect a number you already own that has a WhatsApp Business Account in Meta Business Manager. You'll need its WhatsApp Business Account ID, its phone number ID and a Meta system-user access token.",
  "Vobiz connects a number to one provider only, and the number can't stay registered in the WhatsApp or WhatsApp Business app. If it is, remove it there yourself before requesting a code — ClickAI never unregisters or deletes an existing WhatsApp account.",
] as const;

export interface ByonRequestOutcome {
  phoneNumber: string;
  state: "verification_requested" | "verification_unconfirmed";
  expiresAt: string | null;
}

function formatExpiry(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** The toast and the panel text after a verification request. */
export function byonRequestMessages(r: ByonRequestOutcome): {
  tone: "success" | "warning";
  toast: string;
  panel: string;
} {
  if (r.state === "verification_requested") {
    const expiry = r.expiresAt
      ? ` If a code arrives, it expires at ${formatExpiry(r.expiresAt)}.`
      : "";
    return {
      tone: "success",
      toast: "Verification request accepted. Delivery has not been confirmed.",
      panel: `Vobiz accepted the verification request for ${r.phoneNumber}. Delivery has not been confirmed.${expiry} If no code arrives within a few minutes, don't keep requesting new ones (requests are limited per hour) — check that the number is eligible and contact support.`,
    };
  }
  return {
    tone: "warning",
    toast: "Vobiz answered, but ClickAI couldn't confirm the verification request.",
    panel: `Vobiz answered the verification request for ${r.phoneNumber}, but not in a way ClickAI recognizes, so it isn't known whether a code was sent. If a code arrives, enter it below; otherwise wait a few minutes before trying again, or contact support.`,
  };
}
