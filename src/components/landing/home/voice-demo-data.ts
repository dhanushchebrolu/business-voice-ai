/**
 * The recorded call shown in the hero player. To ship the real recording:
 *   1. put the file in /public/audio and set `src`,
 *   2. replace `segments` with the real transcript and its timestamps (seconds),
 *   3. set `synced: true`.
 * Until then `synced` stays false and the player shows the script as a preview
 * only: no highlighting, auto-scroll, click-to-seek or action ticks, because the
 * placeholder tones contain no speech to follow.
 */

export type Speaker = "caller" | "agent";

export type CallSegment = {
  id: string;
  speaker: Speaker;
  text: string;
  /** Seconds into the recording. Ignored while `synced` is false. */
  start: number;
  end: number;
};

export type CallAction = {
  label: string;
  /** Seconds at which this step is complete in the recording. Ignored while `synced` is false. */
  at: number;
};

export type RecordedCall = {
  src: string;
  title: string;
  callType: string;
  /** true only when `segments` and `actions` carry real timestamps from the recording. */
  synced: boolean;
  segments: CallSegment[];
  actions: CallAction[];
};

export const DEMO_CALL: RecordedCall = {
  src: "/audio/ai-receptionist-demo.mp3",
  title: "AI Receptionist",
  callType: "Appointment booking",
  synced: false,
  segments: [
    {
      id: "s1",
      speaker: "caller",
      text: "Hi, I'd like to book an appointment for tomorrow.",
      start: 0,
      end: 4,
    },
    {
      id: "s2",
      speaker: "agent",
      text: "Of course. What time works best for you?",
      start: 4,
      end: 8,
    },
    { id: "s3", speaker: "caller", text: "Around 4 PM, if that's possible.", start: 8, end: 11 },
    {
      id: "s4",
      speaker: "agent",
      text: "Let me check the calendar. Yes, 4 PM is free.",
      start: 11,
      end: 14,
    },
    {
      id: "s5",
      speaker: "agent",
      text: "I've booked it for you, and a confirmation will be sent.",
      start: 14,
      end: 16.5,
    },
  ],
  actions: [
    { label: "Call answered", at: 0 },
    { label: "Request understood", at: 4 },
    { label: "Calendar checked", at: 12 },
    { label: "Free time found", at: 13 },
    { label: "Appointment booked", at: 15 },
    { label: "Confirmation sent", at: 16 },
  ],
};
