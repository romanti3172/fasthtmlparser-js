// HTML5 character reference decoder (WHATWG "character reference state"): all 2125 named references,
// the legacy names without ';', numeric references with or without ';', and the spec replacements
// (0, surrogates, > U+10FFFF → U+FFFD; 0x80–0x9F → Windows-1252).

import { isAlnum } from './chars.ts';
import { entityMaxLegacyName, entityMaxName, entityNames, entityValues } from './entities.ts';

interface Entity {
  value: string;
  legacy: boolean;
}

let table: Map<string, Entity> | null = null;

function entityTable(): Map<string, Entity> {
  if (table !== null) return table;
  const t = new Map<string, Entity>();
  const names = entityNames.split(' ');
  for (let i = 0; i < names.length; i++) {
    let name = names[i];
    const legacy = name.charCodeAt(0) === 43; // '+'
    if (legacy) name = name.slice(1);
    const second = entityValues.charCodeAt(2 * i + 1);
    const value = second === 0 ? entityValues[2 * i] : entityValues.slice(2 * i, 2 * i + 2);
    t.set(name, { value, legacy });
  }
  table = t;
  return t;
}

/** Whether a value read from the page differs from its source: it has a character reference or a CR. */
export function needsDecoding(s: string): boolean {
  return s.indexOf('&') >= 0 || s.indexOf('\r') >= 0;
}

/** HTML input stream preprocessing: CR LF and a lone CR become LF. */
export function normalizeNewlines(s: string): string {
  if (s.indexOf('\r') < 0) return s;
  return s.replace(/\r\n?/g, '\n');
}

/** Decodes the character references in text; CR LF and a lone CR become LF. */
export function decodeHtml(s: string): string {
  return decode(s, false);
}

/**
 * With inAttribute, a legacy name without ';' followed by '=' or an alphanumeric is left as is
 * (so "?a=1&copy=2" stays intact). Without '&' and CR the input is returned as is.
 */
export function decode(s: string, inAttribute: boolean): string {
  // Line breaks first, as a browser reads the page; a CR written as "&#13;" is decoded after that and stays.
  if (s.indexOf('\r') >= 0) s = normalizeNewlines(s);
  let amp = s.indexOf('&');
  if (amp < 0) return s;

  let out = '';
  let pos = 0;
  while (amp >= 0) {
    out += s.slice(pos, amp);
    let consumed = 0;
    if (s.charCodeAt(amp + 1) === 35) {
      // '#'
      consumed = matchNumeric(s, amp + 1);
      if (consumed > 0) out += String.fromCodePoint(numericValue);
    } else {
      consumed = matchNamed(s, amp + 1, inAttribute);
      if (consumed > 0) out += namedValue;
    }
    if (consumed === 0) out += '&'; // not a reference: keep '&'
    pos = amp + 1 + consumed;
    amp = s.indexOf('&', pos);
  }
  return out + s.slice(pos);
}

// the results of matchNumeric / matchNamed (no allocation per reference)
let numericValue = 0;
let namedValue = '';

/** s[at] is '#'. Returns the number of chars consumed (0: not a reference); the code point is in numericValue. */
function matchNumeric(s: string, at: number): number {
  let i = at + 1;
  const hex = i < s.length && (s.charCodeAt(i) | 0x20) === 120; // 'x'
  if (hex) i++;
  const digits = i;
  let value = 0;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let d: number;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (hex && (c | 0x20) >= 97 && (c | 0x20) <= 102) d = (c | 0x20) - 97 + 10;
    else break;
    value = hex ? value * 16 + d : value * 10 + d;
    if (value > 0x10ffff) value = 0x110000; // saturate on long digit runs
  }
  if (i === digits) return 0; // "&#" / "&#x" without digits is plain text
  if (i < s.length && s.charCodeAt(i) === 59) i++; // ';'
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    value = 0xfffd;
  } else if (value >= 0x80 && value <= 0x9f) {
    const mapped = windows1252[value - 0x80];
    if (mapped !== 0) value = mapped;
  }
  numericValue = value;
  return i - at;
}

/** s[at] is the char right after '&'. Returns the number of chars consumed (0: not a reference); the text is in namedValue. */
function matchNamed(s: string, at: number, inAttribute: boolean): number {
  const limit = Math.min(s.length - at, entityMaxName + 1);
  let n = 0;
  while (n < limit && isAlnum(s.charCodeAt(at + n))) n++;
  if (n < 2) return 0;
  const t = entityTable();
  // Full match: "&name;".
  if (at + n < s.length && s.charCodeAt(at + n) === 59) {
    const e = t.get(s.slice(at, at + n));
    if (e !== undefined) {
      namedValue = e.value;
      return n + 1;
    }
  }
  // Longest legacy prefix without ';': "&copy2024" → "©2024", "&notit;" → "¬it;".
  for (let k = Math.min(n, entityMaxLegacyName); k >= 2; k--) {
    const e = t.get(s.slice(at, at + k));
    if (e !== undefined && e.legacy) {
      if (inAttribute && at + k < s.length) {
        const c = s.charCodeAt(at + k);
        if (c === 61 || isAlnum(c)) break;
      }
      namedValue = e.value;
      return k;
    }
  }
  return 0;
}

/**
 * Decodes one character reference; s[at] is the char right after '&'.
 * Returns the number of chars consumed after '&' (0: not a reference) and the decoded text.
 */
export function decodeReference(s: string, at: number): [number, string] {
  if (s.charCodeAt(at) === 35) {
    const consumed = matchNumeric(s, at);
    return consumed === 0 ? [0, ''] : [consumed, String.fromCodePoint(numericValue)];
  }
  const consumed = matchNamed(s, at, false);
  return consumed === 0 ? [0, ''] : [consumed, namedValue];
}

// Replacements for numeric references 0x80..0x9F; 0 = keep the code point as is.
const windows1252 = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178,
];
