// Text with the visible line structure kept (Node.textLineBreaks).

import { indexFold, isSpace, isUnicodeSpace, trimRightAscii } from './chars.ts';
import { decodeReference, normalizeNewlines } from './decode.ts';
import { Tag, tagCount, tagNames } from './names.ts';
import { isMarkupStart, lookupTag } from './parse.ts';

const breakNone = 0; // inline tag (b, span, a, ...): removed, words are not split
const breakSpace = 1; // table cell: word separator
const breakLine = 2; // <br> and block elements (div, li, tr, ...): new line
const breakParagraph = 3; // p, h1-h6: new paragraph (blank line)
const breakSkipContent = 4; // script, style, noscript: contents are not text

const lineBreakKinds = (() => {
  const kinds = new Uint8Array(tagCount).fill(breakNone);
  for (const t of [Tag.P, Tag.H1, Tag.H2, Tag.H3, Tag.H4, Tag.H5, Tag.H6]) kinds[t] = breakParagraph;
  for (const t of [
    Tag.Br, Tag.Div, Tag.Li, Tag.Ul, Tag.Ol, Tag.Dl, Tag.Dt, Tag.Dd,
    Tag.Table, Tag.Caption, Tag.Tr, Tag.Thead, Tag.Tbody, Tag.Tfoot,
    Tag.Section, Tag.Article, Tag.Aside, Tag.Nav, Tag.Header, Tag.Footer, Tag.Main,
    Tag.Address, Tag.Blockquote, Tag.Pre, Tag.Hr, Tag.Figure, Tag.Figcaption,
    Tag.Form, Tag.Fieldset, Tag.Legend, Tag.Details, Tag.Summary, Tag.Dialog,
    Tag.Option, Tag.Html, Tag.Head, Tag.Body, Tag.Title,
    Tag.Hgroup, Tag.Search, Tag.Menu, Tag.Center, Tag.Dir, Tag.Listing,
    Tag.Xmp, Tag.Plaintext, Tag.Multicol, Tag.Frameset, Tag.Marquee,
  ]) {
    kinds[t] = breakLine;
  }
  kinds[Tag.Td] = kinds[Tag.Th] = breakSpace;
  for (const t of [Tag.Script, Tag.Style, Tag.Noscript, Tag.Template, Tag.Noframes, Tag.Noembed]) kinds[t] = breakSkipContent;
  return kinds;
})();

/** Writes text, collapsing whitespace and turning requested breaks into trimmed lines. */
class LineWriter {
  out = '';
  pendingBreaks = 0; // new lines requested since the last text char
  pendingSpace = false;

  /** Writes s[from, to). */
  chars(s: string, from: number, to: number): void {
    for (let i = from; i < to; i++) {
      const c = s.charCodeAt(i);
      if (isUnicodeSpace(c)) {
        this.pendingSpace = true;
        continue;
      }
      // a run of text chars at once
      let j = i + 1;
      while (j < to && !isUnicodeSpace(s.charCodeAt(j))) j++;
      this.text(s.slice(i, j));
      i = j - 1;
    }
  }

  private text(t: string): void {
    if (this.out.length > 0) {
      // nothing before the first text char: leading breaks and spaces are trimmed
      if (this.pendingBreaks > 0) this.out += this.pendingBreaks >= 2 ? '\n\n' : '\n'; // at most one blank line
      else if (this.pendingSpace) this.out += ' ';
    }
    this.pendingBreaks = 0;
    this.pendingSpace = false;
    this.out += t;
  }

  /** A block boundary: at least count new lines before the next text. */
  lineBreak(count: number): void {
    this.pendingBreaks = Math.max(this.pendingBreaks, count);
  }
}

/** The text of an HTML fragment with the visible line structure kept. Lines are joined with "\n". */
export function clearTagsLineBreaks(value: string): string {
  if (value === '') return '';
  if (value.indexOf('\r') >= 0) value = normalizeNewlines(value); // values are read as a browser reads the page
  const w = new LineWriter();
  const n = value.length;
  let i = 0;
  while (i < n) {
    const c = value.charCodeAt(i);

    if (c === 38) {
      // '&': decoded chars go through the same whitespace/text logic (&nbsp; collapses, &lt; is plain text)
      const [consumed, decoded] = decodeReference(value, i + 1);
      if (consumed > 0) {
        w.chars(decoded, 0, decoded.length);
        i += 1 + consumed;
      } else {
        w.chars('&', 0, 1);
        i++;
      }
      continue;
    }

    if (c !== 60 || !isMarkupStart(value, i)) {
      // plain text up to the next '&' or '<'
      let j = i + 1;
      while (j < n) {
        const d = value.charCodeAt(j);
        if (d === 38 || d === 60) break;
        j++;
      }
      w.chars(value, i, j);
      i = j;
      continue;
    }

    if (value.startsWith('<!--', i)) {
      const end = value.indexOf('-->', i + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }

    const closeTag = value.indexOf('>', i);
    if (closeTag < 0) break; // unterminated tag: the rest is markup
    const tag = value.slice(i + 1, closeTag);
    i = closeTag + 1;

    const closing = tag.charCodeAt(0) === 47;
    let name = closing ? tag.slice(1) : tag;
    for (let k = 0; k < name.length; k++) {
      const d = name.charCodeAt(k);
      if (d === 47 || (isSpace(d) && d !== 11)) {
        // " \t\r\n\f/"
        name = name.slice(0, k);
        break;
      }
    }
    const known = lookupTag(name);
    if (known < 0) continue; // unknown tag: just removed

    switch (lineBreakKinds[known]) {
      case breakLine:
        if (known === Tag.Br) w.pendingBreaks++; // every <br> counts
        else w.lineBreak(1);
        break;
      case breakParagraph:
        w.lineBreak(2);
        break;
      case breakSpace:
        w.chars(' ', 0, 1);
        break;
      case breakSkipContent:
        if (!closing && !trimRightAscii(tag).endsWith('/')) {
          // jump to the closing tag; it is removed on the next iteration
          const end = indexFold(value, '</' + tagNames[known], i);
          i = end < 0 ? n : end;
        }
        break;
    }
  }
  return w.out;
}
