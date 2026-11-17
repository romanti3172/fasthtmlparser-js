// Attributes are read from the source of the opening tag when they are asked for.

import { equalFold, indexFold, isSpace } from './chars.ts';
import { decode, needsDecoding } from './decode.ts';
import { Tag, tagNames } from './names.ts';
import type { HtmlNode } from './document.ts';

/** The decoded value of the first attribute with the name (case-insensitive); "" when missing or without a value. */
export function attrValue(n: HtmlNode, name: string): string {
  return decode(attrRaw(n, name), true);
}

/** Whether one of the space-separated classes equals cls (case-insensitive). */
export function hasClass(n: HtmlNode, cls: string): boolean {
  if (cls === '') return false;
  let value = attrRaw(n, 'class');
  if (needsDecoding(value)) value = decode(value, true);
  if (value.length === cls.length) return equalFold(value, cls);
  if (cls.length > value.length) return false;
  for (let from = 0; from <= value.length - cls.length; ) {
    const i = indexFold(value, cls, from);
    if (i < 0) return false;
    const after = i + cls.length;
    if ((i === 0 || isSpace(value.charCodeAt(i - 1))) && (after === value.length || isSpace(value.charCodeAt(after)))) {
      return true;
    }
    from = i + 1;
  }
  return false;
}

/**
 * The raw value of the first attribute with the name, as a browser reads the tag: quoted or unquoted
 * (href=/p?a=1), "" for an attribute without a value or a missing one.
 */
export function attrRaw(n: HtmlNode, attribute: string): string {
  // a comment has no attributes, whatever its text looks like
  if (attribute === '' || n.key === Tag.Comment) return '';

  const src = n.document.source;
  const start = n.start;
  const end = openTagEnd(n); // src[start, end): "<name attributes", without the closing '>'

  // The first place where the name stands as a word of its own. Most tags have none.
  let pos = nextWord(src, end, attribute, start + 1);
  if (pos < 0) return '';

  // That word is the attribute unless it is inside the value of another one (title="see id=5", x= id).
  // Nearly always that is ruled out at once, and the value is read in place.
  const firstWord = n.key >= 0 && pos - start === tagNames[n.key].length + 2;
  if (firstWord || isNameForSure(src, start, pos)) {
    readValueAt(src, pos + attribute.length, end);
    return valueStart < 0 ? '' : src.slice(valueStart, valueStart + valueLength);
  }

  // Otherwise the attributes are read one by one, up to the one that starts at that word.
  const s = new AttrScanner(n);
  while (s.next()) {
    // a word the scanner has passed was inside a value: the next one takes its place
    while (pos < s.nameStart) {
      pos = nextWord(src, end, attribute, pos + 1);
      if (pos < 0) return '';
    }
    if (pos === s.nameStart && s.nameLength === attribute.length) {
      return s.valueStart < 0 ? '' : src.slice(s.valueStart, s.valueStart + s.valueLength);
    }
  }
  return '';
}

const startsName = (c: number) => isSpace(c) || c === 34 || c === 39 || c === 47 || c === 61;
const endsName = (c: number) => isSpace(c) || c === 61 || c === 47 || c === 62;

/** The next place in src[start, end) at or after from where the name stands as a word of its own, or -1. */
function nextWord(src: string, end: number, attribute: string, from: number): number {
  while (from < end) {
    const found = indexFold(src, attribute, from, end);
    if (found < 0) break;
    const after = found + attribute.length;
    if (startsName(src.charCodeAt(found - 1)) && (after === end || endsName(src.charCodeAt(after)))) return found;
    from = found + 1;
  }
  return -1;
}

/**
 * Whether the word at pos of the opening tag that starts at start is an attribute name, judged by the chars
 * before it alone. False means "not sure".
 */
function isNameForSure(src: string, start: number, pos: number): boolean {
  // After whitespace, and not as the unquoted value in "x= word".
  let last = pos - 1;
  if (!isSpace(src.charCodeAt(last))) return false;
  while (last > start && isSpace(src.charCodeAt(last))) last--;
  if (src.charCodeAt(last) === 61) return false;
  // Not inside a quoted value: it is enough that the last quote of each kind before the word does not open a value.
  return !opensValue(src, start, lastIndexIn(src, '"', start, last)) && !opensValue(src, start, lastIndexIn(src, "'", start, last));
}

/** The last position of ch in src[start, last]; -1 when there is none. Never looks before the tag. */
function lastIndexIn(src: string, ch: string, start: number, last: number): number {
  const c = ch.charCodeAt(0);
  for (let i = last; i >= start; i--) if (src.charCodeAt(i) === c) return i;
  return -1;
}

/** Whether the quote at quote (or -1: none) stands right after an '='. */
function opensValue(src: string, start: number, quote: number): boolean {
  if (quote < 0) return false;
  let k = quote - 1; // >= start: the tag starts with '<'
  while (k > start && isSpace(src.charCodeAt(k))) k--;
  return src.charCodeAt(k) === 61;
}

/** Compares the decoded value; decodes only when the raw value has '&' or CR. */
export function attrEquals(raw: string, value: string): boolean {
  return needsDecoding(raw) ? decode(raw, true) === value : raw === value;
}

/** Whether the decoded value starts with prefix. */
export function attrStartsWith(raw: string, prefix: string): boolean {
  return (needsDecoding(raw) ? decode(raw, true) : raw).startsWith(prefix);
}

/** The position of the '>' that ends the opening tag. */
export function openTagEnd(n: HtmlNode): number {
  const end = n.innerStart > 0 && n.innerEnd > 0 ? n.innerStart - 1 : n.end;
  return Math.min(end, n.document.source.length);
}

// the result of readValueAt: value start (-1: no '='), length, and the position after the value
let valueStart = 0;
let valueLength = 0;
let valueNext = 0;

/** Reads the value that follows an attribute name at pos (before end). */
function readValueAt(s: string, pos: number, end: number): void {
  let p = pos;
  while (p < end && isSpace(s.charCodeAt(p))) p++;
  if (p >= end || s.charCodeAt(p) !== 61) {
    valueStart = -1;
    valueLength = 0;
    valueNext = pos;
    return;
  }
  p++;
  while (p < end && isSpace(s.charCodeAt(p))) p++;
  const q = s.charCodeAt(p);
  if (p < end && (q === 34 || q === 39)) {
    valueStart = p + 1;
    let close = valueStart;
    while (close < end && s.charCodeAt(close) !== q) close++;
    if (close >= end) {
      valueLength = end - valueStart;
      valueNext = end;
    } else {
      valueLength = close - valueStart;
      valueNext = close + 1;
    }
    return;
  }
  valueStart = p;
  while (p < end && !isSpace(s.charCodeAt(p))) p++;
  valueLength = p - valueStart;
  valueNext = p;
}

/** Reads the attributes of an opening tag one by one: positions in the source. */
export class AttrScanner {
  readonly src: string;
  readonly end: number;
  pos: number;
  nameStart = 0;
  nameLength = 0;
  valueStart = 0; // -1: no value
  valueLength = 0;

  constructor(n: HtmlNode) {
    const src = n.document.source;
    const end = openTagEnd(n);
    let i = n.start + 1; // skip '<' and the name
    while (i < end) {
      const c = src.charCodeAt(i);
      if (isSpace(c) || c === 47 || c === 62) break;
      i++;
    }
    this.src = src;
    this.end = end;
    this.pos = i;
  }

  /** Moves to the next attribute; false at the end of the tag. */
  next(): boolean {
    const s = this.src;
    for (;;) {
      while (this.pos < this.end && (isSpace(s.charCodeAt(this.pos)) || s.charCodeAt(this.pos) === 47)) this.pos++;
      if (this.pos >= this.end) return false;
      this.nameStart = this.pos;
      while (this.pos < this.end) {
        const c = s.charCodeAt(this.pos);
        if (isSpace(c) || c === 61 || c === 47 || c === 62) break;
        this.pos++;
      }
      this.nameLength = this.pos - this.nameStart;
      if (this.nameLength === 0) {
        this.pos++; // a stray '=': skip it
        continue;
      }
      readValueAt(s, this.pos, this.end);
      this.valueStart = valueStart;
      this.valueLength = valueLength;
      this.pos = valueNext;
      return true;
    }
  }

  get name(): string {
    return this.src.slice(this.nameStart, this.nameStart + this.nameLength);
  }

  get rawValue(): string {
    return this.valueStart < 0 ? '' : this.src.slice(this.valueStart, this.valueStart + this.valueLength);
  }
}

/** Whether the element has the attribute, with or without a value. */
export function hasAttribute(n: HtmlNode, name: string): boolean {
  if (attrRaw(n, name) !== '') return true;
  if (n.key === Tag.Comment) return false;
  const s = new AttrScanner(n);
  while (s.next()) if (equalFold(s.name, name)) return true;
  return false;
}
