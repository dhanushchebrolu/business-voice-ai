import { createFileRoute } from "@tanstack/react-router";
import { ProductPage, type ProductContent } from "@/components/landing/product-page";

const CONTENT: ProductContent = {
  surface: "voice",
  eyebrow: "AI Voice Agents",
  title: "An AI employee that answers your business calls",
  intro:
    "ClickAI voice agents pick up calls in your business's name, answer from the information you provide, book appointments and keep a record of every call.",
  capabilities: [
    {
      name: "Inbound call answering",
      detail: "Answers calls to your business number using your hours, services and FAQs.",
      status: "Available",
    },
    {
      name: "Appointment scheduling",
      detail: "Checks live availability and books into your calendar during the call.",
      status: "Available",
    },
    {
      name: "FAQ answers",
      detail: "Answers from the knowledge you add; it does not invent policies it was not given.",
      status: "Available",
    },
    {
      name: "Call history",
      detail: "Calls and outcomes are recorded in your dashboard.",
      status: "Available",
    },
    {
      name: "Outbound call campaigns",
      detail:
        "Calls to your own contacts through the campaigns feature; depends on telephony provider setup and contact consent.",
      status: "Needs setup",
    },
    {
      name: "Escalation to a person",
      detail:
        "You set a transfer number; the agent is instructed to offer it when a caller asks for a human or it cannot help. Otherwise it takes a message.",
      status: "Needs setup",
    },
    {
      name: "Lead qualification questions",
      detail: "Collect the details you specify during the call.",
      status: "Needs setup",
    },
    {
      name: "Your own systems",
      detail: "Sending call data to a CRM or internal tool is built as custom work.",
      status: "Custom",
    },
  ],
  workflow: [
    { step: "Call arrives", detail: "A customer calls your business number." },
    { step: "AI answers", detail: "The agent greets in your business's name and listens." },
    { step: "Action", detail: "It answers, checks availability or books." },
    { step: "Record", detail: "The call and any booking appear in your dashboard." },
  ],
  useCases: [
    "Clinics handling appointment calls",
    "Salons and service businesses with a busy front desk",
    "Restaurants taking booking enquiries",
    "Any business missing calls after hours",
  ],
  setup: [
    "Tell us about your business: services, hours, FAQs.",
    "We configure the agent and connect your number and calendar.",
    "You test it with real calls.",
    "Go live and review call history.",
  ],
  note: "Phone numbers and telephony run through a provider; call charges and AI usage apply. Live behaviour such as transfer depends on your provider setup.",
  faq: [
    {
      q: "Does it sound like a person?",
      a: "It is a synthetic voice and is not presented as a human. Languages and voices depend on what is configured for your account.",
    },
    {
      q: "What if it cannot answer?",
      a: "It takes a message or offers your transfer number, depending on your configuration.",
    },
    {
      q: "Can it call out?",
      a: "Outbound campaigns exist for your own contacts; they need setup and consent. Ask us for a demo.",
    },
  ],
};

export const Route = createFileRoute("/ai-voice-agents")({
  head: () => ({
    meta: [
      { title: "AI Voice Agents for Business Calls | ClickAI" },
      {
        name: "description",
        content:
          "ClickAI voice agents answer inbound business calls, book appointments, answer FAQs and record call history, configured from your business details.",
      },
      { property: "og:title", content: "AI Voice Agents for Business Calls | ClickAI" },
      {
        property: "og:description",
        content:
          "ClickAI voice agents answer inbound business calls, book appointments, answer FAQs and record call history, configured from your business details.",
      },
      { property: "og:url", content: "https://clickai.in/ai-voice-agents" },
    ],
    links: [{ rel: "canonical", href: "https://clickai.in/ai-voice-agents" }],
  }),
  component: () => <ProductPage c={CONTENT} />,
});
