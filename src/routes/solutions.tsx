import { createFileRoute, Link } from "@tanstack/react-router";
import { LandingNav } from "@/components/landing/landing-nav";
import { LandingFooter } from "@/components/landing/landing-footer";
import { PageHero } from "@/components/landing/page-hero";
import { FinalCta } from "@/components/landing/final-cta";

const TITLE = "AI Employees by Industry | ClickAI";
const DESC =
  "How ClickAI voice and WhatsApp agents help clinics, restaurants, real estate, education, retail and professional services handle calls, messages and bookings.";

export const Route = createFileRoute("/solutions")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESC },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESC },
      { property: "og:url", content: "https://clickai.in/solutions" },
    ],
    links: [{ rel: "canonical", href: "https://clickai.in/solutions" }],
  }),
  component: Solutions,
});

const PRODUCTS = {
  voice: { label: "AI Voice Agents", to: "/ai-voice-agents" },
  whatsapp: { label: "WhatsApp AI Agents", to: "/whatsapp-ai-agents" },
  appointments: { label: "Appointment Automation", to: "/appointment-automation" },
  automation: { label: "Business Automation", to: "/business-automation" },
} as const;

const INDUSTRIES: {
  id: string;
  name: string;
  problem: string;
  help: string;
  workflow: string;
  custom: string;
  products: (keyof typeof PRODUCTS)[];
}[] = [
  {
    id: "healthcare",
    name: "Healthcare and clinics",
    problem: "Front-desk phones ring during consultations, and appointment changes pile up.",
    help: "The agent answers calls, books and moves appointments against your calendar, and answers common questions from information you provide. It does not give medical advice.",
    workflow: "Call → check availability → book → WhatsApp confirmation and reminder.",
    custom: "Patient-record or hospital-system integration is custom work.",
    products: ["voice", "appointments", "whatsapp"],
  },
  {
    id: "restaurants",
    name: "Restaurants and hospitality",
    problem: "Booking calls and timing questions arrive during service, when nobody can pick up.",
    help: "Answers questions about hours, menu and location, and records booking requests.",
    workflow: "Call or WhatsApp → answer or take booking details → confirm.",
    custom: "Table-management or point-of-sale connections are custom work.",
    products: ["voice", "whatsapp"],
  },
  {
    id: "real-estate",
    name: "Real estate",
    problem: "Enquiries come in at all hours and leads go cold before anyone responds.",
    help: "Responds to enquiries, collects the buyer's requirements and contact details, and books site visits.",
    workflow: "Enquiry → qualifying questions → lead stored → site-visit booking.",
    custom: "Syncing leads to a property CRM is custom work.",
    products: ["voice", "whatsapp", "automation"],
  },
  {
    id: "education",
    name: "Education",
    problem: "Admission and course questions repeat constantly, especially at peak enquiry times.",
    help: "Answers repeat questions from the material you give it and books counselling calls.",
    workflow: "Enquiry → answer → collect details → counselling slot.",
    custom: "Student-system integration is custom work.",
    products: ["whatsapp", "voice", "appointments"],
  },
  {
    id: "retail",
    name: "Retail and local business",
    problem: "Small teams lose time on store-hours, availability and appointment questions.",
    help: "Handles common questions and bookings, and can send a Razorpay payment link where payments are connected.",
    workflow: "Message → answer → booking or payment link.",
    custom: "Inventory or e-commerce store connections are custom work.",
    products: ["whatsapp", "voice", "automation"],
  },
  {
    id: "professional-services",
    name: "Professional services",
    problem: "Calls interrupt billable work, and new enquiries wait for a callback.",
    help: "Takes enquiry details, books consultations and passes the summary to your team.",
    workflow: "Call → capture details → book consultation → notify the team.",
    custom: "Practice-management software integration is custom work.",
    products: ["voice", "appointments", "automation"],
  },
];

function Solutions() {
  return (
    <div className="theme-light min-h-screen bg-white text-slate-900">
      <LandingNav />
      <PageHero
        eyebrow="Solutions"
        title="Built around how your business takes calls and messages"
        intro="The same products fit different industries. Below is what each one typically needs, and what is a custom build. ClickAI does not make compliance or clinical claims."
      />
      <main className="mx-auto grid max-w-[1200px] gap-12 px-5 py-16 sm:px-8 sm:py-24 lg:grid-cols-[220px_1fr] lg:gap-20">
        <nav aria-label="Industries" className="hidden lg:block">
          <ul className="sticky top-28 space-y-2 text-sm">
            {INDUSTRIES.map((i) => (
              <li key={i.id}>
                <a
                  href={`#${i.id}`}
                  className="block border-l-2 border-slate-200 py-1 pl-4 text-slate-500 transition-colors hover:border-violet-600 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-600"
                >
                  {i.name}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div>
          {INDUSTRIES.map((i) => (
            <section
              key={i.id}
              id={i.id}
              className="border-t border-slate-200 py-10 first:border-t-0 first:pt-0"
            >
              <h2 className="font-serif text-3xl tracking-tight">{i.name}</h2>
              <dl className="mt-6 grid gap-x-10 gap-y-5 text-sm leading-relaxed text-slate-600 sm:grid-cols-2">
                <div>
                  <dt className="font-medium text-slate-900">The problem</dt>
                  <dd className="mt-1">{i.problem}</dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-900">How ClickAI helps</dt>
                  <dd className="mt-1">{i.help}</dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-900">Example workflow</dt>
                  <dd className="mt-1">{i.workflow}</dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-900">Custom work</dt>
                  <dd className="mt-1">{i.custom}</dd>
                </div>
              </dl>
              <p className="mt-6 flex flex-wrap gap-x-5 gap-y-1 text-sm">
                {i.products.map((k) => (
                  <Link
                    key={k}
                    to={PRODUCTS[k].to}
                    className="font-medium text-violet-600 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-600"
                  >
                    {PRODUCTS[k].label}
                  </Link>
                ))}
              </p>
            </section>
          ))}
        </div>
      </main>
      <FinalCta />
      <LandingFooter />
    </div>
  );
}
