import { supabase } from "@/integrations/supabase/client";

/** Choices and submit logic shared by the /contact page and the homepage contact section. */
export const INDUSTRIES = [
  "Healthcare / clinics",
  "Restaurants / hospitality",
  "Real estate",
  "Education",
  "Retail / local business",
  "Professional services",
  "Other",
];
export const INTERESTS = [
  "AI Voice Agents",
  "WhatsApp AI Agents",
  "Appointment Automation",
  "Business Automation",
  "Custom integration",
];

export type DemoRequestForm = {
  name: string;
  email: string;
  phone: string;
  businessName: string;
  industry: string;
  interest: string;
  message: string;
};

export const EMPTY_DEMO_REQUEST: DemoRequestForm = {
  name: "",
  email: "",
  phone: "",
  businessName: "",
  industry: "",
  interest: "",
  message: "",
};

/** Validates and stores a demo request. Returns an error message, or null on success. */
export async function submitDemoRequest(
  form: DemoRequestForm,
  consent: boolean,
): Promise<string | null> {
  if (!consent) return "Please agree to be contacted before submitting.";
  const email = form.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return "Please enter a valid email address.";
  try {
    const { error } = await supabase.from("demo_requests").insert({
      name: form.name.trim(),
      email,
      phone: form.phone.trim() || null,
      business_name: form.businessName.trim() || null,
      // No dedicated columns exist yet for these two fields (adding them needs a migration),
      // so they are prefixed to the message the team already reads.
      message:
        [
          form.industry && `Industry: ${form.industry}`,
          form.interest && `Product interest: ${form.interest}`,
          form.message.trim(),
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 2000) || null,
      marketing_consent: consent,
    });
    if (error) throw error;
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "Could not send your request. Please try again.";
  }
}
