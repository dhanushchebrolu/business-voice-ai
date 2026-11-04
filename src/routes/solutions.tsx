import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { LandingNav } from "@/components/landing/landing-nav";
import { LandingFooter } from "@/components/landing/landing-footer";

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
      <main className="mx-auto max-w-[1100px] px-5 py-16 sm:px-8 sm:py-20">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-violet-600">Solutions</p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
          Built around how your business takes calls and messages
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-slate-600">
          The same products fit different industries. Below is what each one typically needs, and
          what is a custom build. ClickAI does not make compliance or clinical claims.
        </p>

        <div className="mt-12 divide-y divide-slate-200 border-y border-slate-200">
          {INDUSTRIES.map((i) => (
            <section key={i.id} id={i.id} className="grid gap-6 py-10 lg:grid-cols-[260px_1fr]">
              <h2 className="text-xl font-semibold tracking-tight">{i.name}</h2>
              <div className="space-y-4 text-sm leading-relaxed text-slate-600">
                <p>
                  <span className="font-medium text-slate-900">The problem. </span>
                  {i.problem}
                </p>
                <p>
                  <span className="font-medium text-slate-900">How ClickAI helps. </span>
                  {i.help}
                </p>
                <p>
                  <span className="font-medium text-slate-900">Example workflow. </span>
                  {i.workflow}
                </p>
                <p>
                  <span className="font-medium text-slate-900">Custom. </span>
                  {i.custom}
                </p>
                <p className="flex flex-wrap gap-x-4 gap-y-1">
                  {i.products.map((k) => (
                    <Link
                      key={k}
                      to={PRODUCTS[k].to}
                      className="font-medium text-violet-600 underline underline-offset-2"
                    >
                      {PRODUCTS[k].label}
                    </Link>
                  ))}
                </p>
              </div>
            </section>
          ))}
        </div>

        <div className="mt-12">
          <Link to="/contact">
            <Button size="lg" className="rounded-full bg-violet-600 px-6 text-white">
              Book a Demo
            </Button>
          </Link>
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}
