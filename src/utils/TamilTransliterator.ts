/**
 * tamilTransliterator.ts
 * 
 * Converts Tamil Unicode text → Roman transliteration so users can
 * search Tamil-named products/customers/orders by typing English.
 *
 * Example:  "அரிசி"  → "arisi"
 *           "பால்"   → "paal"
 *           "வெங்காயம்" → "vengaayam"
 */

// ── Independent vowels ────────────────────────────────────────────────
const VOWELS: Record<string, string> = {
  "அ": "a",  "ஆ": "aa", "இ": "i",  "ஈ": "ii",
  "உ": "u",  "ஊ": "uu", "எ": "e",  "ஏ": "ee",
  "ஐ": "ai", "ஒ": "o",  "ஓ": "oo", "ஔ": "au",
};

const CONSONANTS: Record<string, string> = {
  "க": "k",  "ங": "ng", "ச": "ch", "ஞ": "nj",
  "ட": "t",  "ண": "n",  "த": "th", "ந": "n",
  "ப": "p",  "ம": "m",  "ய": "y",  "ர": "r",
  "ல": "l",  "வ": "v",  "ழ": "zh", "ள": "l",
  "ற": "tr", "ன": "n",  "ஜ": "j",  "ஷ": "sh",
  "ஸ": "s",  "ஹ": "h",  "ஶ": "sh",
};

const VOWEL_SIGNS: Record<string, string> = {
  "\u0BBE": "aa",
  "\u0BBF": "i",
  "\u0BC0": "ii",
  "\u0BC1": "u",
  "\u0BC2": "uu",
  "\u0BC6": "e",
  "\u0BC7": "ee",
  "\u0BC8": "ai",
  "\u0BCA": "o",
  "\u0BCB": "oo",
  "\u0BCC": "au",
  "\u0BCD": "",   // virama — removes inherent vowel
  "\u0BD7": "au",
};

const TAMIL_DIGITS: Record<string, string> = {
  "௦": "0", "௧": "1", "௨": "2", "௩": "3", "௪": "4",
  "௫": "5", "௬": "6", "௭": "7", "௮": "8", "௯": "9",
};

const VIRAMA = "\u0BCD";

export function containsTamil(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x0b80 && code <= 0x0bff) return true;
  }
  return false;
}

export function transliterate(text: string): string {
  if (!containsTamil(text)) return text;

  const chars = [...text];
  const out: string[] = [];
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i];

    // Special cluster: க் + ஷ → "ksh"
    if (ch === "க" && chars[i + 1] === VIRAMA && chars[i + 2] === "ஷ") {
      out.push("ksh");
      i += 3;
      continue;
    }

    if (ch in TAMIL_DIGITS) {
      out.push(TAMIL_DIGITS[ch]);
      i++;
      continue;
    }

    if (ch in VOWELS) {
      out.push(VOWELS[ch]);
      i++;
      continue;
    }

    if (ch in CONSONANTS) {
      const base = CONSONANTS[ch];
      const next = chars[i + 1];

      if (next === VIRAMA) {
        out.push(base);
        i += 2;
      } else if (next !== undefined && next in VOWEL_SIGNS) {
        out.push(base, VOWEL_SIGNS[next]);
        i += 2;
      } else {
        out.push(base, "a");
        i++;
      }
      continue;
    }

    if (ch in VOWEL_SIGNS) {
      out.push(VOWEL_SIGNS[ch]);
      i++;
      continue;
    }

    out.push(ch);
    i++;
  }

  return out.join("");
}

export function forPrinter(text: string): string {
  return containsTamil(text) ? transliterate(text) : text;
}