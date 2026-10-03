import { createFileRoute } from "@tanstack/react-router";
import { LegalLayout, LegalSection } from "@/components/legal/LegalLayout";
import { LEGAL_LAST_UPDATED } from "@/lib/legal-dates";
import { CLICKAI_LEGAL_NAME, CLICKAI_ADDRESS_INLINE } from "@/lib/company-info";

export const Route = createFileRoute("/refund-cancellation-policy")({
  head: () => ({
    meta: [
      { title: "Refund & Cancellation Policy | ClickAI" },
      {
        name: "description",
        content:
          "How subscription cancellation, refunds, and failed payments are handled on ClickAI.",
      },
      { property: "og:title", content: "ClickAI Refund & Cancellation Policy" },
    ],
    links: [{ rel: "canonical", href: "https://clickai.in/refund-cancellation-policy" }],
  }),
  component: RefundCancellation,
});

function RefundCancellation() {
  return (
    <LegalLayout
      title="Refund & Cancellation Policy"
      lastUpdated={LEGAL_LAST_UPDATED}
      related={[{ label: "Terms & Conditions", to: "/terms" }]}
    >
      <LegalSection id="subscription-cancellation" title="Subscription cancellation">
        <p>
          You may cancel your ClickAI subscription at any time by contacting{" "}
          <a href="mailto:hello@clickai.in">hello@clickai.in</a>. Cancellation stops future billing;
          it does not automatically refund amounts already charged, except as described below.
        </p>
      </LegalSection>

      <LegalSection id="setup-and-usage-fees" title="Setup fees, usage fees, and plan charges">
        <p>
          One-time setup fees, subscription fees, and usage-based charges (including telephony,
          messaging, and AI usage charges) are billed according to your selected plan and the order
          terms shown in your dashboard at the time of purchase or usage. Those order terms control
          for your specific plan.
        </p>
      </LegalSection>

      <LegalSection id="refund-eligibility" title="Refund eligibility">
        <p>
          Refunds are handled according to the applicable plan or order terms shown to you at the
          time of purchase, and are considered on a case-by-case basis where those terms allow it.
          We do not guarantee a fixed refund window for every charge; contact{" "}
          <a href="mailto:hello@clickai.in">hello@clickai.in</a> with your request and we will
          confirm what applies to your plan.
        </p>
        <p>
          Where a refund is approved, it is processed back through our payment provider (Razorpay)
          to your original payment method. A provider-confirmed refund may be processed instantly or
          take additional time to settle, depending on the payment method and the provider's own
          processing.
        </p>
      </LegalSection>

      <LegalSection id="failed-payments" title="Failed payments">
        <p>
          If a payment fails, the related service or feature may not activate, or may be placed on
          hold, until a successful payment is confirmed by our payment provider. We will not
          activate paid features based on an unconfirmed or failed payment.
        </p>
      </LegalSection>

      <LegalSection id="suspension" title="Account suspension">
        <p>
          An account may be suspended for non-payment, policy violations, or as described in our{" "}
          <a href="/terms">Terms & Conditions</a> or{" "}
          <a href="/acceptable-use-policy">Acceptable Use Policy</a>. Suspension does not, by
          itself, entitle you to a refund of amounts already charged.
        </p>
      </LegalSection>

      <LegalSection id="contact-support" title="How to contact support">
        <p>
          For any billing, cancellation, or refund question, contact us at{" "}
          <a href="mailto:hello@clickai.in">hello@clickai.in</a> or{" "}
          <a href="tel:+917660001231">+91 76600 01231</a>.
        </p>
        <p>
          {CLICKAI_LEGAL_NAME}
          <br />
          {CLICKAI_ADDRESS_INLINE}
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
