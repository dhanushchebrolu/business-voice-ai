import { createFileRoute } from "@tanstack/react-router";
import { ProductPage, type ProductContent } from "@/components/landing/product-page";

const CONTENT: ProductContent = {
  eyebrow: "Appointment Automation",
  title: "Bookings that manage themselves",
  intro:
    "Your AI employee books, reschedules and cancels appointments against the availability you set, on calls and on WhatsApp.",
  capabilities: [
    {
      name: "Working hours",
      detail: "Weekly opening hours define when customers can book.",
      status: "Available",
    },
    {
      name: "Daily overrides",
      detail: "Close a specific day or set special hours for it.",
      status: "Available",
    },
    {
      name: "Google Calendar",
      detail:
        "Connect your Google Calendar so existing events block slots and bookings are written back.",
      status: "Available",
    },
    {
      name: "Reschedule and cancel",
      detail:
        "Customers can change their own bookings; the agent only changes bookings tied to their number.",
      status: "Available",
    },
    {
      name: "Confirmations and reminders",
      detail: "Sent on WhatsApp when it is connected.",
      status: "Needs setup",
    },
    {
      name: "Other calendars",
      detail: "Outlook or booking-system sync is custom work.",
      status: "Custom",
    },
  ],
  example: {
    heading: "Example of a booking",
    turns: [
      { from: "customer", text: "I need an appointment on Thursday." },
      { from: "ai", text: "Thursday I have 10:00 am and 3:00 pm. Which one?" },
      { from: "customer", text: "3 pm." },
      { from: "ai", text: "Booked for Thursday 3:00 pm. I'll send a confirmation." },
    ],
  },
  workflow: [
    { step: "Request", detail: "Customer asks by call or WhatsApp." },
    { step: "Check", detail: "Hours, overrides and calendar are checked." },
    { step: "Book", detail: "The slot is reserved without double-booking." },
    { step: "Notify", detail: "Confirmation and reminders go out." },
  ],
  useCases: [
    "Clinics and dental practices",
    "Salons and wellness",
    "Consultants and professional services",
    "Coaching and education enquiries",
  ],
  setup: [
    "Set weekly hours and services.",
    "Add any day-specific closures.",
    "Connect Google Calendar.",
    "Test a booking end to end.",
  ],
  note: "If a Google Calendar sync fails the booking is kept and flagged for retry.",
  faq: [
    { q: "Will it double-book?", a: "Availability is re-checked at the moment of booking." },
    { q: "Which calendars work?", a: "Google Calendar today. Others are custom." },
    {
      q: "Can customers pay when booking?",
      a: "Razorpay payment links are supported for priced services once connected.",
    },
  ],
};

export const Route = createFileRoute("/appointment-automation")({
  head: () => ({
    meta: [
      { title: "Appointment Booking Automation | ClickAI" },
      {
        name: "description",
        content:
          "Automate appointment booking with working hours, daily overrides and Google Calendar sync, over calls and WhatsApp.",
      },
      { property: "og:title", content: "Appointment Booking Automation | ClickAI" },
      {
        property: "og:description",
        content:
          "Automate appointment booking with working hours, daily overrides and Google Calendar sync, over calls and WhatsApp.",
      },
      { property: "og:url", content: "https://clickai.in/appointment-automation" },
    ],
    links: [{ rel: "canonical", href: "https://clickai.in/appointment-automation" }],
  }),
  component: () => <ProductPage c={CONTENT} />,
});
