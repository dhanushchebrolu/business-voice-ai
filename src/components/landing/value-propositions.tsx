const ITEMS = [
  {
    number: "01",
    title: "Customer Engagement",
    body: "AI that answers, understands and responds to customers across every channel.",
  },
  {
    number: "02",
    title: "Lead Conversion",
    body: "Qualify leads, follow up automatically and turn conversations into opportunities.",
  },
  {
    number: "03",
    title: "Business Automation",
    body: "Connect conversations to appointments, CRM workflows, notifications and business operations.",
  },
];

export function ValuePropositions() {
  return (
    <section id="value-propositions" className="bg-[#f6f3ee] py-24 sm:py-32">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <h2 className="max-w-2xl font-serif text-4xl leading-[1.08] text-[#14141a] sm:text-5xl lg:text-6xl">
          One AI platform.
          <br />
          Every customer conversation.
        </h2>

        <div className="mt-16 grid gap-14 border-t border-[#14141a]/10 pt-14 sm:grid-cols-3 sm:gap-10">
          {ITEMS.map((item) => (
            <div key={item.number}>
              <span className="font-serif text-2xl text-[#14141a]/35">{item.number}</span>
              <h3 className="mt-4 text-lg font-semibold tracking-tight text-[#14141a] sm:text-xl">
                {item.title}
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-[#14141a]/55 sm:text-base">
                {item.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
