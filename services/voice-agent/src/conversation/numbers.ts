/**
 * Spoken numbers, months and tokens for the date/time reader (datetime.ts).
 *
 * Numbers 0..59 in English, Hindi and Telugu (script and romanized), so a
 * transcript's minutes ("तीस मिनट", "ముప్పై నిమిషాలకి", "four thirty") and
 * days of the month ("पंद्रह नवंबर", "నవంబర్ పదిహేనో తేదీన") can be read as
 * numbers. Pure data plus a tokenizer; no decisions are made here.
 */

/** One word of a transcript, with where it is. */
export interface Token {
  /** As written (case kept). */
  t: string;
  /** Lower-cased. */
  l: string;
  start: number;
  end: number;
}

/**
 * Words, digit groups ("4:30", "15th", "15న", "11am") and single punctuation
 * marks. Digits joined by ":" or "." stay one token so a clock is never split.
 */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = /\d+(?:[:.]\d+)?[\p{L}\p{M}]*|[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*|[^\s\p{L}\p{M}\d]/gu;
  for (const m of text.matchAll(re)) {
    out.push({ t: m[0], l: m[0].toLowerCase(), start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Number words                                                        */
/* ------------------------------------------------------------------ */

const EN_UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const EN_TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fourty: 40,
  fifty: 50,
};

const EN_ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  thirtieth: 30,
};

/** Hindi 0..59 (Devanagari, with common spelling variants) and romanized forms. */
const HI_WORDS: Record<string, number> = {
  शून्य: 0,
  एक: 1,
  दो: 2,
  तीन: 3,
  चार: 4,
  पांच: 5,
  पाँच: 5,
  छह: 6,
  छः: 6,
  छे: 6,
  सात: 7,
  आठ: 8,
  नौ: 9,
  दस: 10,
  ग्यारह: 11,
  बारह: 12,
  तेरह: 13,
  चौदह: 14,
  पंद्रह: 15,
  पन्द्रह: 15,
  सोलह: 16,
  सत्रह: 17,
  अठारह: 18,
  उन्नीस: 19,
  बीस: 20,
  इक्कीस: 21,
  बाईस: 22,
  बाइस: 22,
  तेईस: 23,
  तेइस: 23,
  चौबीस: 24,
  पच्चीस: 25,
  छब्बीस: 26,
  सत्ताईस: 27,
  अट्ठाईस: 28,
  अठाईस: 28,
  उनतीस: 29,
  उन्तीस: 29,
  तीस: 30,
  इकतीस: 31,
  इकत्तीस: 31,
  बत्तीस: 32,
  तैंतीस: 33,
  तेंतीस: 33,
  चौंतीस: 34,
  पैंतीस: 35,
  छत्तीस: 36,
  सैंतीस: 37,
  अड़तीस: 38,
  उनतालीस: 39,
  उन्तालीस: 39,
  चालीस: 40,
  इकतालीस: 41,
  बयालीस: 42,
  तैंतालीस: 43,
  चवालीस: 44,
  चौवालीस: 44,
  पैंतालीस: 45,
  छियालीस: 46,
  सैंतालीस: 47,
  अड़तालीस: 48,
  उनचास: 49,
  पचास: 50,
  इक्यावन: 51,
  बावन: 52,
  तिरपन: 53,
  तिरेपन: 53,
  चौवन: 54,
  चव्वन: 54,
  पचपन: 55,
  छप्पन: 56,
  सत्तावन: 57,
  अट्ठावन: 58,
  उनसठ: 59,
  // romanized
  ek: 1,
  do: 2,
  teen: 3,
  char: 4,
  chaar: 4,
  paanch: 5,
  panch: 5,
  chhe: 6,
  chhah: 6,
  saat: 7,
  aath: 8,
  nau: 9,
  das: 10,
  gyarah: 11,
  gyaarah: 11,
  barah: 12,
  baarah: 12,
  terah: 13,
  chaudah: 14,
  pandrah: 15,
  pandra: 15,
  solah: 16,
  satrah: 17,
  atharah: 18,
  unnis: 19,
  bees: 20,
  ikkis: 21,
  baais: 22,
  teis: 23,
  chaubis: 24,
  pachchis: 25,
  pachees: 25,
  pachis: 25,
  chhabbis: 26,
  sattais: 27,
  atthais: 28,
  untis: 29,
  tees: 30,
  ikattis: 31,
  paintis: 35,
  paintees: 35,
  chalis: 40,
  chalees: 40,
  paintalis: 45,
  paintalees: 45,
  pachas: 50,
  pachaas: 50,
  pachpan: 55,
};

/** Lookups run on NFC text: "अड़तीस" may arrive with a precomposed or a combining nukta. */
const HI_NFC: Record<string, number> = Object.fromEntries(
  Object.entries(HI_WORDS).map(([w, v]) => [w.normalize("NFC"), v]),
);

/** Telugu 0..19 and tens; compounds are tens + unit ("ఇరవై ఐదు", "ఇరవైఐదు"). */
const TE_UNITS: Record<string, number> = {
  సున్నా: 0,
  ఒకటి: 1,
  ఒంటి: 1,
  రెండు: 2,
  మూడు: 3,
  నాలుగు: 4,
  ఐదు: 5,
  అయిదు: 5,
  ఆరు: 6,
  ఏడు: 7,
  ఎనిమిది: 8,
  తొమ్మిది: 9,
  పది: 10,
  పదకొండు: 11,
  పన్నెండు: 12,
  పదమూడు: 13,
  పద్నాలుగు: 14,
  పదునాలుగు: 14,
  పదిహేను: 15,
  పదహేను: 15,
  పదహారు: 16,
  పదారు: 16,
  పదిహేడు: 17,
  పదిహేడ: 17,
  పద్దెనిమిది: 18,
  పందొమ్మిది: 19,
  // romanized
  sunna: 0,
  okati: 1,
  rendu: 2,
  moodu: 3,
  mudu: 3,
  naalugu: 4,
  nalugu: 4,
  aidu: 5,
  ayidu: 5,
  aaru: 6,
  edu: 7,
  enimidi: 8,
  tommidi: 9,
  padi: 10,
  padakondu: 11,
  pannendu: 12,
  padamudu: 13,
  padnalugu: 14,
  padihenu: 15,
  padaharu: 16,
  padihedu: 17,
  paddenimidi: 18,
  pandommidi: 19,
};
const TE_TENS: Record<string, number> = {
  ఇరవై: 20,
  ముప్పై: 30,
  ముప్ఫై: 30,
  ముప్పయి: 30,
  నలభై: 40,
  నలబై: 40,
  యాభై: 50,
  యాబై: 50,
  iravai: 20,
  muppai: 30,
  nalabhai: 40,
  nalabai: 40,
  yabhai: 50,
  yaabhai: 50,
};

/** Hour words 1..12 (the guard's vocabulary): what a bare number word may be as a clock hour. */
export const HOUR_WORDS: Record<string, number> = Object.fromEntries(
  [...Object.entries(EN_UNITS), ...Object.entries(HI_WORDS), ...Object.entries(TE_UNITS)].filter(
    ([, v]) => v >= 1 && v <= 12,
  ),
);

const TELUGU_VOWEL_SIGN = /[ా-ౌౕౖ]$/u;

/**
 * Telugu number words take suffixes ("పదిహేనో", "పదిహేనున", "నాలుగున్నర",
 * "నాలుగుంపావు"): the stem is the word without its final vowel sign.
 */
const TE_STEMS: Array<[string, number]> = Object.entries({ ...TE_UNITS, ...TE_TENS })
  .filter(([w]) => /[ఀ-౿]/u.test(w))
  .map(([w, v]) => [w.replace(TELUGU_VOWEL_SIGN, ""), v] as [string, number])
  .sort((a, b) => b[0].length - a[0].length);
const TE_ROMAN_STEMS: Array<[string, number]> = Object.entries({ ...TE_UNITS, ...TE_TENS })
  .filter(([w]) => /^[a-z]+$/.test(w))
  .map(([w, v]) => [w.replace(/[aeiou]$/, ""), v] as [string, number])
  .sort((a, b) => b[0].length - a[0].length);

export interface NumberHit {
  value: number;
  /** Index of the first token after the number. */
  next: number;
  /** Letters attached after the number in its last token ("th", "ో", "ున్నర", "am"). */
  suffix: string;
  digits: boolean;
}

/** A Telugu word as stem + suffix ("నాలుగున్నర" -> 4, "ున్నర"). */
export function teluguStem(word: string): { value: number; suffix: string } | null {
  if (word in TE_UNITS) return { value: TE_UNITS[word]!, suffix: "" };
  if (word in TE_TENS) return { value: TE_TENS[word]!, suffix: "" };
  const lower = word.toLowerCase();
  for (const [stem, value] of /^[a-z]+$/.test(lower) ? TE_ROMAN_STEMS : TE_STEMS) {
    if (stem.length >= 2 && lower.startsWith(stem))
      return { value, suffix: lower.slice(stem.length) };
  }
  return null;
}

function simpleWord(l: string): number | null {
  if (l in EN_UNITS) return EN_UNITS[l]!;
  if (l in EN_TENS) return EN_TENS[l]!;
  if (l in HI_NFC) return HI_NFC[l]!;
  if (l in TE_UNITS) return TE_UNITS[l]!;
  if (l in TE_TENS) return TE_TENS[l]!;
  return null;
}

/**
 * The number that starts at token `k`: digits (with any attached letters as
 * the suffix), one word, or tens + unit ("twenty five", "forty-five",
 * "ఇరవై ఐదు"). Telugu suffixed forms only when `allowSuffix` is set.
 */
export function numberAt(tokens: Token[], k: number, allowSuffix = false): NumberHit | null {
  const tok = tokens[k];
  if (!tok) return null;
  const d = /^(\d+)([\p{L}\p{M}]*)$/u.exec(tok.t);
  if (d) return { value: Number(d[1]), next: k + 1, suffix: d[2]!.toLowerCase(), digits: true };
  // "forty-five" is one token only when written with a hyphen inside a word.
  const hy = /^([a-z]+)-([a-z]+)$/.exec(tok.l);
  if (hy && hy[1]! in EN_TENS && hy[2]! in EN_UNITS && EN_UNITS[hy[2]!]! < 10)
    return { value: EN_TENS[hy[1]!]! + EN_UNITS[hy[2]!]!, next: k + 1, suffix: "", digits: false };
  const first = simpleWord(tok.l);
  if (first !== null) {
    // Tens + unit across two tokens (or a hyphen token between).
    if (first % 10 === 0 && first >= 20) {
      let j = k + 1;
      if (tokens[j]?.t === "-") j++;
      const u = tokens[j];
      const unit = u ? (EN_UNITS[u.l] ?? TE_UNITS[u.l] ?? null) : null;
      if (unit !== null && unit >= 1 && unit <= 9)
        return { value: first + unit, next: j + 1, suffix: "", digits: false };
      if (allowSuffix && u) {
        const st = teluguStem(u.t);
        if (st && st.value >= 1 && st.value <= 9 && tok.l in TE_TENS)
          return { value: first + st.value, next: j + 1, suffix: st.suffix, digits: false };
      }
    }
    return { value: first, next: k + 1, suffix: "", digits: false };
  }
  if (!allowSuffix) return null;
  const st = teluguStem(tok.t);
  if (!st) return null;
  // Joined compound "ఇరవైఐదు": tens stem + unit word.
  if (st.value >= 20 && st.value % 10 === 0 && st.suffix) {
    const rest = teluguStem(st.suffix.replace(/^[ా-ౌ]/u, ""));
    if (rest && rest.value >= 1 && rest.value <= 9)
      return { value: st.value + rest.value, next: k + 1, suffix: rest.suffix, digits: false };
  }
  return { value: st.value, next: k + 1, suffix: st.suffix, digits: false };
}

/** English ordinal words ("fifteenth", "twenty-first", "twenty first"). */
export function ordinalAt(tokens: Token[], k: number): { value: number; next: number } | null {
  const tok = tokens[k];
  if (!tok) return null;
  if (tok.l in EN_ORDINALS) return { value: EN_ORDINALS[tok.l]!, next: k + 1 };
  const hy = /^(twenty|thirty)-([a-z]+)$/.exec(tok.l);
  if (hy && hy[2]! in EN_ORDINALS && EN_ORDINALS[hy[2]!]! < 10)
    return { value: EN_TENS[hy[1]!]! + EN_ORDINALS[hy[2]!]!, next: k + 1 };
  if (tok.l === "twenty" || tok.l === "thirty") {
    const j = tokens[k + 1]?.t === "-" ? k + 2 : k + 1;
    const u = tokens[j];
    if (u && u.l in EN_ORDINALS && EN_ORDINALS[u.l]! < 10)
      return { value: EN_TENS[tok.l]! + EN_ORDINALS[u.l]!, next: j + 1 };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Months                                                              */
/* ------------------------------------------------------------------ */

const MONTH_NAMES: Array<[number, string[]]> = [
  [1, ["january", "jan", "जनवरी", "జనవరి"]],
  [2, ["february", "feb", "फ़रवरी", "फरवरी", "ఫిబ్రవరి", "ఫిబ్రవరీ"]],
  [3, ["march", "मार्च", "మార్చి", "మార్చ్"]],
  [4, ["april", "apr", "अप्रैल", "अप्रेल", "ఏప్రిల్", "ఎప్రిల్"]],
  [5, ["may", "मई", "మే"]],
  [6, ["june", "jun", "जून", "జూన్"]],
  [7, ["july", "jul", "जुलाई", "జూలై", "జులై"]],
  [8, ["august", "aug", "अगस्त", "ఆగస్టు", "ఆగస్ట్"]],
  [9, ["september", "sep", "sept", "सितंबर", "सितम्बर", "సెప్టెంబర్", "సెప్టెంబరు"]],
  [10, ["october", "oct", "अक्टूबर", "अक्तूबर", "అక్టోబర్", "అక్టోబరు"]],
  [11, ["november", "nov", "नवंबर", "नवम्बर", "నవంబర్", "నవంబరు"]],
  [12, ["december", "dec", "दिसंबर", "दिसम्बर", "డిసెంబర్", "డిసెంబరు"]],
];

/** Telugu case endings a month name can carry ("నవంబర్లో", "నవంబర్ న"). */
const TE_MONTH_SUFFIX = /^(?:లో|న|నెల|నెలలో|ు)?$/u;

/** The month a token names (1..12), or null. Short words must match exactly. */
export function monthOf(tok: Token | undefined): number | null {
  if (!tok) return null;
  const l = tok.l.replace(/\.$/, "").normalize("NFC");
  for (const [n, names] of MONTH_NAMES) {
    for (const raw of names) {
      const name = raw.normalize("NFC");
      if (l === name) return n;
      if (/[ఀ-౿]/u.test(name) && name.length >= 4 && l.startsWith(name)) {
        if (TE_MONTH_SUFFIX.test(l.slice(name.length))) return n;
      }
    }
  }
  return null;
}

export function daysInMonth(month: number, year: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
