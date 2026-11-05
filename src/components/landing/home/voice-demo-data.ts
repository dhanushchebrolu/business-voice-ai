/**
 * The call shown in the hero player. It is data, not code.
 *
 * To ship the real recording:
 *   1. put the file in /public/audio and set `src` to its URL,
 *   2. give every segment its real `start` and `end` (seconds into the file),
 *   3. replace the sample text with the real transcript.
 * That is all: with a `src` the player plays it, draws its real waveform, follows
 * the segment timestamps and lets visitors click a line to jump there.
 *
 * While `src` is null the player shows a recording-pending state and the sample
 * script below. Sample segments have no timestamps, so nothing can pretend to be
 * in sync with audio that does not exist.
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
  /** URL of the real recording, or null while it is still being prepared. */
  src: string | null;
  title: string;
  callType: string;
  segments: CallSegment[];
};

export const DEMO_CALL: RecordedCall = {
  src: null,
  title: "AI Receptionist",
  callType: "Appointment booking",
  segments: [
    { id: "s1", speaker: "customer", text: "Hi, I'd like to book an appointment for tomorrow." },
    { id: "s2", speaker: "agent", text: "Of course. What time works best for you?" },
    { id: "s3", speaker: "customer", text: "Around 4 PM, if that's possible." },
    { id: "s4", speaker: "agent", text: "Let me check the calendar. Yes, 4 PM is free." },
    {
      id: "s5",
      speaker: "agent",
      text: "I've booked it for you, and a confirmation will be sent.",
    },
  ],
};
