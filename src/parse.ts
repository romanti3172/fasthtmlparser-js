// A page is scanned once in fast mode: tags are matched to their end tags and nothing else.
// Well-formed markup needs nothing more. Where the HTML5 optional-end-tag rules matter (<li>one<li>two</ul>),
// tags are left open inside an element: when its end tag (or the end of the document) finds them on the stack
// and one of them is a rule target (li, p, td, tr, option, ...), only that part is scanned again in rules mode,
// from the outermost such tag up to that end tag. Everything before it was parsed right and is kept.
//
// Port of ParsingCore.cs from z3l.FastHtmlParser; positions are UTF-16 indexes into the source.

import { isSpace, isUnicodeSpace, lowerKey, indexFold, startsWithAt } from './chars.ts';
import { Tag, tagCount, tagNames } from './names.ts';
import { HtmlNode, type HtmlDocument } from './document.ts';

/** Nesting deeper than this is flattened, as browsers do (Blink: 512). */
const maxDepth = 512;
/** The parts scanned again with the optional-end-tag rules may add up to this many times the source length. */
const repairBudgetFactor = 8;

const LT = 60; // '<'
const GT = 62; // '>'
const EQ = 61; // '='
const SLASH = 47;

// ----- tables -----

// Tag names by a hash of their lower-case chars (open addressing): a name is looked up right in the source,
// without cutting it out as a string first.
const tableMask = 1023;
const tagTable = new Int16Array(tableMask + 1).fill(-1);

function hashRange(s: string, from: number, to: number): number {
  let h = 0;
  for (let i = from; i < to; i++) {
    let c = s.charCodeAt(i);
    if (c >= 65 && c <= 90) c += 32;
    h = (Math.imul(h, 31) + c) | 0;
  }
  return (h ^ (h >>> 10)) & tableMask;
}

for (let t = 0; t < tagNames.length; t++) {
  let slot = hashRange(tagNames[t], 0, tagNames[t].length);
  while (tagTable[slot] >= 0) slot = (slot + 1) & tableMask;
  tagTable[slot] = t;
}

/** Finds the tag name s[from, to) case-insensitively (ASCII); -1 for a name that is not a known tag. */
export function lookupTagAt(s: string, from: number, to: number): number {
  const length = to - from;
  if (length <= 0 || length > 32) return -1;
  for (let slot = hashRange(s, from, to); ; slot = (slot + 1) & tableMask) {
    const t = tagTable[slot];
    if (t < 0) return -1;
    const name = tagNames[t];
    if (name.length !== length) continue;
    let k = 0;
    for (; k < length; k++) {
      let c = s.charCodeAt(from + k);
      if (c >= 65 && c <= 90) c += 32;
      if (c !== name.charCodeAt(k)) break;
    }
    if (k === length) return t;
  }
}

/** Finds a tag name case-insensitively (ASCII); -1 for a name that is not a known tag. */
export function lookupTag(name: string): number {
  return lookupTagAt(name, 0, name.length);
}

function tagSet(...tags: number[]): Uint8Array {
  const set = new Uint8Array(tagCount);
  for (const t of tags) set[t] = 1;
  return set;
}

class ImpliedEndRule {
  readonly targets = new Uint8Array(tagCount);
  readonly stops = new Uint8Array(tagCount);
  readonly targetKeys: number[] = [];

  constructor(targets: number[], ...stops: number[][]) {
    for (const t of targets) {
      this.targets[t] = 1;
      this.targetKeys.push(t);
    }
    for (const list of stops) for (const s of list) this.stops[s] = 1;
  }

  /** Whether a target is open at all: in well-formed markup it is not. */
  anyOpen(openByKey: Int32Array): boolean {
    for (const t of this.targetKeys) if (openByKey[t] > 0) return true;
    return false;
  }
}

// Elements that limit the scope of the rules (HTML5 "has an element in scope").
const scopeStops = [Tag.Html, Tag.Body, Tag.Table, Tag.Caption, Tag.Td, Tag.Th, Tag.Template,
  Tag.Object, Tag.Applet, Tag.Marquee, Tag.Button];

// <p> is ended by the start of a block element (HTML5 "close a p element").
const pRule = new ImpliedEndRule([Tag.P], scopeStops);

const closesP = tagSet(Tag.Address, Tag.Article, Tag.Aside, Tag.Blockquote, Tag.Center, Tag.Details,
  Tag.Dialog, Tag.Dir, Tag.Div, Tag.Dl, Tag.Fieldset, Tag.Figcaption, Tag.Figure,
  Tag.Footer, Tag.Form, Tag.H1, Tag.H2, Tag.H3, Tag.H4, Tag.H5, Tag.H6,
  Tag.Header, Tag.Hgroup, Tag.Hr, Tag.Listing, Tag.Main, Tag.Menu, Tag.Nav,
  Tag.Ol, Tag.P, Tag.Pre, Tag.Search, Tag.Section, Tag.Summary, Tag.Table,
  Tag.Ul, Tag.Li, Tag.Dd, Tag.Dt, Tag.Plaintext, Tag.Xmp);

const impliedEndRules: (ImpliedEndRule | undefined)[] = (() => {
  const rules: (ImpliedEndRule | undefined)[] = new Array(tagCount).fill(undefined);
  rules[Tag.Li] = new ImpliedEndRule([Tag.Li], scopeStops, [Tag.Ul, Tag.Ol, Tag.Menu]);

  const dtdd = new ImpliedEndRule([Tag.Dt, Tag.Dd], scopeStops, [Tag.Dl]);
  rules[Tag.Dt] = rules[Tag.Dd] = dtdd;

  const tableStops = [Tag.Html, Tag.Body, Tag.Template, Tag.Table];
  const cell = new ImpliedEndRule([Tag.Td, Tag.Th], tableStops, [Tag.Tr, Tag.Tbody, Tag.Thead, Tag.Tfoot]);
  rules[Tag.Td] = rules[Tag.Th] = cell;
  rules[Tag.Tr] = new ImpliedEndRule([Tag.Tr, Tag.Td, Tag.Th], tableStops, [Tag.Tbody, Tag.Thead, Tag.Tfoot]);
  const section = new ImpliedEndRule([Tag.Tbody, Tag.Thead, Tag.Tfoot, Tag.Tr, Tag.Td, Tag.Th, Tag.Caption], tableStops);
  rules[Tag.Tbody] = rules[Tag.Thead] = rules[Tag.Tfoot] = section;

  const selectStops = [Tag.Html, Tag.Body, Tag.Template, Tag.Select, Tag.Datalist];
  rules[Tag.Option] = new ImpliedEndRule([Tag.Option], selectStops, [Tag.Optgroup]);
  rules[Tag.Optgroup] = new ImpliedEndRule([Tag.Option, Tag.Optgroup], selectStops);
  return rules;
})();

const isRuleTarget = (() => {
  const t = new Uint8Array(tagCount);
  for (const r of impliedEndRules) if (r) for (const k of r.targetKeys) t[k] = 1;
  return t;
})();

// HTML5 void elements (incl. obsolete ones the parsing rules also treat as void) and declarations.
const voidTags = tagSet(Tag.Area, Tag.Base, Tag.Br, Tag.Col, Tag.Embed, Tag.Hr, Tag.Img, Tag.Input,
  Tag.Link, Tag.Meta, Tag.Source, Tag.Track, Tag.Wbr,
  Tag.Basefont, Tag.Bgsound, Tag.Frame, Tag.Keygen, Tag.Param, Tag.Isindex,
  Tag.Doctype, Tag.XmlDeclaration);

/** "</script", "</style", ... for the elements whose content is raw text (HTML5 RAWTEXT / RCDATA); "" for others. */
export const rawTextEnds: readonly string[] = (() => {
  const ends: string[] = new Array(tagCount).fill('');
  for (const t of [Tag.Script, Tag.Style, Tag.Textarea, Tag.Title, Tag.Xmp, Tag.Iframe, Tag.Noembed, Tag.Noframes]) {
    ends[t] = '</' + tagNames[t];
  }
  return ends;
})();

// ----- helpers -----

/** As in HTML5, '<' starts markup only before an ASCII letter, '/', '!' or '?'. */
export function isMarkupStart(s: string, i: number, limit = s.length): boolean {
  if (i + 1 >= limit) return false;
  const c = s.charCodeAt(i + 1);
  const l = c | 0x20;
  return (l >= 97 && l <= 122) || c === SLASH || c === 33 || c === 63;
}

/** The position of the '<' of the end tag (e.g. "</script") in s[from, limit), or limit if there is none. */
export function findRawTextEnd(s: string, from: number, endTag: string, limit = s.length): number {
  while (from < limit) {
    const pos = indexFold(s, endTag, from, limit);
    if (pos < 0) break;
    const after = pos + endTag.length;
    // "</script>", "</script >", "</script/>" end it; "</scripts" does not.
    if (after >= limit) return pos;
    const c = s.charCodeAt(after);
    if (c === GT || c === SLASH || isSpace(c)) return pos;
    from = after;
  }
  return limit;
}

/**
 * The position of the '>' that ends a comment whose content starts at contentStart (in s[0, limit)).
 * As in HTML5: "<!-->" and "<!--->" are empty comments, "-->" or "--!>" end a comment, otherwise it runs to the end.
 */
export function findCommentEnd(s: string, contentStart: number, limit = s.length): number {
  if (contentStart < limit && s.charCodeAt(contentStart) === GT) return contentStart;
  if (contentStart + 1 < limit && s.charCodeAt(contentStart) === 45 && s.charCodeAt(contentStart + 1) === GT) {
    return contentStart + 1;
  }
  let from = contentStart;
  while (from < limit) {
    const dashes = s.indexOf('--', from);
    if (dashes < 0 || dashes + 2 > limit) break;
    const pos = dashes + 2;
    if (pos < limit && s.charCodeAt(pos) === GT) return pos;
    if (pos + 1 < limit && s.charCodeAt(pos) === 33 && s.charCodeAt(pos + 1) === GT) return pos + 1;
    from = dashes + 1;
  }
  return limit - 1;
}

// the result of tagNameAt: the name is src[nameFrom, nameTo)
let nameFrom = 0;
let nameTo = 0;

/** Finds the name in the inside of an opening tag src[from, to) (trimmed; "!--" for a comment). */
function tagNameAt(src: string, from: number, to: number): void {
  while (to > from && isUnicodeSpace(src.charCodeAt(to - 1))) to--;
  while (from < to && isUnicodeSpace(src.charCodeAt(from))) from++;
  nameFrom = from;
  if (startsWithAt(src, from, '!--', to)) {
    nameTo = from + 3;
    return;
  }
  // The name ends at whitespace or '/': <br/> is "br", as <br /> is.
  let i = from;
  while (i < to) {
    const c = src.charCodeAt(i);
    if (isSpace(c) || c === SLASH) break;
    i++;
  }
  nameTo = i;
}

function grow(size: number): void {
  const n = Math.max(size, scratchSize * 2, 256);
  const copy = <T extends Int32Array | Uint8Array>(a: T, b: T): T => {
    b.set(a);
    return b;
  };
  sKey = copy(sKey, new Int32Array(n));
  sDepth = copy(sDepth, new Int32Array(n));
  sPrevOpen = copy(sPrevOpen, new Int32Array(n));
  sSelfClosed = copy(sSelfClosed, new Uint8Array(n));
  scratchSize = n;
}

/** An XML document (RSS, Atom, sitemap, XHTML) is parsed by XML rules: elements end only with an end tag or "/>". */
function isXml(src: string): boolean {
  let i = 0;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (!isSpace(c) && c !== 0xfeff) break; // whitespace and a BOM
    i++;
  }
  return startsWithAt(src, i, '<?') && src.length - i >= 5 && src.slice(i, i + 5).toLowerCase() === '<?xml';
}

interface CustomName {
  name: string; // the lower-case name, one string per document
  open: number; // how many tags with this name are in the open list
}

// Scratch buffers reused between parses (JS is single-threaded): only the result is allocated per document.
let scratchSize = 0;
let sKey = new Int32Array(0); // Tag, or -1 for a custom name
let sDepth = new Int32Array(0);
let sPrevOpen = new Int32Array(0); // the open tags as a linked list in document order
let sSelfClosed = new Uint8Array(0); // <x/>: stays in the open list (a later </x> ends it), but nests nothing
let sStack = new Int32Array(64); // indexes of the open tags that contain the following ones
const sOpenByKey = new Int32Array(tagCount); // per Tag, how many are on the stack: kept only in rules mode
const sOpenInList = new Int32Array(tagCount); // per Tag, how many are in the open list

class ParseState {
  readonly doc: HtmlDocument;
  readonly src: string;
  readonly isXml: boolean;
  readonly nodes: HtmlNode[] = [];
  custom: Map<string, CustomName> | null = null;
  count = 0;
  stackTop = 0;
  lastOpen = -1;
  openP = 0; // <p> tags on the stack, kept in both modes
  budget: number; // chars that may still be scanned again by repair
  tagStarted = false; // scan results
  tagStart = 0;

  constructor(doc: HtmlDocument, src: string) {
    this.doc = doc;
    this.src = src;
    this.isXml = isXml(src);
    this.budget = repairBudgetFactor * src.length;
  }

  /** Parses src[from, to) (from is outside a tag), adding tags at count. Tags still open at to stay on the stack. */
  scan(rules: boolean, from: number, to: number): void {
    const src = this.src;
    let tagStarted = false;
    let tagStart = 0;
    let i = from;
    while (i < to) {
      if (!tagStarted) {
        // Outside a tag only '<' matters: jump to it.
        const lt = src.indexOf('<', i);
        if (lt < 0 || lt >= to) break;
        i = lt;

        if (startsWithAt(src, i + 1, '!--', to)) {
          // <!-- ... -->: one "!--" tag; its content is not markup, it does not nest anything.
          const commentEnd = findCommentEnd(src, i + 4, to);
          let parent = -1;
          let depth = 0;
          if (this.stackTop > 0) {
            parent = sStack[this.stackTop - 1];
            depth = sDepth[parent] + 1;
          }
          const k = this.count;
          if (k >= scratchSize) grow(k + 1);
          this.nodes[k] = new HtmlNode(this.doc, k, parent, Tag.Comment, '', i, commentEnd, commentEnd + 1, depth);
          sKey[k] = Tag.Comment;
          sDepth[k] = depth;
          sPrevOpen[k] = -1;
          sSelfClosed[k] = 0;
          this.count++;
          i = commentEnd + 1;
          continue;
        }

        // As in HTML5, '<' starts markup only before a letter, '/', '!' or '?': "a < b" is text.
        if (!isMarkupStart(src, i, to)) {
          i++;
          continue;
        }

        tagStarted = true;
        tagStart = i + 1;
        i++;
        continue;
      }

      // Inside a tag only '<', '=' and '>' matter.
      let c = 0;
      while (i < to) {
        c = src.charCodeAt(i);
        if (c === LT || c === EQ || c === GT) break;
        i++;
      }
      if (i >= to) break;

      if (c === LT) {
        // An unfinished tag: start over at this '<' (it may also start a comment).
        tagStarted = false;
        continue;
      }
      if (c === EQ) {
        // A quoted value may contain '<' and '>' (data-x="<p>...</p>"): jump over it.
        let q = i + 1;
        while (q < to && isSpace(src.charCodeAt(q))) q++;
        if (q < to) {
          const quote = src.charCodeAt(q);
          if (quote === 34 || quote === 39) {
            const closeQuote = src.indexOf(quote === 34 ? '"' : "'", q + 1);
            if (closeQuote >= 0 && closeQuote < to) i = closeQuote;
          }
        }
      } else {
        // '>'
        if (src.charCodeAt(tagStart) === SLASH) this.endTag(rules, tagStart, i);
        else i = this.startTag(rules, tagStart, i, to);
        tagStarted = false;
      }
      i++;
    }
    this.tagStarted = tagStarted;
    this.tagStart = tagStart;
  }

  /** Matches the end tag src[tagStart-1 .. gt] to the innermost open tag with that name. */
  endTag(rules: boolean, tagStart: number, gt: number): void {
    const src = this.src;
    let from = tagStart + 1;
    let to = gt;
    while (to > from && isUnicodeSpace(src.charCodeAt(to - 1))) to--;
    while (from < to && isUnicodeSpace(src.charCodeAt(from))) from++;
    if (from === to) return;
    // Resolve the name once, then compare ints instead of a lookup per candidate.
    const key = lookupTagAt(src, from, to);
    const name = key >= 0 ? '' : src.slice(from, to); // only custom names are compared as strings
    // The rules may have ended the matched tag itself (<li><div><li>x</div>: the second <li> ends the first one
    // together with its <div>, as in a browser): the end tag is matched again, to what is open now.
    // Once: the part is not scanned a second time.
    if (this.matchEnd(rules, key, name, tagStart, gt, true)) this.matchEnd(rules, key, name, tagStart, gt, false);
  }

  /**
   * Ends the innermost open tag with the end tag's name. Returns true when it scanned a part again
   * with the optional-end-tag rules instead, and the end tag is to be matched once more.
   */
  matchEnd(rules: boolean, key: number, name: string, tagStart: number, gt: number, canRepair: boolean): boolean {
    // A name that no open tag has is a stray end tag: it is skipped without scanning the open tags.
    let closing: CustomName | undefined;
    if (key >= 0) {
      if (sOpenInList[key] <= 0) return false;
    } else {
      if (this.custom === null) return false;
      closing = this.custom.get(lowerKey(name));
      if (closing === undefined || closing.open <= 0) return false;
    }

    for (let j = this.lastOpen; j >= 0; j = sPrevOpen[j]) {
      if (key >= 0) {
        if (sKey[j] !== key) continue;
      } else if (sKey[j] >= 0 || this.nodes[j].custom !== closing!.name) {
        continue;
      }

      const innerEnd = tagStart - 2;

      // Tags left open inside it: if the optional-end-tag rules apply to one of them,
      // scan its part again with the rules (fast mode only; rules mode has applied them).
      if (canRepair && !rules && !this.isXml && this.stackTop > 0 && sStack[this.stackTop - 1] > j) {
        let above = this.stackTop - 1;
        while (above > 0 && sStack[above - 1] > j) above--;
        const target = this.firstMisnested(above, this.stackTop);
        if (target >= 0) {
          this.repair(target, tagStart - 1);
          return true;
        }
      }

      const node = this.nodes[j];
      node.innerEnd = innerEnd;
      node.end = gt;

      while (this.stackTop > 0 && sStack[this.stackTop - 1] >= j) {
        this.stackTop--;
        const popped = sKey[sStack[this.stackTop]];
        if (popped === Tag.P) this.openP--;
        if (rules && popped >= 0) sOpenByKey[popped]--;
      }

      // It leaves the open list with everything opened after it; the tags opened inside it and
      // never closed end right before this end tag, as in a browser.
      this.truncateOpenList(j, innerEnd);
      return false;
    }
    return false;
  }

  /** Adds the tag src[tagStart-1 .. gt]; returns the position to continue from (gt, or before a raw-text end tag). */
  startTag(rules: boolean, tagStart: number, gt: number, to: number): number {
    const src = this.src;
    tagNameAt(src, tagStart, gt);
    const key = lookupTagAt(src, nameFrom, nameTo);
    // Custom names (svg elements, web components, ...): one string per distinct name per document.
    const custom = key < 0 ? this.internName(src.slice(nameFrom, nameTo)) : '';

    if (!this.isXml && key >= 0) {
      // Optional end tags (HTML5): <li> ends an open <li>, <td> an open <td>, ...
      const rule = impliedEndRules[key];
      if (rule !== undefined) {
        if (rules) {
          if (rule.anyOpen(sOpenByKey)) this.closeInScope(rule, tagStart - 2, true);
        } else if (this.stackTop > 0) {
          // The common case of a left-out end tag is caught right here: the innermost open tag is a target.
          const top = sKey[sStack[this.stackTop - 1]];
          if (top >= 0 && rule.targets[top]) this.applyRuleInFastMode(rule, tagStart);
        }
      }

      // A block element ends an open <p>. Usually no <p> is open and this is one compare.
      if (this.openP > 0 && closesP[key]) {
        if (rules) this.closeInScope(pRule, tagStart - 2, true);
        else this.applyRuleInFastMode(pRule, tagStart);
      }
    }

    // the innermost open tag is the parent
    let parent = -1;
    let depth = 0;
    if (this.stackTop > 0) {
      parent = sStack[this.stackTop - 1];
      depth = sDepth[parent] + 1;
    }

    const index = this.count;
    if (index >= scratchSize) grow(index + 1);
    this.nodes[index] = new HtmlNode(this.doc, index, parent, key, custom, tagStart - 1, gt, gt + 1, depth);

    // Void elements (<br>, <img>, <meta>, ...) and declarations never contain anything.
    const isVoid = !this.isXml && key >= 0 && voidTags[key] === 1;
    let selfClosing = isVoid;
    if (!selfClosing) {
      let e = gt;
      while (e > tagStart && isSpace(src.charCodeAt(e - 1))) e--;
      selfClosing = e > tagStart && src.charCodeAt(e - 1) === SLASH;
    }

    sKey[index] = key;
    sDepth[index] = depth;
    if (isVoid) {
      sPrevOpen[index] = -1;
      sSelfClosed[index] = 0;
    } else {
      sPrevOpen[index] = this.lastOpen;
      sSelfClosed[index] = selfClosing ? 1 : 0;
      this.lastOpen = index;
      if (key >= 0) sOpenInList[key]++;
      else this.adjustCustom(custom, 1);
    }
    this.count++;

    if (!selfClosing) {
      // Deeper than maxDepth the tag is not nested: it stays in the open list for its end tag.
      if (this.stackTop < maxDepth) {
        if (this.stackTop === sStack.length) {
          const grown = new Int32Array(sStack.length * 2);
          grown.set(sStack);
          sStack = grown;
        }
        sStack[this.stackTop++] = index;
        if (key === Tag.P) this.openP++;
        if (rules && key >= 0) sOpenByKey[key]++;
      }

      // <script>, <style>, <textarea>, <title>, ...: the content is text, not markup;
      // continue right before the matching end tag.
      if (!this.isXml && key >= 0 && rawTextEnds[key] !== '') {
        return findRawTextEnd(src, gt + 1, rawTextEnds[key], to) - 1;
      }
    }
    return gt;
  }

  // ----- implied end tags -----

  /** Among the tags left open at stack positions [from, to), the outermost one that a rule should have ended, or -1. */
  firstMisnested(from: number, to: number): number {
    for (let s = from; s < to - 1; s++) {
      const key = sKey[sStack[s]];
      if (key < 0 || !isRuleTarget[key]) continue;
      for (let inner = s + 1; inner < to; inner++) {
        const innerKey = sKey[sStack[inner]];
        if (innerKey >= 0) {
          const rule = impliedEndRules[innerKey];
          if (rule !== undefined && rule.targets[key]) return s;
        }
      }
    }
    return -1;
  }

  /**
   * Scans again with the optional-end-tag rules from the tag at stack position stackPos up to regionEnd:
   * the tags from it on are replaced, the ones before it are kept.
   */
  repair(stackPos: number, regionEnd: number): void {
    const first = sStack[stackPos];
    const from = this.nodes[first].start;

    // Past the budget the part is left as it is, so that parsing stays linear on any markup.
    const cost = regionEnd - from;
    if (cost > this.budget) return;
    this.budget -= cost;

    this.truncateOpenList(first, -1);
    this.stackTop = stackPos;
    this.count = first;

    sOpenByKey.fill(0);
    this.openP = 0;
    for (let s = 0; s < stackPos; s++) {
      const key = sKey[sStack[s]];
      if (key < 0) continue;
      sOpenByKey[key]++;
      if (key === Tag.P) this.openP++;
    }

    this.scan(true, from, regionEnd);
  }

  /**
   * Removes the tags from index first on from the open list (they are its tail).
   * With end >= 0 the ones that have no end tag of their own end there.
   */
  truncateOpenList(first: number, end: number): void {
    let k = this.lastOpen;
    while (k >= first) {
      const node = this.nodes[k];
      const key = sKey[k];
      if (key >= 0) sOpenInList[key]--;
      else this.adjustCustom(node.custom, -1);

      if (end >= 0 && !sSelfClosed[k] && node.innerEnd === 0) {
        node.innerEnd = end;
        node.end = end;
      }
      k = sPrevOpen[k];
    }
    this.lastOpen = k;
  }

  adjustCustom(name: string, delta: number): void {
    if (this.custom === null || name === '') return;
    const c = this.custom.get(name);
    if (c !== undefined) c.open += delta;
  }

  /** The lower-case name as one string per document. */
  internName(name: string): string {
    if (name === '') return '';
    if (this.custom === null) this.custom = new Map();
    const lower = lowerKey(name);
    const c = this.custom.get(lower);
    if (c !== undefined) return c.name;
    this.custom.set(lower, { name: lower, open: 0 });
    return lower;
  }

  /** The stack position of the outermost target of rule below the first stop tag, or -1. */
  scopeStart(rule: ImpliedEndRule): number {
    let from = -1;
    for (let s = this.stackTop - 1; s >= 0; s--) {
      const k = sKey[sStack[s]];
      if (k < 0) continue;
      if (rule.targets[k]) from = s;
      else if (rule.stops[k]) break;
    }
    return from;
  }

  /**
   * Applies rule for the tag that starts at tagStart. If a tag it ends was itself misnested,
   * that part is scanned again with the rules first.
   */
  applyRuleInFastMode(rule: ImpliedEndRule, tagStart: number): void {
    const from = this.scopeStart(rule);
    if (from < 0) return;
    const m = this.firstMisnested(from, this.stackTop);
    if (m >= 0) this.repair(m, tagStart - 1);
    this.closeInScope(rule, tagStart - 2, false);
  }

  /** Ends the outermost target found below the first stop tag together with everything opened inside it. */
  closeInScope(rule: ImpliedEndRule, end: number, byKey: boolean): void {
    const from = this.scopeStart(rule);
    if (from < 0) return;
    const first = sStack[from];
    while (this.stackTop > from) {
      this.stackTop--;
      const key = sKey[sStack[this.stackTop]];
      if (key === Tag.P) this.openP--;
      if (byKey && key >= 0) sOpenByKey[key]--;
    }
    this.truncateOpenList(first, end);
  }
}

/** Parses src into the flat tag list of doc. */
export function parseTags(doc: HtmlDocument, src: string): HtmlNode[] {
  if (src.indexOf('<') < 0) return [];
  // the per-tag buffers grow as tags are added
  sOpenInList.fill(0);
  sOpenByKey.fill(0);

  const st = new ParseState(doc, src);
  st.scan(false, 0, src.length);

  // The end of the document ends every tag still open (a truncated page keeps its text),
  // right before an unfinished tag if the source stops inside one.
  const regionEnd = st.tagStarted ? st.tagStart - 1 : src.length;
  if (!st.isXml) {
    const s = st.firstMisnested(0, st.stackTop);
    if (s >= 0) st.repair(s, regionEnd);
  }
  st.truncateOpenList(0, regionEnd - 1);

  const nodes = st.nodes;
  nodes.length = st.count;
  for (const n of nodes) if (n.innerEnd === 0) n.innerStart = 0; // not closed: no body
  return nodes;
}
