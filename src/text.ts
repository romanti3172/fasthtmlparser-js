// Visible text: tags, comments and invisible content removed, whitespace collapsed, entities decoded.

import { equalFold, isSpace, isUnicodeSpace, startsWithAt } from './chars.ts';
import { decode } from './decode.ts';
import { findCommentEnd, findRawTextEnd, isMarkupStart, lookupTagAt } from './parse.ts';
import { separatesWordsTag } from './textlines.ts';

/**
 * s[i] is '<'. Returns the index of the last char of what is not text there: a comment, a tag,
 * or a tag together with invisible content (script, style, ...) up to its end tag. -1: an unterminated tag.
 */
export function skipMarkup(s: string, i: number): number {
  if (startsWithAt(s, i + 1, '!--')) return findCommentEnd(s, i + 4);
  const tagEnd = s.indexOf('>', i + 1);
  if (tagEnd < 0) return -1;
  const endTag = invisibleContentEnd(s, i + 1, tagEnd);
  if (endTag !== '') return findRawTextEnd(s, tagEnd + 1, endTag) - 1;
  return tagEnd;
}

/**
 * For the inside of an opening tag s[from, to), the end tag ("</script") when the element's content
 * is never visible text (script, style, noscript, template, noframes, noembed), otherwise "".
 */
function invisibleContentEnd(s: string, from: number, to: number): string {
  if (from >= to) return '';
  const first = s.charCodeAt(from) | 0x20;
  if (first !== 115 && first !== 116 && first !== 110) return ''; // s, t, n
  let n = 1;
  while (from + n < to && n <= 8) {
    const c = s.charCodeAt(from + n) | 0x20;
    if (c < 97 || c > 122) break;
    n++;
  }
  if (from + n < to) {
    const c = s.charCodeAt(from + n);
    if (c !== 47 && !isSpace(c)) return '';
  }
  const name = s.slice(from, from + n);
  let end: string;
  if (equalFold(name, 'style')) end = '</style';
  else if (equalFold(name, 'script')) end = '</script';
  else if (equalFold(name, 'noembed')) end = '</noembed';
  else if (equalFold(name, 'noscript')) end = '</noscript';
  else if (equalFold(name, 'template')) end = '</template';
  else if (equalFold(name, 'noframes')) end = '</noframes';
  else return '';
  let e = to;
  while (e > from && isSpace(s.charCodeAt(e - 1))) e--;
  if (s.charCodeAt(e - 1) === 47) return ''; // <script src="x" />: no content
  return end;
}

function isAsciiLetterOrDigit(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57);
}

/**
 * Whether the markup at s[i] ('<') is a tag that separates words in the one-line text, as in jsoup's `text()`:
 * `<br>`, a block element or a table cell, opening or closing. Comments, declarations, inline and unknown tags do not.
 */
export function separatesWords(s: string, i: number): boolean {
  let start = i + 1;
  if (start < s.length && s.charCodeAt(start) === 47) start++;
  let end = start;
  while (end < s.length && isAsciiLetterOrDigit(s.charCodeAt(end))) end++;
  if (end === start) return false;
  const tag = lookupTagAt(s, start, end);
  return tag >= 0 && separatesWordsTag(tag);
}

/** +1 for an opening pre, listing or plaintext at s[i], -1 for a closing one, 0 otherwise: their text keeps its whitespace. */
function preTag(s: string, i: number): number {
  let start = i + 1;
  let sign = 1;
  if (start < s.length && s.charCodeAt(start) === 47) {
    start++;
    sign = -1;
  }
  const first = s.charCodeAt(start) | 0x20;
  if (start >= s.length || (first !== 112 && first !== 108)) return 0;
  let end = start;
  while (end < s.length && /[a-zA-Z]/.test(s[end]!)) end++;
  const name = s.slice(start, end).toLowerCase();
  return name === 'pre' || name === 'listing' || name === 'plaintext' ? sign : 0;
}

/** Whether trimmed text has whitespace to collapse: a line break, tab or other space than ' ', or two spaces in a row. */
export function needsCollapse(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32) {
      if (i + 1 < s.length && isUnicodeSpace(s.charCodeAt(i + 1))) return true;
    } else if (isUnicodeSpace(c)) {
      return true;
    }
  }
  return false;
}

/** Whether the HTML has a "<pre" (any case). */
export function hasPreTag(s: string): boolean {
  for (let i = s.indexOf('<'); i >= 0; i = s.indexOf('<', i + 1)) {
    if (s.slice(i + 1, i + 4).toLowerCase() === 'pre') return true;
  }
  return false;
}

/**
 * Removes tags, comments and invisible content, collapses whitespace runs into one ' ' and trims: the visible text in
 * one line, as jsoup's `text()`. `<br>`, block elements and table cells separate words ("a<br>b", a row of cells:
 * "a b"), inline tags do not ("a<b>b</b>": "ab"). Inside `<pre>` (inPre: the text itself is in one) whitespace is
 * kept as written.
 */
function stripTags(s: string, inPre: boolean): string {
  let out = '';
  let pendingSpace = false;
  let preDepth = inPre ? 1 : 0;
  let run = -1; // start of the current run of text chars
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 60 && isMarkupStart(s, i)) {
      if (run >= 0) {
        out += s.slice(run, i);
        run = -1;
      }
      const last = skipMarkup(s, i);
      if (last < 0) break;
      if (!inPre) preDepth = Math.max(0, preDepth + preTag(s, i));
      // only after a word: next to whitespace the tag changes nothing (and costs no lookup)
      if (out.length > 0 && !pendingSpace && !isUnicodeSpace(out.charCodeAt(out.length - 1)) && separatesWords(s, i)) {
        pendingSpace = true;
      }
      i = last + 1;
      continue;
    }
    if (isUnicodeSpace(c) && preDepth === 0) {
      if (run >= 0) {
        out += s.slice(run, i);
        run = -1;
      }
      if (out.length > 0) pendingSpace = true;
      i++;
      continue;
    }
    if (run < 0) {
      if (out.length === 0 && isUnicodeSpace(c)) {
        // inside <pre>: not at the start
        i++;
        continue;
      }
      if (pendingSpace) {
        out += ' ';
        pendingSpace = false;
      }
      run = i;
    }
    i++;
  }
  if (run >= 0) out += run === 0 ? s : s.slice(run);
  // right trim (inside <pre> there may be trailing whitespace)
  let end = out.length;
  while (end > 0 && isUnicodeSpace(out.charCodeAt(end - 1))) end--;
  return end === out.length ? out : out.slice(0, end);
}

/** The visible text of an HTML fragment in one line. */
export function clearTags(s: string, inPre = false): string {
  if (s === '') return '';
  const text = stripTags(s, inPre);
  return text.indexOf('&') >= 0 ? decode(text, false) : text;
}

/** Whether the visible text of the body equals expected, comparing on the fly. textOf gives the full text. */
export function isText(value: string, expected: string, textOf: () => string): boolean {
  if (value === '' || expected === '') return false;
  let matched = 0;
  let prevSpace = true; // left trim
  let pendingSpace = false; // a collapsed space counts only if more text follows (right trim)
  for (let i = 0; i < value.length; ) {
    const c = value.charCodeAt(i);
    if (c === 60 && isMarkupStart(value, i)) {
      const last = skipMarkup(value, i);
      if (last < 0) break;
      // <br>, blocks and cells separate words, as in text()
      if (!prevSpace && separatesWords(value, i)) {
        pendingSpace = true;
        prevSpace = true;
      }
      i = last + 1;
      continue;
    }
    if (isUnicodeSpace(c)) {
      if (!prevSpace) {
        pendingSpace = true;
        prevSpace = true;
      }
      i++;
      continue;
    }
    // Text with entities must be decoded before comparing: take the full path.
    if (c === 38) return textOf() === expected;
    if (pendingSpace) {
      if (matched >= expected.length || expected.charCodeAt(matched) !== 32) return false;
      matched++;
      pendingSpace = false;
    }
    if (matched >= expected.length || expected.charCodeAt(matched) !== c) return false;
    matched++;
    prevSpace = false;
    i++;
  }
  return matched === expected.length;
}
