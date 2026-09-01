/** Lockable product features. Shared by the admin control plane and the customer app. */
export const PLATFORM_FEATURES = [
  { key: "dashboard", label: "Dashboard access", description: "Signing in and using the customer dashboard at all." },
  { key: "phone", label: "Phone number & calls", description: "Assigned number, inbound and outbound calling." },
  { key: "voice", label: "AI voice agent", description: "Publishing and running the voice receptionist." },
  { key: "whatsapp", label: "WhatsApp", description: "WhatsApp inbox and AI replies." },
  { key: "chatbot", label: "Website chatbot", description: "Embeddable website chat widget." },
  { key: "campaigns", label: "Outbound campaigns", description: "CSV campaigns and bulk outbound calling." },
  { key: "appointments", label: "Appointments", description: "Calendar, bookings and staff scheduling." },
] as const;

export type FeatureKey = (typeof PLATFORM_FEATURES)[number]["key"];

export const FEATURE_LABEL: Record<string, string> = Object.fromEntries(
  PLATFORM_FEATURES.map((f) => [f.key, f.label]),
);

export type FeatureLockMap = Record<string, boolean>;
