// Visible text: tags, comments and invisible content removed, whitespace collapsed, entities decoded.

import { equalFold, isSpace, isUnicodeSpace, startsWithAt } from './chars.ts';
import { decode } from './decode.ts';
import { findCommentEnd, findRawTextEnd, isMarkupStart } from './parse.ts';

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

/** Removes tags, comments and invisible content, collapses whitespace runs into one ' ' and trims. */
function stripTags(s: string): string {
  let out = '';
  let pendingSpace = false;
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
      if (last < 0) return out;
      i = last + 1;
      continue;
    }
    if (isUnicodeSpace(c)) {
      if (run >= 0) {
        out += s.slice(run, i);
        run = -1;
      }
      if (out.length > 0) pendingSpace = true;
      i++;
      continue;
    }
    if (run < 0) {
      if (pendingSpace) {
        out += ' ';
        pendingSpace = false;
      }
      run = i;
    }
    i++;
  }
  if (run >= 0) out += run === 0 ? s : s.slice(run);
  return out;
}

/** The visible text of an HTML fragment. */
export function clearTags(s: string): string {
  if (s === '') return '';
  const text = stripTags(s);
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
