import { createFileRoute } from "@tanstack/react-router";
import { LegalLayout, LegalSection } from "@/components/legal/LegalLayout";
import { LEGAL_LAST_UPDATED } from "@/lib/legal-dates";
import { CLICKAI_LEGAL_NAME } from "@/lib/company-info";

export const Route = createFileRoute("/cookie-policy")({
  head: () => ({
    meta: [
      { title: "Cookie Policy | ClickAI" },
      {
        name: "description",
        content: "Which cookies ClickAI actually uses, and why.",
      },
      { property: "og:title", content: "ClickAI Cookie Policy" },
    ],
    links: [{ rel: "canonical", href: "https://clickai.in/cookie-policy" }],
  }),
  component: CookiePolicy,
});

function CookiePolicy() {
  return (
    <LegalLayout
      title="Cookie Policy"
      lastUpdated={LEGAL_LAST_UPDATED}
      related={[{ label: "Privacy Policy", to: "/privacy-policy" }]}
    >
      <p className="text-muted-foreground">
        This page lists the cookies ClickAI actually uses. We keep this list accurate to what the
        platform sets, not a generic template. ClickAI is the brand operated by {CLICKAI_LEGAL_NAME}
        .
      </p>

      <LegalSection id="essential" title="Essential cookies">
        <p>
          ClickAI's signed-in dashboard sets one first-party preference cookie,{" "}
          <code>sidebar_state</code>, to remember whether your navigation sidebar is expanded or
          collapsed. It does not identify you personally and is not used for tracking or
          advertising. Your signed-in session itself is managed by our authentication provider and
          may use browser storage rather than a cookie.
        </p>
      </LegalSection>

      <LegalSection id="analytics" title="Analytics cookies">
        <p>
          ClickAI does not currently set any analytics cookies (for example, Google Analytics). If
          we add analytics in the future, we will update this page before doing so.
        </p>
      </LegalSection>

      <LegalSection id="preference" title="Preference cookies">
        <p>
          Other than the sidebar preference above, ClickAI does not currently set additional
          preference cookies.
        </p>
      </LegalSection>

      <LegalSection id="marketing" title="Marketing cookies">
        <p>ClickAI does not currently set any marketing or advertising cookies.</p>
      </LegalSection>

      <LegalSection id="managing" title="Managing cookies">
        <p>
          Most browsers let you block or delete cookies through their settings. Blocking the
          essential cookie above may affect dashboard preferences like your sidebar state, but will
          not prevent you from using ClickAI.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
