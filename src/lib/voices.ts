export interface LanguageDef {
  code: string;
  label: string;
  native: string;
}

/** Languages currently supported by the Sarvam speech stack. */
export const LANGUAGES: LanguageDef[] = [
  { code: "en-IN", label: "English", native: "English" },
  { code: "hi-IN", label: "Hindi", native: "हिन्दी" },
  { code: "bn-IN", label: "Bengali", native: "বাংলা" },
  { code: "ta-IN", label: "Tamil", native: "தமிழ்" },
  { code: "te-IN", label: "Telugu", native: "తెలుగు" },
  { code: "gu-IN", label: "Gujarati", native: "ગુજરાતી" },
  { code: "kn-IN", label: "Kannada", native: "ಕನ್ನಡ" },
  { code: "ml-IN", label: "Malayalam", native: "മലയാളം" },
  { code: "mr-IN", label: "Marathi", native: "मराठी" },
  { code: "pa-IN", label: "Punjabi", native: "ਪੰਜਾਬੀ" },
  { code: "od-IN", label: "Odia", native: "ଓଡ଼ିଆ" },
];

export function languageLabel(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

export interface VoiceDef {
  id: string;
  name: string;
  gender: "male" | "female";
}

const MALE = [
  "Shubh", "Aditya", "Rahul", "Rohan", "Amit", "Dev", "Ratan", "Varun", "Manan", "Sumit",
  "Kabir", "Aayan", "Ashutosh", "Advait", "Anand", "Tarun", "Sunny", "Mani", "Gokul",
  "Vijay", "Mohit", "Rehan", "Soham",
];

const FEMALE = [
  "Ritu", "Priya", "Neha", "Pooja", "Simran", "Kavya", "Ishita", "Shreya", "Roopa",
  "Tanya", "Shruti", "Suhani", "Kavitha", "Rupali",
];

/** Bulbul v3 speakers. IDs are stored lowercase. */
export const VOICES: VoiceDef[] = [
  ...FEMALE.map((name) => ({ id: name.toLowerCase(), name, gender: "female" as const })),
  ...MALE.map((name) => ({ id: name.toLowerCase(), name, gender: "male" as const })),
];

export function voiceById(id: string): VoiceDef | undefined {
  return VOICES.find((v) => v.id === id);
}

export const PACE_MIN = 0.5;
export const PACE_MAX = 2.0;
