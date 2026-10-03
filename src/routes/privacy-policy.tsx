import { createFileRoute } from "@tanstack/react-router";
import { LegalLayout, LegalSection } from "@/components/legal/LegalLayout";
import { LEGAL_LAST_UPDATED } from "@/lib/legal-dates";

export const Route = createFileRoute("/privacy-policy")({
  head: () => ({
    meta: [
      { title: "ClickAI Privacy Policy | ClickAI" },
      {
        name: "description",
        content:
          "How ClickAI Private Limited collects, uses, stores and protects information for its AI business automation platform.",
      },
      { property: "og:title", content: "ClickAI Privacy Policy" },
    ],
    links: [{ rel: "canonical", href: "https://clickai.in/privacy-policy" }],
  }),
  component: PrivacyPolicy,
});

const TOC = [
  { id: "information-collected", label: "Information we collect" },
  { id: "how-we-use", label: "How we use information" },
  { id: "ai-processing", label: "AI processing" },
  { id: "voice-and-communications", label: "Voice and communications" },
  { id: "third-party-providers", label: "Third-party providers" },
  { id: "data-retention", label: "Data retention" },
  { id: "security", label: "Security" },
  { id: "your-rights", label: "Your rights" },
  { id: "changes", label: "Changes to this policy" },
  { id: "contact", label: "Contact us" },
];

function PrivacyPolicy() {
  return (
    <LegalLayout
      title="Privacy Policy"
      lastUpdated={LEGAL_LAST_UPDATED}
      toc={TOC}
      related={[
        { label: "Terms & Conditions", to: "/terms" },
        { label: "Messaging Policy", to: "/messaging-policy" },
        { label: "Cookie Policy", to: "/cookie-policy" },
        { label: "AI Disclaimer", to: "/ai-disclaimer" },
      ]}
    >
      <p className="text-muted-foreground">
        This Privacy Policy explains how ClickAI Private Limited ("ClickAI", "we", "us") collects,
        uses, stores and protects information when you visit clickai.in, use our platform, or
        interact with a business that uses ClickAI's AI agents on their behalf.
      </p>

      <LegalSection id="information-collected" title="1. Information we collect">
        <p>Depending on how you interact with ClickAI, we may collect:</p>
        <ul>
          <li>Name and business name</li>
          <li>Email address and phone number</li>
          <li>Account and workspace configuration information</li>
          <li>Contact-form and demo-request information</li>
          <li>Appointment and booking information you or your customers provide</li>
          <li>Customer messages exchanged through a ClickAI-powered channel</li>
          <li>
            Voice interaction data and call metadata (call time, duration, and outcome) for calls
            handled by a ClickAI voice agent
          </li>
          <li>
            Call recordings and transcripts,{" "}
            <strong>only where a workspace has recording or transcription actually enabled</strong>{" "}
            — see "Voice and communications" below
          </li>
          <li>
            WhatsApp and other message-channel data, where a business has connected that channel
          </li>
          <li>Website usage information, IP address, and device/browser information</li>
          <li>Cookies and analytics information (see our Cookie Policy)</li>
          <li>
            Payment and billing information — processed by our payment provider; ClickAI does not
            store full card numbers
          </li>
        </ul>
        <p>
          We do not claim to collect categories of information that ClickAI does not actually
          process for your workspace or interaction.
        </p>
      </LegalSection>

      <LegalSection id="how-we-use" title="2. How we use information">
        <p>We use information to:</p>
        <ul>
          <li>Provide and operate ClickAI's services, including its AI agents</li>
          <li>Process customer requests, enquiries, and bookings</li>
          <li>Schedule and manage appointments</li>
          <li>Send transactional communications (confirmations, receipts, account notices)</li>
          <li>Provide customer and technical support</li>
          <li>Process billing and payments</li>
          <li>Maintain security and prevent fraud or abuse</li>
          <li>Improve the reliability and quality of our services</li>
          <li>Produce aggregate analytics</li>
          <li>Comply with applicable law</li>
        </ul>
      </LegalSection>

      <LegalSection id="ai-processing" title="3. AI processing">
        <p>
          ClickAI processes information through AI systems (including third-party speech-to-text,
          text-to-speech and language-model providers) in order to provide the services you or a
          business configured ClickAI to provide — for example, understanding a caller's request or
          drafting a reply.
        </p>
        <p>
          If you are a business using ClickAI, you are responsible for ensuring you have the
          appropriate authorization and consent to provide your customers' information to ClickAI
          and to have it processed by AI systems on your behalf.
        </p>
        <p>
          AI-generated responses are not guaranteed to always be accurate. See our{" "}
          <a href="/ai-disclaimer">AI Disclaimer</a> for more detail, particularly for healthcare,
          financial, legal, emergency, or other safety-critical situations.
        </p>
      </LegalSection>

      <LegalSection id="voice-and-communications" title="4. Voice and communications">
        <p>
          If you call a business that uses a ClickAI voice agent, your call may be answered by an
          automated AI system rather than a human.
        </p>
        <p>
          Whether a call is recorded or transcribed depends entirely on how that specific workspace
          is configured. Where recording or transcription is enabled for a workspace, we process and
          store that audio or transcript in order to operate the service, improve reliability, and
          provide the business with a record of the interaction, for as long as described under
          "Data retention" below. Where it is not enabled, ClickAI does not produce or retain a
          recording of that call.
        </p>
        <p>
          A business using ClickAI for calls is responsible for obtaining any consent or disclosure
          required under the laws applicable to it (for example, call-recording consent
          requirements) before enabling recording.
        </p>
      </LegalSection>

      <LegalSection id="third-party-providers" title="5. Third-party providers">
        <p>
          We work with third-party providers to deliver ClickAI's services. Depending on which
          features a workspace uses, this may include providers in the following categories:
        </p>
        <ul>
          <li>Cloud hosting and infrastructure</li>
          <li>Telephony providers, for connecting and routing phone calls</li>
          <li>Messaging providers, for WhatsApp and other message channels</li>
          <li>Speech-to-text and text-to-speech providers</li>
          <li>AI/language-model providers, for generating conversational responses</li>
          <li>Payment providers, for processing transactions</li>
          <li>Calendar providers, for appointment scheduling</li>
          <li>Analytics providers, for understanding website usage</li>
        </ul>
        <p>
          We only use a provider in a category above where that integration actually exists for your
          workspace or on this website. Naming a provider category here is not an endorsement by, or
          of, that provider, and does not imply a partnership beyond the ordinary customer
          relationship of using their service.
        </p>
      </LegalSection>

      <LegalSection id="data-retention" title="6. Data retention">
        <p>
          We retain information only for as long as reasonably necessary to provide our services,
          meet contractual obligations, comply with legal requirements, resolve disputes, maintain
          security, and support other legitimate business purposes. Retention periods vary by the
          type of data and the purpose it was collected for, and we have not published a single
          fixed retention period for every category of data at this time.
        </p>
      </LegalSection>

      <LegalSection id="security" title="7. Security">
        <p>
          We use reasonable technical and organizational measures designed to protect information
          against unauthorized access, loss, misuse or alteration. No method of transmission or
          storage is completely secure, and we cannot guarantee absolute security.
        </p>
      </LegalSection>

      <LegalSection id="your-rights" title="8. Your rights">
        <p>
          Depending on your relationship with ClickAI and applicable law, you may have the right to:
        </p>
        <ul>
          <li>Access the information we hold about you</li>
          <li>Request correction of inaccurate information</li>
          <li>Request deletion of your information</li>
          <li>Withdraw consent, where processing is based on consent</li>
          <li>Raise a privacy enquiry or complaint</li>
        </ul>
        <p>
          To exercise any of these rights, contact us at{" "}
          <a href="mailto:hello@clickai.in">hello@clickai.in</a>.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="9. Changes to this policy">
        <p>
          We may update this Privacy Policy from time to time. We will update the "Last updated"
          date above when we do. Continued use of ClickAI after an update means you accept the
          revised policy.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="10. Contact us">
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
