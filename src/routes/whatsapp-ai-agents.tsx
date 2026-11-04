import { createFileRoute } from "@tanstack/react-router";
import { ProductPage, type ProductContent } from "@/components/landing/product-page";

const CONTENT: ProductContent = {
  surface: "whatsapp",
  eyebrow: "WhatsApp AI Agents",
  title: "Reply to customers on WhatsApp, around the clock",
  intro:
    "Connect your WhatsApp Business number and your AI employee answers enquiries, helps customers book, and hands over to your team when asked.",
  capabilities: [
    {
      name: "AI replies to enquiries",
      detail: "Answers from your business information on the official WhatsApp Business Platform.",
      status: "Available",
    },
    {
      name: "Booking and rescheduling",
      detail:
        "The agent proposes a booking or change and the customer confirms with YES before anything happens.",
      status: "Available",
    },
    {
      name: "Booking notifications",
      detail: "Confirmation, reschedule, cancellation and reminder messages.",
      status: "Available",
    },
    {
      name: "Human handoff",
      detail:
        "If a customer asks for a person, AI replies stop for that conversation so your team can take over.",
      status: "Available",
    },
    {
      name: "Opt-out handling",
      detail: "STOP and START are recorded and respected.",
      status: "Available",
    },
    {
      name: "Message templates and campaigns",
      detail: "Templates synced from Meta; campaigns only go to opted-in contacts.",
      status: "Needs setup",
    },
    {
      name: "CRM or other tools",
      detail: "Syncing chats with external systems is custom work.",
      status: "Custom",
    },
  ],
  workflow: [
    {
      step: "Message arrives",
      detail: "Meta delivers the message to ClickAI, verified by signature.",
    },
    { step: "AI replies", detail: "The agent answers from your information." },
    { step: "Customer confirms", detail: "Bookings change only after a clear YES." },
    { step: "Handoff", detail: "Your team can take over any conversation." },
  ],
  useCases: [
    "Appointment reminders and changes",
    "Pre-sales enquiries",
    "Order and booking questions",
    "Follow-ups with customers who opted in",
  ],
  setup: [
    "Connect your WhatsApp Business account through Meta's signup.",
    "Add your business information to the agent.",
    "Choose which actions the agent may take.",
    "Test in your dashboard, then go live.",
  ],
  note: "WhatsApp messaging uses Meta's official Business Platform; Meta's rules, template approval and conversation charges apply. The chat above is a drawn example, not a live WhatsApp window.",
  faq: [
    {
      q: "Is this the official WhatsApp API?",
      a: "Yes. It connects through the WhatsApp Business Platform, not an unofficial method.",
    },
    {
      q: "Can I message anyone?",
      a: "No. Marketing messages go only to contacts with recorded consent.",
    },
    { q: "Can staff reply?", a: "Yes. Conversations appear in your dashboard." },
  ],
};

export const Route = createFileRoute("/whatsapp-ai-agents")({
  head: () => ({
    meta: [
      { title: "WhatsApp AI Agents for Business | ClickAI" },
      {
        name: "description",
        content:
          "ClickAI WhatsApp agents reply to customer messages on the official WhatsApp Business Platform, handle bookings and hand off to your team.",
      },
      { property: "og:title", content: "WhatsApp AI Agents for Business | ClickAI" },
      {
        property: "og:description",
        content:
          "ClickAI WhatsApp agents reply to customer messages on the official WhatsApp Business Platform, handle bookings and hand off to your team.",
      },
      { property: "og:url", content: "https://clickai.in/whatsapp-ai-agents" },
    ],
    links: [{ rel: "canonical", href: "https://clickai.in/whatsapp-ai-agents" }],
  }),
  component: () => <ProductPage c={CONTENT} />,
});
