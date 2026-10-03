import { createFileRoute } from "@tanstack/react-router";
import { LegalLayout, LegalSection } from "@/components/legal/LegalLayout";
import { LEGAL_LAST_UPDATED } from "@/lib/legal-dates";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "ClickAI Terms & Conditions | ClickAI" },
      {
        name: "description",
        content: "The terms that govern use of ClickAI's AI business automation platform.",
      },
      { property: "og:title", content: "ClickAI Terms & Conditions" },
    ],
    links: [{ rel: "canonical", href: "https://clickai.in/terms" }],
  }),
  component: Terms,
});

const TOC = [
  { id: "acceptance", label: "Acceptance" },
  { id: "services", label: "Description of services" },
  { id: "accounts", label: "Account responsibilities" },
  { id: "customer-responsibilities", label: "Customer responsibilities" },
  { id: "agent-configuration", label: "AI-agent configuration" },
  { id: "voice-messaging", label: "Voice, messaging & WhatsApp" },
  { id: "appointments", label: "Appointment automation" },
  { id: "integrations", label: "Third-party integrations" },
  { id: "billing", label: "Usage and billing" },
  { id: "prohibited-use", label: "Prohibited use" },
  { id: "ip", label: "Intellectual property" },
  { id: "customer-content", label: "Customer content" },
  { id: "data-processing", label: "Data processing" },
  { id: "ai-limitations", label: "AI limitations" },
  { id: "availability", label: "Service availability" },
  { id: "suspension-termination", label: "Suspension and termination" },
  { id: "refunds", label: "Refunds" },
  { id: "liability", label: "Limitation of liability" },
  { id: "indemnification", label: "Indemnification" },
  { id: "governing-law", label: "Governing law" },
  { id: "changes", label: "Changes to these terms" },
  { id: "contact", label: "Contact information" },
];

function Terms() {
  return (
    <LegalLayout
      title="Terms & Conditions"
      lastUpdated={LEGAL_LAST_UPDATED}
      toc={TOC}
      related={[
        { label: "Privacy Policy", to: "/privacy-policy" },
        { label: "Acceptable Use Policy", to: "/acceptable-use-policy" },
        { label: "Refund & Cancellation Policy", to: "/refund-cancellation-policy" },
      ]}
    >
      <p className="text-muted-foreground">
        These Terms & Conditions ("Terms") govern your access to and use of the services provided by
        ClickAI Private Limited ("ClickAI", "we", "us"), including the clickai.in website and the
        ClickAI platform. By creating an account or using ClickAI, you agree to these Terms.
      </p>

      <LegalSection id="acceptance" title="1. Acceptance">
        <p>
          By accessing or using ClickAI's services, you confirm that you have the authority to bind
          the business you represent to these Terms, and that you accept them on behalf of that
          business.
        </p>
      </LegalSection>

      <LegalSection id="services" title="2. Description of services">
        <p>
          ClickAI provides a platform for configuring and operating AI employees for a business —
          including AI voice agents, AI-assisted customer support, AI sales assistance, appointment
          booking automation, and WhatsApp/messaging automation — together with related dashboards,
          call logs, and usage/billing tools. The exact features available to you depend on your
          plan and which integrations your workspace has connected.
        </p>
      </LegalSection>

      <LegalSection id="accounts" title="3. Account responsibilities">
        <p>
          You are responsible for maintaining the confidentiality of your account credentials and
          for all activity that occurs under your account. Notify us promptly at{" "}
          <a href="mailto:hello@clickai.in">hello@clickai.in</a> if you suspect unauthorized access.
        </p>
      </LegalSection>

      <LegalSection id="customer-responsibilities" title="4. Customer responsibilities">
        <p>
          As a business using ClickAI, you are responsible for the accuracy of the business
          information, pricing, policies and rules you configure, for obtaining any consents
          required to communicate with your own customers, and for complying with laws applicable to
          your industry (including, where relevant, telecom, consumer-protection, healthcare, and
          data-protection laws).
        </p>
      </LegalSection>

      <LegalSection id="agent-configuration" title="5. AI-agent configuration">
        <p>
          Your AI agent answers based on the business profile, services, pricing, rules and
          knowledge you configure. You are responsible for reviewing and keeping this configuration
          accurate — ClickAI does not independently verify the business information you enter.
        </p>
      </LegalSection>

      <LegalSection id="voice-messaging" title="6. Voice, messaging & WhatsApp">
        <p>
          Where enabled for your workspace, ClickAI's voice agents answer phone calls, and ClickAI's
          messaging tools send and receive messages over channels such as WhatsApp. These features
          depend on third-party telephony and messaging providers and are subject to those
          providers' own availability, policies and limits. See our{" "}
          <a href="/messaging-policy">Messaging Policy</a> for consent, frequency and opt-out
          details.
        </p>
      </LegalSection>

      <LegalSection id="appointments" title="7. Appointment automation">
        <p>
          Where connected to a calendar integration, ClickAI's agents can create, modify, or cancel
          appointments on your behalf, within the rules you configure. You are responsible for
          reviewing your calendar and the rules governing automated booking.
        </p>
      </LegalSection>

      <LegalSection id="integrations" title="8. Third-party integrations">
        <p>
          ClickAI integrates with third-party providers (for example, telephony, messaging,
          calendar, and payment providers) only where you have connected them. We are not
          responsible for the availability, accuracy, or performance of third-party services we do
          not operate.
        </p>
      </LegalSection>

      <LegalSection id="billing" title="9. Usage and billing">
        <p>
          Subscription charges, setup fees, and usage-based charges (such as telephony or messaging
          usage, and AI usage) are billed according to your selected plan and order terms, as shown
          in your dashboard at the time of purchase or usage. Call capacity, message throughput, and
          similar limits depend on your plan, your number configuration, and your connected
          provider's own account limits — not an unlimited or carrier-wide guarantee.
        </p>
      </LegalSection>

      <LegalSection id="prohibited-use" title="10. Prohibited use">
        <p>
          You must not use ClickAI for any purpose prohibited by our{" "}
          <a href="/acceptable-use-policy">Acceptable Use Policy</a>, which is incorporated into
          these Terms by reference.
        </p>
      </LegalSection>

      <LegalSection id="ip" title="11. Intellectual property">
        <p>
          ClickAI and its platform, software, and branding are the property of ClickAI Private
          Limited. These Terms do not transfer any ClickAI intellectual property to you, except the
          limited right to use the platform as permitted by your plan.
        </p>
      </LegalSection>

      <LegalSection id="customer-content" title="12. Customer content">
        <p>
          You retain ownership of the business information, customer data, and other content you
          submit to ClickAI ("Customer Content"). You grant ClickAI a license to process Customer
          Content solely to provide the services to you.
        </p>
      </LegalSection>

      <LegalSection id="data-processing" title="13. Data processing">
        <p>
          ClickAI processes personal data in accordance with our{" "}
          <a href="/privacy-policy">Privacy Policy</a>. Where you submit your customers' personal
          data to ClickAI, you act as the data controller for that data and ClickAI acts as a
          processor on your instructions, to the extent applicable law treats these roles that way.
        </p>
      </LegalSection>

      <LegalSection id="ai-limitations" title="14. AI limitations">
        <p>
          ClickAI's AI agents can make mistakes and do not guarantee accuracy. See our{" "}
          <a href="/ai-disclaimer">AI Disclaimer</a> for the full scope of this limitation,
          including for healthcare, financial, legal, emergency, and other safety-critical
          situations.
        </p>
      </LegalSection>

      <LegalSection id="availability" title="15. Service availability">
        <p>
          We aim to keep ClickAI available and reliable, but we do not guarantee uninterrupted or
          error-free operation. Scheduled maintenance, third-party provider outages, and factors
          outside our control may affect availability.
        </p>
      </LegalSection>

      <LegalSection id="suspension-termination" title="16. Suspension and termination">
        <p>
          We may suspend or terminate access to ClickAI where necessary to prevent abuse, comply
          with law, comply with an upstream provider's requirements, or address a breach of these
          Terms or our Acceptable Use Policy. You may cancel your subscription as described in our{" "}
          <a href="/refund-cancellation-policy">Refund & Cancellation Policy</a>.
        </p>
      </LegalSection>

      <LegalSection id="refunds" title="17. Refunds">
        <p>
          Refunds are handled according to the applicable plan or order terms shown at the time of
          purchase, and our <a href="/refund-cancellation-policy">Refund & Cancellation Policy</a>.
        </p>
      </LegalSection>

      <LegalSection id="liability" title="18. Limitation of liability">
        <p>
          To the maximum extent permitted by applicable law, ClickAI will not be liable for
          indirect, incidental, special, consequential, or punitive damages, or for lost profits or
          revenues, arising from your use of the services.
        </p>
      </LegalSection>

      <LegalSection id="indemnification" title="19. Indemnification">
        <p>
          You agree to indemnify and hold ClickAI harmless from claims arising out of your misuse of
          the services, your Customer Content, or your violation of these Terms, our Acceptable Use
          Policy, or applicable law.
        </p>
      </LegalSection>

      <LegalSection id="governing-law" title="20. Governing law">
        <p>
          These Terms are governed by the laws applicable to ClickAI Private Limited's place of
          incorporation, without regard to conflict-of-law principles, except where applicable law
          requires otherwise.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="21. Changes to these terms">
        <p>
          We may update these Terms from time to time. We will update the "Last updated" date above
          when we do. Continued use of ClickAI after an update means you accept the revised Terms.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="22. Contact information">
        <p>
          ClickAI Private Limited
          <br />
          Email: <a href="mailto:hello@clickai.in">hello@clickai.in</a>
          <br />
          Phone: <a href="tel:+917660001231">+91 76600 01231</a>
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
