import { normalizeVoiceLanguageCode, type VoiceLanguageCode } from "./voice-languages.ts";

/**
 * Deterministic booking, availability and reschedule outcome sentences for
 * non-English calls, plus language-aware detection of the conversation-state
 * phrases the runtime keys on ("anything else?", goodbyes, "no, that's all").
 *
 * WHY DETERMINISTIC: the runtime can check model wording for a false
 * booking claim only in English (voice-runtime.server.ts
 * isClaimCheckableText). On any other call it used to either let the model
 * phrase the outcome unchecked — so a mistranslated date, time or "it's
 * booked" could reach the caller — or fall back to the verified English
 * sentence, which the caller may not understand. These templates are filled
 * only from the real tool result (dates, times, service names), formatted
 * for the caller's language with Intl, so nothing can be invented and
 * nothing English is spoken on a non-English call.
 *
 * English calls keep the runtime's existing English sentences:
 * callOutcomeLine returns null for English.
 *
 * Templates are short, plain and passive or first-person-plural, avoiding
 * gendered first-person verbs (the voice may be male or female). They should
 * be reviewed by a native speaker of each language before being relied on.
 */

type NonEnglish = Exclude<VoiceLanguageCode, "en-IN">;

/** Intl locale per language — Odia is `or` to ICU, `od-IN` to Sarvam TTS. */
const INTL_LOCALE: Record<VoiceLanguageCode, string> = {
  "en-IN": "en-IN",
  "hi-IN": "hi-IN",
  "bn-IN": "bn-IN",
  "ta-IN": "ta-IN",
  "te-IN": "te-IN",
  "gu-IN": "gu-IN",
  "kn-IN": "kn-IN",
  "ml-IN": "ml-IN",
  "mr-IN": "mr-IN",
  "pa-IN": "pa-IN",
  "od-IN": "or-IN",
};

/** Raw facts from the real tool result — never model output. */
export interface OutcomeFacts {
  /** Local calendar date, YYYY-MM-DD. */
  date?: string | null;
  /** Local wall-clock time, HH:mm (24h). */
  time?: string | null;
  /** Real open slot start instants (ISO UTC), listed in order. */
  slotStarts?: string[];
  /** The business's IANA timezone, for slotStarts / appointment instants. */
  timeZone?: string;
  service?: string | null;
  /** The caller's name, for a booking summary. */
  customerName?: string | null;
  /** One existing appointment (reschedule). */
  appointment?: { service: string | null; startIso: string } | null;
  /** Several existing appointments (reschedule: "which one?"). */
  appointments?: { service: string | null; startIso: string }[];
}

interface Formatted {
  date: string;
  time: string;
  /** date and time together, or whichever is known, or "that time". */
  when: string;
  /** slotStarts as a localized "A, B or C" list. */
  times: string;
  service: string;
  /** The caller's name, or "" when not known. */
  name: string;
  /** The single appointment: service, date, time. */
  booking: string;
  /** The appointments as a localized "A, B and C" list. */
  list: string;
}

const APPOINTMENT_WORD: Record<NonEnglish, string> = {
  "hi-IN": "अपॉइंटमेंट",
  "bn-IN": "অ্যাপয়েন্টমেন্ট",
  "ta-IN": "அப்பாயிண்ட்மெண்ட்",
  "te-IN": "అపాయింట్మెంట్",
  "gu-IN": "એપોઇન્ટમેન્ટ",
  "kn-IN": "ಅಪಾಯಿಂಟ್ಮೆಂಟ್",
  "ml-IN": "അപ്പോയിന്റ്മെന്റ്",
  "mr-IN": "अपॉइंटमेंट",
  "pa-IN": "ਅਪੌਇੰਟਮੈਂਟ",
  "od-IN": "ଆପଏଣ୍ଟମେଣ୍ଟ",
};

const THAT_TIME: Record<NonEnglish, string> = {
  "hi-IN": "वह समय",
  "bn-IN": "সেই সময়",
  "ta-IN": "அந்த நேரம்",
  "te-IN": "ఆ సమయం",
  "gu-IN": "તે સમય",
  "kn-IN": "ಆ ಸಮಯ",
  "ml-IN": "ആ സമയം",
  "mr-IN": "ती वेळ",
  "pa-IN": "ਉਹ ਸਮਾਂ",
  "od-IN": "ସେହି ସମୟ",
};

function safeFormat(locale: string, options: Intl.DateTimeFormatOptions, instant: Date): string {
  try {
    return new Intl.DateTimeFormat(locale, options).format(instant);
  } catch {
    // An unknown timezone falls back to UTC rather than failing the turn.
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(instant);
  }
}

const DATE_OPTIONS = { weekday: "long", day: "numeric", month: "long" } as const;
const TIME_OPTIONS = { hour: "numeric", minute: "2-digit" } as const;

/** A YYYY-MM-DD local date, named in the language ("शुक्रवार, 30 अक्टूबर"). */
export function formatLocalDate(language: string, ymd: string): string {
  const code = normalizeVoiceLanguageCode(language) ?? "en-IN";
  const instant = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(instant.getTime())) return ymd;
  return safeFormat(INTL_LOCALE[code], { ...DATE_OPTIONS, timeZone: "UTC" }, instant);
}

/** An HH:mm local time, formatted for the language ("3:00 PM"). */
export function formatLocalTime(language: string, hhmm: string): string {
  const code = normalizeVoiceLanguageCode(language) ?? "en-IN";
  const instant = new Date(`2000-01-01T${hhmm}:00Z`);
  if (Number.isNaN(instant.getTime())) return hhmm;
  return safeFormat(INTL_LOCALE[code], { ...TIME_OPTIONS, timeZone: "UTC" }, instant);
}

function formatInstant(
  language: VoiceLanguageCode,
  iso: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso;
  return safeFormat(INTL_LOCALE[language], { ...options, timeZone }, instant);
}

function formatList(language: VoiceLanguageCode, items: string[], type: "or" | "and"): string {
  try {
    return new Intl.ListFormat(INTL_LOCALE[language], {
      type: type === "or" ? "disjunction" : "conjunction",
    }).format(items);
  } catch {
    return items.join(", ");
  }
}

function format(language: NonEnglish, facts: OutcomeFacts): Formatted {
  const tz = facts.timeZone ?? "UTC";
  const date = facts.date ? formatLocalDate(language, facts.date) : "";
  const time = facts.time ? formatLocalTime(language, facts.time) : "";
  const describe = (a: { service: string | null; startIso: string }) =>
    `${a.service?.trim() || APPOINTMENT_WORD[language]}, ${formatInstant(language, a.startIso, tz, DATE_OPTIONS)}, ${formatInstant(language, a.startIso, tz, TIME_OPTIONS)}`;
  return {
    date,
    time,
    when: [date, time].filter(Boolean).join(", ") || THAT_TIME[language],
    times: formatList(
      language,
      (facts.slotStarts ?? []).map((iso) => formatInstant(language, iso, tz, TIME_OPTIONS)),
      "or",
    ),
    service: facts.service?.trim() || APPOINTMENT_WORD[language],
    name: facts.customerName?.trim() ?? "",
    booking: facts.appointment ? describe(facts.appointment) : APPOINTMENT_WORD[language],
    list: formatList(language, (facts.appointments ?? []).map(describe), "and"),
  };
}

export type OutcomeKey =
  // availability
  | "slotAvailable"
  | "slotUnavailableAgain"
  | "calendarCheckFailed"
  | "slotUnavailableAlternatives"
  | "slotUnavailableNoneThatDay"
  | "noSlotsOnDate"
  | "noSlotsInPeriod"
  | "slotsOnDate"
  // booking
  | "lineCannotBook"
  | "bookingSlotTaken"
  | "bookingFailed"
  | "invalidPhone"
  | "bookingSaved"
  | "bookingPending"
  | "bookingConfirmed"
  | "appointmentConfirmed"
  | "appointmentSaved"
  | "notBookedYet"
  /** Every detail known: the short summary (name, service, date, time) and the one question that books it — the runtime's own booking question. */
  | "confirmBooking"
  /** Nothing booked yet, every detail known: reads them back and asks to book — the runtime's own booking question. */
  | "notBookedYetConfirm"
  | "noReminders"
  // reschedule
  | "rescheduleKept"
  | "rescheduleNeedsCallerNumber"
  | "rescheduleNotFound"
  | "rescheduleNotPossible"
  | "rescheduleLookupFailed"
  | "rescheduleWhich"
  | "rescheduleAskNewTime"
  | "rescheduleAskTimeOnDate"
  | "rescheduleConfirm"
  | "rescheduleSameTime"
  | "rescheduleTimePassed"
  | "rescheduleUnchanged"
  | "rescheduleMoved"
  | "rescheduleMovedSyncPending"
  | "rescheduleSlotUnavailable"
  | "rescheduleOutsideHours"
  | "rescheduleUnconfirmed";

type Templates = Record<OutcomeKey, (d: Formatted) => string> & { anythingElse: string };

const OUTCOMES: Record<NonEnglish, Templates> = {
  "hi-IN": {
    anythingElse: "क्या किसी और चीज़ में मदद कर सकते हैं?",
    slotAvailable: (d) => `${d.when} उपलब्ध है। क्या इसे बुक कर दें?`,
    slotUnavailableAgain: () => "जैसा पहले बताया, वह समय उपलब्ध नहीं है।",
    calendarCheckFailed: () =>
      "माफ़ कीजिए, अभी कैलेंडर देखा नहीं जा सका, इसलिए इसकी पुष्टि नहीं हो सकती। कृपया थोड़ी देर बाद फिर से कोशिश करें।",
    slotUnavailableAlternatives: (d) =>
      `वह समय उपलब्ध नहीं है। उस दिन खाली समय हैं: ${d.times}। क्या इनमें से कोई ठीक रहेगा?`,
    slotUnavailableNoneThatDay: () =>
      "वह समय उपलब्ध नहीं है, और उस दिन कोई और खाली समय नहीं है। क्या किसी और दिन देखें?",
    noSlotsOnDate: (d) => `${d.date} को कोई खाली समय नहीं है। क्या किसी और दिन देखें?`,
    noSlotsInPeriod: (d) =>
      `${d.date} को उस समय के आसपास कोई खाली समय नहीं है। क्या कोई और समय या दिन देखें?`,
    slotsOnDate: (d) => `${d.date} को ये समय खाली हैं: ${d.times}। क्या इनमें से कोई ठीक रहेगा?`,
    lineCannotBook: () =>
      "माफ़ कीजिए, अभी इस लाइन पर बुकिंग पूरी नहीं हो सकती। कृपया थोड़ी देर बाद फिर से कोशिश करें।",
    bookingSlotTaken: () =>
      "माफ़ कीजिए, वह समय अभी-अभी किसी और ने ले लिया, इसलिए बुक नहीं हो सका। क्या कोई और समय चाहेंगे?",
    bookingFailed: () =>
      "माफ़ कीजिए, बुकिंग पूरी नहीं हो सकी, इसलिए कुछ भी कन्फर्म नहीं हुआ है। क्या फिर से कोशिश करें, या कोई और समय चुनेंगे?",
    invalidPhone: () =>
      "माफ़ कीजिए, वह फ़ोन नंबर इस्तेमाल नहीं हो सका। कृपया अपना फ़ोन नंबर एक-एक अंक करके फिर से बताइए।",
    bookingSaved: (d) =>
      `${d.when} के लिए आपका अनुरोध सेव हो गया है, पर अभी कन्फर्म नहीं हुआ है। हमारी टीम जल्द ही आपसे पुष्टि करेगी।`,
    bookingPending: (d) =>
      `${d.when} के लिए आपका अनुरोध भेज दिया गया है, पर अभी कन्फर्म नहीं हुआ है। हमारी टीम जल्द ही आपसे पुष्टि करेगी।`,
    bookingConfirmed: (d) => `आपका ${d.service} ${d.when} के लिए कन्फर्म हो गया है।`,
    appointmentConfirmed: () => "आपका अपॉइंटमेंट कन्फर्म हो गया है।",
    appointmentSaved: () =>
      "आपका अपॉइंटमेंट अनुरोध सेव हो गया है, और हमारी टीम जल्द ही आपसे पुष्टि करेगी।",
    notBookedYet: () =>
      "अभी तक कुछ भी बुक नहीं हुआ है। बुकिंग के लिए बाकी जानकारी बताइए या पुष्टि कीजिए।",
    confirmBooking: (d) =>
      `${d.name ? `${d.name} जी, ` : ""}${d.service}, ${d.when}। क्या यह अपॉइंटमेंट बुक कर दूँ?`,
    notBookedYetConfirm: (d) =>
      `अभी तक कुछ भी बुक नहीं हुआ है। ${d.service}, ${d.when}। क्या इसे बुक कर दें?`,
    noReminders: () => "इस लाइन पर रिमाइंडर सेट नहीं किया जा सकता।",
    rescheduleKept: () => "ठीक है, आपका अपॉइंटमेंट जैसा था वैसा ही है।",
    rescheduleNeedsCallerNumber: () =>
      "अपॉइंटमेंट तभी बदला जा सकता है जब आप उसी नंबर से कॉल करें जिससे वह बुक हुआ था, और इस कॉल पर वह नंबर दिख नहीं रहा है। कृपया उसी नंबर से दोबारा कॉल कीजिए।",
    rescheduleNotFound: () =>
      "आप जिस नंबर से कॉल कर रहे हैं, उस पर कोई आने वाला अपॉइंटमेंट नहीं मिला। अगर वह किसी और नंबर से बुक हुआ था, तो कृपया उस नंबर से कॉल कीजिए। आपके लिए नया अपॉइंटमेंट भी बुक किया जा सकता है।",
    rescheduleNotPossible: () =>
      "माफ़ कीजिए, यह अपॉइंटमेंट इस कॉल पर बदला नहीं जा सकता। हमारी टीम इसमें आपकी मदद कर सकती है।",
    rescheduleLookupFailed: () =>
      "माफ़ कीजिए, अभी आपका अपॉइंटमेंट देखा नहीं जा सका। कृपया थोड़ी देर बाद फिर कोशिश कीजिए, या हमारी टीम आपकी मदद कर सकती है।",
    rescheduleWhich: (d) =>
      `आपके नंबर पर ये आने वाले अपॉइंटमेंट हैं: ${d.list}। आप कौन-सा बदलना चाहेंगे?`,
    rescheduleAskNewTime: (d) => `आपका ${d.booking} बुक है। नई तारीख और समय क्या चाहेंगे?`,
    rescheduleAskTimeOnDate: (d) => `${d.date} को आपका ${d.service} किस समय पर करना चाहेंगे?`,
    rescheduleConfirm: (d) => `पुष्टि के लिए — क्या आपका ${d.booking} ${d.when} पर कर दें?`,
    rescheduleSameTime: (d) => `आपका ${d.booking} पहले से उसी समय के लिए बुक है।`,
    rescheduleTimePassed: () => "वह समय निकल चुका है। कौन-सा दूसरा समय चाहेंगे?",
    rescheduleUnchanged: () =>
      "माफ़ कीजिए, अभी इसे बदला नहीं जा सका। आपका अपॉइंटमेंट पहले जैसा ही है।",
    rescheduleMoved: (d) => `हो गया — आपका अपॉइंटमेंट ${d.when} पर कर दिया गया है।`,
    rescheduleMovedSyncPending: (d) =>
      `आपका अपॉइंटमेंट ${d.when} पर कर दिया गया है। हमारी टीम कैलेंडर अपडेट पूरा करेगी और कुछ बदलने पर आपको बताएगी।`,
    rescheduleSlotUnavailable: (d) =>
      `माफ़ कीजिए, ${d.when} उपलब्ध नहीं है। आपका अपॉइंटमेंट पहले जैसा ही है। क्या कोई और समय चाहेंगे?`,
    rescheduleOutsideHours: (d) =>
      `माफ़ कीजिए, ${d.when} कामकाज के समय से बाहर है। आपका अपॉइंटमेंट पहले जैसा ही है। क्या कोई और समय चाहेंगे?`,
    rescheduleUnconfirmed: () =>
      "माफ़ कीजिए, अभी यह बदलाव कन्फर्म नहीं हो सका। हमारी टीम जाँच करके आपके अपॉइंटमेंट का समय आपसे कन्फर्म करेगी।",
  },
  "mr-IN": {
    anythingElse: "आणखी काही मदत हवी आहे का?",
    slotAvailable: (d) => `${d.when} उपलब्ध आहे. हे बुक करायचे का?`,
    slotUnavailableAgain: () => "आधी सांगितल्याप्रमाणे, ती वेळ उपलब्ध नाही.",
    calendarCheckFailed: () =>
      "माफ करा, आत्ता कॅलेंडर तपासता आले नाही, त्यामुळे याची खात्री करता येत नाही. कृपया थोड्या वेळाने पुन्हा प्रयत्न करा.",
    slotUnavailableAlternatives: (d) =>
      `ती वेळ उपलब्ध नाही. त्या दिवशी या वेळा मोकळ्या आहेत: ${d.times}. यापैकी कोणती चालेल?`,
    slotUnavailableNoneThatDay: () =>
      "ती वेळ उपलब्ध नाही, आणि त्या दिवशी दुसरी कोणतीही मोकळी वेळ नाही. दुसरा दिवस तपासायचा का?",
    noSlotsOnDate: (d) => `${d.date} रोजी कोणतीही मोकळी वेळ नाही. दुसरा दिवस तपासायचा का?`,
    noSlotsInPeriod: (d) =>
      `${d.date} रोजी त्या वेळेच्या आसपास कोणतीही मोकळी वेळ नाही. दुसरी वेळ किंवा दिवस तपासायचा का?`,
    slotsOnDate: (d) => `${d.date} रोजी या वेळा मोकळ्या आहेत: ${d.times}. यापैकी कोणती चालेल?`,
    lineCannotBook: () =>
      "माफ करा, आत्ता या लाइनवर बुकिंग पूर्ण करता येत नाही. कृपया थोड्या वेळाने पुन्हा प्रयत्न करा.",
    bookingSlotTaken: () =>
      "माफ करा, ती वेळ नुकतीच दुसऱ्या कोणी घेतली, त्यामुळे बुक होऊ शकले नाही. दुसरी वेळ हवी आहे का?",
    bookingFailed: () =>
      "माफ करा, बुकिंग पूर्ण होऊ शकले नाही, त्यामुळे काहीही निश्चित झालेले नाही. पुन्हा प्रयत्न करायचा का, की दुसरी वेळ निवडायची?",
    invalidPhone: () =>
      "माफ करा, तो फोन नंबर वापरता आला नाही. कृपया आपला फोन नंबर एक-एक अंक करून पुन्हा सांगा.",
    bookingSaved: (d) =>
      `${d.when} साठी आपली विनंती सेव्ह झाली आहे, पण अजून निश्चित झालेली नाही. आमची टीम लवकरच आपल्याशी खात्री करेल.`,
    bookingPending: (d) =>
      `${d.when} साठी आपली विनंती पाठवली आहे, पण अजून निश्चित झालेली नाही. आमची टीम लवकरच आपल्याशी खात्री करेल.`,
    bookingConfirmed: (d) => `आपले ${d.service} ${d.when} साठी निश्चित झाले आहे.`,
    appointmentConfirmed: () => "आपली अपॉइंटमेंट निश्चित झाली आहे.",
    appointmentSaved: () =>
      "आपली अपॉइंटमेंट विनंती सेव्ह झाली आहे, आणि आमची टीम लवकरच आपल्याशी खात्री करेल.",
    notBookedYet: () =>
      "अजून काहीही बुक झालेले नाही. बुकिंगसाठी उरलेली माहिती सांगा किंवा खात्री करा.",
    confirmBooking: (d) =>
      `${d.name ? `${d.name}, ` : ""}${d.service}, ${d.when}. हे अपॉइंटमेंट बुक करू का?`,
    notBookedYetConfirm: (d) =>
      `अजून काहीही बुक झालेले नाही. ${d.service}, ${d.when}. हे बुक करायचे का?`,
    noReminders: () => "या लाइनवर रिमाइंडर सेट करता येत नाही.",
    rescheduleKept: () => "ठीक आहे, आपली अपॉइंटमेंट आहे तशीच राहील.",
    rescheduleNeedsCallerNumber: () =>
      "अपॉइंटमेंट ज्या नंबरवरून बुक झाली त्याच नंबरवरून कॉल केल्यावरच ती बदलता येते, आणि या कॉलवर तो नंबर दिसत नाही. कृपया त्या नंबरवरून पुन्हा कॉल करा.",
    rescheduleNotFound: () =>
      "आपण ज्या नंबरवरून कॉल करत आहात त्यावर कोणतीही आगामी अपॉइंटमेंट सापडली नाही. ती दुसऱ्या नंबरवरून बुक झाली असल्यास, कृपया त्या नंबरवरून कॉल करा. आपल्यासाठी नवी अपॉइंटमेंटही बुक करता येईल.",
    rescheduleNotPossible: () =>
      "माफ करा, ही अपॉइंटमेंट या कॉलवर बदलता येत नाही. आमची टीम यात आपली मदत करू शकते.",
    rescheduleLookupFailed: () =>
      "माफ करा, आत्ता आपली अपॉइंटमेंट शोधता आली नाही. कृपया थोड्या वेळाने पुन्हा प्रयत्न करा, किंवा आमची टीम मदत करू शकते.",
    rescheduleWhich: (d) =>
      `आपल्या नंबरवर या आगामी अपॉइंटमेंट आहेत: ${d.list}. आपल्याला कोणती बदलायची आहे?`,
    rescheduleAskNewTime: (d) => `आपले ${d.booking} बुक आहे. नवी तारीख आणि वेळ कोणती हवी?`,
    rescheduleAskTimeOnDate: (d) => `${d.date} रोजी आपले ${d.service} कोणत्या वेळी करायचे आहे?`,
    rescheduleConfirm: (d) => `खात्रीसाठी — आपले ${d.booking} ${d.when} ला हलवायचे का?`,
    rescheduleSameTime: (d) => `आपले ${d.booking} आधीच त्याच वेळेसाठी बुक आहे.`,
    rescheduleTimePassed: () => "ती वेळ निघून गेली आहे. दुसरी कोणती वेळ हवी?",
    rescheduleUnchanged: () => "माफ करा, आत्ता हे बदलता आले नाही. आपली अपॉइंटमेंट आधीसारखीच आहे.",
    rescheduleMoved: (d) => `झाले — आपली अपॉइंटमेंट ${d.when} ला हलवली आहे.`,
    rescheduleMovedSyncPending: (d) =>
      `आपली अपॉइंटमेंट ${d.when} ला हलवली आहे. आमची टीम कॅलेंडर अपडेट पूर्ण करेल आणि काही बदलल्यास आपल्याला कळवेल.`,
    rescheduleSlotUnavailable: (d) =>
      `माफ करा, ${d.when} उपलब्ध नाही. आपली अपॉइंटमेंट आधीसारखीच आहे. दुसरी वेळ हवी आहे का?`,
    rescheduleOutsideHours: (d) =>
      `माफ करा, ${d.when} कामकाजाच्या वेळेबाहेर आहे. आपली अपॉइंटमेंट आधीसारखीच आहे. दुसरी वेळ हवी आहे का?`,
    rescheduleUnconfirmed: () =>
      "माफ करा, आत्ता हा बदल निश्चित होऊ शकला नाही. आमची टीम तपासून आपल्या अपॉइंटमेंटची वेळ आपल्याशी निश्चित करेल.",
  },
  "bn-IN": {
    anythingElse: "আর কিছুতে সাহায্য করতে পারি?",
    slotAvailable: (d) => `${d.when} খালি আছে। বুক করে দেব?`,
    slotUnavailableAgain: () => "আগেই বলা হয়েছে, সেই সময়টি খালি নেই।",
    calendarCheckFailed: () =>
      "দুঃখিত, এই মুহূর্তে ক্যালেন্ডার দেখা গেল না, তাই এটি নিশ্চিত করা যাচ্ছে না। অনুগ্রহ করে একটু পরে আবার চেষ্টা করুন।",
    slotUnavailableAlternatives: (d) =>
      `সেই সময়টি খালি নেই। সেদিন এই সময়গুলো খালি আছে: ${d.times}। এর মধ্যে কোনোটা চলবে?`,
    slotUnavailableNoneThatDay: () =>
      "সেই সময়টি খালি নেই, আর সেদিন অন্য কোনো সময়ও খালি নেই। অন্য কোনো দিন দেখব?",
    noSlotsOnDate: (d) => `${d.date} কোনো সময় খালি নেই। অন্য কোনো দিন দেখব?`,
    noSlotsInPeriod: (d) =>
      `${d.date} ওই সময়ের দিকে কোনো সময় খালি নেই। অন্য কোনো সময় বা দিন দেখব?`,
    slotsOnDate: (d) => `${d.date} এই সময়গুলো খালি আছে: ${d.times}। এর মধ্যে কোনোটা চলবে?`,
    lineCannotBook: () =>
      "দুঃখিত, এই মুহূর্তে এই লাইনে বুকিং সম্পূর্ণ করা যাচ্ছে না। অনুগ্রহ করে একটু পরে আবার চেষ্টা করুন।",
    bookingSlotTaken: () =>
      "দুঃখিত, সেই সময়টি এইমাত্র অন্য কেউ নিয়ে নিয়েছে, তাই বুক করা গেল না। অন্য কোনো সময় চাইবেন?",
    bookingFailed: () =>
      "দুঃখিত, বুকিং সম্পূর্ণ হয়নি, তাই কিছুই নিশ্চিত হয়নি। আবার চেষ্টা করব, নাকি অন্য সময় বেছে নেবেন?",
    invalidPhone: () =>
      "দুঃখিত, ওই ফোন নম্বরটি ব্যবহার করা গেল না। অনুগ্রহ করে আপনার ফোন নম্বরটি এক এক অঙ্ক করে আবার বলুন।",
    bookingSaved: (d) =>
      `${d.when}-এর জন্য আপনার অনুরোধ সেভ হয়েছে, তবে এখনও নিশ্চিত হয়নি। আমাদের টিম শীঘ্রই আপনার সঙ্গে নিশ্চিত করবে।`,
    bookingPending: (d) =>
      `${d.when}-এর জন্য আপনার অনুরোধ পাঠানো হয়েছে, তবে এখনও নিশ্চিত হয়নি। আমাদের টিম শীঘ্রই আপনার সঙ্গে নিশ্চিত করবে।`,
    bookingConfirmed: (d) => `আপনার ${d.service} ${d.when}-এর জন্য নিশ্চিত হয়েছে।`,
    appointmentConfirmed: () => "আপনার অ্যাপয়েন্টমেন্ট নিশ্চিত হয়েছে।",
    appointmentSaved: () =>
      "আপনার অ্যাপয়েন্টমেন্টের অনুরোধ সেভ হয়েছে, আর আমাদের টিম শীঘ্রই আপনার সঙ্গে নিশ্চিত করবে।",
    notBookedYet: () => "এখনও কিছু বুক হয়নি। বুকিংয়ের জন্য বাকি তথ্য বলুন বা নিশ্চিত করুন।",
    confirmBooking: (d) =>
      `${d.name ? `${d.name}, ` : ""}${d.service}, ${d.when}। অ্যাপয়েন্টমেন্টটা বুক করে দেব?`,
    notBookedYetConfirm: (d) => `এখনও কিছু বুক হয়নি। ${d.service}, ${d.when}। বুক করে দেব?`,
    noReminders: () => "এই লাইনে রিমাইন্ডার সেট করা যায় না।",
    rescheduleKept: () => "ঠিক আছে, আপনার অ্যাপয়েন্টমেন্ট যেমন ছিল তেমনই থাকছে।",
    rescheduleNeedsCallerNumber: () =>
      "যে নম্বর থেকে অ্যাপয়েন্টমেন্ট বুক করা হয়েছিল, সেই নম্বর থেকে ফোন করলেই কেবল সেটি বদলানো যায়, আর এই কলে সেই নম্বরটি দেখা যাচ্ছে না। অনুগ্রহ করে সেই নম্বর থেকে আবার ফোন করুন।",
    rescheduleNotFound: () =>
      "আপনি যে নম্বর থেকে ফোন করছেন, তাতে কোনো আসন্ন অ্যাপয়েন্টমেন্ট পাওয়া যায়নি। অন্য নম্বর থেকে বুক করা হয়ে থাকলে, অনুগ্রহ করে সেই নম্বর থেকে ফোন করুন। আপনার জন্য নতুন অ্যাপয়েন্টমেন্টও বুক করা যেতে পারে।",
    rescheduleNotPossible: () =>
      "দুঃখিত, এই কলে এই অ্যাপয়েন্টমেন্টটি বদলানো যাচ্ছে না। আমাদের টিম এ বিষয়ে সাহায্য করতে পারে।",
    rescheduleLookupFailed: () =>
      "দুঃখিত, এই মুহূর্তে আপনার অ্যাপয়েন্টমেন্ট খুঁজে পাওয়া গেল না। একটু পরে আবার চেষ্টা করুন, অথবা আমাদের টিম সাহায্য করতে পারে।",
    rescheduleWhich: (d) =>
      `আপনার নম্বরে এই আসন্ন অ্যাপয়েন্টমেন্টগুলো আছে: ${d.list}। কোনটি বদলাতে চান?`,
    rescheduleAskNewTime: (d) => `আপনার ${d.booking} বুক করা আছে। নতুন তারিখ আর সময় কী চান?`,
    rescheduleAskTimeOnDate: (d) => `${d.date} আপনার ${d.service} কোন সময়ে সরাতে চান?`,
    rescheduleConfirm: (d) => `নিশ্চিত করতে — আপনার ${d.booking} কি ${d.when}-এ সরাতে চান?`,
    rescheduleSameTime: (d) => `আপনার ${d.booking} আগে থেকেই ওই সময়ের জন্য বুক করা আছে।`,
    rescheduleTimePassed: () => "সেই সময়টি পেরিয়ে গেছে। অন্য কোন সময় চান?",
    rescheduleUnchanged: () =>
      "দুঃখিত, এই মুহূর্তে এটি বদলানো গেল না। আপনার অ্যাপয়েন্টমেন্ট আগের মতোই আছে।",
    rescheduleMoved: (d) => `হয়ে গেছে — আপনার অ্যাপয়েন্টমেন্ট ${d.when}-এ সরানো হয়েছে।`,
    rescheduleMovedSyncPending: (d) =>
      `আপনার অ্যাপয়েন্টমেন্ট ${d.when}-এ সরানো হয়েছে। আমাদের টিম ক্যালেন্ডার আপডেট সম্পূর্ণ করবে এবং কিছু বদলালে আপনাকে জানাবে।`,
    rescheduleSlotUnavailable: (d) =>
      `দুঃখিত, ${d.when} খালি নেই। আপনার অ্যাপয়েন্টমেন্ট আগের মতোই আছে। অন্য কোনো সময় চাইবেন?`,
    rescheduleOutsideHours: (d) =>
      `দুঃখিত, ${d.when} কাজের সময়ের বাইরে। আপনার অ্যাপয়েন্টমেন্ট আগের মতোই আছে। অন্য কোনো সময় চাইবেন?`,
    rescheduleUnconfirmed: () =>
      "দুঃখিত, এই মুহূর্তে পরিবর্তনটি নিশ্চিত করা গেল না। আমাদের টিম দেখে আপনার অ্যাপয়েন্টমেন্টের সময় আপনার সঙ্গে নিশ্চিত করবে।",
  },
  "ta-IN": {
    anythingElse: "வேறு ஏதாவது உதவி வேண்டுமா?",
    slotAvailable: (d) => `${d.when} காலியாக உள்ளது. இதை புக் செய்யலாமா?`,
    slotUnavailableAgain: () => "முன்பே சொன்னபடி, அந்த நேரம் காலியாக இல்லை.",
    calendarCheckFailed: () =>
      "மன்னிக்கவும், இப்போது காலெண்டரைப் பார்க்க முடியவில்லை, அதனால் இதை உறுதிசெய்ய முடியாது. சிறிது நேரம் கழித்து மீண்டும் முயற்சிக்கவும்.",
    slotUnavailableAlternatives: (d) =>
      `அந்த நேரம் காலியாக இல்லை. அன்று காலியாக உள்ள நேரங்கள்: ${d.times}. இவற்றில் ஏதாவது சரியாக இருக்குமா?`,
    slotUnavailableNoneThatDay: () =>
      "அந்த நேரம் காலியாக இல்லை, அன்று வேறு எந்த நேரமும் காலியாக இல்லை. வேறு ஒரு நாளைப் பார்க்கலாமா?",
    noSlotsOnDate: (d) =>
      `${d.date} அன்று எந்த நேரமும் காலியாக இல்லை. வேறு ஒரு நாளைப் பார்க்கலாமா?`,
    noSlotsInPeriod: (d) =>
      `${d.date} அன்று அந்த நேரப்பகுதியில் எந்த நேரமும் காலியாக இல்லை. வேறு நேரம் அல்லது நாளைப் பார்க்கலாமா?`,
    slotsOnDate: (d) =>
      `${d.date} அன்று காலியாக உள்ள நேரங்கள்: ${d.times}. இவற்றில் ஏதாவது சரியாக இருக்குமா?`,
    lineCannotBook: () =>
      "மன்னிக்கவும், இப்போது இந்த லைனில் புக்கிங்கை முடிக்க முடியாது. சிறிது நேரம் கழித்து மீண்டும் முயற்சிக்கவும்.",
    bookingSlotTaken: () =>
      "மன்னிக்கவும், அந்த நேரத்தை இப்போதுதான் வேறொருவர் எடுத்துவிட்டார், அதனால் புக் செய்ய முடியவில்லை. வேறு நேரம் வேண்டுமா?",
    bookingFailed: () =>
      "மன்னிக்கவும், புக்கிங் முடியவில்லை, அதனால் எதுவும் உறுதியாகவில்லை. மீண்டும் முயற்சிக்கலாமா, அல்லது வேறு நேரத்தைத் தேர்ந்தெடுக்கிறீர்களா?",
    invalidPhone: () =>
      "மன்னிக்கவும், அந்த தொலைபேசி எண்ணைப் பயன்படுத்த முடியவில்லை. தயவுசெய்து உங்கள் எண்ணை ஒவ்வொரு இலக்கமாக மீண்டும் சொல்லுங்கள்.",
    bookingSaved: (d) =>
      `${d.when}க்கான உங்கள் கோரிக்கை சேமிக்கப்பட்டது, ஆனால் இன்னும் உறுதியாகவில்லை. எங்கள் குழு விரைவில் உங்களுடன் உறுதிசெய்யும்.`,
    bookingPending: (d) =>
      `${d.when}க்கான உங்கள் கோரிக்கை அனுப்பப்பட்டது, ஆனால் இன்னும் உறுதியாகவில்லை. எங்கள் குழு விரைவில் உங்களுடன் உறுதிசெய்யும்.`,
    bookingConfirmed: (d) => `உங்கள் ${d.service} ${d.when}க்கு உறுதியாகிவிட்டது.`,
    appointmentConfirmed: () => "உங்கள் அப்பாயிண்ட்மெண்ட் உறுதியாகிவிட்டது.",
    appointmentSaved: () =>
      "உங்கள் அப்பாயிண்ட்மெண்ட் கோரிக்கை சேமிக்கப்பட்டது, எங்கள் குழு விரைவில் உங்களுடன் உறுதிசெய்யும்.",
    notBookedYet: () =>
      "இதுவரை எதுவும் புக் செய்யப்படவில்லை. புக்கிங்கிற்கு மீதமுள்ள விவரங்களைச் சொல்லுங்கள் அல்லது உறுதிசெய்யுங்கள்.",
    confirmBooking: (d) =>
      `${d.name ? `${d.name}, ` : ""}${d.service}, ${d.when}. இதை புக் செய்யலாமா?`,
    notBookedYetConfirm: (d) =>
      `இதுவரை எதுவும் புக் செய்யப்படவில்லை. ${d.service}, ${d.when}. இதை புக் செய்யலாமா?`,
    noReminders: () => "இந்த லைனில் நினைவூட்டல் அமைக்க முடியாது.",
    rescheduleKept: () => "சரி, உங்கள் அப்பாயிண்ட்மெண்ட் அப்படியே இருக்கும்.",
    rescheduleNeedsCallerNumber: () =>
      "அப்பாயிண்ட்மெண்ட் புக் செய்யப்பட்ட அதே எண்ணிலிருந்து அழைத்தால் மட்டுமே அதை மாற்ற முடியும், இந்த அழைப்பில் அந்த எண் தெரியவில்லை. தயவுசெய்து அந்த எண்ணிலிருந்து மீண்டும் அழையுங்கள்.",
    rescheduleNotFound: () =>
      "நீங்கள் அழைக்கும் எண்ணில் வரவிருக்கும் அப்பாயிண்ட்மெண்ட் எதுவும் இல்லை. வேறு எண்ணில் புக் செய்திருந்தால், தயவுசெய்து அந்த எண்ணிலிருந்து அழையுங்கள். உங்களுக்காக புதிய அப்பாயிண்ட்மெண்ட்டும் புக் செய்யலாம்.",
    rescheduleNotPossible: () =>
      "மன்னிக்கவும், இந்த அழைப்பில் இந்த அப்பாயிண்ட்மெண்ட்டை மாற்ற முடியாது. எங்கள் குழு இதில் உதவ முடியும்.",
    rescheduleLookupFailed: () =>
      "மன்னிக்கவும், இப்போது உங்கள் அப்பாயிண்ட்மெண்ட்டைக் கண்டுபிடிக்க முடியவில்லை. சிறிது நேரம் கழித்து மீண்டும் முயற்சிக்கவும், அல்லது எங்கள் குழு உதவும்.",
    rescheduleWhich: (d) =>
      `உங்கள் எண்ணில் வரவிருக்கும் அப்பாயிண்ட்மெண்ட்கள்: ${d.list}. எதை மாற்ற விரும்புகிறீர்கள்?`,
    rescheduleAskNewTime: (d) =>
      `உங்கள் ${d.booking} புக் செய்யப்பட்டுள்ளது. புதிய தேதி மற்றும் நேரம் என்ன வேண்டும்?`,
    rescheduleAskTimeOnDate: (d) =>
      `${d.date} அன்று உங்கள் ${d.service} எந்த நேரத்திற்கு மாற்ற வேண்டும்?`,
    rescheduleConfirm: (d) => `உறுதிசெய்ய — உங்கள் ${d.booking} ஐ ${d.when}க்கு மாற்றலாமா?`,
    rescheduleSameTime: (d) =>
      `உங்கள் ${d.booking} ஏற்கனவே அதே நேரத்திற்கு புக் செய்யப்பட்டுள்ளது.`,
    rescheduleTimePassed: () => "அந்த நேரம் ஏற்கனவே கடந்துவிட்டது. வேறு எந்த நேரம் வேண்டும்?",
    rescheduleUnchanged: () =>
      "மன்னிக்கவும், இப்போது இதை மாற்ற முடியவில்லை. உங்கள் அப்பாயிண்ட்மெண்ட் மாறாமல் உள்ளது.",
    rescheduleMoved: (d) => `முடிந்தது — உங்கள் அப்பாயிண்ட்மெண்ட் ${d.when}க்கு மாற்றப்பட்டது.`,
    rescheduleMovedSyncPending: (d) =>
      `உங்கள் அப்பாயிண்ட்மெண்ட் ${d.when}க்கு மாற்றப்பட்டது. எங்கள் குழு காலெண்டர் புதுப்பிப்பை முடித்து, ஏதாவது மாறினால் உங்களுக்குத் தெரிவிக்கும்.`,
    rescheduleSlotUnavailable: (d) =>
      `மன்னிக்கவும், ${d.when} காலியாக இல்லை. உங்கள் அப்பாயிண்ட்மெண்ட் மாறாமல் உள்ளது. வேறு நேரம் வேண்டுமா?`,
    rescheduleOutsideHours: (d) =>
      `மன்னிக்கவும், ${d.when} வேலை நேரத்திற்கு வெளியே உள்ளது. உங்கள் அப்பாயிண்ட்மெண்ட் மாறாமல் உள்ளது. வேறு நேரம் வேண்டுமா?`,
    rescheduleUnconfirmed: () =>
      "மன்னிக்கவும், இப்போது இந்த மாற்றத்தை உறுதிசெய்ய முடியவில்லை. எங்கள் குழு சரிபார்த்து உங்கள் அப்பாயிண்ட்மெண்ட் நேரத்தை உங்களுடன் உறுதிசெய்யும்.",
  },
  "te-IN": {
    anythingElse: "ఇంకేమైనా సహాయం కావాలా?",
    slotAvailable: (d) => `${d.when} ఖాళీగా ఉంది. బుక్ చేయమంటారా?`,
    slotUnavailableAgain: () => "ముందే చెప్పినట్లు, ఆ సమయం ఖాళీగా లేదు.",
    calendarCheckFailed: () =>
      "క్షమించండి, ఇప్పుడు క్యాలెండర్ చూడలేకపోయాం, అందుకే దీన్ని నిర్ధారించలేం. దయచేసి కొద్దిసేపటి తర్వాత మళ్ళీ ప్రయత్నించండి.",
    slotUnavailableAlternatives: (d) =>
      `ఆ సమయం ఖాళీగా లేదు. ఆ రోజు ఖాళీగా ఉన్న సమయాలు: ${d.times}. వీటిలో ఏదైనా సరిపోతుందా?`,
    slotUnavailableNoneThatDay: () =>
      "ఆ సమయం ఖాళీగా లేదు, ఆ రోజు వేరే ఏ సమయమూ ఖాళీగా లేదు. వేరే రోజు చూడమంటారా?",
    noSlotsOnDate: (d) => `${d.date} రోజున ఏ సమయమూ ఖాళీగా లేదు. వేరే రోజు చూడమంటారా?`,
    noSlotsInPeriod: (d) =>
      `${d.date} రోజున ఆ సమయంలో ఏ సమయమూ ఖాళీగా లేదు. వేరే సమయం లేదా రోజు చూడమంటారా?`,
    slotsOnDate: (d) => `${d.date} రోజున ఖాళీగా ఉన్న సమయాలు: ${d.times}. వీటిలో ఏదైనా సరిపోతుందా?`,
    lineCannotBook: () =>
      "క్షమించండి, ఇప్పుడు ఈ లైన్‌లో బుకింగ్ పూర్తి చేయలేం. దయచేసి కొద్దిసేపటి తర్వాత మళ్ళీ ప్రయత్నించండి.",
    bookingSlotTaken: () =>
      "క్షమించండి, ఆ సమయాన్ని ఇప్పుడే వేరొకరు తీసుకున్నారు, అందుకే బుక్ చేయలేకపోయాం. వేరే సమయం కావాలా?",
    bookingFailed: () =>
      "క్షమించండి, బుకింగ్ పూర్తి కాలేదు, అందుకే ఏదీ నిర్ధారణ కాలేదు. మళ్ళీ ప్రయత్నించమంటారా, లేదా వేరే సమయం ఎంచుకుంటారా?",
    invalidPhone: () =>
      "క్షమించండి, ఆ ఫోన్ నంబర్‌ను ఉపయోగించలేకపోయాం. దయచేసి మీ ఫోన్ నంబర్‌ను ఒక్కో అంకె చొప్పున మళ్ళీ చెప్పండి.",
    bookingSaved: (d) =>
      `${d.when} కోసం మీ అభ్యర్థన సేవ్ అయింది, కానీ ఇంకా నిర్ధారణ కాలేదు. మా టీమ్ త్వరలో మీతో నిర్ధారిస్తుంది.`,
    bookingPending: (d) =>
      `${d.when} కోసం మీ అభ్యర్థన పంపబడింది, కానీ ఇంకా నిర్ధారణ కాలేదు. మా టీమ్ త్వరలో మీతో నిర్ధారిస్తుంది.`,
    bookingConfirmed: (d) => `మీ ${d.service} ${d.when} కి నిర్ధారణ అయింది.`,
    appointmentConfirmed: () => "మీ అపాయింట్మెంట్ నిర్ధారణ అయింది.",
    appointmentSaved: () =>
      "మీ అపాయింట్మెంట్ అభ్యర్థన సేవ్ అయింది, మా టీమ్ త్వరలో మీతో నిర్ధారిస్తుంది.",
    notBookedYet: () =>
      "ఇప్పటివరకు ఏదీ బుక్ కాలేదు. బుకింగ్ కోసం మిగిలిన వివరాలు చెప్పండి లేదా నిర్ధారించండి.",
    confirmBooking: (d) =>
      `${d.name ? `${d.name} గారు, ` : ""}${d.service}, ${d.when}. బుక్ చేయమంటారా?`,
    notBookedYetConfirm: (d) =>
      `ఇప్పటివరకు ఏదీ బుక్ కాలేదు. ${d.service}, ${d.when}. బుక్ చేయమంటారా?`,
    noReminders: () => "ఈ లైన్‌లో రిమైండర్ సెట్ చేయడం కుదరదు.",
    rescheduleKept: () => "సరే, మీ అపాయింట్మెంట్ అలాగే ఉంటుంది.",
    rescheduleNeedsCallerNumber: () =>
      "అపాయింట్మెంట్ బుక్ చేసిన నంబర్ నుండే కాల్ చేస్తేనే దాన్ని మార్చగలం, ఈ కాల్‌లో ఆ నంబర్ కనిపించడం లేదు. దయచేసి ఆ నంబర్ నుండి మళ్ళీ కాల్ చేయండి.",
    rescheduleNotFound: () =>
      "మీరు కాల్ చేస్తున్న నంబర్‌పై రాబోయే అపాయింట్మెంట్ ఏదీ కనిపించలేదు. వేరే నంబర్‌తో బుక్ చేసి ఉంటే, దయచేసి ఆ నంబర్ నుండి కాల్ చేయండి. మీ కోసం కొత్త అపాయింట్మెంట్ కూడా బుక్ చేయవచ్చు.",
    rescheduleNotPossible: () =>
      "క్షమించండి, ఈ కాల్‌లో ఈ అపాయింట్మెంట్‌ను మార్చలేం. మా టీమ్ ఇందులో సహాయం చేయగలదు.",
    rescheduleLookupFailed: () =>
      "క్షమించండి, ఇప్పుడు మీ అపాయింట్మెంట్‌ను చూడలేకపోయాం. కొద్దిసేపటి తర్వాత మళ్ళీ ప్రయత్నించండి, లేదా మా టీమ్ సహాయం చేస్తుంది.",
    rescheduleWhich: (d) =>
      `మీ నంబర్‌పై రాబోయే అపాయింట్మెంట్లు ఇవి: ${d.list}. వీటిలో దేన్ని మార్చాలనుకుంటున్నారు?`,
    rescheduleAskNewTime: (d) => `మీ ${d.booking} బుక్ అయి ఉంది. కొత్త తేదీ, సమయం ఏది కావాలి?`,
    rescheduleAskTimeOnDate: (d) => `${d.date} రోజున మీ ${d.service} ఏ సమయానికి మార్చాలి?`,
    rescheduleConfirm: (d) => `నిర్ధారణ కోసం — మీ ${d.booking} ను ${d.when} కి మార్చమంటారా?`,
    rescheduleSameTime: (d) => `మీ ${d.booking} ఇప్పటికే అదే సమయానికి బుక్ అయి ఉంది.`,
    rescheduleTimePassed: () => "ఆ సమయం ఇప్పటికే గడిచిపోయింది. వేరే ఏ సమయం కావాలి?",
    rescheduleUnchanged: () =>
      "క్షమించండి, ఇప్పుడు దీన్ని మార్చలేకపోయాం. మీ అపాయింట్మెంట్ మారలేదు.",
    rescheduleMoved: (d) => `అయిపోయింది — మీ అపాయింట్మెంట్‌ను ${d.when} కి మార్చాం.`,
    rescheduleMovedSyncPending: (d) =>
      `మీ అపాయింట్మెంట్‌ను ${d.when} కి మార్చాం. మా టీమ్ క్యాలెండర్ అప్‌డేట్ పూర్తి చేసి, ఏదైనా మారితే మీకు తెలియజేస్తుంది.`,
    rescheduleSlotUnavailable: (d) =>
      `క్షమించండి, ${d.when} ఖాళీగా లేదు. మీ అపాయింట్మెంట్ మారలేదు. వేరే సమయం కావాలా?`,
    rescheduleOutsideHours: (d) =>
      `క్షమించండి, ${d.when} పని వేళలకు బయట ఉంది. మీ అపాయింట్మెంట్ మారలేదు. వేరే సమయం కావాలా?`,
    rescheduleUnconfirmed: () =>
      "క్షమించండి, ఇప్పుడు ఈ మార్పును నిర్ధారించలేకపోయాం. మా టీమ్ పరిశీలించి మీ అపాయింట్మెంట్ సమయాన్ని మీతో నిర్ధారిస్తుంది.",
  },
  "gu-IN": {
    anythingElse: "બીજી કોઈ મદદ જોઈએ છે?",
    slotAvailable: (d) => `${d.when} ઉપલબ્ધ છે. શું તે બુક કરી દઈએ?`,
    slotUnavailableAgain: () => "પહેલાં કહ્યું તેમ, તે સમય ઉપલબ્ધ નથી.",
    calendarCheckFailed: () =>
      "માફ કરશો, અત્યારે કૅલેન્ડર જોઈ શકાયું નહીં, એટલે આની પુષ્ટિ થઈ શકતી નથી. કૃપા કરીને થોડી વાર પછી ફરી પ્રયાસ કરો.",
    slotUnavailableAlternatives: (d) =>
      `તે સમય ઉપલબ્ધ નથી. તે દિવસે આ સમય ખાલી છે: ${d.times}. આમાંથી કોઈ ચાલશે?`,
    slotUnavailableNoneThatDay: () =>
      "તે સમય ઉપલબ્ધ નથી, અને તે દિવસે બીજો કોઈ સમય ખાલી નથી. બીજો દિવસ જોઈએ?",
    noSlotsOnDate: (d) => `${d.date}ના રોજ કોઈ સમય ખાલી નથી. બીજો દિવસ જોઈએ?`,
    noSlotsInPeriod: (d) =>
      `${d.date}ના રોજ તે સમયગાળામાં કોઈ સમય ખાલી નથી. બીજો સમય કે દિવસ જોઈએ?`,
    slotsOnDate: (d) => `${d.date}ના રોજ આ સમય ખાલી છે: ${d.times}. આમાંથી કોઈ ચાલશે?`,
    lineCannotBook: () =>
      "માફ કરશો, અત્યારે આ લાઇન પર બુકિંગ પૂરું થઈ શકતું નથી. કૃપા કરીને થોડી વાર પછી ફરી પ્રયાસ કરો.",
    bookingSlotTaken: () =>
      "માફ કરશો, તે સમય હમણાં જ કોઈ બીજાએ લઈ લીધો, એટલે બુક થઈ શક્યું નહીં. બીજો સમય જોઈએ છે?",
    bookingFailed: () =>
      "માફ કરશો, બુકિંગ પૂરું થઈ શક્યું નહીં, એટલે કંઈ પણ કન્ફર્મ થયું નથી. ફરી પ્રયાસ કરીએ, કે બીજો સમય પસંદ કરશો?",
    invalidPhone: () =>
      "માફ કરશો, તે ફોન નંબર વાપરી શકાયો નહીં. કૃપા કરીને આપનો ફોન નંબર એક-એક અંક કરીને ફરી કહો.",
    bookingSaved: (d) =>
      `${d.when} માટે આપની વિનંતી સેવ થઈ ગઈ છે, પણ હજુ કન્ફર્મ થઈ નથી. અમારી ટીમ ટૂંક સમયમાં આપની સાથે પુષ્ટિ કરશે.`,
    bookingPending: (d) =>
      `${d.when} માટે આપની વિનંતી મોકલી દેવામાં આવી છે, પણ હજુ કન્ફર્મ થઈ નથી. અમારી ટીમ ટૂંક સમયમાં આપની સાથે પુષ્ટિ કરશે.`,
    bookingConfirmed: (d) => `આપનું ${d.service} ${d.when} માટે કન્ફર્મ થઈ ગયું છે.`,
    appointmentConfirmed: () => "આપની એપોઇન્ટમેન્ટ કન્ફર્મ થઈ ગઈ છે.",
    appointmentSaved: () =>
      "આપની એપોઇન્ટમેન્ટની વિનંતી સેવ થઈ ગઈ છે, અને અમારી ટીમ ટૂંક સમયમાં આપની સાથે પુષ્ટિ કરશે.",
    notBookedYet: () => "હજુ સુધી કંઈ બુક થયું નથી. બુકિંગ માટે બાકીની માહિતી કહો અથવા પુષ્ટિ કરો.",
    confirmBooking: (d) =>
      `${d.name ? `${d.name}, ` : ""}${d.service}, ${d.when}. શું તે બુક કરી દઈએ?`,
    notBookedYetConfirm: (d) =>
      `હજુ સુધી કંઈ બુક થયું નથી. ${d.service}, ${d.when}. શું તે બુક કરી દઈએ?`,
    noReminders: () => "આ લાઇન પર રિમાઇન્ડર સેટ કરી શકાતું નથી.",
    rescheduleKept: () => "ઠીક છે, આપની એપોઇન્ટમેન્ટ જેમ છે તેમ જ રહેશે.",
    rescheduleNeedsCallerNumber: () =>
      "એપોઇન્ટમેન્ટ જે નંબરથી બુક થઈ હતી તે જ નંબરથી કૉલ કરો ત્યારે જ તે બદલી શકાય છે, અને આ કૉલ પર તે નંબર દેખાતો નથી. કૃપા કરીને તે નંબરથી ફરી કૉલ કરો.",
    rescheduleNotFound: () =>
      "આપ જે નંબરથી કૉલ કરી રહ્યા છો તેના પર કોઈ આગામી એપોઇન્ટમેન્ટ મળી નથી. જો તે બીજા નંબરથી બુક થઈ હોય, તો કૃપા કરીને તે નંબરથી કૉલ કરો. આપના માટે નવી એપોઇન્ટમેન્ટ પણ બુક કરી શકાય છે.",
    rescheduleNotPossible: () =>
      "માફ કરશો, આ કૉલ પર આ એપોઇન્ટમેન્ટ બદલી શકાતી નથી. અમારી ટીમ આમાં મદદ કરી શકે છે.",
    rescheduleLookupFailed: () =>
      "માફ કરશો, અત્યારે આપની એપોઇન્ટમેન્ટ શોધી શકાઈ નહીં. થોડી વાર પછી ફરી પ્રયાસ કરો, અથવા અમારી ટીમ મદદ કરી શકે છે.",
    rescheduleWhich: (d) =>
      `આપના નંબર પર આ આગામી એપોઇન્ટમેન્ટ છે: ${d.list}. આપ કઈ બદલવા માંગો છો?`,
    rescheduleAskNewTime: (d) => `આપનું ${d.booking} બુક છે. નવી તારીખ અને સમય કયો જોઈએ?`,
    rescheduleAskTimeOnDate: (d) => `${d.date}ના રોજ આપનું ${d.service} કયા સમયે ખસેડવું છે?`,
    rescheduleConfirm: (d) => `પુષ્ટિ માટે — શું આપનું ${d.booking} ${d.when} પર ખસેડીએ?`,
    rescheduleSameTime: (d) => `આપનું ${d.booking} પહેલેથી જ તે જ સમય માટે બુક છે.`,
    rescheduleTimePassed: () => "તે સમય વીતી ગયો છે. બીજો કયો સમય જોઈએ?",
    rescheduleUnchanged: () =>
      "માફ કરશો, અત્યારે આ બદલી શકાયું નહીં. આપની એપોઇન્ટમેન્ટ પહેલાં જેવી જ છે.",
    rescheduleMoved: (d) => `થઈ ગયું — આપની એપોઇન્ટમેન્ટ ${d.when} પર ખસેડવામાં આવી છે.`,
    rescheduleMovedSyncPending: (d) =>
      `આપની એપોઇન્ટમેન્ટ ${d.when} પર ખસેડવામાં આવી છે. અમારી ટીમ કૅલેન્ડર અપડેટ પૂરું કરશે અને કંઈ બદલાય તો આપને જણાવશે.`,
    rescheduleSlotUnavailable: (d) =>
      `માફ કરશો, ${d.when} ઉપલબ્ધ નથી. આપની એપોઇન્ટમેન્ટ પહેલાં જેવી જ છે. બીજો સમય જોઈએ છે?`,
    rescheduleOutsideHours: (d) =>
      `માફ કરશો, ${d.when} કામકાજના સમયની બહાર છે. આપની એપોઇન્ટમેન્ટ પહેલાં જેવી જ છે. બીજો સમય જોઈએ છે?`,
    rescheduleUnconfirmed: () =>
      "માફ કરશો, અત્યારે આ ફેરફાર કન્ફર્મ થઈ શક્યો નહીં. અમારી ટીમ તપાસીને આપની એપોઇન્ટમેન્ટનો સમય આપની સાથે કન્ફર્મ કરશે.",
  },
  "kn-IN": {
    anythingElse: "ಬೇರೆ ಏನಾದರೂ ಸಹಾಯ ಬೇಕೇ?",
    slotAvailable: (d) => `${d.when} ಲಭ್ಯವಿದೆ. ಇದನ್ನು ಬುಕ್ ಮಾಡಲೇ?`,
    slotUnavailableAgain: () => "ಮೊದಲೇ ಹೇಳಿದಂತೆ, ಆ ಸಮಯ ಲಭ್ಯವಿಲ್ಲ.",
    calendarCheckFailed: () =>
      "ಕ್ಷಮಿಸಿ, ಈಗ ಕ್ಯಾಲೆಂಡರ್ ನೋಡಲು ಆಗಲಿಲ್ಲ, ಆದ್ದರಿಂದ ಇದನ್ನು ಖಚಿತಪಡಿಸಲು ಆಗುವುದಿಲ್ಲ. ದಯವಿಟ್ಟು ಸ್ವಲ್ಪ ಸಮಯದ ನಂತರ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.",
    slotUnavailableAlternatives: (d) =>
      `ಆ ಸಮಯ ಲಭ್ಯವಿಲ್ಲ. ಆ ದಿನ ಖಾಲಿ ಇರುವ ಸಮಯಗಳು: ${d.times}. ಇವುಗಳಲ್ಲಿ ಯಾವುದಾದರೂ ಸರಿಹೊಂದುತ್ತದೆಯೇ?`,
    slotUnavailableNoneThatDay: () =>
      "ಆ ಸಮಯ ಲಭ್ಯವಿಲ್ಲ, ಮತ್ತು ಆ ದಿನ ಬೇರೆ ಯಾವ ಸಮಯವೂ ಖಾಲಿ ಇಲ್ಲ. ಬೇರೆ ದಿನ ನೋಡಲೇ?",
    noSlotsOnDate: (d) => `${d.date} ರಂದು ಯಾವ ಸಮಯವೂ ಖಾಲಿ ಇಲ್ಲ. ಬೇರೆ ದಿನ ನೋಡಲೇ?`,
    noSlotsInPeriod: (d) =>
      `${d.date} ರಂದು ಆ ಸಮಯದಲ್ಲಿ ಯಾವ ಸಮಯವೂ ಖಾಲಿ ಇಲ್ಲ. ಬೇರೆ ಸಮಯ ಅಥವಾ ದಿನ ನೋಡಲೇ?`,
    slotsOnDate: (d) =>
      `${d.date} ರಂದು ಖಾಲಿ ಇರುವ ಸಮಯಗಳು: ${d.times}. ಇವುಗಳಲ್ಲಿ ಯಾವುದಾದರೂ ಸರಿಹೊಂದುತ್ತದೆಯೇ?`,
    lineCannotBook: () =>
      "ಕ್ಷಮಿಸಿ, ಈಗ ಈ ಲೈನ್‌ನಲ್ಲಿ ಬುಕಿಂಗ್ ಪೂರ್ಣಗೊಳಿಸಲು ಆಗುವುದಿಲ್ಲ. ದಯವಿಟ್ಟು ಸ್ವಲ್ಪ ಸಮಯದ ನಂತರ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.",
    bookingSlotTaken: () =>
      "ಕ್ಷಮಿಸಿ, ಆ ಸಮಯವನ್ನು ಈಗಷ್ಟೇ ಬೇರೊಬ್ಬರು ತೆಗೆದುಕೊಂಡರು, ಆದ್ದರಿಂದ ಬುಕ್ ಮಾಡಲು ಆಗಲಿಲ್ಲ. ಬೇರೆ ಸಮಯ ಬೇಕೇ?",
    bookingFailed: () =>
      "ಕ್ಷಮಿಸಿ, ಬುಕಿಂಗ್ ಪೂರ್ಣಗೊಳ್ಳಲಿಲ್ಲ, ಆದ್ದರಿಂದ ಏನೂ ಖಚಿತವಾಗಿಲ್ಲ. ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಲೇ, ಅಥವಾ ಬೇರೆ ಸಮಯ ಆರಿಸುತ್ತೀರಾ?",
    invalidPhone: () =>
      "ಕ್ಷಮಿಸಿ, ಆ ಫೋನ್ ನಂಬರ್ ಬಳಸಲು ಆಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ನಿಮ್ಮ ಫೋನ್ ನಂಬರ್ ಅನ್ನು ಒಂದೊಂದು ಅಂಕಿಯಾಗಿ ಮತ್ತೆ ಹೇಳಿ.",
    bookingSaved: (d) =>
      `${d.when} ಗಾಗಿ ನಿಮ್ಮ ವಿನಂತಿ ಉಳಿಸಲಾಗಿದೆ, ಆದರೆ ಇನ್ನೂ ಖಚಿತವಾಗಿಲ್ಲ. ನಮ್ಮ ತಂಡ ಶೀಘ್ರದಲ್ಲೇ ನಿಮ್ಮೊಂದಿಗೆ ಖಚಿತಪಡಿಸುತ್ತದೆ.`,
    bookingPending: (d) =>
      `${d.when} ಗಾಗಿ ನಿಮ್ಮ ವಿನಂತಿಯನ್ನು ಕಳುಹಿಸಲಾಗಿದೆ, ಆದರೆ ಇನ್ನೂ ಖಚಿತವಾಗಿಲ್ಲ. ನಮ್ಮ ತಂಡ ಶೀಘ್ರದಲ್ಲೇ ನಿಮ್ಮೊಂದಿಗೆ ಖಚಿತಪಡಿಸುತ್ತದೆ.`,
    bookingConfirmed: (d) => `ನಿಮ್ಮ ${d.service} ${d.when} ಕ್ಕೆ ಖಚಿತವಾಗಿದೆ.`,
    appointmentConfirmed: () => "ನಿಮ್ಮ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಖಚಿತವಾಗಿದೆ.",
    appointmentSaved: () =>
      "ನಿಮ್ಮ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ವಿನಂತಿ ಉಳಿಸಲಾಗಿದೆ, ನಮ್ಮ ತಂಡ ಶೀಘ್ರದಲ್ಲೇ ನಿಮ್ಮೊಂದಿಗೆ ಖಚಿತಪಡಿಸುತ್ತದೆ.",
    notBookedYet: () => "ಇನ್ನೂ ಏನೂ ಬುಕ್ ಆಗಿಲ್ಲ. ಬುಕಿಂಗ್‌ಗಾಗಿ ಉಳಿದ ವಿವರಗಳನ್ನು ಹೇಳಿ ಅಥವಾ ಖಚಿತಪಡಿಸಿ.",
    confirmBooking: (d) =>
      `${d.name ? `${d.name}, ` : ""}${d.service}, ${d.when}. ಇದನ್ನು ಬುಕ್ ಮಾಡಲೇ?`,
    notBookedYetConfirm: (d) =>
      `ಇನ್ನೂ ಏನೂ ಬುಕ್ ಆಗಿಲ್ಲ. ${d.service}, ${d.when}. ಇದನ್ನು ಬುಕ್ ಮಾಡಲೇ?`,
    noReminders: () => "ಈ ಲೈನ್‌ನಲ್ಲಿ ರಿಮೈಂಡರ್ ಹೊಂದಿಸಲು ಆಗುವುದಿಲ್ಲ.",
    rescheduleKept: () => "ಸರಿ, ನಿಮ್ಮ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಹಾಗೆಯೇ ಇರುತ್ತದೆ.",
    rescheduleNeedsCallerNumber: () =>
      "ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಬುಕ್ ಮಾಡಿದ ನಂಬರಿನಿಂದಲೇ ಕರೆ ಮಾಡಿದಾಗ ಮಾತ್ರ ಅದನ್ನು ಬದಲಾಯಿಸಬಹುದು, ಮತ್ತು ಈ ಕರೆಯಲ್ಲಿ ಆ ನಂಬರ್ ಕಾಣುತ್ತಿಲ್ಲ. ದಯವಿಟ್ಟು ಆ ನಂಬರಿನಿಂದ ಮತ್ತೆ ಕರೆ ಮಾಡಿ.",
    rescheduleNotFound: () =>
      "ನೀವು ಕರೆ ಮಾಡುತ್ತಿರುವ ನಂಬರಿನಲ್ಲಿ ಮುಂಬರುವ ಯಾವುದೇ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಸಿಗಲಿಲ್ಲ. ಬೇರೆ ನಂಬರಿನಿಂದ ಬುಕ್ ಮಾಡಿದ್ದರೆ, ದಯವಿಟ್ಟು ಆ ನಂಬರಿನಿಂದ ಕರೆ ಮಾಡಿ. ನಿಮಗಾಗಿ ಹೊಸ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಕೂಡ ಬುಕ್ ಮಾಡಬಹುದು.",
    rescheduleNotPossible: () =>
      "ಕ್ಷಮಿಸಿ, ಈ ಕರೆಯಲ್ಲಿ ಈ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಬದಲಾಯಿಸಲು ಆಗುವುದಿಲ್ಲ. ನಮ್ಮ ತಂಡ ಇದರಲ್ಲಿ ಸಹಾಯ ಮಾಡಬಹುದು.",
    rescheduleLookupFailed: () =>
      "ಕ್ಷಮಿಸಿ, ಈಗ ನಿಮ್ಮ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಹುಡುಕಲು ಆಗಲಿಲ್ಲ. ಸ್ವಲ್ಪ ಸಮಯದ ನಂತರ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ, ಅಥವಾ ನಮ್ಮ ತಂಡ ಸಹಾಯ ಮಾಡಬಹುದು.",
    rescheduleWhich: (d) =>
      `ನಿಮ್ಮ ನಂಬರಿನಲ್ಲಿ ಮುಂಬರುವ ಅಪಾಯಿಂಟ್ಮೆಂಟ್‌ಗಳು: ${d.list}. ಯಾವುದನ್ನು ಬದಲಾಯಿಸಬೇಕು?`,
    rescheduleAskNewTime: (d) => `ನಿಮ್ಮ ${d.booking} ಬುಕ್ ಆಗಿದೆ. ಹೊಸ ದಿನಾಂಕ ಮತ್ತು ಸಮಯ ಯಾವುದು ಬೇಕು?`,
    rescheduleAskTimeOnDate: (d) =>
      `${d.date} ರಂದು ನಿಮ್ಮ ${d.service} ಅನ್ನು ಯಾವ ಸಮಯಕ್ಕೆ ಬದಲಾಯಿಸಬೇಕು?`,
    rescheduleConfirm: (d) => `ಖಚಿತಪಡಿಸಲು — ನಿಮ್ಮ ${d.booking} ಅನ್ನು ${d.when} ಕ್ಕೆ ಬದಲಾಯಿಸಲೇ?`,
    rescheduleSameTime: (d) => `ನಿಮ್ಮ ${d.booking} ಈಗಾಗಲೇ ಅದೇ ಸಮಯಕ್ಕೆ ಬುಕ್ ಆಗಿದೆ.`,
    rescheduleTimePassed: () => "ಆ ಸಮಯ ಈಗಾಗಲೇ ಕಳೆದುಹೋಗಿದೆ. ಬೇರೆ ಯಾವ ಸಮಯ ಬೇಕು?",
    rescheduleUnchanged: () =>
      "ಕ್ಷಮಿಸಿ, ಈಗ ಇದನ್ನು ಬದಲಾಯಿಸಲು ಆಗಲಿಲ್ಲ. ನಿಮ್ಮ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಬದಲಾಗಿಲ್ಲ.",
    rescheduleMoved: (d) => `ಆಯಿತು — ನಿಮ್ಮ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಅನ್ನು ${d.when} ಕ್ಕೆ ಬದಲಾಯಿಸಲಾಗಿದೆ.`,
    rescheduleMovedSyncPending: (d) =>
      `ನಿಮ್ಮ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಅನ್ನು ${d.when} ಕ್ಕೆ ಬದಲಾಯಿಸಲಾಗಿದೆ. ನಮ್ಮ ತಂಡ ಕ್ಯಾಲೆಂಡರ್ ನವೀಕರಣ ಪೂರ್ಣಗೊಳಿಸಿ, ಏನಾದರೂ ಬದಲಾದರೆ ನಿಮಗೆ ತಿಳಿಸುತ್ತದೆ.`,
    rescheduleSlotUnavailable: (d) =>
      `ಕ್ಷಮಿಸಿ, ${d.when} ಲಭ್ಯವಿಲ್ಲ. ನಿಮ್ಮ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಬದಲಾಗಿಲ್ಲ. ಬೇರೆ ಸಮಯ ಬೇಕೇ?`,
    rescheduleOutsideHours: (d) =>
      `ಕ್ಷಮಿಸಿ, ${d.when} ಕೆಲಸದ ಸಮಯದ ಹೊರಗಿದೆ. ನಿಮ್ಮ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಬದಲಾಗಿಲ್ಲ. ಬೇರೆ ಸಮಯ ಬೇಕೇ?`,
    rescheduleUnconfirmed: () =>
      "ಕ್ಷಮಿಸಿ, ಈಗ ಈ ಬದಲಾವಣೆಯನ್ನು ಖಚಿತಪಡಿಸಲು ಆಗಲಿಲ್ಲ. ನಮ್ಮ ತಂಡ ಪರಿಶೀಲಿಸಿ ನಿಮ್ಮ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಸಮಯವನ್ನು ನಿಮ್ಮೊಂದಿಗೆ ಖಚಿತಪಡಿಸುತ್ತದೆ.",
  },
  "ml-IN": {
    anythingElse: "മറ്റെന്തെങ്കിലും സഹായം വേണോ?",
    slotAvailable: (d) => `${d.when} ലഭ്യമാണ്. ഇത് ബുക്ക് ചെയ്യട്ടെ?`,
    slotUnavailableAgain: () => "നേരത്തെ പറഞ്ഞതുപോലെ, ആ സമയം ലഭ്യമല്ല.",
    calendarCheckFailed: () =>
      "ക്ഷമിക്കണം, ഇപ്പോൾ കലണ്ടർ പരിശോധിക്കാൻ കഴിഞ്ഞില്ല, അതിനാൽ ഇത് ഉറപ്പാക്കാൻ കഴിയില്ല. ദയവായി കുറച്ചുകഴിഞ്ഞ് വീണ്ടും ശ്രമിക്കുക.",
    slotUnavailableAlternatives: (d) =>
      `ആ സമയം ലഭ്യമല്ല. അന്ന് ഒഴിവുള്ള സമയങ്ങൾ: ${d.times}. ഇതിൽ ഏതെങ്കിലും പറ്റുമോ?`,
    slotUnavailableNoneThatDay: () =>
      "ആ സമയം ലഭ്യമല്ല, അന്ന് മറ്റൊരു സമയവും ഒഴിവില്ല. മറ്റൊരു ദിവസം നോക്കട്ടെ?",
    noSlotsOnDate: (d) => `${d.date} ന് ഒരു സമയവും ഒഴിവില്ല. മറ്റൊരു ദിവസം നോക്കട്ടെ?`,
    noSlotsInPeriod: (d) =>
      `${d.date} ന് ആ സമയത്ത് ഒരു സമയവും ഒഴിവില്ല. മറ്റൊരു സമയമോ ദിവസമോ നോക്കട്ടെ?`,
    slotsOnDate: (d) => `${d.date} ന് ഒഴിവുള്ള സമയങ്ങൾ: ${d.times}. ഇതിൽ ഏതെങ്കിലും പറ്റുമോ?`,
    lineCannotBook: () =>
      "ക്ഷമിക്കണം, ഇപ്പോൾ ഈ ലൈനിൽ ബുക്കിംഗ് പൂർത്തിയാക്കാൻ കഴിയില്ല. ദയവായി കുറച്ചുകഴിഞ്ഞ് വീണ്ടും ശ്രമിക്കുക.",
    bookingSlotTaken: () =>
      "ക്ഷമിക്കണം, ആ സമയം ഇപ്പോൾ മറ്റൊരാൾ എടുത്തു, അതിനാൽ ബുക്ക് ചെയ്യാൻ കഴിഞ്ഞില്ല. മറ്റൊരു സമയം വേണോ?",
    bookingFailed: () =>
      "ക്ഷമിക്കണം, ബുക്കിംഗ് പൂർത്തിയായില്ല, അതിനാൽ ഒന്നും ഉറപ്പായിട്ടില്ല. വീണ്ടും ശ്രമിക്കട്ടെ, അതോ മറ്റൊരു സമയം തിരഞ്ഞെടുക്കുമോ?",
    invalidPhone: () =>
      "ക്ഷമിക്കണം, ആ ഫോൺ നമ്പർ ഉപയോഗിക്കാൻ കഴിഞ്ഞില്ല. ദയവായി നിങ്ങളുടെ ഫോൺ നമ്പർ ഓരോ അക്കമായി വീണ്ടും പറയൂ.",
    bookingSaved: (d) =>
      `${d.when} നുള്ള നിങ്ങളുടെ അഭ്യർത്ഥന സേവ് ചെയ്തു, പക്ഷേ ഇതുവരെ ഉറപ്പായിട്ടില്ല. ഞങ്ങളുടെ ടീം ഉടൻ നിങ്ങളുമായി ഉറപ്പാക്കും.`,
    bookingPending: (d) =>
      `${d.when} നുള്ള നിങ്ങളുടെ അഭ്യർത്ഥന അയച്ചു, പക്ഷേ ഇതുവരെ ഉറപ്പായിട്ടില്ല. ഞങ്ങളുടെ ടീം ഉടൻ നിങ്ങളുമായി ഉറപ്പാക്കും.`,
    bookingConfirmed: (d) => `നിങ്ങളുടെ ${d.service} ${d.when} ന് ഉറപ്പായി.`,
    appointmentConfirmed: () => "നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് ഉറപ്പായി.",
    appointmentSaved: () =>
      "നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് അഭ്യർത്ഥന സേവ് ചെയ്തു, ഞങ്ങളുടെ ടീം ഉടൻ നിങ്ങളുമായി ഉറപ്പാക്കും.",
    notBookedYet: () =>
      "ഇതുവരെ ഒന്നും ബുക്ക് ചെയ്തിട്ടില്ല. ബുക്കിംഗിനായി ബാക്കി വിവരങ്ങൾ പറയുക, അല്ലെങ്കിൽ ഉറപ്പാക്കുക.",
    confirmBooking: (d) =>
      `${d.name ? `${d.name}, ` : ""}${d.service}, ${d.when}. ഇത് ബുക്ക് ചെയ്യട്ടെ?`,
    notBookedYetConfirm: (d) =>
      `ഇതുവരെ ഒന്നും ബുക്ക് ചെയ്തിട്ടില്ല. ${d.service}, ${d.when}. ഇത് ബുക്ക് ചെയ്യട്ടെ?`,
    noReminders: () => "ഈ ലൈനിൽ റിമൈൻഡർ സെറ്റ് ചെയ്യാൻ കഴിയില്ല.",
    rescheduleKept: () => "ശരി, നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് അതുപോലെ തന്നെ തുടരും.",
    rescheduleNeedsCallerNumber: () =>
      "അപ്പോയിന്റ്മെന്റ് ബുക്ക് ചെയ്ത നമ്പറിൽ നിന്ന് വിളിക്കുമ്പോൾ മാത്രമേ അത് മാറ്റാൻ കഴിയൂ, ഈ കോളിൽ ആ നമ്പർ കാണുന്നില്ല. ദയവായി ആ നമ്പറിൽ നിന്ന് വീണ്ടും വിളിക്കുക.",
    rescheduleNotFound: () =>
      "നിങ്ങൾ വിളിക്കുന്ന നമ്പറിൽ വരാനിരിക്കുന്ന അപ്പോയിന്റ്മെന്റ് ഒന്നും കണ്ടെത്തിയില്ല. മറ്റൊരു നമ്പറിൽ ബുക്ക് ചെയ്തതാണെങ്കിൽ, ദയവായി ആ നമ്പറിൽ നിന്ന് വിളിക്കുക. നിങ്ങൾക്കായി പുതിയ അപ്പോയിന്റ്മെന്റും ബുക്ക് ചെയ്യാം.",
    rescheduleNotPossible: () =>
      "ക്ഷമിക്കണം, ഈ കോളിൽ ഈ അപ്പോയിന്റ്മെന്റ് മാറ്റാൻ കഴിയില്ല. ഞങ്ങളുടെ ടീമിന് ഇതിൽ സഹായിക്കാനാകും.",
    rescheduleLookupFailed: () =>
      "ക്ഷമിക്കണം, ഇപ്പോൾ നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് കണ്ടെത്താൻ കഴിഞ്ഞില്ല. കുറച്ച് കഴിഞ്ഞ് വീണ്ടും ശ്രമിക്കുക, അല്ലെങ്കിൽ ഞങ്ങളുടെ ടീം സഹായിക്കും.",
    rescheduleWhich: (d) =>
      `നിങ്ങളുടെ നമ്പറിൽ വരാനിരിക്കുന്ന അപ്പോയിന്റ്മെന്റുകൾ: ${d.list}. ഏതാണ് മാറ്റേണ്ടത്?`,
    rescheduleAskNewTime: (d) =>
      `നിങ്ങളുടെ ${d.booking} ബുക്ക് ചെയ്തിട്ടുണ്ട്. പുതിയ തീയതിയും സമയവും ഏതാണ് വേണ്ടത്?`,
    rescheduleAskTimeOnDate: (d) => `${d.date} ന് നിങ്ങളുടെ ${d.service} ഏത് സമയത്തേക്ക് മാറ്റണം?`,
    rescheduleConfirm: (d) => `ഉറപ്പാക്കാൻ — നിങ്ങളുടെ ${d.booking} ${d.when} ലേക്ക് മാറ്റട്ടെ?`,
    rescheduleSameTime: (d) =>
      `നിങ്ങളുടെ ${d.booking} ഇതിനകം അതേ സമയത്തേക്ക് ബുക്ക് ചെയ്തിട്ടുണ്ട്.`,
    rescheduleTimePassed: () => "ആ സമയം കഴിഞ്ഞുപോയി. മറ്റേത് സമയമാണ് വേണ്ടത്?",
    rescheduleUnchanged: () =>
      "ക്ഷമിക്കണം, ഇപ്പോൾ ഇത് മാറ്റാൻ കഴിഞ്ഞില്ല. നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റിൽ മാറ്റമില്ല.",
    rescheduleMoved: (d) => `കഴിഞ്ഞു — നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് ${d.when} ലേക്ക് മാറ്റി.`,
    rescheduleMovedSyncPending: (d) =>
      `നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് ${d.when} ലേക്ക് മാറ്റി. ഞങ്ങളുടെ ടീം കലണ്ടർ അപ്ഡേറ്റ് പൂർത്തിയാക്കി, എന്തെങ്കിലും മാറ്റമുണ്ടെങ്കിൽ നിങ്ങളെ അറിയിക്കും.`,
    rescheduleSlotUnavailable: (d) =>
      `ക്ഷമിക്കണം, ${d.when} ലഭ്യമല്ല. നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റിൽ മാറ്റമില്ല. മറ്റൊരു സമയം വേണോ?`,
    rescheduleOutsideHours: (d) =>
      `ക്ഷമിക്കണം, ${d.when} പ്രവൃത്തി സമയത്തിന് പുറത്താണ്. നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റിൽ മാറ്റമില്ല. മറ്റൊരു സമയം വേണോ?`,
    rescheduleUnconfirmed: () =>
      "ക്ഷമിക്കണം, ഇപ്പോൾ ഈ മാറ്റം ഉറപ്പാക്കാൻ കഴിഞ്ഞില്ല. ഞങ്ങളുടെ ടീം പരിശോധിച്ച് നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് സമയം നിങ്ങളുമായി ഉറപ്പാക്കും.",
  },
  "pa-IN": {
    anythingElse: "ਕੋਈ ਹੋਰ ਮਦਦ ਚਾਹੀਦੀ ਹੈ?",
    slotAvailable: (d) => `${d.when} ਉਪਲਬਧ ਹੈ। ਕੀ ਇਹ ਬੁੱਕ ਕਰ ਦੇਈਏ?`,
    slotUnavailableAgain: () => "ਜਿਵੇਂ ਪਹਿਲਾਂ ਦੱਸਿਆ, ਉਹ ਸਮਾਂ ਉਪਲਬਧ ਨਹੀਂ ਹੈ।",
    calendarCheckFailed: () =>
      "ਮਾਫ਼ ਕਰਨਾ, ਇਸ ਵੇਲੇ ਕੈਲੰਡਰ ਦੇਖਿਆ ਨਹੀਂ ਜਾ ਸਕਿਆ, ਇਸ ਲਈ ਇਸ ਦੀ ਪੁਸ਼ਟੀ ਨਹੀਂ ਹੋ ਸਕਦੀ। ਕਿਰਪਾ ਕਰਕੇ ਥੋੜ੍ਹੀ ਦੇਰ ਬਾਅਦ ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੋ।",
    slotUnavailableAlternatives: (d) =>
      `ਉਹ ਸਮਾਂ ਉਪਲਬਧ ਨਹੀਂ ਹੈ। ਉਸ ਦਿਨ ਇਹ ਸਮੇਂ ਖਾਲੀ ਹਨ: ${d.times}। ਕੀ ਇਨ੍ਹਾਂ ਵਿੱਚੋਂ ਕੋਈ ਠੀਕ ਰਹੇਗਾ?`,
    slotUnavailableNoneThatDay: () =>
      "ਉਹ ਸਮਾਂ ਉਪਲਬਧ ਨਹੀਂ ਹੈ, ਅਤੇ ਉਸ ਦਿਨ ਹੋਰ ਕੋਈ ਸਮਾਂ ਖਾਲੀ ਨਹੀਂ ਹੈ। ਕੀ ਕੋਈ ਹੋਰ ਦਿਨ ਦੇਖੀਏ?",
    noSlotsOnDate: (d) => `${d.date} ਨੂੰ ਕੋਈ ਸਮਾਂ ਖਾਲੀ ਨਹੀਂ ਹੈ। ਕੀ ਕੋਈ ਹੋਰ ਦਿਨ ਦੇਖੀਏ?`,
    noSlotsInPeriod: (d) =>
      `${d.date} ਨੂੰ ਉਸ ਸਮੇਂ ਦੌਰਾਨ ਕੋਈ ਸਮਾਂ ਖਾਲੀ ਨਹੀਂ ਹੈ। ਕੀ ਕੋਈ ਹੋਰ ਸਮਾਂ ਜਾਂ ਦਿਨ ਦੇਖੀਏ?`,
    slotsOnDate: (d) =>
      `${d.date} ਨੂੰ ਇਹ ਸਮੇਂ ਖਾਲੀ ਹਨ: ${d.times}। ਕੀ ਇਨ੍ਹਾਂ ਵਿੱਚੋਂ ਕੋਈ ਠੀਕ ਰਹੇਗਾ?`,
    lineCannotBook: () =>
      "ਮਾਫ਼ ਕਰਨਾ, ਇਸ ਵੇਲੇ ਇਸ ਲਾਈਨ 'ਤੇ ਬੁਕਿੰਗ ਪੂਰੀ ਨਹੀਂ ਹੋ ਸਕਦੀ। ਕਿਰਪਾ ਕਰਕੇ ਥੋੜ੍ਹੀ ਦੇਰ ਬਾਅਦ ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੋ।",
    bookingSlotTaken: () =>
      "ਮਾਫ਼ ਕਰਨਾ, ਉਹ ਸਮਾਂ ਹੁਣੇ ਕਿਸੇ ਹੋਰ ਨੇ ਲੈ ਲਿਆ, ਇਸ ਲਈ ਬੁੱਕ ਨਹੀਂ ਹੋ ਸਕਿਆ। ਕੀ ਕੋਈ ਹੋਰ ਸਮਾਂ ਚਾਹੀਦਾ ਹੈ?",
    bookingFailed: () =>
      "ਮਾਫ਼ ਕਰਨਾ, ਬੁਕਿੰਗ ਪੂਰੀ ਨਹੀਂ ਹੋ ਸਕੀ, ਇਸ ਲਈ ਕੁਝ ਵੀ ਪੱਕਾ ਨਹੀਂ ਹੋਇਆ। ਕੀ ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੀਏ, ਜਾਂ ਕੋਈ ਹੋਰ ਸਮਾਂ ਚੁਣੋਗੇ?",
    invalidPhone: () =>
      "ਮਾਫ਼ ਕਰਨਾ, ਉਹ ਫ਼ੋਨ ਨੰਬਰ ਵਰਤਿਆ ਨਹੀਂ ਜਾ ਸਕਿਆ। ਕਿਰਪਾ ਕਰਕੇ ਆਪਣਾ ਫ਼ੋਨ ਨੰਬਰ ਇੱਕ-ਇੱਕ ਅੰਕ ਕਰਕੇ ਦੁਬਾਰਾ ਦੱਸੋ।",
    bookingSaved: (d) =>
      `${d.when} ਲਈ ਤੁਹਾਡੀ ਬੇਨਤੀ ਸੇਵ ਹੋ ਗਈ ਹੈ, ਪਰ ਅਜੇ ਪੱਕੀ ਨਹੀਂ ਹੋਈ। ਸਾਡੀ ਟੀਮ ਜਲਦੀ ਹੀ ਤੁਹਾਡੇ ਨਾਲ ਪੁਸ਼ਟੀ ਕਰੇਗੀ।`,
    bookingPending: (d) =>
      `${d.when} ਲਈ ਤੁਹਾਡੀ ਬੇਨਤੀ ਭੇਜ ਦਿੱਤੀ ਗਈ ਹੈ, ਪਰ ਅਜੇ ਪੱਕੀ ਨਹੀਂ ਹੋਈ। ਸਾਡੀ ਟੀਮ ਜਲਦੀ ਹੀ ਤੁਹਾਡੇ ਨਾਲ ਪੁਸ਼ਟੀ ਕਰੇਗੀ।`,
    bookingConfirmed: (d) => `ਤੁਹਾਡੀ ${d.service} ${d.when} ਲਈ ਪੱਕੀ ਹੋ ਗਈ ਹੈ।`,
    appointmentConfirmed: () => "ਤੁਹਾਡੀ ਅਪੌਇੰਟਮੈਂਟ ਪੱਕੀ ਹੋ ਗਈ ਹੈ।",
    appointmentSaved: () =>
      "ਤੁਹਾਡੀ ਅਪੌਇੰਟਮੈਂਟ ਦੀ ਬੇਨਤੀ ਸੇਵ ਹੋ ਗਈ ਹੈ, ਅਤੇ ਸਾਡੀ ਟੀਮ ਜਲਦੀ ਹੀ ਤੁਹਾਡੇ ਨਾਲ ਪੁਸ਼ਟੀ ਕਰੇਗੀ।",
    notBookedYet: () =>
      "ਅਜੇ ਤੱਕ ਕੁਝ ਵੀ ਬੁੱਕ ਨਹੀਂ ਹੋਇਆ। ਬੁਕਿੰਗ ਲਈ ਬਾਕੀ ਜਾਣਕਾਰੀ ਦੱਸੋ ਜਾਂ ਪੁਸ਼ਟੀ ਕਰੋ।",
    confirmBooking: (d) =>
      `${d.name ? `${d.name} ਜੀ, ` : ""}${d.service}, ${d.when}। ਕੀ ਇਹ ਬੁੱਕ ਕਰ ਦੇਈਏ?`,
    notBookedYetConfirm: (d) =>
      `ਅਜੇ ਤੱਕ ਕੁਝ ਵੀ ਬੁੱਕ ਨਹੀਂ ਹੋਇਆ। ${d.service}, ${d.when}। ਕੀ ਇਹ ਬੁੱਕ ਕਰ ਦੇਈਏ?`,
    noReminders: () => "ਇਸ ਲਾਈਨ 'ਤੇ ਰਿਮਾਈਂਡਰ ਸੈੱਟ ਨਹੀਂ ਕੀਤਾ ਜਾ ਸਕਦਾ।",
    rescheduleKept: () => "ਠੀਕ ਹੈ, ਤੁਹਾਡੀ ਅਪੌਇੰਟਮੈਂਟ ਜਿਵੇਂ ਹੈ ਉਵੇਂ ਹੀ ਰਹੇਗੀ।",
    rescheduleNeedsCallerNumber: () =>
      "ਅਪੌਇੰਟਮੈਂਟ ਉਸੇ ਨੰਬਰ ਤੋਂ ਕਾਲ ਕਰਨ 'ਤੇ ਹੀ ਬਦਲੀ ਜਾ ਸਕਦੀ ਹੈ ਜਿਸ ਤੋਂ ਉਹ ਬੁੱਕ ਹੋਈ ਸੀ, ਅਤੇ ਇਸ ਕਾਲ 'ਤੇ ਉਹ ਨੰਬਰ ਦਿਖਾਈ ਨਹੀਂ ਦੇ ਰਿਹਾ। ਕਿਰਪਾ ਕਰਕੇ ਉਸ ਨੰਬਰ ਤੋਂ ਦੁਬਾਰਾ ਕਾਲ ਕਰੋ।",
    rescheduleNotFound: () =>
      "ਤੁਸੀਂ ਜਿਸ ਨੰਬਰ ਤੋਂ ਕਾਲ ਕਰ ਰਹੇ ਹੋ, ਉਸ 'ਤੇ ਕੋਈ ਆਉਣ ਵਾਲੀ ਅਪੌਇੰਟਮੈਂਟ ਨਹੀਂ ਮਿਲੀ। ਜੇ ਉਹ ਕਿਸੇ ਹੋਰ ਨੰਬਰ ਤੋਂ ਬੁੱਕ ਹੋਈ ਸੀ, ਤਾਂ ਕਿਰਪਾ ਕਰਕੇ ਉਸ ਨੰਬਰ ਤੋਂ ਕਾਲ ਕਰੋ। ਤੁਹਾਡੇ ਲਈ ਨਵੀਂ ਅਪੌਇੰਟਮੈਂਟ ਵੀ ਬੁੱਕ ਕੀਤੀ ਜਾ ਸਕਦੀ ਹੈ।",
    rescheduleNotPossible: () =>
      "ਮਾਫ਼ ਕਰਨਾ, ਇਸ ਕਾਲ 'ਤੇ ਇਹ ਅਪੌਇੰਟਮੈਂਟ ਬਦਲੀ ਨਹੀਂ ਜਾ ਸਕਦੀ। ਸਾਡੀ ਟੀਮ ਇਸ ਵਿੱਚ ਮਦਦ ਕਰ ਸਕਦੀ ਹੈ।",
    rescheduleLookupFailed: () =>
      "ਮਾਫ਼ ਕਰਨਾ, ਇਸ ਵੇਲੇ ਤੁਹਾਡੀ ਅਪੌਇੰਟਮੈਂਟ ਲੱਭੀ ਨਹੀਂ ਜਾ ਸਕੀ। ਥੋੜ੍ਹੀ ਦੇਰ ਬਾਅਦ ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੋ, ਜਾਂ ਸਾਡੀ ਟੀਮ ਮਦਦ ਕਰ ਸਕਦੀ ਹੈ।",
    rescheduleWhich: (d) =>
      `ਤੁਹਾਡੇ ਨੰਬਰ 'ਤੇ ਇਹ ਆਉਣ ਵਾਲੀਆਂ ਅਪੌਇੰਟਮੈਂਟਾਂ ਹਨ: ${d.list}। ਤੁਸੀਂ ਕਿਹੜੀ ਬਦਲਣਾ ਚਾਹੋਗੇ?`,
    rescheduleAskNewTime: (d) =>
      `ਤੁਹਾਡੀ ${d.booking} ਬੁੱਕ ਹੈ। ਨਵੀਂ ਤਾਰੀਖ ਅਤੇ ਸਮਾਂ ਕਿਹੜਾ ਚਾਹੀਦਾ ਹੈ?`,
    rescheduleAskTimeOnDate: (d) => `${d.date} ਨੂੰ ਤੁਹਾਡੀ ${d.service} ਕਿਸ ਸਮੇਂ 'ਤੇ ਕਰਨੀ ਹੈ?`,
    rescheduleConfirm: (d) => `ਪੁਸ਼ਟੀ ਲਈ — ਕੀ ਤੁਹਾਡੀ ${d.booking} ${d.when} 'ਤੇ ਕਰ ਦੇਈਏ?`,
    rescheduleSameTime: (d) => `ਤੁਹਾਡੀ ${d.booking} ਪਹਿਲਾਂ ਹੀ ਉਸੇ ਸਮੇਂ ਲਈ ਬੁੱਕ ਹੈ।`,
    rescheduleTimePassed: () => "ਉਹ ਸਮਾਂ ਲੰਘ ਚੁੱਕਾ ਹੈ। ਕਿਹੜਾ ਹੋਰ ਸਮਾਂ ਚਾਹੀਦਾ ਹੈ?",
    rescheduleUnchanged: () =>
      "ਮਾਫ਼ ਕਰਨਾ, ਇਸ ਵੇਲੇ ਇਹ ਬਦਲਿਆ ਨਹੀਂ ਜਾ ਸਕਿਆ। ਤੁਹਾਡੀ ਅਪੌਇੰਟਮੈਂਟ ਪਹਿਲਾਂ ਵਾਂਗ ਹੀ ਹੈ।",
    rescheduleMoved: (d) => `ਹੋ ਗਿਆ — ਤੁਹਾਡੀ ਅਪੌਇੰਟਮੈਂਟ ${d.when} 'ਤੇ ਕਰ ਦਿੱਤੀ ਗਈ ਹੈ।`,
    rescheduleMovedSyncPending: (d) =>
      `ਤੁਹਾਡੀ ਅਪੌਇੰਟਮੈਂਟ ${d.when} 'ਤੇ ਕਰ ਦਿੱਤੀ ਗਈ ਹੈ। ਸਾਡੀ ਟੀਮ ਕੈਲੰਡਰ ਅੱਪਡੇਟ ਪੂਰਾ ਕਰੇਗੀ ਅਤੇ ਕੁਝ ਬਦਲਣ 'ਤੇ ਤੁਹਾਨੂੰ ਦੱਸੇਗੀ।`,
    rescheduleSlotUnavailable: (d) =>
      `ਮਾਫ਼ ਕਰਨਾ, ${d.when} ਉਪਲਬਧ ਨਹੀਂ ਹੈ। ਤੁਹਾਡੀ ਅਪੌਇੰਟਮੈਂਟ ਪਹਿਲਾਂ ਵਾਂਗ ਹੀ ਹੈ। ਕੀ ਕੋਈ ਹੋਰ ਸਮਾਂ ਚਾਹੀਦਾ ਹੈ?`,
    rescheduleOutsideHours: (d) =>
      `ਮਾਫ਼ ਕਰਨਾ, ${d.when} ਕੰਮ ਦੇ ਸਮੇਂ ਤੋਂ ਬਾਹਰ ਹੈ। ਤੁਹਾਡੀ ਅਪੌਇੰਟਮੈਂਟ ਪਹਿਲਾਂ ਵਾਂਗ ਹੀ ਹੈ। ਕੀ ਕੋਈ ਹੋਰ ਸਮਾਂ ਚਾਹੀਦਾ ਹੈ?`,
    rescheduleUnconfirmed: () =>
      "ਮਾਫ਼ ਕਰਨਾ, ਇਸ ਵੇਲੇ ਇਹ ਬਦਲਾਅ ਪੱਕਾ ਨਹੀਂ ਹੋ ਸਕਿਆ। ਸਾਡੀ ਟੀਮ ਜਾਂਚ ਕਰਕੇ ਤੁਹਾਡੀ ਅਪੌਇੰਟਮੈਂਟ ਦਾ ਸਮਾਂ ਤੁਹਾਡੇ ਨਾਲ ਪੱਕਾ ਕਰੇਗੀ।",
  },
  "od-IN": {
    anythingElse: "ଆଉ କିଛି ସାହାଯ୍ୟ ଦରକାର କି?",
    slotAvailable: (d) => `${d.when} ଉପଲବ୍ଧ ଅଛି। ଏହାକୁ ବୁକ୍ କରିଦେବୁ କି?`,
    slotUnavailableAgain: () => "ଆଗରୁ କୁହାଯାଇଥିବା ପରି, ସେହି ସମୟ ଉପଲବ୍ଧ ନାହିଁ।",
    calendarCheckFailed: () =>
      "କ୍ଷମା କରିବେ, ଏବେ କ୍ୟାଲେଣ୍ଡର ଦେଖାଯାଇପାରିଲା ନାହିଁ, ତେଣୁ ଏହା ନିଶ୍ଚିତ କରାଯାଇପାରିବ ନାହିଁ। ଦୟାକରି କିଛି ସମୟ ପରେ ପୁଣି ଚେଷ୍ଟା କରନ୍ତୁ।",
    slotUnavailableAlternatives: (d) =>
      `ସେହି ସମୟ ଉପଲବ୍ଧ ନାହିଁ। ସେଦିନ ଖାଲି ଥିବା ସମୟ: ${d.times}। ଏଥିମଧ୍ୟରୁ କୌଣସିଟି ଚଳିବ କି?`,
    slotUnavailableNoneThatDay: () =>
      "ସେହି ସମୟ ଉପଲବ୍ଧ ନାହିଁ, ଏବଂ ସେଦିନ ଆଉ କୌଣସି ସମୟ ଖାଲି ନାହିଁ। ଅନ୍ୟ ଦିନ ଦେଖିବୁ କି?",
    noSlotsOnDate: (d) => `${d.date} ରେ କୌଣସି ସମୟ ଖାଲି ନାହିଁ। ଅନ୍ୟ ଦିନ ଦେଖିବୁ କି?`,
    noSlotsInPeriod: (d) =>
      `${d.date} ରେ ସେହି ସମୟରେ କୌଣସି ସମୟ ଖାଲି ନାହିଁ। ଅନ୍ୟ ସମୟ ବା ଦିନ ଦେଖିବୁ କି?`,
    slotsOnDate: (d) => `${d.date} ରେ ଖାଲି ଥିବା ସମୟ: ${d.times}। ଏଥିମଧ୍ୟରୁ କୌଣସିଟି ଚଳିବ କି?`,
    lineCannotBook: () =>
      "କ୍ଷମା କରିବେ, ଏବେ ଏହି ଲାଇନରେ ବୁକିଂ ସମ୍ପୂର୍ଣ୍ଣ କରାଯାଇପାରିବ ନାହିଁ। ଦୟାକରି କିଛି ସମୟ ପରେ ପୁଣି ଚେଷ୍ଟା କରନ୍ତୁ।",
    bookingSlotTaken: () =>
      "କ୍ଷମା କରିବେ, ସେହି ସମୟ ଏଇମାତ୍ର ଅନ୍ୟ କେହି ନେଇଗଲେ, ତେଣୁ ବୁକ୍ କରାଯାଇପାରିଲା ନାହିଁ। ଅନ୍ୟ ସମୟ ଦରକାର କି?",
    bookingFailed: () =>
      "କ୍ଷମା କରିବେ, ବୁକିଂ ସମ୍ପୂର୍ଣ୍ଣ ହୋଇପାରିଲା ନାହିଁ, ତେଣୁ କିଛି ନିଶ୍ଚିତ ହୋଇନାହିଁ। ପୁଣି ଚେଷ୍ଟା କରିବୁ, ନା ଅନ୍ୟ ସମୟ ବାଛିବେ?",
    invalidPhone: () =>
      "କ୍ଷମା କରିବେ, ସେହି ଫୋନ୍ ନମ୍ବର ବ୍ୟବହାର କରାଯାଇପାରିଲା ନାହିଁ। ଦୟାକରି ଆପଣଙ୍କ ଫୋନ୍ ନମ୍ବର ଗୋଟିଏ ଗୋଟିଏ ଅଙ୍କ କରି ପୁଣି କୁହନ୍ତୁ।",
    bookingSaved: (d) =>
      `${d.when} ପାଇଁ ଆପଣଙ୍କ ଅନୁରୋଧ ସେଭ୍ ହୋଇଛି, କିନ୍ତୁ ଏପର୍ଯ୍ୟନ୍ତ ନିଶ୍ଚିତ ହୋଇନାହିଁ। ଆମ ଟିମ ଶୀଘ୍ର ଆପଣଙ୍କ ସହ ନିଶ୍ଚିତ କରିବ।`,
    bookingPending: (d) =>
      `${d.when} ପାଇଁ ଆପଣଙ୍କ ଅନୁରୋଧ ପଠାଯାଇଛି, କିନ୍ତୁ ଏପର୍ଯ୍ୟନ୍ତ ନିଶ୍ଚିତ ହୋଇନାହିଁ। ଆମ ଟିମ ଶୀଘ୍ର ଆପଣଙ୍କ ସହ ନିଶ୍ଚିତ କରିବ।`,
    bookingConfirmed: (d) => `ଆପଣଙ୍କ ${d.service} ${d.when} ପାଇଁ ନିଶ୍ଚିତ ହୋଇଛି।`,
    appointmentConfirmed: () => "ଆପଣଙ୍କ ଆପଏଣ୍ଟମେଣ୍ଟ ନିଶ୍ଚିତ ହୋଇଛି।",
    appointmentSaved: () =>
      "ଆପଣଙ୍କ ଆପଏଣ୍ଟମେଣ୍ଟ ଅନୁରୋଧ ସେଭ୍ ହୋଇଛି, ଆମ ଟିମ ଶୀଘ୍ର ଆପଣଙ୍କ ସହ ନିଶ୍ଚିତ କରିବ।",
    notBookedYet: () =>
      "ଏପର୍ଯ୍ୟନ୍ତ କିଛି ବୁକ୍ ହୋଇନାହିଁ। ବୁକିଂ ପାଇଁ ବାକି ତଥ୍ୟ କୁହନ୍ତୁ କିମ୍ବା ନିଶ୍ଚିତ କରନ୍ତୁ।",
    confirmBooking: (d) =>
      `${d.name ? `${d.name}, ` : ""}${d.service}, ${d.when}। ଏହାକୁ ବୁକ୍ କରିଦେବୁ କି?`,
    notBookedYetConfirm: (d) =>
      `ଏପର୍ଯ୍ୟନ୍ତ କିଛି ବୁକ୍ ହୋଇନାହିଁ। ${d.service}, ${d.when}। ଏହାକୁ ବୁକ୍ କରିଦେବୁ କି?`,
    noReminders: () => "ଏହି ଲାଇନରେ ରିମାଇଣ୍ଡର ସେଟ୍ କରାଯାଇପାରିବ ନାହିଁ।",
    rescheduleKept: () => "ଠିକ ଅଛି, ଆପଣଙ୍କ ଆପଏଣ୍ଟମେଣ୍ଟ ଯେମିତି ଅଛି ସେମିତି ରହିବ।",
    rescheduleNeedsCallerNumber: () =>
      "ଆପଏଣ୍ଟମେଣ୍ଟ ଯେଉଁ ନମ୍ବରରୁ ବୁକ୍ ହୋଇଥିଲା, ସେହି ନମ୍ବରରୁ କଲ୍ କଲେ ହିଁ ତାହା ବଦଳାଯାଇପାରିବ, ଏବଂ ଏହି କଲରେ ସେହି ନମ୍ବର ଦେଖାଯାଉନାହିଁ। ଦୟାକରି ସେହି ନମ୍ବରରୁ ପୁଣି କଲ୍ କରନ୍ତୁ।",
    rescheduleNotFound: () =>
      "ଆପଣ କଲ୍ କରୁଥିବା ନମ୍ବରରେ କୌଣସି ଆଗାମୀ ଆପଏଣ୍ଟମେଣ୍ଟ ମିଳିଲା ନାହିଁ। ଯଦି ଅନ୍ୟ ନମ୍ବରରୁ ବୁକ୍ ହୋଇଥିଲା, ଦୟାକରି ସେହି ନମ୍ବରରୁ କଲ୍ କରନ୍ତୁ। ଆପଣଙ୍କ ପାଇଁ ନୂଆ ଆପଏଣ୍ଟମେଣ୍ଟ ମଧ୍ୟ ବୁକ୍ କରାଯାଇପାରିବ।",
    rescheduleNotPossible: () =>
      "କ୍ଷମା କରିବେ, ଏହି କଲରେ ଏହି ଆପଏଣ୍ଟମେଣ୍ଟ ବଦଳାଯାଇପାରିବ ନାହିଁ। ଆମ ଟିମ ଏଥିରେ ସାହାଯ୍ୟ କରିପାରିବ।",
    rescheduleLookupFailed: () =>
      "କ୍ଷମା କରିବେ, ଏବେ ଆପଣଙ୍କ ଆପଏଣ୍ଟମେଣ୍ଟ ଖୋଜାଯାଇପାରିଲା ନାହିଁ। କିଛି ସମୟ ପରେ ପୁଣି ଚେଷ୍ଟା କରନ୍ତୁ, କିମ୍ବା ଆମ ଟିମ ସାହାଯ୍ୟ କରିପାରିବ।",
    rescheduleWhich: (d) =>
      `ଆପଣଙ୍କ ନମ୍ବରରେ ଏହି ଆଗାମୀ ଆପଏଣ୍ଟମେଣ୍ଟ ଅଛି: ${d.list}। କେଉଁଟି ବଦଳାଇବାକୁ ଚାହୁଁଛନ୍ତି?`,
    rescheduleAskNewTime: (d) => `ଆପଣଙ୍କ ${d.booking} ବୁକ୍ ହୋଇଛି। ନୂଆ ତାରିଖ ଓ ସମୟ କ'ଣ ଦରକାର?`,
    rescheduleAskTimeOnDate: (d) => `${d.date} ରେ ଆପଣଙ୍କ ${d.service} କେଉଁ ସମୟକୁ ବଦଳାଇବେ?`,
    rescheduleConfirm: (d) =>
      `ନିଶ୍ଚିତ କରିବା ପାଇଁ — ଆପଣଙ୍କ ${d.booking} କୁ ${d.when} କୁ ବଦଳାଇଦେବୁ କି?`,
    rescheduleSameTime: (d) => `ଆପଣଙ୍କ ${d.booking} ପୂର୍ବରୁ ସେହି ସମୟ ପାଇଁ ବୁକ୍ ହୋଇଛି।`,
    rescheduleTimePassed: () => "ସେହି ସମୟ ବିତିଯାଇଛି। ଅନ୍ୟ କେଉଁ ସମୟ ଦରକାର?",
    rescheduleUnchanged: () =>
      "କ୍ଷମା କରିବେ, ଏବେ ଏହା ବଦଳାଯାଇପାରିଲା ନାହିଁ। ଆପଣଙ୍କ ଆପଏଣ୍ଟମେଣ୍ଟ ଆଗ ପରି ଅଛି।",
    rescheduleMoved: (d) => `ହୋଇଗଲା — ଆପଣଙ୍କ ଆପଏଣ୍ଟମେଣ୍ଟ ${d.when} କୁ ବଦଳାଯାଇଛି।`,
    rescheduleMovedSyncPending: (d) =>
      `ଆପଣଙ୍କ ଆପଏଣ୍ଟମେଣ୍ଟ ${d.when} କୁ ବଦଳାଯାଇଛି। ଆମ ଟିମ କ୍ୟାଲେଣ୍ଡର ଅପଡେଟ୍ ସମ୍ପୂର୍ଣ୍ଣ କରିବ ଏବଂ କିଛି ବଦଳିଲେ ଆପଣଙ୍କୁ ଜଣାଇବ।`,
    rescheduleSlotUnavailable: (d) =>
      `କ୍ଷମା କରିବେ, ${d.when} ଉପଲବ୍ଧ ନାହିଁ। ଆପଣଙ୍କ ଆପଏଣ୍ଟମେଣ୍ଟ ଆଗ ପରି ଅଛି। ଅନ୍ୟ ସମୟ ଦରକାର କି?`,
    rescheduleOutsideHours: (d) =>
      `କ୍ଷମା କରିବେ, ${d.when} କାମ ସମୟ ବାହାରେ। ଆପଣଙ୍କ ଆପଏଣ୍ଟମେଣ୍ଟ ଆଗ ପରି ଅଛି। ଅନ୍ୟ ସମୟ ଦରକାର କି?`,
    rescheduleUnconfirmed: () =>
      "କ୍ଷମା କରିବେ, ଏବେ ଏହି ପରିବର୍ତ୍ତନ ନିଶ୍ଚିତ ହୋଇପାରିଲା ନାହିଁ। ଆମ ଟିମ ଯାଞ୍ଚ କରି ଆପଣଙ୍କ ଆପଏଣ୍ଟମେଣ୍ଟ ସମୟ ଆପଣଙ୍କ ସହ ନିଶ୍ଚିତ କରିବ।",
  },
};

/** "Is there anything else I can help you with?" — English: the runtime's own question. */
export const ANYTHING_ELSE_ENGLISH = "Is there anything else I can help you with?";

function nonEnglish(language: string): NonEnglish | null {
  const code = normalizeVoiceLanguageCode(language);
  return code && code !== "en-IN" ? code : null;
}

/**
 * The deterministic sentence for `key` in `language`, filled only from
 * `facts`. Null on an English call — the caller keeps the runtime's existing
 * English sentence there.
 */
export function callOutcomeLine(
  language: string,
  key: OutcomeKey,
  facts: OutcomeFacts = {},
): string | null {
  const code = nonEnglish(language);
  if (!code) return null;
  return OUTCOMES[code][key](format(code, facts));
}

/** The "anything else?" question in `language`. */
export function anythingElseQuestion(language: string): string {
  const code = nonEnglish(language);
  return code ? OUTCOMES[code].anythingElse : ANYTHING_ELSE_ENGLISH;
}

/** `text` followed by the "anything else?" question, unless it already asks it. */
export function withAnythingElse(language: string, text: string): string {
  return askedAnythingElse(text, language) ? text : `${text} ${anythingElseQuestion(language)}`;
}

const ANYTHING_ELSE_ENGLISH_PATTERN =
  /\b(?:anything\s+else|any\s+other\s+(?:questions?|thing)|anything\s+more|something\s+else\s+i\s+can|else\s+can\s+i\s+help)\b/i;

/**
 * The core of each language's "anything else?" — what every runtime line
 * that offers further help contains (this module's question, the
 * voice-fallback-messages lines), and what a model reply asking the same
 * thing naturally contains too.
 */
const ANYTHING_ELSE_MARKERS: Record<NonEnglish, string[]> = {
  "hi-IN": ["और चीज़ में मदद", "और कुछ मदद", "और कोई मदद"],
  "mr-IN": ["आणखी काही मदत", "आणखी काही हवे"],
  "bn-IN": ["আর কিছুতে সাহায্য", "আর কিছু সাহায্য"],
  "ta-IN": ["வேறு ஏதாவது உதவி", "வேறு ஏதேனும் உதவி"],
  "te-IN": ["ఇంకేమైనా సహాయం", "ఇంకా ఏమైనా సహాయం"],
  "gu-IN": ["બીજી કોઈ મદદ", "બીજું કંઈ મદદ"],
  "kn-IN": ["ಬೇರೆ ಏನಾದರೂ ಸಹಾಯ", "ಇನ್ನೇನಾದರೂ ಸಹಾಯ"],
  "ml-IN": ["മറ്റെന്തെങ്കിലും സഹായം", "വേറെ എന്തെങ്കിലും സഹായം"],
  "pa-IN": ["ਕੋਈ ਹੋਰ ਮਦਦ", "ਹੋਰ ਕੋਈ ਮਦਦ"],
  "od-IN": ["ଆଉ କିଛି ସାହାଯ୍ୟ"],
};

/** The agent's reply asked whether the caller needs anything else — in English or `language`. */
export function askedAnythingElse(reply: string, language: string): boolean {
  if (ANYTHING_ELSE_ENGLISH_PATTERN.test(reply)) return true;
  const code = nonEnglish(language);
  return code ? ANYTHING_ELSE_MARKERS[code].some((m) => reply.includes(m)) : false;
}

const GOODBYE_ENGLISH_PATTERN =
  /\b(?:good\s?bye|bye|have\s+a\s+(?:great|good|nice|lovely|wonderful)\s+(?:day|evening|night|one))\b/i;

/** "Thank you for calling" / "goodbye" in each language — how the runtime's own farewells end a call. */
const GOODBYE_MARKERS: Record<NonEnglish, string[]> = {
  "hi-IN": ["कॉल करने के लिए धन्यवाद", "अलविदा", "फिर मिलेंगे"],
  "mr-IN": ["कॉल केल्याबद्दल धन्यवाद", "निरोप"],
  "bn-IN": ["ফোন করার জন্য ধন্যবাদ", "বিদায়"],
  "ta-IN": ["அழைத்ததற்கு நன்றி", "சென்று வாருங்கள்"],
  "te-IN": ["కాల్ చేసినందుకు ధన్యవాదాలు", "వెళ్ళొస్తాను"],
  "gu-IN": ["કૉલ કરવા બદલ આભાર", "આવજો"],
  "kn-IN": ["ಕರೆ ಮಾಡಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು", "ಹೋಗಿ ಬನ್ನಿ"],
  "ml-IN": ["വിളിച്ചതിന് നന്ദി"],
  "pa-IN": ["ਕਾਲ ਕਰਨ ਲਈ ਧੰਨਵਾਦ", "ਅਲਵਿਦਾ"],
  "od-IN": ["କଲ୍ କରିଥିବାରୁ ଧନ୍ୟବାଦ", "ବିଦାୟ"],
};

/** The agent's reply already said goodbye — in English or `language`. */
export function saidGoodbye(reply: string, language: string): boolean {
  if (GOODBYE_ENGLISH_PATTERN.test(reply)) return true;
  const code = nonEnglish(language);
  return code ? GOODBYE_MARKERS[code].some((m) => reply.includes(m)) : false;
}

/**
 * Whole-utterance "no, that's all" replies to "anything else?", in every
 * supported language and common romanized forms. Only ever consulted right
 * after the agent asked "anything else?" (see voice-runtime.server.ts), the
 * same rule call-lifecycle-policy.ts applies to its English list — so a bare
 * "नहीं" answering some other question is never read as ending the call.
 */
const NOTHING_ELSE_REPLIES = new Set(
  [
    // Hindi / Hinglish
    "नहीं",
    "नहीं धन्यवाद",
    "नहीं शुक्रिया",
    "बस",
    "बस इतना ही",
    "और कुछ नहीं",
    "कुछ नहीं",
    "धन्यवाद",
    "शुक्रिया",
    "ठीक है धन्यवाद",
    "nahi",
    "nahin",
    "nahi thanks",
    "bas",
    "bas itna hi",
    "aur kuch nahi",
    "kuch nahi",
    "dhanyavad",
    "shukriya",
    // Marathi
    "नाही",
    "नाही धन्यवाद",
    "एवढंच",
    "आणखी काही नाही",
    // Bengali
    "না",
    "না ধন্যবাদ",
    "আর কিছু না",
    "আর কিছু নয়",
    "ধন্যবাদ",
    // Tamil
    "இல்லை",
    "இல்லை நன்றி",
    "வேறு எதுவும் இல்லை",
    "நன்றி",
    "போதும்",
    // Telugu
    "లేదు",
    "లేదు ధన్యవాదాలు",
    "ఇంకేమీ లేదు",
    "ఇంకేం లేదు",
    "ధన్యవాదాలు",
    "చాలు",
    "అంతే",
    // Gujarati
    "ના",
    "ના આભાર",
    "બીજું કંઈ નહીં",
    "આભાર",
    // Kannada
    "ಇಲ್ಲ",
    "ಇಲ್ಲ ಧನ್ಯವಾದಗಳು",
    "ಬೇರೇನೂ ಇಲ್ಲ",
    "ಧನ್ಯವಾದಗಳು",
    "ಸಾಕು",
    // Malayalam
    "ഇല്ല",
    "ഇല്ല നന്ദി",
    "വേറെ ഒന്നുമില്ല",
    "നന്ദി",
    "മതി",
    // Punjabi
    "ਨਹੀਂ",
    "ਨਹੀਂ ਧੰਨਵਾਦ",
    "ਹੋਰ ਕੁਝ ਨਹੀਂ",
    "ਧੰਨਵਾਦ",
    "ਬੱਸ",
    // Odia
    "ନାହିଁ",
    "ନା",
    "ନାହିଁ ଧନ୍ୟବାଦ",
    "ଆଉ କିଛି ନାହିଁ",
    "ଧନ୍ୟବାଦ",
  ].map((s) => s.toLowerCase()),
);

/** Goodbyes a caller may say in any supported language (English is call-lifecycle-policy.ts's). */
const CALLER_GOODBYE_PATTERN =
  /अलविदा|फिर मिलेंगे|বিদায়|ਅਲਵਿਦਾ|ବିଦାୟ|આવજો|\b(?:alvida|phir milenge)\b/iu;

function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The non-English counterpart of call-lifecycle-policy.ts's "nothing_else"
 * / "goodbye" intents, for a caller turn with no new request.
 */
export function callerClosingIntentAnyLanguage(
  text: string,
  ctx: { awaitingAnythingElse: boolean },
): "nothing_else" | "goodbye" | null {
  if (CALLER_GOODBYE_PATTERN.test(text)) return "goodbye";
  if (ctx.awaitingAnythingElse && NOTHING_ELSE_REPLIES.has(normalizeUtterance(text))) {
    return "nothing_else";
  }
  return null;
}

/** Whole-utterance "yes" to a confirmation question, in every supported language. */
const AFFIRMATIVE_REPLIES = new Set(
  [
    "हाँ",
    "हां",
    "जी",
    "जी हाँ",
    "जी हां",
    "हाँ जी",
    "हां जी",
    "ठीक है",
    "हाँ ठीक है",
    "हाँ कर दो",
    "कर दो",
    "haan",
    "han",
    "ha",
    "ji",
    "haan ji",
    "ji haan",
    "theek hai",
    "thik hai",
    "kar do",
    "हो",
    "होय",
    "चालेल",
    "ठीक आहे",
    "হ্যাঁ",
    "হ্যা",
    "ঠিক আছে",
    "আচ্ছা",
    "ஆம்",
    "ஆமா",
    "சரி",
    "అవును",
    "సరే",
    "అలాగే",
    "హా",
    "હા",
    "હાં",
    "બરાબર",
    "ચાલશે",
    "ಹೌದು",
    "ಸರಿ",
    "ಆಯ್ತು",
    "അതെ",
    "ശരി",
    "ਹਾਂ",
    "ਹਾਂ ਜੀ",
    "ਹਾਂਜੀ",
    "ਠੀਕ ਹੈ",
    "ହଁ",
    "ହଁ ଠିକ ଅଛି",
    "ଠିକ ଅଛି",
  ].map((s) => s.toLowerCase()),
);

/** Whole-utterance "no" to a confirmation question, in every supported language. */
const NEGATIVE_REPLIES = new Set(
  [
    "नहीं",
    "नहीं जी",
    "मत करो",
    "रहने दो",
    "nahi",
    "nahin",
    "mat karo",
    "rehne do",
    "नाही",
    "না",
    "থাক",
    "இல்லை",
    "வேண்டாம்",
    "లేదు",
    "వద్దు",
    "ના",
    "નહીં",
    "ಇಲ್ಲ",
    "ಬೇಡ",
    "ഇല്ല",
    "വേണ്ട",
    "ਨਹੀਂ",
    "ਨਹੀਂ ਜੀ",
    "ନାହିଁ",
    "ନା",
    "ଦରକାର ନାହିଁ",
  ].map((s) => s.toLowerCase()),
);

/**
 * A short yes or no to a confirmation question, in any supported language
 * — the non-English counterpart of the runtime's English confirmation
 * patterns. Whole-utterance only, so a sentence that merely contains "हाँ"
 * is never read as consent.
 */
export function confirmationAnswerAnyLanguage(text: string): "yes" | "no" | null {
  const normalized = normalizeUtterance(text);
  if (AFFIRMATIVE_REPLIES.has(normalized)) return "yes";
  if (NEGATIVE_REPLIES.has(normalized)) return "no";
  return null;
}

/**
 * "Book it" in each language's own words — the non-English counterpart of
 * the runtime's EXPLICIT_BOOKING_INSTRUCTION_PATTERN. A booking verb in the
 * imperative, so a mere mention of booking ("मेरी बुकिंग कब है?") never
 * matches.
 */
const NATIVE_BOOKING_INSTRUCTION =
  /बुक\s*(?:कर\s*(?:दो|दीजिए|दीजिये|दें|दे|लो|लीजिए|लीजिये)|करो|कीजिए|कीजिये|करें|करा)|বুক\s*(?:করুন|করে\s*দিন|করে\s*দাও|করো)|புக்\s*(?:செய்யுங்கள்|செய்யுங்க|பண்ணுங்க|பண்ணுங்கள்|செய்|பண்ணு)|బుక్\s*(?:చేయండి|చెయ్యండి|చేయి|చెయ్యి|చేసేయండి)|બુક\s*(?:કરો|કરી\s*દો|કરી\s*આપો)|ಬುಕ್\s*(?:ಮಾಡಿ|ಮಾಡು|ಮಾಡಿಬಿಡಿ)|ബുക്ക്\s*(?:ചെയ്യൂ|ചെയ്യുക|ചെയ്തോളൂ|ചെയ്യണം)|ਬੁੱਕ\s*(?:ਕਰ\s*(?:ਦਿਓ|ਦਿਉ|ਦੋ)|ਕਰੋ)|ବୁକ୍\s*(?:କରନ୍ତୁ|କରିଦିଅନ୍ତୁ|କର)|\bbook\s+(?:kar\s*(?:do|dijiye|dena)|karo|kijiye|chey(?:yandi|andi))\b/iu;

/**
 * "Confirm it" in each language's own words — the counterpart of the
 * English "confirm the booking", and what the runtime's own "…or confirm"
 * lines invite. Imperatives only, as whole words: "कन्फर्म कर दीजिए",
 * "నిర్ధారించండి" match, while "not confirmed" forms that merely start
 * the same way ("ಖಚಿತಪಡಿಸಿಲ್ಲ") never do.
 */
const NATIVE_CONFIRM_INSTRUCTION =
  /(?:(?:कन्फर्म|कंफर्म|पुष्टि|खात्री)\s*(?:कर\s*(?:दो|दीजिए|दीजिये|दें)|करो|कीजिए|कीजिये|करें|करा)|(?:কনফার্ম|নিশ্চিত)\s*(?:করুন|করে\s*দিন|করে\s*দাও)|(?:கன்ஃபார்ம்|உறுதி)\s*(?:செய்யுங்கள்|செய்யுங்க|பண்ணுங்க|பண்ணுங்கள்)|కన్ఫర్మ్\s*(?:చేయండి|చెయ్యండి|చేసేయండి)|నిర్ధారించండి|(?:કન્ફર્મ|પુષ્ટિ)\s*(?:કરો|કરી\s*દો|કરી\s*આપો)|ಕನ್ಫರ್ಮ್\s*(?:ಮಾಡಿ|ಮಾಡಿಬಿಡಿ)|ಖಚಿತ\s*ಪಡಿಸಿ|കൺഫേം\s*(?:ചെയ്യൂ|ചെയ്യുക|ചെയ്തോളൂ)|ഉറപ്പാക്കൂ|ഉറപ്പാക്കുക|(?:ਕਨਫਰਮ|ਪੁਸ਼ਟੀ)\s*(?:ਕਰ\s*(?:ਦਿਓ|ਦਿਉ|ਦੋ)|ਕਰੋ)|(?:କନଫର୍ମ|ନିଶ୍ଚିତ)\s*(?:କରନ୍ତୁ|କରିଦିଅନ୍ତୁ)|\bconfirm\s+kar\s*(?:do|dijiye|dena))(?![\p{L}\p{M}])/iu;

/** A refusal or "wait" in any supported language — never consent to a booking. */
const NATIVE_NEGATION =
  /नहीं|मत\s|रुको|रुकिए|नाही|না\b|থাক|இல்லை|வேண்டாம்|లేదు|వద్దు|ఆగండి|ના\b|નહીં|ಇಲ್ಲ|ಬೇಡ|ഇല്ല|വേണ്ട|ਨਹੀਂ|ਨਾ\b|ନାହିଁ|ନା\b|\b(?:nahi|nahin|mat|ruko|vaddu|venda)\b/iu;

/**
 * Whether a caller turn, in any supported language, is an explicit booking
 * instruction, a bare "yes", or a refusal — for voice-runtime.server.ts
 * callerAuthorizesBooking, which still decides whether a bare "yes" was an
 * answer to a booking question.
 */
export function callerBookingIntentAnyLanguage(
  text: string,
): "instruct" | "yes" | "decline" | null {
  if (NATIVE_NEGATION.test(text)) return "decline";
  if (NATIVE_BOOKING_INSTRUCTION.test(text) || NATIVE_CONFIRM_INSTRUCTION.test(text)) {
    return "instruct";
  }
  return confirmationAnswerAnyLanguage(text) === "yes" ? "yes" : null;
}
