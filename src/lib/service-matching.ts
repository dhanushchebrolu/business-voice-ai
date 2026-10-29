/**
 * Maps how a caller describes a service ("clean my teeth", "dental
 * cleaning", "I want to book teeth cleaning") onto one of the business's
 * OWN configured `services` rows. It never invents a service: the result is
 * always one of the rows passed in, or no match.
 *
 * Why this exists (Smile Dental incident): the voice runtime only recognised
 * a service when the caller's words contained a configured service name
 * verbatim. "Clean my teeth" never contains "Teeth Cleaning", and "teeth
 * cleaning" never contains a longer configured name such as "Teeth Cleaning
 * & Polish" — so the service stayed unknown and the runtime asked "Which
 * service would you like to book?" on every turn.
 *
 * Matching works on word stems, with "teeth"/"tooth"/"dental" treated as
 * one concept. A row matches when the caller's words share at least one
 * DISTINCTIVE stem with the row name (e.g. "clean", "whiten", "root",
 * "canal", "checkup"). Body words alone ("teeth", "tooth", "mouth", "gum")
 * never select a service: "my tooth hurts" must not book a "Tooth
 * Extraction". When two rows score equally the result is ambiguous and the
 * caller is asked to choose between exactly those rows.
 *
 * Pure (no I/O) and isomorphic.
 */

export interface ServiceRow {
  id: string;
  name: string;
  duration_minutes: number | null;
}

export type ServiceMatch =
  | { kind: "match"; row: ServiceRow; exact: boolean }
  | { kind: "ambiguous"; candidates: ServiceRow[] }
  | { kind: "none" };

// Words that carry no information about WHICH service is meant.
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "i",
  "id",
  "im",
  "me",
  "my",
  "mine",
  "we",
  "our",
  "you",
  "your",
  "to",
  "for",
  "of",
  "and",
  "or",
  "with",
  "on",
  "in",
  "at",
  "is",
  "it",
  "its",
  "be",
  "want",
  "wanted",
  "wanna",
  "would",
  "like",
  "need",
  "needs",
  "please",
  "get",
  "got",
  "have",
  "has",
  "do",
  "done",
  "some",
  "can",
  "could",
  "book",
  "booking",
  "booked",
  "schedule",
  "appointment",
  "appointments",
  "slot",
  "session",
  "service",
  "services",
  "just",
  "also",
  "today",
  "tomorrow",
  "pm",
  "am",
  "this",
  "that",
  "yes",
  "yeah",
  "ok",
  "okay",
  "sure",
  "go",
  "ahead",
  "come",
  "visit",
  "let",
  "lets",
  "s",
  "am",
  "are",
  "will",
  "shall",
  "should",
  "now",
  "then",
  "there",
  "here",
  "kind",
  "type",
  "regular",
  "normal",
  "routine",
  "general",
  "quick",
]);

// Concepts that say what part of the body is involved but not what is done
// to it — never enough on their own to choose a service.
const WEAK_STEMS = new Set(["tooth", "mouth", "gum", "smile", "oral"]);

// Equivalent words folded to one stem before comparison.
const SYNONYMS: Record<string, string> = {
  teeth: "tooth",
  tooth: "tooth",
  dental: "tooth",
  dentist: "tooth",
  dentistry: "tooth",
  gums: "gum",
  clean: "clean",
  cleaning: "clean",
  cleanings: "clean",
  cleaned: "clean",
  cleanup: "clean",
  scaling: "clean",
  scale: "clean",
  prophylaxis: "clean",
  polish: "polish",
  polishing: "polish",
  whiten: "whiten",
  whitening: "whiten",
  bleach: "whiten",
  bleaching: "whiten",
  checkup: "checkup",
  "check-up": "checkup",
  examination: "checkup",
  exam: "checkup",
  consult: "consult",
  consultation: "consult",
  filling: "fill",
  fillings: "fill",
  fill: "fill",
  extraction: "extract",
  extract: "extract",
  pull: "extract",
  pulled: "extract",
  removal: "extract",
  braces: "brace",
  brace: "brace",
  aligner: "align",
  aligners: "align",
  crown: "crown",
  crowns: "crown",
  implant: "implant",
  implants: "implant",
  canal: "canal",
  rootcanal: "canal",
  rct: "canal",
};

function stem(word: string): string {
  const w = word.toLowerCase();
  if (SYNONYMS[w]) return SYNONYMS[w];
  // Light suffix stripping for words not in the synonym table.
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** The meaningful stems of a phrase, in order, without duplicates. */
export function serviceStems(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/check[\s-]up/g, "checkup")
    .replace(/root\s+canal/g, "root canal")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    const s = stem(word);
    if (s && !STOPWORDS.has(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Dental treatment names as callers say them in Indian scripts — the
 * English loanword written in that script ("క్లీనింగ్", "क्लीनिंग"), or the
 * language's own word for teeth — with the English word a configured
 * service name uses. Services are configured in English, so without this a
 * Telugu or Hindi caller saying "cleaning" was never matched and was asked
 * for the service again.
 */
const NATIVE_SERVICE_WORDS: [string[], string][] = [
  [
    [
      "క్లీనింగ్",
      "क्लीनिंग",
      "க்ளீனிங்",
      "கிளீனிங்",
      "ಕ್ಲೀನಿಂಗ್",
      "ക്ലീനിംഗ്",
      "ক্লিনিং",
      "ક્લીનિંગ",
      "ਕਲੀਨਿੰਗ",
      "କ୍ଲିନିଂ",
    ],
    "cleaning",
  ],
  [
    [
      "స్కేలింగ్",
      "स्केलिंग",
      "ஸ்கேலிங்",
      "ಸ್ಕೇಲಿಂಗ್",
      "സ്കെയിലിംഗ്",
      "স্কেলিং",
      "સ્કેલિંગ",
      "ਸਕੇਲਿੰਗ",
    ],
    "scaling",
  ],
  [
    [
      "రూట్ కెనాల్",
      "రూట్ కేనాల్",
      "रूट कैनाल",
      "रूट केनाल",
      "ரூட் கேனால்",
      "ರೂಟ್ ಕೆನಾಲ್",
      "റൂട്ട് കനാൽ",
      "রুট ক্যানাল",
      "રૂટ કેનાલ",
      "ਰੂਟ ਕੈਨਾਲ",
    ],
    "root canal",
  ],
  [
    [
      "చెకప్",
      "చెక్ అప్",
      "चेकअप",
      "चेक अप",
      "செக்கப்",
      "ಚೆಕಪ್",
      "ചെക്കപ്പ്",
      "চেকআপ",
      "ચેકઅપ",
      "ਚੈੱਕਅੱਪ",
    ],
    "checkup",
  ],
  [
    [
      "కన్సల్టేషన్",
      "कंसल्टेशन",
      "कन्सल्टेशन",
      "கன்சல்டேஷன்",
      "ಕನ್ಸಲ್ಟೇಶನ್",
      "കൺസൾട്ടേഷൻ",
      "কনসালটেশন",
      "કન્સલ્ટેશન",
      "ਕੰਸਲਟੇਸ਼ਨ",
    ],
    "consultation",
  ],
  [
    ["ఫిల్లింగ్", "फिलिंग", "ஃபில்லிங்", "ಫಿಲ್ಲಿಂಗ್", "ഫില്ലിംഗ്", "ফিলিং", "ફિલિંગ", "ਫਿਲਿੰਗ"],
    "filling",
  ],
  [
    [
      "వైటెనింగ్",
      "వైట్నింగ్",
      "व्हाइटनिंग",
      "वाइटनिंग",
      "வைட்டனிங்",
      "ವೈಟ್ನಿಂಗ್",
      "വൈറ്റനിംഗ്",
      "হোয়াইটেনিং",
      "વ્હાઇટનિંગ",
      "ਵਾਈਟਨਿੰਗ",
    ],
    "whitening",
  ],
  [
    [
      "ఎక్స్‌ట్రాక్షన్",
      "ఎక్స్ట్రాక్షన్",
      "एक्सट्रैक्शन",
      "எக்ஸ்ட்ராக்ஷன்",
      "ಎಕ್ಸ್‌ಟ್ರಾಕ್ಷನ್",
      "എക്സ്ട്രാക്ഷൻ",
      "এক্সট্রাকশন",
      "એક્સ્ટ્રેક્શન",
      "ਐਕਸਟਰੈਕਸ਼ਨ",
    ],
    "extraction",
  ],
  [
    [
      "ఇంప్లాంట్",
      "इम्प्लांट",
      "इंप्लांट",
      "இம்ப்ளான்ட்",
      "ಇಂಪ್ಲಾಂಟ್",
      "ഇംപ്ലാന്റ്",
      "ইমপ্ল্যান্ট",
      "ઇમ્પ્લાન્ટ",
      "ਇੰਪਲਾਂਟ",
    ],
    "implant",
  ],
  [
    ["బ్రేసెస్", "ब्रेसेस", "பிரேசஸ்", "ಬ್ರೇಸಸ್", "ബ്രേസസ്", "ব্রেসেস", "બ્રેસીસ", "ਬ੍ਰੇਸਿਜ਼"],
    "braces",
  ],
  [
    [
      "పళ్ళు",
      "పళ్ల",
      "दांत",
      "दाँत",
      "பல்",
      "ಹಲ್ಲು",
      "പല്ല്",
      "দাঁত",
      "दात",
      "દાંત",
      "ਦੰਦ",
      "ଦାନ୍ତ",
    ],
    "teeth",
  ],
];

/** The caller's words plus the English service word for each native-script treatment name in them. */
export function withEnglishServiceWords(text: string): string {
  const english = NATIVE_SERVICE_WORDS.filter(([native]) =>
    native.some((n) => text.includes(n)),
  ).map(([, word]) => word);
  return english.length ? `${text} ${english.join(" ")}` : text;
}

/**
 * Resolves caller wording to one configured service row.
 *
 * 1. A configured name said verbatim (longest wins) — the original
 *    behaviour, kept so specific names beat generic ones.
 * 2. Otherwise stem overlap: distinctive stems shared with the row name
 *    score 2, body stems 1; at least one distinctive stem is required.
 *    A unique top score is a match; a tie is ambiguous.
 */
export function resolveServiceFromText(rows: ServiceRow[], rawText: string): ServiceMatch {
  const usable = rows.filter((r) => r.name.trim());
  if (!usable.length || !rawText.trim()) return { kind: "none" };
  const text = withEnglishServiceWords(rawText);

  const lowerText = ` ${text.toLowerCase().replace(/\s+/g, " ")} `;
  let verbatim: ServiceRow | null = null;
  for (const row of usable) {
    const name = normalizeName(row.name);
    if (lowerText.includes(name) && (!verbatim || name.length > verbatim.name.trim().length)) {
      verbatim = row;
    }
  }
  if (verbatim) return { kind: "match", row: verbatim, exact: true };

  const spoken = new Set(serviceStems(text));
  if (!spoken.size) return { kind: "none" };

  const scored = usable
    .map((row) => {
      const nameStems = serviceStems(row.name);
      let score = 0;
      let distinctive = 0;
      for (const s of nameStems) {
        if (!spoken.has(s)) continue;
        if (WEAK_STEMS.has(s)) score += 1;
        else {
          score += 2;
          distinctive++;
        }
      }
      return { row, score, distinctive };
    })
    .filter((s) => s.distinctive > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { kind: "none" };
  const top = scored[0]!.score;
  const best = scored.filter((s) => s.score === top).map((s) => s.row);
  if (best.length === 1) return { kind: "match", row: best[0]!, exact: false };
  return { kind: "ambiguous", candidates: best };
}

/**
 * The configured row a free-text service label refers to (e.g. the label
 * the model proposed, or one already stored on a booking): exact name,
 * then either-direction substring, then resolveServiceFromText. Null when
 * nothing (or more than one row equally) fits.
 */
export function findConfiguredService(rows: ServiceRow[], label: string | null): ServiceRow | null {
  if (!label || !label.trim()) return null;
  const normalized = normalizeName(label);
  const exact = rows.find((r) => normalizeName(r.name) === normalized);
  if (exact) return exact;
  const substring = rows.filter((r) => {
    const name = normalizeName(r.name);
    return name && (name.includes(normalized) || normalized.includes(name));
  });
  if (substring.length === 1) return substring[0]!;
  const resolved = resolveServiceFromText(substring.length > 1 ? substring : rows, label);
  return resolved.kind === "match" ? resolved.row : null;
}

/** "A", "A or B", "A, B or C" — for a spoken clarification. */
export function spokenServiceList(rows: ServiceRow[], conjunction = "or"): string {
  const names = rows.map((r) => r.name.trim()).filter(Boolean);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${conjunction} ${names[names.length - 1]}`;
}
