import { createFileRoute } from "@tanstack/react-router";
import { ProductPage, type ProductContent } from "@/components/landing/product-page";

const CONTENT: ProductContent = {
  eyebrow: "Business Workflow Automation",
  title: "From conversation to completed task",
  intro:
    "Calls and messages become leads, bookings and follow-ups. Standard workflows work today; connections to your own systems are built to order.",
  capabilities: [
    {
      name: "Lead capture",
      detail:
        "Contact details and enquiries gathered in conversations are stored in your dashboard.",
      status: "Available",
    },
    {
      name: "Appointment workflows",
      detail: "Booking, reminder and cancellation flows.",
      status: "Available",
    },
    {
      name: "Payment links",
      detail: "Razorpay links sent in conversation.",
      status: "Needs setup",
    },
    {
      name: "CRM updates",
      detail: "HubSpot, Zoho and similar are not live integrations yet.",
      status: "Custom",
    },
    {
      name: "Webhooks and APIs",
      detail: "Send events to your systems; scoped per project.",
      status: "Custom",
    },
    {
      name: "Internal task routing",
      detail: "Notify or assign staff from a conversation; designed with you.",
      status: "Custom",
    },
  ],
  example: {
    heading: "Example of a workflow",
    turns: [
      { from: "customer", text: "I'd like a quote for next month." },
      { from: "ai", text: "Happy to help. Can I take your name, number and what you need?" },
      { from: "customer", text: "Asha, a monthly service plan." },
      { from: "ai", text: "Thanks Asha. Our team will contact you today." },
    ],
  },
  workflow: [
    { step: "Conversation", detail: "A call or message arrives." },
    { step: "Capture", detail: "Details are collected." },
    { step: "Route", detail: "Stored, and sent onward where connected." },
    { step: "Follow up", detail: "Your team or the agent follows up." },
  ],
  useCases: [
    "Lead handling for service businesses",
    "Repeat enquiries that take staff time",
    "Booking-led businesses",
    "Teams moving data between tools by hand",
  ],
  setup: [
    "List the workflows you repeat.",
    "We mark what works today and what is custom.",
    "Build and test with you.",
    "Monitor and adjust.",
  ],
  note: "Custom integrations are scoped and quoted separately; nothing marked Custom is live until built.",
  faq: [
    { q: "Which CRMs do you support?", a: "None are live yet. We scope them as custom work." },
    { q: "Do I need a developer?", a: "No. We build the connection with you." },
    { q: "How is custom work priced?", a: "Quoted per project. See the pricing page." },
  ],
};

export const Route = createFileRoute("/business-automation")({
  head: () => ({
    meta: [
      { title: "Business Workflow Automation | ClickAI" },
      {
        name: "description",
        content:
          "Connect conversations to your workflows: lead capture, notifications and custom integrations built around your business.",
      },
      { property: "og:title", content: "Business Workflow Automation | ClickAI" },
      {
        property: "og:description",
        content:
          "Connect conversations to your workflows: lead capture, notifications and custom integrations built around your business.",
      },
      { property: "og:url", content: "https://clickai.in/business-automation" },
    ],
    links: [{ rel: "canonical", href: "https://clickai.in/business-automation" }],
  }),
  component: () => <ProductPage c={CONTENT} />,
});
