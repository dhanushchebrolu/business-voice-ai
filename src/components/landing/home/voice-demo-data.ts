/**
 * The recordings shown in the hero player. It is data, not code.
 *
 * Each entry is one real recorded call in one language. To add or replace one:
 *   1. put the file in /public/audio and set `src`,
 *   2. add its transcript to `segments`, each with the real `start` and `end`
 *      (seconds into that file); an empty `segments` shows a transcript-pending
 *      state for that language and nothing is ever shown in its place,
 *   3. nothing else: the player draws that file's own waveform, follows the
 *      timestamps and lets visitors click a line to jump there.
 */

export type Speaker = "customer" | "agent";

export type CallSegment = {
  id: string;
  speaker: Speaker;
  text: string;
  /** Seconds into the recording. Leave both out until the real timestamps are known. */
  start?: number;
  end?: number;
};

export type RecordedCall = {
  id: string;
  /** Text on the language button, in the language itself. */
  label: string;
  /** BCP 47 tag of the call's language, for the button's `lang` attribute. */
  lang: string;
  /** English name, used for the accessible name of the button. */
  name: string;
  /** URL of the recording, or null while it is still being prepared. */
  src: string | null;
  title: string;
  segments: CallSegment[];
};

// Transcripts are pending: none of these recordings has a verified transcript or timestamps yet.
export const DEMO_CALLS: RecordedCall[] = [
  {
    id: "en",
    label: "English",
    lang: "en",
    name: "English",
    src: "/audio/click-ai-english-call-fresh.mp3",
    title: "AI Receptionist",
    segments: [],
  },
  {
    id: "te",
    label: "తెలుగు",
    lang: "te",
    name: "Telugu",
    src: "/audio/click-ai-telugu-call.mp3",
    title: "AI Receptionist",
    segments: [],
  },
  {
    id: "hi",
    label: "हिन्दी",
    lang: "hi",
    name: "Hindi",
    src: "/audio/click-ai-hindi-call.mp3",
    title: "AI Receptionist",
    segments: [],
  },
];
