/**
 * Synthetic speech fixtures. No real customer data: the business is "Smile
 * Dental (test)", the caller is "Test Caller", and every phone number starts
 * with 1, which no Indian mobile number does (`1234567890`).
 *
 * Indic text is in native script (Sarvam: "Romanised Indic input degrades
 * quality"); code-mixed items follow STT `codemix` convention (English words
 * in Latin script, Indic words in native script). A separate romanized set
 * measures the documented degradation.
 *
 * Each item lists the entities a transcript must preserve. An entity passes
 * if ANY accepted form appears in the normalized transcript, so a correct
 * transcript that writes "800" or "आठ सौ" both count.
 */

export type Lang = "te-IN" | "hi-IN" | "en-IN";
export type Variant = "native" | "code-mixed" | "romanized";
export type Category =
  | "greeting"
  | "appointment"
  | "date"
  | "time"
  | "price"
  | "phone-plain"
  | "phone-grouped"
  | "name"
  | "yes-no"
  | "closing";

export interface Entity {
  kind: "digits" | "time" | "date" | "price" | "keyword";
  /** Accepted forms; matching is on normalized text (see metrics.ts). */
  accept: string[];
}

export interface Fixture {
  id: string;
  lang: Lang;
  variant: Variant;
  category: Category;
  text: string;
  entities: Entity[];
}

const PHONE = "1234567890"; // synthetic: Indian mobiles never start with 1
const PHONE_GROUPED = "12345 67890";

const phone = (): Entity => ({ kind: "digits", accept: [PHONE] });
const time430 = (...words: string[]): Entity => ({
  kind: "time",
  accept: ["4:30", "4.30", "16:30", "430", ...words],
});
const kw = (...accept: string[]): Entity => ({ kind: "keyword", accept });

type Row = [Category, string, Entity[]];

function group(lang: Lang, variant: Variant, prefix: string, rows: Row[]): Fixture[] {
  return rows.map(([category, text, entities]) => ({
    id: `${prefix}-${category}`,
    lang,
    variant,
    category,
    text,
    entities,
  }));
}

export const FIXTURES: Fixture[] = [
  ...group("en-IN", "native", "en", [
    [
      "greeting",
      "Hello, thank you for calling Smile Dental. How can I help you today?",
      [kw("smile dental")],
    ],
    [
      "appointment",
      "I would like to book a cleaning tomorrow at 4:30 PM.",
      [time430("four thirty"), kw("cleaning")],
    ],
    [
      "date",
      "Can I come on Friday, the 15th of November?",
      [{ kind: "date", accept: ["15", "fifteenth"] }, kw("friday")],
    ],
    [
      "time",
      "Is 11 AM available on Monday?",
      [{ kind: "time", accept: ["11", "eleven"] }, kw("monday")],
    ],
    [
      "price",
      "A teeth cleaning costs 800 rupees.",
      [{ kind: "price", accept: ["800", "eight hundred"] }],
    ],
    ["phone-plain", `My number is ${PHONE}.`, [phone()]],
    ["phone-grouped", `My number is ${PHONE_GROUPED}.`, [phone()]],
    ["name", "My name is Test Caller.", [kw("test caller")]],
    ["yes-no", "Yes, that works for me.", [kw("yes")]],
    ["closing", "No, that's all. Thank you, goodbye.", [kw("thank")]],
  ]),
  ...group("hi-IN", "native", "hi", [
    [
      "greeting",
      "नमस्ते, स्माइल डेंटल में फ़ोन करने के लिए धन्यवाद। मैं आपकी क्या मदद कर सकती हूँ?",
      [kw("धन्यवाद")],
    ],
    [
      "appointment",
      "मुझे कल शाम साढ़े चार बजे क्लीनिंग करवानी है।",
      [time430("साढ़े चार", "साढ़े 4"), kw("कल")],
    ],
    [
      "date",
      "क्या मैं शुक्रवार, पंद्रह नवंबर को आ सकता हूँ?",
      [{ kind: "date", accept: ["15", "पंद्रह"] }, kw("शुक्रवार")],
    ],
    [
      "time",
      "क्या सोमवार को सुबह ग्यारह बजे समय खाली है?",
      [{ kind: "time", accept: ["11", "ग्यारह"] }, kw("सोमवार")],
    ],
    [
      "price",
      "दांतों की सफ़ाई का खर्च आठ सौ रुपये है।",
      [{ kind: "price", accept: ["800", "आठ सौ"] }],
    ],
    ["phone-plain", `मेरा नंबर ${PHONE} है।`, [phone()]],
    ["phone-grouped", `मेरा नंबर ${PHONE_GROUPED} है।`, [phone()]],
    ["name", "मेरा नाम टेस्ट कॉलर है।", [kw("टेस्ट", "test")]],
    ["yes-no", "हाँ, यह समय ठीक है।", [kw("हाँ", "हां")]],
    ["closing", "बस इतना ही, धन्यवाद।", [kw("धन्यवाद")]],
  ]),
  ...group("te-IN", "native", "te", [
    [
      "greeting",
      "నమస్కారం, స్మైల్ డెంటల్‌కు ఫోన్ చేసినందుకు ధన్యవాదాలు. నేను మీకు ఎలా సహాయం చేయగలను?",
      [kw("ధన్యవాదాలు")],
    ],
    [
      "appointment",
      "నాకు రేపు సాయంత్రం నాలుగున్నర గంటలకు క్లీనింగ్ అపాయింట్‌మెంట్ కావాలి.",
      [time430("నాలుగున్నర", "4న్నర"), kw("రేపు")],
    ],
    [
      "date",
      "నేను శుక్రవారం, నవంబర్ పదిహేనో తేదీన రావచ్చా?",
      [
        { kind: "date", accept: ["15", "పదిహేన"] } /* stem: పదిహేను (15) / పదిహేనో (15th) */,
        kw("శుక్రవారం"),
      ],
    ],
    [
      "time",
      "సోమవారం ఉదయం పదకొండు గంటలకు ఖాళీ ఉందా?",
      [{ kind: "time", accept: ["11", "పదకొండు"] }, kw("సోమవారం")],
    ],
    [
      "price",
      "క్లీనింగ్‌కు ఎనిమిది వందల రూపాయలు అవుతుంది.",
      [{ kind: "price", accept: ["800", "ఎనిమిది వందల"] }],
    ],
    ["phone-plain", `నా నంబర్ ${PHONE}.`, [phone()]],
    ["phone-grouped", `నా నంబర్ ${PHONE_GROUPED}.`, [phone()]],
    ["name", "నా పేరు టెస్ట్ కాలర్.", [kw("టెస్ట్", "test")]],
    ["yes-no", "అవును, ఆ సమయం సరిపోతుంది.", [kw("అవును")]],
    ["closing", "అంతే అండి, ధన్యవాదాలు.", [kw("ధన్యవాదాలు")]],
  ]),
  ...group("hi-IN", "code-mixed", "hi-mix", [
    ["greeting", "Hello, मुझे एक appointment book करना है।", [kw("appointment")]],
    [
      "appointment",
      "मुझे कल evening 4:30 PM पर cleaning appointment चाहिए।",
      [time430(), kw("cleaning")],
    ],
    [
      "date",
      "क्या मैं Friday, 15 November को आ सकता हूँ?",
      [{ kind: "date", accept: ["15"] }, kw("friday")],
    ],
    [
      "time",
      "क्या Monday को 11 AM का slot free है?",
      [{ kind: "time", accept: ["11"] }, kw("monday")],
    ],
    ["price", "Cleaning का charge 800 rupees है।", [{ kind: "price", accept: ["800"] }]],
    ["phone-plain", `मेरा phone number ${PHONE} है।`, [phone()]],
    ["phone-grouped", `मेरा phone number ${PHONE_GROUPED} है।`, [phone()]],
    ["name", "मेरा name Test Caller है।", [kw("test")]],
    ["yes-no", "हाँ, यह time ठीक है।", [kw("हाँ", "हां")]],
    ["closing", "बस इतना ही, thank you।", [kw("thank")]],
  ]),
  ...group("te-IN", "code-mixed", "te-mix", [
    ["greeting", "Hello అండి, నాకు ఒక appointment book చేయాలి.", [kw("appointment")]],
    [
      "appointment",
      "నాకు రేపు evening 4:30 PM కి cleaning appointment కావాలి.",
      [time430(), kw("cleaning")],
    ],
    [
      "date",
      "నేను Friday, 15 November న రావచ్చా?",
      [{ kind: "date", accept: ["15"] }, kw("friday")],
    ],
    ["time", "Monday 11 AM కి slot free ఉందా?", [{ kind: "time", accept: ["11"] }, kw("monday")]],
    ["price", "Cleaning కి charge 800 rupees అవుతుంది.", [{ kind: "price", accept: ["800"] }]],
    ["phone-plain", `నా phone number ${PHONE}.`, [phone()]],
    ["phone-grouped", `నా phone number ${PHONE_GROUPED}.`, [phone()]],
    ["name", "నా name Test Caller.", [kw("test")]],
    ["yes-no", "అవును, ఆ time ok.", [kw("అవును")]],
    ["closing", "అంతే అండి, thank you.", [kw("thank")]],
  ]),
  // Romanized Indic: Sarvam documents degraded TTS quality; our LLM sometimes produces it.
  ...group("hi-IN", "romanized", "hi-rom", [
    [
      "appointment",
      "Mujhe kal shaam saadhe chaar baje cleaning karwani hai.",
      [time430("साढ़े चार", "saadhe chaar"), kw("cleaning")],
    ],
    [
      "price",
      "Daanton ki safai ka kharch aath sau rupaye hai.",
      [{ kind: "price", accept: ["800", "आठ सौ", "aath sau"] }],
    ],
    ["phone-plain", `Mera number ${PHONE} hai.`, [phone()]],
    ["closing", "Bas itna hi, dhanyavaad.", [kw("धन्यवाद", "dhanyavaad")]],
  ]),
  ...group("te-IN", "romanized", "te-rom", [
    [
      "appointment",
      "Naaku repu saayantram naalugunnara gantalaku cleaning appointment kaavaali.",
      [time430("నాలుగున్నర", "naalugunnara"), kw("cleaning")],
    ],
    [
      "price",
      "Cleaning ki enimidi vandala roopaayalu avutundi.",
      [{ kind: "price", accept: ["800", "ఎనిమిది వందల", "enimidi vandala"] }],
    ],
    ["phone-plain", `Naa number ${PHONE}.`, [phone()]],
    ["closing", "Anthe andi, dhanyavaadaalu.", [kw("ధన్యవాదాలు", "dhanyavaadaalu")]],
  ]),
];

export const fixture = (id: string): Fixture => {
  const f = FIXTURES.find((x) => x.id === id);
  if (!f) throw new Error(`unknown fixture ${id}`);
  return f;
};

/**
 * Voices. bulbul:v3 short names (Sarvam v3 best practices: priya is
 * recommended for Hindi and Telugu; ishita (F) / ratan (M) for English).
 * bulbul:v4-flash persona IDs from Sarvam's v4 voice catalog; v3 names are
 * not valid on v4.
 */
export const V3_VOICES = {
  production: "priya",
  englishFemale: "ishita",
  englishMale: "ratan",
} as const;
export const V4_FLASH_VOICES: Record<string, string> = {
  "te-IN": "pooja_te_conversation",
  "hi-IN": "priya_hi_recovery",
  "en-IN": "ishita_en_customer",
  "hi-IN/code-mixed": "ishita_enhi_customer",
};
