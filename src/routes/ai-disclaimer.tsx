import { createFileRoute } from "@tanstack/react-router";
import { LegalLayout, LegalSection } from "@/components/legal/LegalLayout";
import { LEGAL_LAST_UPDATED } from "@/lib/legal-dates";
import { CLICKAI_LEGAL_NAME } from "@/lib/company-info";

export const Route = createFileRoute("/ai-disclaimer")({
  head: () => ({
    meta: [
      { title: "AI Disclaimer | ClickAI" },
      {
        name: "description",
        content:
          "The limits of ClickAI's AI agents, and when human escalation should be used instead.",
      },
      { property: "og:title", content: "ClickAI AI Disclaimer" },
    ],
    links: [{ rel: "canonical", href: "https://clickai.in/ai-disclaimer" }],
  }),
  component: AiDisclaimer,
});

function AiDisclaimer() {
  return (
    <LegalLayout
      title="AI Disclaimer"
      lastUpdated={LEGAL_LAST_UPDATED}
      related={[
        { label: "Terms & Conditions", to: "/terms" },
        { label: "Privacy Policy", to: "/privacy-policy" },
      ]}
    >
      <LegalSection id="can-make-mistakes" title="AI agents can make mistakes">
        <p>
          ClickAI's AI agents (voice, chat, and WhatsApp) are designed to handle natural customer
          conversations, but they can misunderstand a request, give an incomplete answer, or make an
          error. ClickAI does not guarantee that AI output is always accurate.
        </p>
      </LegalSection>

      <LegalSection id="not-professional-advice" title="Not professional advice">
        <p>
          Responses from a ClickAI AI agent should not automatically be treated as professional
          advice. ClickAI does not provide professional medical, legal, or financial advice through
          its AI agents, even when a business configures an agent for a healthcare, legal, or
          financial practice.
        </p>
      </LegalSection>

      <LegalSection id="business-responsibility" title="Business responsibility">
        <p>
          Businesses using ClickAI are responsible for reviewing their AI agent's configuration,
          including the information, pricing, and rules it answers from, and for remaining
          responsible for compliance with the laws applicable to their own industry.
        </p>
      </LegalSection>

      <LegalSection
        id="high-stakes-situations"
        title="Healthcare, financial, legal, and emergency situations"
      >
        <p>
          For healthcare, financial, legal, emergency, or other safety-critical situations, a human
          should be involved rather than relying solely on an AI agent's response. If a caller or
          customer describes an emergency, a ClickAI agent configured for that business is intended
          to escalate to a human — but you, as the business, are responsible for configuring and
          testing that escalation path for your own situation.
        </p>
      </LegalSection>

      <LegalSection id="human-escalation" title="Human escalation">
        <p>
          We recommend every business configure a clear path for a caller or customer to reach a
          human when a situation requires human judgment, and to review AI conversation transcripts
          periodically.
        </p>
      </LegalSection>

      <LegalSection id="company" title="About ClickAI">
        <p>ClickAI is the brand operated by {CLICKAI_LEGAL_NAME}.</p>
      </LegalSection>
    </LegalLayout>
  );
}
