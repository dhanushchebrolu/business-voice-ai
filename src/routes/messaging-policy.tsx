import { createFileRoute } from "@tanstack/react-router";
import { LegalLayout, LegalSection } from "@/components/legal/LegalLayout";
import { LEGAL_LAST_UPDATED } from "@/lib/legal-dates";
import { CLICKAI_LEGAL_NAME, CLICKAI_ADDRESS_INLINE } from "@/lib/company-info";

export const Route = createFileRoute("/messaging-policy")({
  head: () => ({
    meta: [
      { title: "Messaging Policy | ClickAI" },
      {
        name: "description",
        content:
          "Consent, frequency, rates and opt-out details for ClickAI's voice, WhatsApp and messaging features.",
      },
      { property: "og:title", content: "ClickAI Messaging Policy" },
    ],
    links: [{ rel: "canonical", href: "https://clickai.in/messaging-policy" }],
  }),
  component: MessagingPolicy,
});

function MessagingPolicy() {
  return (
    <LegalLayout
      title="Messaging Policy"
      lastUpdated={LEGAL_LAST_UPDATED}
      related={[
        { label: "Privacy Policy", to: "/privacy-policy" },
        { label: "Acceptable Use Policy", to: "/acceptable-use-policy" },
      ]}
    >
      <p className="text-muted-foreground">
        This policy explains how ClickAI's communication channels work today, and the consent,
        frequency, and opt-out rules that apply to each. Channels are described separately below
        because they do not all behave the same way.
      </p>

      <LegalSection id="consent" title="Consent">
        <p>
          A business using ClickAI must obtain appropriate consent before sending marketing or other
          regulated communications to its own customers through ClickAI. Providing a phone number or
          email address to request a callback, book an appointment, or ask a question is not, by
          itself, consent to ongoing marketing communications — see "Service vs. marketing
          communication" below.
        </p>
      </LegalSection>

      <LegalSection id="channels" title="Voice calls">
        <p>
          ClickAI's voice agents place and answer phone calls through a connected telephony
          provider. A phone call is not a channel with a text-based "reply to opt out" mechanism —
          if you do not want to continue a call, you can tell the AI agent directly, or ask to speak
          with a human.
        </p>
      </LegalSection>

      <LegalSection id="whatsapp" title="WhatsApp">
        <p>
          Where a business has connected WhatsApp through ClickAI, messages are sent and received
          using the WhatsApp Business Platform, subject to WhatsApp's own messaging and opt-out
          rules. WhatsApp does not use SMS-style "STOP"/"HELP" keyword handling — to stop receiving
          WhatsApp messages from a business, tell that business (or its ClickAI AI agent) directly
          that you want to opt out, or block the number in WhatsApp.
        </p>
      </LegalSection>

      <LegalSection id="sms" title="SMS">
        <p>
          ClickAI does not currently send SMS messages. If SMS messaging is introduced in the
          future, this policy will be updated before it is enabled, and standard SMS practice —
          replying <strong>STOP</strong> to opt out and <strong>HELP</strong> for assistance — will
          apply to that channel specifically, not to WhatsApp or voice calls.
        </p>
      </LegalSection>

      <LegalSection id="email" title="Email">
        <p>
          ClickAI and the businesses using it may send transactional email (for example, account
          notices or a reply to an enquiry you submitted). Any marketing email will include a clear
          way to unsubscribe.
        </p>
      </LegalSection>

      <LegalSection id="frequency-rates" title="Message frequency and rates">
        <p>
          Message frequency varies based on your interaction with the business and the communication
          service being used. Message and data rates may apply where applicable, depending on your
          mobile carrier and plan.
        </p>
      </LegalSection>

      <LegalSection id="service-vs-marketing" title="Service vs. marketing communication">
        <p>
          ClickAI distinguishes between <strong>service/transactional communication</strong> (for
          example, confirming an appointment you requested, or replying to your enquiry) and{" "}
          <strong>marketing communication</strong> (for example, promotional offers). Giving your
          number or email solely to request a callback does not, by itself, enroll you in ongoing
          marketing communications.
        </p>
      </LegalSection>

      <LegalSection id="opt-out" title="Opting out">
        <p>
          You can opt out of marketing communications at any time by telling the business or its AI
          agent directly, or by contacting us at{" "}
          <a href="mailto:hello@clickai.in">hello@clickai.in</a>.
        </p>
        <p>
          ClickAI is the brand operated by {CLICKAI_LEGAL_NAME}, {CLICKAI_ADDRESS_INLINE}.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
