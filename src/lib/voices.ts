import { VOICE_LANGUAGES, voiceLanguageName } from "./voice-languages.ts";

export interface LanguageDef {
  code: string;
  label: string;
  native: string;
}

/** Languages the voice agent supports end to end — see voice-languages.ts. */
export const LANGUAGES: LanguageDef[] = VOICE_LANGUAGES.map((l) => ({
  code: l.code,
  label: l.name,
  native: l.native,
}));

export function languageLabel(code: string): string {
  return voiceLanguageName(code);
}

export interface VoiceDef {
  id: string;
  name: string;
  gender: "male" | "female";
}

const MALE = [
  "Shubh",
  "Aditya",
  "Rahul",
  "Rohan",
  "Amit",
  "Dev",
  "Ratan",
  "Varun",
  "Manan",
  "Sumit",
  "Kabir",
  "Aayan",
  "Ashutosh",
  "Advait",
  "Anand",
  "Tarun",
  "Sunny",
  "Mani",
  "Gokul",
  "Vijay",
  "Mohit",
  "Rehan",
  "Soham",
];

const FEMALE = [
  "Ritu",
  "Priya",
  "Neha",
  "Pooja",
  "Simran",
  "Kavya",
  "Ishita",
  "Shreya",
  "Roopa",
  "Tanya",
  "Shruti",
  "Suhani",
  "Kavitha",
  "Rupali",
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
