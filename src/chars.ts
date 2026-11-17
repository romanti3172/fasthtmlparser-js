// Character helpers shared by the parser, the text readers and the query engines.
// Positions are UTF-16 code unit indexes, as in JavaScript strings (and .NET).

/** ASCII whitespace as the parser sees it: space, \t, \n, \r, \f, \v. */
export function isSpace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13);
}

/** Whitespace as .NET char.IsWhiteSpace sees it (all such chars are in the BMP). */
export function isUnicodeSpace(c: number): boolean {
  if (c < 0x80) return c === 32 || (c >= 9 && c <= 13);
  return (
    c === 0x85 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

/** Trims Unicode whitespace (char.IsWhiteSpace) from both ends. */
export function trimSpace(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isUnicodeSpace(s.charCodeAt(start))) start++;
  while (end > start && isUnicodeSpace(s.charCodeAt(end - 1))) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

/** Trims ASCII whitespace from the end. */
export function trimRightAscii(s: string): string {
  let end = s.length;
  while (end > 0 && isSpace(s.charCodeAt(end - 1))) end--;
  return end === s.length ? s : s.slice(0, end);
}

export function isLowerAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 65 && c <= 90) || c >= 0x80) return false;
  }
  return true;
}

/** Lower-cases ASCII letters only. */
export function lowerAscii(s: string): string {
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c >= 65 && c <= 90) break;
    i++;
  }
  if (i === s.length) return s;
  let out = s.slice(0, i);
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

/** The lower-case name: the same string when it is already lower-case ASCII. */
export function lowerKey(s: string): string {
  return isLowerAscii(s) ? s : s.toLowerCase();
}

/** Case-insensitive comparison (ASCII fast path, Unicode lower-case otherwise). */
export function equalFold(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    if ((x | y) >= 0x80) return a.toLowerCase() === b.toLowerCase();
    const lx = x | 0x20;
    if (lx !== (y | 0x20) || lx < 97 || lx > 122) return false;
  }
  return true;
}

/** Whether s[at..] starts with the ASCII string sub, ignoring ASCII case. */
export function startsWithFold(s: string, at: number, sub: string): boolean {
  if (at < 0 || at + sub.length > s.length) return false;
  for (let k = 0; k < sub.length; k++) {
    const x = s.charCodeAt(at + k);
    const y = sub.charCodeAt(k);
    if (x === y) continue;
    const lx = x | 0x20;
    if (lx !== (y | 0x20) || lx < 97 || lx > 122) return false;
  }
  return true;
}

/** indexOf with ASCII case folding; sub must be ASCII. Searches s[from, to). */
export function indexFold(s: string, sub: string, from = 0, to = s.length): number {
  const n = sub.length;
  if (n === 0) return from;
  const c = sub.charCodeAt(0);
  const isLetter = (c | 0x20) >= 97 && (c | 0x20) <= 122;
  const lower = isLetter ? c | 0x20 : c;
  const upper = isLetter ? c & ~0x20 : c;
  const last = to - n;
  for (let i = from; i <= last; i++) {
    const x = s.charCodeAt(i);
    if ((x === lower || x === upper) && startsWithFold(s, i, sub)) return i;
  }
  return -1;
}

/** Whether s[at..] starts with sub (case-sensitive) and the match ends before limit. */
export function startsWithAt(s: string, at: number, sub: string, limit = s.length): boolean {
  return at + sub.length <= limit && s.startsWith(sub, at);
}

export function isHexChar(c: number): boolean {
  return (c >= 48 && c <= 57) || ((c | 0x20) >= 97 && (c | 0x20) <= 102);
}

export function isAlnum(c: number): boolean {
  return (c >= 48 && c <= 57) || ((c | 0x20) >= 97 && (c | 0x20) <= 122);
}
