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
 *
 * Timestamps below are the real start and end of each spoken utterance, found by
 * splitting each recording at its silences. Wording is machine-transcribed
 * (Whisper large-v3) from each file in its own language; Hindi has three
 * spelling normalisations; speakers are assigned from what is said.
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
  /** Shown above the transcript, e.g. to say the captions are machine-generated. */
  note?: string;
  segments: CallSegment[];
};

export const DEMO_CALLS: RecordedCall[] = [
  {
    id: "en",
    label: "English",
    lang: "en",
    name: "English",
    src: "/audio/click-ai-english-call-fresh.mp3",
    title: "AI Receptionist",
    segments: [
      { id: "en-1", speaker: "agent", text: "Hello.", start: 0.2, end: 0.82 },
      {
        id: "en-2",
        speaker: "agent",
        text: "Thanks for calling Bright Smile Dental Clinic.",
        start: 1.02,
        end: 3.1,
      },
      { id: "en-3", speaker: "agent", text: "How can I help you today?", start: 3.48, end: 4.44 },
      {
        id: "en-4",
        speaker: "customer",
        text: "Hi, I need to reschedule my appointment for Tuesday.",
        start: 4.88,
        end: 8.26,
      },
      {
        id: "en-5",
        speaker: "agent",
        text: "Of course, I can take care of that.",
        start: 8.86,
        end: 10.56,
      },
      {
        id: "en-6",
        speaker: "agent",
        text: "Could I have your booking ID or just your name?",
        start: 11.0,
        end: 13.44,
      },
      { id: "en-7", speaker: "customer", text: "It's Rahul.", start: 13.88, end: 14.84 },
      { id: "en-8", speaker: "agent", text: "Thanks, Rahul.", start: 15.4, end: 16.2 },
      {
        id: "en-9",
        speaker: "agent",
        text: "Let me check Tuesday for you.",
        start: 16.56,
        end: 18.32,
      },
      {
        id: "en-10",
        speaker: "agent",
        text: "I have a 3 o'clock appointment available. Would that work?",
        start: 18.9,
        end: 21.66,
      },
      {
        id: "en-11",
        speaker: "customer",
        text: "Yes, three o'clock works for me.",
        start: 22.3,
        end: 24.04,
      },
      {
        id: "en-12",
        speaker: "agent",
        text: "You're booked for Tuesday at 3.",
        start: 25.34,
        end: 26.78,
      },
      {
        id: "en-13",
        speaker: "agent",
        text: "Is there anything else I can help you with?",
        start: 27.28,
        end: 28.7,
      },
      {
        id: "en-14",
        speaker: "customer",
        text: "No, that's everything. Thank you.",
        start: 29.32,
        end: 31.0,
      },
      { id: "en-15", speaker: "agent", text: "You're welcome, Rahul.", start: 31.54, end: 32.54 },
      { id: "en-16", speaker: "agent", text: "We'll see you Tuesday.", start: 32.74, end: 33.64 },
      { id: "en-17", speaker: "agent", text: "Have a great day.", start: 33.9, end: 34.56 },
    ],
  },
  {
    // Unresolved: automatic Telugu transcription of this recording was too inaccurate to publish
    // (misspelt and garbled words), and no native review has happened yet.
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
    note: "Auto-generated captions",
    segments: [
      { id: "hi-1", speaker: "agent", text: "नमस्कार", start: 0.22, end: 0.96 },
      {
        id: "hi-2",
        speaker: "agent",
        text: "Bright Smile Dental Clinic में आपका स्वागत है",
        start: 1.16,
        end: 3.6,
      },
      {
        id: "hi-3",
        speaker: "agent",
        text: "मैं आपकी क्या मदद कर सकती हूँ?",
        start: 3.84,
        end: 5.38,
      },
      {
        id: "hi-4",
        speaker: "customer",
        text: "नमस्ते, मुझे मंगलवार की अपनी अपॉइंडमेंट का समय बदलना है।",
        start: 5.72,
        end: 9.7,
      },
      {
        id: "hi-5",
        speaker: "agent",
        text: "बिल्कुल, मैं आपकी मदद करती हूँ.",
        start: 10.16,
        end: 12.06,
      },
      {
        id: "hi-6",
        speaker: "agent",
        text: "क्या आप अपना नाम या booking ID बता सकते हैं?",
        start: 12.38,
        end: 14.96,
      },
      { id: "hi-7", speaker: "customer", text: "मेरा नाम राहुल है।", start: 15.42, end: 16.68 },
      { id: "hi-8", speaker: "agent", text: "धन्यवाद राहुल जी", start: 17.16, end: 18.26 },
      {
        id: "hi-9",
        speaker: "agent",
        text: "मैं आपका appointment देख रही हूँ.",
        start: 18.5,
        end: 19.98,
      },
      {
        id: "hi-10",
        speaker: "agent",
        text: "मंगलवार को दोपहर 3 बजे का समय उपलब्ध है",
        start: 20.42,
        end: 23.14,
      },
      {
        id: "hi-11",
        speaker: "agent",
        text: "क्या ये आपके लिए ठीक रहेगा?",
        start: 23.36,
        end: 24.82,
      },
      { id: "hi-12", speaker: "customer", text: "हाँ तीन बजे ठीक है", start: 25.28, end: 26.6 },
      { id: "hi-13", speaker: "agent", text: "बढ़िया", start: 27.12, end: 27.66 },
      {
        id: "hi-14",
        speaker: "agent",
        text: "आपका appointment मंगलवार को दोपहर 3 बजे के लिए तय कर दिया गया है",
        start: 27.92,
        end: 31.52,
      },
      {
        id: "hi-15",
        speaker: "agent",
        text: "क्या मैं आपकी किसी और चीज में मदद कर सकती हूँ?",
        start: 31.82,
        end: 34.02,
      },
      { id: "hi-16", speaker: "customer", text: "नहीं धन्यवाद", start: 34.46, end: 35.54 },
      { id: "hi-17", speaker: "agent", text: "आपका स्वागत है", start: 36.04, end: 36.96 },
      { id: "hi-18", speaker: "agent", text: "आपका दिन शुभ हो", start: 37.12, end: 38.1 },
    ],
  },
];
