const INDUSTRIES = [
  {
    name: "Restaurants & Cafés",
    capabilities: "Food ordering, table reservations, delivery support",
  },
  { name: "Hotels & Resorts", capabilities: "Room booking, availability, check-in information" },
  { name: "Hospitals & Clinics", capabilities: "Doctor appointments, token management, reminders" },
  { name: "Salons & Spas", capabilities: "Service booking, stylist selection, reminders" },
  { name: "Retail Stores", capabilities: "Product enquiries, order placement, delivery tracking" },
  { name: "Diagnostic Centers", capabilities: "Test booking, home sample collection, reports" },
  { name: "Service Businesses", capabilities: "Bookings, site visits, quotations, follow-ups" },
  { name: "E-commerce / D2C", capabilities: "Order placement, payment support, returns" },
];

export function IndustriesSection() {
  return (
    <section id="industries" className="border-t border-[#14141a]/10 bg-[#f6f3ee] py-24 sm:py-32">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-[#14141a]/40">
          Industries
        </p>
        <h2 className="mt-4 max-w-xl font-serif text-4xl leading-[1.08] text-[#14141a] sm:text-5xl">
          AI built for your business.
        </h2>

        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {INDUSTRIES.map((industry) => (
            <div
              key={industry.name}
              className="rounded-2xl border border-[#14141a]/10 bg-white p-6"
            >
              <h3 className="text-base font-semibold tracking-tight text-[#14141a]">
                {industry.name}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-[#14141a]/55">
                {industry.capabilities}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
