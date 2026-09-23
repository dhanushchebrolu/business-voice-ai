const CLIENT_OWNS = [
  "Their own branding",
  "Their own AI agents",
  "Their own WhatsApp",
  "Their own voice numbers",
  "Their own conversations",
  "Their own customers",
  "Their own dashboard",
];

const CLIENTS = ["Client A", "Client B", "Client C"];

export function WhiteLabelSection() {
  return (
    <section id="white-label" className="border-t border-[#14141a]/10 bg-[#f6f3ee] py-24 sm:py-32">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <div className="grid gap-14 lg:grid-cols-2 lg:items-center lg:gap-20">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-[#14141a]/40">
              White-label platform
            </p>
            <h2 className="mt-4 font-serif text-4xl leading-[1.08] text-[#14141a] sm:text-5xl">
              Your AI.
              <br />
              Your brand.
              <br />
              Your clients.
            </h2>
            <p className="mt-6 max-w-md text-sm leading-relaxed text-[#14141a]/55 sm:text-base">
              ClickAI is built for agencies, businesses and white-label partners. Deploy one
              platform, run independent AI experiences for every client you serve.
            </p>
            <ul className="mt-8 grid grid-cols-2 gap-x-6 gap-y-2 text-sm text-[#14141a]/60">
              {CLIENT_OWNS.map((item) => (
                <li key={item} className="flex items-baseline gap-2">
                  <span className="text-[#14141a]/30">—</span>
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-3xl border border-[#14141a]/10 bg-white/40 p-8 sm:p-12">
            <svg
              viewBox="0 0 320 220"
              className="w-full"
              role="img"
              aria-label="ClickAI connects independently to three white-label clients"
            >
              <g stroke="rgba(20,20,26,0.18)" strokeWidth="1">
                <line x1="160" y1="42" x2="70" y2="150" />
                <line x1="160" y1="42" x2="160" y2="150" />
                <line x1="160" y1="42" x2="250" y2="150" />
              </g>
              <g>
                <circle cx="160" cy="30" r="26" fill="#14141a" />
                <text
                  x="160"
                  y="34"
                  textAnchor="middle"
                  fontSize="10"
                  fill="#f6f3ee"
                  fontFamily="var(--font-sans)"
                  fontWeight="600"
                >
                  ClickAI
                </text>
              </g>
              {CLIENTS.map((label, i) => {
                const x = 70 + i * 90;
                return (
                  <g key={label}>
                    <rect
                      x={x - 42}
                      y={150}
                      width="84"
                      height="40"
                      rx="10"
                      fill="white"
                      stroke="rgba(20,20,26,0.12)"
                    />
                    <text
                      x={x}
                      y={174}
                      textAnchor="middle"
                      fontSize="11"
                      fill="#14141a"
                      fontFamily="var(--font-sans)"
                      fontWeight="500"
                    >
                      {label}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
      </div>
    </section>
  );
}
