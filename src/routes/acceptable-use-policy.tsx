import { createFileRoute } from "@tanstack/react-router";
import { LegalLayout, LegalSection } from "@/components/legal/LegalLayout";
import { LEGAL_LAST_UPDATED } from "@/lib/legal-dates";

export const Route = createFileRoute("/acceptable-use-policy")({
  head: () => ({
    meta: [
      { title: "Acceptable Use Policy | ClickAI" },
      {
        name: "description",
        content:
          "What is prohibited when using ClickAI's AI communications and automation platform.",
      },
      { property: "og:title", content: "ClickAI Acceptable Use Policy" },
    ],
    links: [{ rel: "canonical", href: "https://clickai.in/acceptable-use-policy" }],
  }),
  component: AcceptableUse,
});

function AcceptableUse() {
  return (
    <LegalLayout
      title="Acceptable Use Policy"
      lastUpdated={LEGAL_LAST_UPDATED}
      related={[
        { label: "Terms & Conditions", to: "/terms" },
        { label: "Messaging Policy", to: "/messaging-policy" },
      ]}
    >
      <p className="text-muted-foreground">
        ClickAI provides AI-powered voice, messaging, and automation tools. Because these tools
        communicate with real people over real telecommunications networks, this policy sets out
        what is never permitted.
      </p>

      <LegalSection id="prohibited" title="Prohibited activities">
        <p>You may not use ClickAI to engage in, or facilitate:</p>
        <ul>
          <li>Spam or unsolicited bulk communication</li>
          <li>Fraud or fraudulent schemes</li>
          <li>Phishing or deceptive attempts to obtain personal or financial information</li>
          <li>Scam operations of any kind</li>
          <li>Impersonation of another person, business, or organization</li>
          <li>Harassment, threats, or abusive communication</li>
          <li>Any illegal activity</li>
          <li>Unauthorized bulk messaging</li>
          <li>Unlawful robocalling</li>
          <li>Misleading or spoofed caller identification</li>
          <li>Abuse of telecommunications networks or carrier infrastructure</li>
          <li>Circumventing a telephony or messaging provider's restrictions or safeguards</li>
          <li>Unlawful collection or processing of personal information</li>
          <li>
            Malicious automation, including automation intended to disrupt third-party systems
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="enforcement" title="Enforcement">
        <p>
          We may suspend or terminate access to ClickAI, with or without notice, where we reasonably
          believe it is necessary to prevent abuse, comply with the law, or comply with an upstream
          telephony or messaging provider's own requirements. We may also report suspected illegal
          activity to the appropriate authorities.
        </p>
      </LegalSection>

      <LegalSection id="reporting" title="Reporting a violation">
        <p>
          If you believe ClickAI, or a business using ClickAI, has violated this policy, contact us
          at <a href="mailto:hello@clickai.in">hello@clickai.in</a>.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
