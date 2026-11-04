/**
 * Single source for the integrations page and the home-page integrations
 * ledger. "Available" is limited to what has a connect flow in the dashboard
 * today; an existing public API alone does not make an integration live.
 */
export type IntegrationStatus = "Available" | "In development" | "Custom integration";

/**
 * "Available" is limited to what has a connect flow in the dashboard
 * (see IntegrationsSection and app.integrations): WhatsApp Business,
 * voice telephony, website chat, Instagram, Google Calendar and Razorpay.
 * Everything else is not live; an existing public API does not make it so.
 */
export const INTEGRATION_GROUPS: {
  heading: string;
  items: { name: string; status: IntegrationStatus }[];
}[] = [
  {
    heading: "Communication",
    items: [
      { name: "WhatsApp Business", status: "Available" },
      { name: "Voice telephony", status: "Available" },
      { name: "Website chat", status: "Available" },
      { name: "Instagram", status: "Available" },
      { name: "SMS", status: "In development" },
      { name: "Email", status: "In development" },
    ],
  },
  {
    heading: "Calendars",
    items: [
      { name: "Google Calendar", status: "Available" },
      { name: "Outlook / Microsoft 365", status: "Custom integration" },
    ],
  },
  {
    heading: "CRM",
    items: [
      { name: "HubSpot", status: "In development" },
      { name: "Zoho CRM", status: "In development" },
      { name: "Salesforce", status: "Custom integration" },
      { name: "Pipedrive", status: "Custom integration" },
    ],
  },
  { heading: "Payments", items: [{ name: "Razorpay", status: "Available" }] },
  {
    heading: "Databases and e-commerce",
    items: [
      { name: "Your database", status: "Custom integration" },
      { name: "Shopify", status: "In development" },
      { name: "WooCommerce", status: "In development" },
    ],
  },
  {
    heading: "Automation and APIs",
    items: [
      { name: "Webhooks", status: "Custom integration" },
      { name: "Your own APIs", status: "Custom integration" },
    ],
  },
];
