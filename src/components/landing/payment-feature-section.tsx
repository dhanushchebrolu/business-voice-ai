/**
 * Describes how ClickAI's in-conversation payment collection is designed
 * to work end to end. This is a product-capability description (the
 * architecture this build is targeting), not a usage claim — it makes no
 * assertion about transaction volume, customer count or revenue, so it
 * doesn't run into the "no fabricated stats" rule that governs the metrics
 * section elsewhere on this page.
 */
const WORKFLOW = [
  "Customer calls or messages",
  "AI checks availability and books",
  "AI creates a payment request",
  "WhatsApp sends a QR code and payment link",
  "Customer pays",
  "Razorpay confirms the payment",
  "AI receives the payment event in real time",
  "AI confirms the booking, out loud or in chat",
];

export function PaymentFeatureSection() {
  return (
    <section className="border-t border-slate-200 bg-white py-24 sm:py-32">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <div className="grid gap-14 lg:grid-cols-2 lg:items-center lg:gap-20">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-blue-600">
              Payments
            </p>
            <h2 className="mt-4 font-serif text-4xl leading-[1.08] text-slate-900 sm:text-5xl">
              Your AI can collect payments while talking to customers.
            </h2>
            <p className="mt-6 max-w-md text-sm leading-relaxed text-slate-500 sm:text-base">
              Connect your own Razorpay account and your AI employee can generate a payment request
              mid-conversation, send a QR code or link over WhatsApp, and confirm the booking the
              moment payment is verified — never before.
            </p>
          </div>

          <ol className="space-y-0 divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-blue-50/30">
            {WORKFLOW.map((step, i) => (
              <li key={step} className="flex items-center gap-4 px-5 py-4">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-blue-600 text-[11px] font-medium text-white">
                  {i + 1}
                </span>
                <span className="text-sm text-slate-600">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
