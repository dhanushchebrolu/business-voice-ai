import { INTEGRATION_GROUPS } from "@/lib/integrations-catalog";
import { Enter, H2, Marquee, MONO_P, RollNumber, ScrollFill, VxSection } from "./primitives";

const AVAILABLE = INTEGRATION_GROUPS.flatMap((g) =>
  g.items.filter((i) => i.status === "Available"),
);

/* ───── "Connects with" marquee (replaces the reference's logo strip; only real integrations) ───── */

export function ConnectsWith() {
  return (
    <section aria-label="Integrations available today" className="relative bg-[var(--vx-page)]">
      <div className="mx-auto max-w-[1425px] px-5 pb-14 pt-6 sm:px-10">
        <p className="text-center font-vmono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--vx-muted)]">
          Connects with
        </p>
        <Marquee label="Available integrations" seconds={32} className="mt-8">
          {[...AVAILABLE, ...AVAILABLE].map((it, i) => (
            <span
              key={`${it.name}-${i}`}
              className="mx-10 flex items-center gap-3 font-display text-[22px] font-medium tracking-[-0.02em] text-[var(--vx-muted)]"
            >
              <span aria-hidden="true" className="size-2 bg-[var(--vx-accent)]" />
              {it.name}
            </span>
          ))}
        </Marquee>
      </div>
    </section>
  );
}

/* ───── 01 The gap ───── */

const STATS = [
  [String(4), "Product areas", "Voice, WhatsApp, appointments, workflows"],
  [
    String(AVAILABLE.length),
    "Integrations available today",
    "Each has a connect flow in the dashboard",
  ],
  [String(5), "Steps from first call to live", "Set up with you, tested before launch"],
] as const;

export function Gap() {
  return (
    <VxSection id="gap" index="01" label="The gap">
      <div className="max-w-[760px]">
        <Enter>
          <h2 className={`${H2} text-[var(--vx-ink)]`}>
            Calls and messages arrive when nobody is free to answer them.
          </h2>
        </Enter>
        <Enter delay={40}>
          <p className={`${MONO_P} mt-6 max-w-[600px]`}>
            Phones ring during appointments and after hours. Messages wait for the next person to
            reply. ClickAI takes the repeat conversations, so your team handles the rest.
          </p>
        </Enter>
      </div>
      <dl className="mt-16 grid gap-px border-y border-[var(--vx-hair)] sm:grid-cols-3">
        {STATS.map(([value, label, note], i) => (
          <Enter key={label} delay={i * 40}>
            <div className="py-8 sm:px-6 sm:first:pl-0">
              <dd className="font-vmono text-[44px] font-medium leading-none tracking-[-0.04em] text-[var(--vx-ink)] sm:text-[56px]">
                <RollNumber value={value} />
              </dd>
              <dt className="mt-5 font-vmono text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--vx-ink)]">
                {label}
              </dt>
              <p className="mt-1 font-vmono text-[12px] text-[var(--vx-muted)]">{note}</p>
            </div>
          </Enter>
        ))}
      </dl>
    </VxSection>
  );
}

/* ───── 02 The loop: three sticky, stacking cards ───── */

function Panel({
  title,
  tag,
  children,
}: {
  title: string;
  tag: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-[var(--vx-hair)] bg-[var(--vx-card)]">
      <div className="flex items-center justify-between border-b border-[var(--vx-hair)] px-4 py-2.5 font-vmono text-[12px]">
        <span className="text-[var(--vx-ink)]">{title}</span>
        <span className="border border-[var(--vx-accent)] px-1.5 py-px text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--vx-accent)]">
          {tag}
        </span>
      </div>
      <div className="p-4 font-vmono text-[12px] leading-relaxed text-[var(--vx-ink)]">
        {children}
      </div>
    </div>
  );
}

function Pass({ label }: { label: string }) {
  return (
    <li className="flex items-center justify-between border-b border-[var(--vx-hair)] py-2.5 last:border-b-0">
      <span>{label}</span>
      <span className="border border-emerald-600/40 px-1.5 py-px text-[10px] font-medium uppercase tracking-[0.1em] text-emerald-700">
        Pass
      </span>
    </li>
  );
}

const CARDS = [
  {
    step: "01 · Configure",
    title: "Your business details become the agent's instructions.",
    text: "You enter services, opening hours, FAQs and rules. The agent answers from that information and nothing else.",
    panel: (
      <Panel title="business.md" tag="Example">
        <ol className="space-y-1.5">
          {[
            "Services and prices",
            "Opening hours and days closed",
            "FAQs and rules",
            "Transfer number for staff",
          ].map((l, i) => (
            <li key={l} className="flex gap-3">
              <span className="text-[var(--vx-muted)]">{i + 1}</span>
              {l}
            </li>
          ))}
        </ol>
      </Panel>
    ),
  },
  {
    step: "02 · Answer",
    title: "Calls and messages are answered on the channels you connect.",
    text: "Voice, WhatsApp Business, website chat and Instagram answer from your configuration, and book against your calendar.",
    panel: (
      <Panel title="channels" tag="Available">
        <ul className="flex flex-wrap gap-2">
          {["voice", "whatsapp", "website-chat", "instagram", "google-calendar", "razorpay"].map(
            (c) => (
              <li
                key={c}
                className="border border-[var(--vx-hair)] bg-[var(--vx-page)] px-2.5 py-1"
              >
                {c}
              </li>
            ),
          )}
        </ul>
      </Panel>
    ),
  },
  {
    step: "03 · Confirm",
    title: "Nothing changes without a clear yes.",
    text: "Bookings and reschedules happen after the customer confirms, and every conversation is saved in your dashboard.",
    panel: (
      <Panel title="before a booking changes" tag="Checks">
        <ul>
          <Pass label="customer_replied_yes" />
          <Pass label="slot_still_available" />
          <Pass label="booking_belongs_to_sender" />
          <Pass label="saved_in_dashboard" />
        </ul>
      </Panel>
    ),
  },
] as const;

export function Loop() {
  return (
    <VxSection id="loop" index="02" label="How it works" bg="alt">
      <ScrollFill
        text="Configure, answer, confirm. Every time, on the record."
        className="max-w-[760px] text-[28px] leading-[1.2] sm:text-[40px]"
      />
      <div className="relative mt-14">
        {CARDS.map((c, i) => (
          <div
            key={c.step}
            style={{ zIndex: i + 1 }}
            className="sticky top-[84px] border-t border-[var(--vx-hair)] bg-[var(--vx-alt)] py-10"
          >
            <div className="grid gap-8 lg:grid-cols-2 lg:gap-16">
              <div>
                <p className="font-vmono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--vx-accent-deep)]">
                  {c.step}
                </p>
                <h3 className="mt-4 text-[24px] leading-[1.2] tracking-[-0.02em] sm:text-[28px]">
                  {c.title}
                </h3>
                <p className={`${MONO_P} mt-4 max-w-[460px] text-[13px]`}>{c.text}</p>
              </div>
              {c.panel}
            </div>
          </div>
        ))}
      </div>
    </VxSection>
  );
}
