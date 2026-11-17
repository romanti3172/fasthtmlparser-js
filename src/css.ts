// CSS selectors over the flat tag list, matched right to left as browsers do.

import { equalFold, isHexChar } from './chars.ts';
import { attrEquals, attrRaw, hasAttribute } from './attr.ts';
import { decode } from './decode.ts';
import { Tag } from './names.ts';
import { lookupTag } from './parse.ts';
import type { HtmlDocument, HtmlNode } from './document.ts';

/** Thrown by `CssQuery.compile` (and the string methods) for an invalid selector. */
export class CssSelectorError extends SyntaxError {
  override name = 'CssSelectorError';
}

/**
 * A compiled CSS selector (or a comma-separated list of them). Compile once and reuse it on any number of documents;
 * the string methods (`doc.css(...)`, `node.cssFirst(...)`, ...) compile and cache selectors automatically.
 *
 * Supported: type, `*`, `#id`, `.class`, attribute selectors (`[a]`, `=`, `~=`, `|=`, `^=`, `$=`, `*=`, with the
 * `i` / `s` flags), the combinators (descendant, `>`, `+`, `~`), selector lists and the pseudo-classes `:first-child`,
 * `:last-child`, `:only-child`, `:first-of-type`, `:last-of-type`, `:only-of-type`, `:nth-child(An+B [of S])`,
 * `:nth-last-child()`, `:nth-of-type()`, `:nth-last-of-type()`, `:not()`, `:is()`, `:where()`, `:has()`, `:empty`,
 * `:root`, `:scope`, `:link`, `:any-link`, `:checked`, `:disabled`, `:enabled`, `:required`, `:optional`, and
 * `:contains("text")`. Pseudo-elements and namespaces are not supported.
 *
 * HTML rules: tag and attribute names are case-insensitive; ids, classes and attribute values are case-sensitive,
 * except the values the HTML standard lists (type, rel, lang, method, ...). Only elements are selected, never comments.
 */
export class CssQuery {
  /** The source of the selector. */
  readonly selector: string;
  /** @internal */
  readonly list: CssList;

  private constructor(selector: string, list: CssList) {
    this.selector = selector;
    this.list = list;
  }

  /** Compiles a CSS selector; throws `CssSelectorError` on an invalid one. */
  static compile(selector: string): CssQuery {
    const c = new CssCompiler(selector);
    const list = c.parseList(false, true);
    if (c.p < c.s.length) c.fail(`unexpected '${c.s[c.p]}'`);
    return new CssQuery(selector, list);
  }

  toString(): string {
    return this.selector;
  }

  /** The matching tags in the document, in document order. */
  all(d: HtmlDocument): HtmlNode[] {
    return this.scan(d, null, 0, d.source.length, false);
  }

  /** The first matching tag in the document, or null. */
  first(d: HtmlDocument): HtmlNode | null {
    return this.scan(d, null, 0, d.source.length, true)[0] ?? null;
  }

  /** The matching tags inside n (as querySelectorAll). */
  allIn(n: HtmlNode): HtmlNode[] {
    return this.scan(n.document, n, n.index + 1, n.end, false);
  }

  /** The first matching tag inside n, or null. */
  firstIn(n: HtmlNode): HtmlNode | null {
    return this.scan(n.document, n, n.index + 1, n.end, true)[0] ?? null;
  }

  /** Whether the tag matches (as element.matches(): :scope is the tag itself); false for comments. */
  matches(n: HtmlNode | null | undefined): boolean {
    return n != null && isElement(n) && this.list.matches(n, new CssContext(n.document, n, n));
  }

  private scan(d: HtmlDocument, scope: HtmlNode | null, from: number, end: number, firstOnly: boolean): HtmlNode[] {
    const ctx = new CssContext(d, scope, scope);
    const out: HtmlNode[] = [];
    const nodes = d.nodes;
    for (let i = from; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.end > end) break;
      if (this.list.matches(n, ctx)) {
        out.push(n);
        if (firstOnly) break;
      }
    }
    return out;
  }
}

const cache = new Map<string, CssQuery>();

/** @internal */
export function cachedCss(selector: string): CssQuery {
  let q = cache.get(selector);
  if (q === undefined) {
    q = CssQuery.compile(selector);
    if (cache.size >= 1024) cache.clear(); // dynamically built selectors must not grow the cache forever
    cache.set(selector, q);
  }
  return q;
}

/** Not a comment, the doctype or the XML declaration. */
export function isElement(n: HtmlNode): boolean {
  if (n.key >= 0) return n.key !== Tag.Comment && n.key !== Tag.Doctype && n.key !== Tag.XmlDeclaration;
  const c = n.custom.charCodeAt(0);
  return n.custom !== '' && c !== 33 && c !== 63;
}

// ----- the tree: sibling links and positions, built once per document -----

/** @internal */
export class CssTree {
  readonly nodes: readonly HtmlNode[];
  readonly previous: Int32Array; // previous element sibling, -1 for none
  readonly next: Int32Array;
  readonly position: Int32Array; // 1-based position among the element siblings
  readonly fromEnd: Int32Array;
  private types: { position: Int32Array; fromEnd: Int32Array } | null = null;

  
  constructor(nodes: readonly HtmlNode[]) {

    const count = nodes.length;
    this.nodes = nodes;
    this.previous = new Int32Array(count).fill(-1);
    this.next = new Int32Array(count).fill(-1);
    this.position = new Int32Array(count);
    this.fromEnd = new Int32Array(count);
    // per parent (slot = parent index + 1, slot 0: the top level): its last element child so far and their number
    const lastChild = new Int32Array(count + 1).fill(-1);
    const children = new Int32Array(count + 1);
    for (let i = 0; i < count; i++) {
      if (!isElement(nodes[i])) continue;
      const slot = nodes[i].parentIndex + 1;
      const prev = lastChild[slot];
      this.previous[i] = prev;
      if (prev >= 0) this.next[prev] = i;
      lastChild[slot] = i;
      this.position[i] = ++children[slot];
    }
    for (let i = 0; i < count; i++) {
      if (this.position[i] > 0) this.fromEnd[i] = children[nodes[i].parentIndex + 1] - this.position[i] + 1;
    }
  }

  prev(n: HtmlNode): HtmlNode | null {
    const i = this.previous[n.index];
    return i < 0 ? null : this.nodes[i];
  }

  nextOf(n: HtmlNode): HtmlNode | null {
    const i = this.next[n.index];
    return i < 0 ? null : this.nodes[i];
  }

  typePositions(): { position: Int32Array; fromEnd: Int32Array } {
    if (this.types !== null) return this.types;
    const count = this.nodes.length;
    const tp = { position: new Int32Array(count), fromEnd: new Int32Array(count) };
    const seen = new Map<string, number>();
    const key = (n: HtmlNode) => n.parentIndex + '|' + n.key + '|' + (n.key < 0 ? n.custom : '');
    for (let i = 0; i < count; i++) {
      if (this.position[i] === 0) continue; // not an element
      const k = key(this.nodes[i]);
      const v = (seen.get(k) ?? 0) + 1;
      seen.set(k, v);
      tp.position[i] = v;
    }
    for (let i = 0; i < count; i++) {
      if (tp.position[i] > 0) tp.fromEnd[i] = seen.get(key(this.nodes[i]))! - tp.position[i] + 1;
    }
    this.types = tp;
    return tp;
  }
}

function treeOf(d: HtmlDocument): CssTree {
  return (d.cssTree ??= new CssTree(d.nodes));
}

// ----- matching -----

const combNone = 0;
const combDescendant = 1; // "a b"
const combChild = 2; // "a > b"
const combAdjacent = 3; // "a + b"
const combSibling = 4; // "a ~ b"

/**
 * The document, the tag the query was called on (:scope, null for the document) and the tag a relative selector
 * starts from (:has(> a), or node.css("> li"); null: the document).
 */
class CssContext {
  readonly doc: HtmlDocument;
  readonly scope: HtmlNode | null;
  readonly anchor: HtmlNode | null;
  constructor(doc: HtmlDocument, scope: HtmlNode | null, anchor: HtmlNode | null) {
    this.doc = doc;
    this.scope = scope;
    this.anchor = anchor;
  }

  tree(): CssTree {
    return treeOf(this.doc);
  }
}

interface CssSimple {
  matches(n: HtmlNode, ctx: CssContext): boolean;
}

class CssList {
  readonly items: CssComplex[] = [];

  matches(n: HtmlNode, ctx: CssContext): boolean {
    for (const item of this.items) if (item.matches(item.compounds.length - 1, n, ctx)) return true;
    return false;
  }
}

/** Compounds joined by combinators; combinators[i] stands between compounds[i] and [i+1]. */
class CssComplex {
  leading = combNone;
  readonly compounds: CssCompound[] = [];
  readonly combinators: number[] = [];

  /** n matches compound i and the part to the left of it matches the tags the combinators lead to. */
  matches(i: number, n: HtmlNode, ctx: CssContext): boolean {
    if (!this.compounds[i].matches(n, ctx)) return false;
    if (i === 0) return this.leading === combNone || isRelated(this.leading, ctx.anchor, n, ctx);
    switch (this.combinators[i - 1]) {
      case combChild: {
        const p = n.parent();
        return p !== null && this.matches(i - 1, p, ctx);
      }
      case combDescendant:
        for (let p = n.parent(); p !== null; p = p.parent()) if (this.matches(i - 1, p, ctx)) return true;
        return false;
      case combAdjacent: {
        const p = ctx.tree().prev(n);
        return p !== null && this.matches(i - 1, p, ctx);
      }
      case combSibling: {
        const t = ctx.tree();
        for (let p = t.prev(n); p !== null; p = t.prev(p)) if (this.matches(i - 1, p, ctx)) return true;
        return false;
      }
    }
    return false;
  }
}

class CssCompound {
  key = -1; // Tag, or -1
  name = ''; // lower-case name not in Tag; "" with key -1: any element
  readonly simples: CssSimple[] = [];

  matches(n: HtmlNode, ctx: CssContext): boolean {
    if (this.key >= 0) {
      if (n.key !== this.key) return false;
    } else if (this.name !== '') {
      if (n.key >= 0 || n.custom !== this.name) return false;
    } else if (!isElement(n)) {
      return false;
    }
    for (const s of this.simples) if (!s.matches(n, ctx)) return false;
    return true;
  }
}

/** n stands in the combinator relation to anchor (null: the document). */
function isRelated(c: number, anchor: HtmlNode | null, n: HtmlNode, ctx: CssContext): boolean {
  switch (c) {
    case combChild:
      return anchor === null ? n.parentIndex < 0 : n.parentIndex === anchor.index;
    case combDescendant:
      if (anchor === null) return true;
      for (let p = n.parent(); p !== null; p = p.parent()) if (p === anchor) return true;
      return false;
    case combAdjacent:
      return anchor !== null && ctx.tree().prev(n) === anchor;
    case combSibling:
      return anchor !== null && anchor.index < n.index && anchor.parentIndex === n.parentIndex && isElement(anchor);
  }
  return false;
}

/** :has(): whether a tag in the anchor's scope matches the relative selector. */
function hasMatch(relative: CssList, anchor: HtmlNode, ctx: CssContext): boolean {
  const nodes = anchor.document.nodes;
  const inner = new CssContext(ctx.doc, ctx.scope, anchor);
  for (const item of relative.items) {
    const last = item.compounds.length - 1;
    let i = anchor.index + 1;
    if (item.leading === combDescendant || item.leading === combChild) {
      // the tags inside the anchor
      for (; i < nodes.length && nodes[i].end <= anchor.end; i++) {
        if (isElement(nodes[i]) && item.matches(last, nodes[i], inner)) return true;
      }
    } else {
      // the following siblings and the tags inside them, up to the end of the parent
      while (i < nodes.length && nodes[i].end <= anchor.end) i++;
      const parent = anchor.parent();
      const end = parent !== null ? parent.end : Number.MAX_SAFE_INTEGER;
      for (; i < nodes.length && nodes[i].end <= end; i++) {
        if (isElement(nodes[i]) && item.matches(last, nodes[i], inner)) return true;
      }
    }
  }
  return false;
}

const isCssSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;

/** Whether a whitespace-separated list contains word. */
function containsWord(list: string, word: string, fold: boolean): boolean {
  if (word === '' || list.length < word.length) return false;
  let i = 0;
  const n = list.length;
  for (;;) {
    while (i < n && isCssSpace(list.charCodeAt(i))) i++;
    if (i === n) return false;
    let end = i;
    while (end < n && !isCssSpace(list.charCodeAt(end))) end++;
    if (equal(list.slice(i, end), word, fold)) return true;
    if (end === n) return false;
    i = end;
  }
}

function equal(a: string, b: string, fold: boolean): boolean {
  return fold ? equalFold(a, b) : a === b;
}

const decoded = (raw: string) => decode(raw, true);

// ----- simple selectors -----

class CssId implements CssSimple {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  matches(n: HtmlNode): boolean {
    return attrEquals(attrRaw(n, 'id'), this.id);
  }
}

class CssClass implements CssSimple {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  matches(n: HtmlNode): boolean {
    const raw = attrRaw(n, 'class');
    return raw !== '' && containsWord(decoded(raw), this.name, false);
  }
}

const opExists = 0; // [a]
const opEquals = 1; // [a=v]
const opIncludes = 2; // [a~=v]
const opDash = 3; // [a|=v]
const opPrefix = 4; // [a^=v]
const opSuffix = 5; // [a$=v]
const opSubstring = 6; // [a*=v]

// HTML: the values of these attributes are compared ignoring ASCII case unless the selector has the 's' flag.
const caseInsensitiveValues = new Set(
  `accept accept-charset align alink axis bgcolor charset checked clear codetype color
  compact declare defer dir direction disabled enctype face frame hreflang http-equiv
  lang language link media method multiple nohref noresize noshade nowrap readonly
  rel rev rules scope scrolling selected shape target text type valign valuetype vlink`.split(/\s+/),
);

class CssAttribute implements CssSimple {
  readonly name: string;
  readonly op: number;
  readonly value: string;
  readonly fold: boolean;
  constructor(name: string, op: number, value: string, fold: boolean) {
    this.name = name;
    this.op = op;
    this.value = value;
    this.fold = fold;
  }

  matches(n: HtmlNode): boolean {
    const raw = attrRaw(n, this.name);
    const v = this.value;
    if (raw === '') {
      // missing or empty: only these can match an empty value
      if (this.op === opExists) return hasAttribute(n, this.name);
      if (this.op === opEquals || this.op === opDash) return v === '' && hasAttribute(n, this.name);
      return false;
    }
    if (this.op === opExists) return true;
    const actual = decoded(raw);
    switch (this.op) {
      case opEquals:
        return equal(actual, v, this.fold);
      case opIncludes:
        return !/[ \t\n\f\r]/.test(v) && containsWord(actual, v, this.fold);
      case opDash:
        return (
          equal(actual, v, this.fold) ||
          (actual.length > v.length && actual.charCodeAt(v.length) === 45 && equal(actual.slice(0, v.length), v, this.fold))
        );
      case opPrefix:
        return v !== '' && actual.length >= v.length && equal(actual.slice(0, v.length), v, this.fold);
      case opSuffix:
        return v !== '' && actual.length >= v.length && equal(actual.slice(actual.length - v.length), v, this.fold);
      case opSubstring:
        if (v === '') return false;
        if (!this.fold) return actual.includes(v);
        for (let i = 0; i + v.length <= actual.length; i++) if (equalFold(actual.slice(i, i + v.length), v)) return true;
        return false;
    }
    return false;
  }
}

/** :nth-child(An+B [of S]) and its relatives; :first-child is :nth-child(1), and so on. */
class CssNth implements CssSimple {
  readonly a: number;
  readonly b: number;
  readonly fromEnd: boolean;
  readonly ofType: boolean;
  readonly of: CssList | null;
  constructor(a: number, b: number, fromEnd: boolean, ofType: boolean, of: CssList | null) {
    this.a = a;
    this.b = b;
    this.fromEnd = fromEnd;
    this.ofType = ofType;
    this.of = of;
  }

  matches(n: HtmlNode, ctx: CssContext): boolean {
    const t = ctx.tree();
    let position: number;
    if (this.of !== null) {
      if (!this.of.matches(n, ctx)) return false;
      position = 1;
      for (let sib = this.fromEnd ? t.nextOf(n) : t.prev(n); sib !== null; sib = this.fromEnd ? t.nextOf(sib) : t.prev(sib)) {
        if (this.of.matches(sib, ctx)) position++;
      }
    } else if (this.ofType) {
      const tp = t.typePositions();
      position = this.fromEnd ? tp.fromEnd[n.index] : tp.position[n.index];
    } else {
      position = this.fromEnd ? t.fromEnd[n.index] : t.position[n.index];
    }
    if (position <= 0) return false; // not an element
    // position = a*n + b for some n >= 0
    if (this.a === 0) return position === this.b;
    const diff = position - this.b;
    return diff % this.a === 0 && Math.trunc(diff / this.a) >= 0;
  }
}

class CssNot implements CssSimple {
  readonly list: CssList;
  constructor(list: CssList) {
    this.list = list;
  }
  matches(n: HtmlNode, ctx: CssContext): boolean {
    return !this.list.matches(n, ctx);
  }
}

class CssIs implements CssSimple {
  readonly list: CssList;
  constructor(list: CssList) {
    this.list = list;
  }
  matches(n: HtmlNode, ctx: CssContext): boolean {
    return this.list.matches(n, ctx);
  }
}

class CssHas implements CssSimple {
  readonly list: CssList;
  constructor(list: CssList) {
    this.list = list;
  }
  matches(n: HtmlNode, ctx: CssContext): boolean {
    return hasMatch(this.list, n, ctx);
  }
}

class CssContains implements CssSimple {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  matches(n: HtmlNode): boolean {
    return n.text().includes(this.text);
  }
}

const pseudoRoot = 0;
const pseudoScope = 1;
const pseudoEmpty = 2;
const pseudoLink = 3;
const pseudoChecked = 4;
const pseudoDisabled = 5;
const pseudoEnabled = 6;
const pseudoRequired = 7;
const pseudoOptional = 8;

const isFormControl = (name: string) =>
  name === 'button' || name === 'input' || name === 'select' || name === 'textarea' ||
  name === 'optgroup' || name === 'option' || name === 'fieldset';
const isInput = (name: string) => name === 'input' || name === 'select' || name === 'textarea';

/** the first top-level element: <html> on a page */
const isRoot = (n: HtmlNode, ctx: CssContext) => n.parentIndex < 0 && ctx.tree().prev(n) === null;

/** No child elements and no text; comments are allowed. */
function isEmpty(n: HtmlNode): boolean {
  if (n.innerStart <= 0 || n.innerEnd <= 0) return true; // a void or unclosed tag has no content
  let position = n.innerStart;
  const nodes = n.document.nodes;
  for (let i = n.index + 1; i < nodes.length && nodes[i].end <= n.end; i++) {
    const child = nodes[i];
    if (isElement(child) || child.start > position) return false; // an element, or text before a comment
    position = Math.max(position, child.end + 1);
  }
  return position > n.innerEnd;
}

class CssPseudo implements CssSimple {
  readonly kind: number;
  constructor(kind: number) {
    this.kind = kind;
  }

  matches(n: HtmlNode, ctx: CssContext): boolean {
    const name = n.name;
    switch (this.kind) {
      case pseudoRoot:
        return isRoot(n, ctx);
      case pseudoScope:
        return ctx.scope !== null ? n === ctx.scope : isRoot(n, ctx);
      case pseudoEmpty:
        return isEmpty(n);
      case pseudoLink:
        return (name === 'a' || name === 'area') && hasAttribute(n, 'href');
      case pseudoChecked:
        return (name === 'input' && hasAttribute(n, 'checked')) || (name === 'option' && hasAttribute(n, 'selected'));
      case pseudoDisabled:
        return isFormControl(name) && hasAttribute(n, 'disabled');
      case pseudoEnabled:
        return isFormControl(name) && !hasAttribute(n, 'disabled');
      case pseudoRequired:
        return isInput(name) && hasAttribute(n, 'required');
      case pseudoOptional:
        return isInput(name) && !hasAttribute(n, 'required');
    }
    return false;
  }
}

// ----- compiler -----

const isNameStart = (c: number) => ((c | 0x20) >= 97 && (c | 0x20) <= 122) || c === 95 || c >= 0x80;
const isNthChar = (c: number) => c === 43 || c === 45 || c === 110 || c === 78 || (c >= 48 && c <= 57) || isCssSpace(c);

/**
 * Parses a selector list (Selectors Level 3 and the common Level 4 pseudo-classes).
 * Identifiers and strings follow the CSS syntax, escapes included (#a\:b, .\31 0, [title="a\"b"]).
 */
class CssCompiler {
  p = 0;
  readonly s: string;
  constructor(s: string) {
    this.s = s;
  }

  fail(msg: string): never {
    throw new CssSelectorError(`invalid CSS selector ${JSON.stringify(this.s)} at position ${this.p}: ${msg}`);
  }

  peek(offset: number): number {
    const i = this.p + offset;
    return i < this.s.length ? this.s.charCodeAt(i) : 0;
  }

  skipSpace(): boolean {
    const start = this.p;
    while (this.p < this.s.length && isCssSpace(this.s.charCodeAt(this.p))) this.p++;
    return this.p > start;
  }

  expect(ch: string): void {
    if (this.peek(0) !== ch.charCodeAt(0)) {
      if (this.p >= this.s.length) this.fail(`'${ch}' expected`);
      this.fail(`'${ch}' expected instead of '${this.s[this.p]}'`);
    }
    this.p++;
  }

  /** selector-list: complex (',' complex)* */
  parseList(relative: boolean, topLevel: boolean): CssList {
    const list = new CssList();
    for (;;) {
      list.items.push(this.parseComplex(relative, topLevel));
      this.skipSpace();
      if (this.peek(0) !== 44) return list; // ','
      this.p++;
    }
  }

  /** complex: [combinator] compound (combinator compound)* */
  parseComplex(relative: boolean, topLevel: boolean): CssComplex {
    this.skipSpace();
    const cx = new CssComplex();
    if (relative || topLevel) {
      const comb = this.readCombinator();
      if (comb !== combNone) {
        if (topLevel && comb !== combChild) this.fail("a selector can start only with '>' (the children of the tag it is called on)");
        cx.leading = comb;
      } else if (relative) {
        cx.leading = combDescendant;
      }
    }
    cx.compounds.push(this.parseCompound());
    for (;;) {
      const ws = this.skipSpace();
      const ch = this.peek(0);
      if (ch === 0 || ch === 44 || ch === 41) return cx; // end, ',' or ')'
      let comb = this.readCombinator();
      if (comb === combNone) {
        if (!ws) this.fail(`unexpected '${this.s[this.p]}'`);
        comb = combDescendant;
      }
      cx.combinators.push(comb);
      cx.compounds.push(this.parseCompound());
    }
  }

  readCombinator(): number {
    let comb: number;
    switch (this.peek(0)) {
      case 62:
        comb = combChild;
        break;
      case 43:
        comb = combAdjacent;
        break;
      case 126:
        comb = combSibling;
        break;
      default:
        return combNone;
    }
    this.p++;
    this.skipSpace();
    return comb;
  }

  /** compound: [type | '*'] (#id | .class | [attribute] | :pseudo)* */
  parseCompound(): CssCompound {
    const cp = new CssCompound();
    let hasType = false;
    if (this.peek(0) === 42) {
      this.p++;
      hasType = true;
    } else if (this.isIdentStart(this.p)) {
      const name = this.readName().toLowerCase();
      hasType = true;
      const t = lookupTag(name);
      if (t >= 0) cp.key = t;
      else cp.name = name;
    }
    if (this.peek(0) === 124) this.fail('namespaces are not supported; escape the colon of a prefixed name: dc\\:creator');

    for (;;) {
      const ch = this.peek(0);
      if (ch === 35) {
        // '#'
        this.p++;
        if (!this.isNameChar(this.p)) this.fail("an id expected after '#'");
        cp.simples.push(new CssId(this.readName()));
      } else if (ch === 46) {
        // '.'
        this.p++;
        if (!this.isIdentStart(this.p)) this.fail("a class name expected after '.'");
        cp.simples.push(new CssClass(this.readName()));
      } else if (ch === 91) {
        cp.simples.push(this.parseAttribute());
      } else if (ch === 58) {
        this.parsePseudo(cp);
      } else {
        break;
      }
    }

    if (!hasType && cp.simples.length === 0) {
      if (this.p >= this.s.length) this.fail('a selector expected');
      this.fail(`unexpected '${this.s[this.p]}'`);
    }
    return cp;
  }

  /** '[' name [op value [i|s]] ']' */
  parseAttribute(): CssSimple {
    this.p++; // '['
    this.skipSpace();
    if (!this.isIdentStart(this.p)) this.fail('an attribute name expected');
    const name = this.readName();
    this.skipSpace();
    if (this.peek(0) === 93) {
      this.p++;
      return new CssAttribute(name, opExists, '', false);
    }

    let op: number;
    const ch = this.peek(0);
    if (ch === 61) {
      op = opEquals;
      this.p++;
    } else if (ch === 126 || ch === 124 || ch === 94 || ch === 36 || ch === 42) {
      op = ch === 126 ? opIncludes : ch === 124 ? opDash : ch === 94 ? opPrefix : ch === 36 ? opSuffix : opSubstring;
      if (this.peek(1) !== 61) this.fail(`'=' expected after '${String.fromCharCode(ch)}'`);
      this.p += 2;
    } else {
      this.fail("'=', '~=', '|=', '^=', '$=', '*=' or ']' expected");
    }

    this.skipSpace();
    let value: string;
    if (this.peek(0) === 34 || this.peek(0) === 39) value = this.readString();
    else if (this.isIdentStart(this.p)) value = this.readName();
    else this.fail('an attribute value expected (quote it if it is not a plain word)');

    this.skipSpace();
    let fold = caseInsensitiveValues.has(name.toLowerCase());
    if (this.isIdentStart(this.p)) {
      const flag = this.readName();
      if (equalFold(flag, 'i')) fold = true;
      else if (equalFold(flag, 's')) fold = false;
      else this.fail(`unknown attribute flag '${flag}'`);
      this.skipSpace();
    }
    this.expect(']');
    return new CssAttribute(name, op, value, fold);
  }

  parsePseudo(cp: CssCompound): void {
    this.p++; // ':'
    if (this.peek(0) === 58) this.fail('pseudo-elements (::before, ::text) select no tags');
    if (!this.isIdentStart(this.p)) this.fail("a pseudo-class name expected after ':'");
    const start = this.p;
    const name = this.readName().toLowerCase();
    const add = (...s: CssSimple[]) => cp.simples.push(...s);

    if (this.peek(0) === 40) {
      this.p++;
      this.skipSpace();
      switch (name) {
        case 'not':
          add(new CssNot(this.parseList(false, false)));
          break;
        case 'is':
        case 'where':
        case 'matches':
        case 'any':
          add(new CssIs(this.parseList(false, false)));
          break;
        case 'has':
          add(new CssHas(this.parseList(true, false)));
          break;
        case 'nth-child':
        case 'nth-last-child':
        case 'nth-of-type':
        case 'nth-last-of-type': {
          const [a, b] = this.parseNth();
          const ofType = name.endsWith('of-type');
          let of: CssList | null = null;
          this.skipSpace();
          if (!ofType && this.isWord('of')) {
            this.p += 2;
            of = this.parseList(false, false);
          }
          add(new CssNth(a, b, name.includes('last'), ofType, of));
          break;
        }
        case 'contains': {
          let text: string;
          if (this.peek(0) === 34 || this.peek(0) === 39) text = this.readString();
          else if (this.isIdentStart(this.p)) text = this.readName();
          else this.fail('a string expected in :contains()');
          add(new CssContains(text));
          break;
        }
        default:
          this.p = start;
          this.fail(`unknown pseudo-class ':${name}()'`);
      }
      this.skipSpace();
      this.expect(')');
      return;
    }

    switch (name) {
      case 'first-child':
        return void add(new CssNth(0, 1, false, false, null));
      case 'last-child':
        return void add(new CssNth(0, 1, true, false, null));
      case 'only-child':
        return void add(new CssNth(0, 1, false, false, null), new CssNth(0, 1, true, false, null));
      case 'first-of-type':
        return void add(new CssNth(0, 1, false, true, null));
      case 'last-of-type':
        return void add(new CssNth(0, 1, true, true, null));
      case 'only-of-type':
        return void add(new CssNth(0, 1, false, true, null), new CssNth(0, 1, true, true, null));
      case 'root':
        return void add(new CssPseudo(pseudoRoot));
      case 'scope':
        return void add(new CssPseudo(pseudoScope));
      case 'empty':
        return void add(new CssPseudo(pseudoEmpty));
      case 'link':
      case 'any-link':
        return void add(new CssPseudo(pseudoLink));
      case 'checked':
        return void add(new CssPseudo(pseudoChecked));
      case 'disabled':
        return void add(new CssPseudo(pseudoDisabled));
      case 'enabled':
        return void add(new CssPseudo(pseudoEnabled));
      case 'required':
        return void add(new CssPseudo(pseudoRequired));
      case 'optional':
        return void add(new CssPseudo(pseudoOptional));
    }
    this.p = start;
    this.fail(`unknown pseudo-class ':${name}'`);
  }

  /** An+B: odd, even, 3, n, -n+3, 2n+1, +2n - 1 */
  parseNth(): [number, number] {
    if (this.isWord('odd')) {
      this.p += 3;
      return [2, 1];
    }
    if (this.isWord('even')) {
      this.p += 4;
      return [2, 0];
    }
    const start = this.p;
    let t = '';
    while (this.p < this.s.length) {
      const ch = this.s.charCodeAt(this.p);
      if (!isNthChar(ch)) break;
      if (!isCssSpace(ch)) t += ch === 78 ? 'n' : this.s[this.p];
      this.p++;
    }
    const n = t.indexOf('n');
    if (n < 0) {
      const v = parseInt32(t);
      if (v !== null) return [0, v];
    } else if (t.indexOf('n', n + 1) < 0) {
      const aText = t.slice(0, n);
      const bText = t.slice(n + 1);
      const a = aText === '' || aText === '+' ? 1 : aText === '-' ? -1 : parseInt32(aText);
      let b: number | null = 0;
      if (bText !== '') {
        const ok = (bText[0] === '+' || bText[0] === '-') && bText.length > 1 && bText.charCodeAt(1) >= 48 && bText.charCodeAt(1) <= 57;
        b = ok ? parseInt32(bText) : null;
      }
      if (a !== null && b !== null) return [a, b];
    }
    this.p = start;
    this.fail('An+B expected (odd, even, 3, 2n+1, -n+3)');
  }

  /** The identifier at the position is word (case-insensitive) and ends there. */
  isWord(word: string): boolean {
    return (
      this.p + word.length <= this.s.length &&
      equalFold(this.s.slice(this.p, this.p + word.length), word) &&
      !this.isNameChar(this.p + word.length)
    );
  }

  isEscape(p: number): boolean {
    if (p >= this.s.length || this.s.charCodeAt(p) !== 92) return false;
    if (p + 1 >= this.s.length) return true;
    const c = this.s.charCodeAt(p + 1);
    return c !== 10 && c !== 13 && c !== 12;
  }

  isNameChar(p: number): boolean {
    if (p >= this.s.length) return false;
    const c = this.s.charCodeAt(p);
    return isNameStart(c) || (c >= 48 && c <= 57) || c === 45 || this.isEscape(p);
  }

  isIdentStart(p: number): boolean {
    if (p >= this.s.length) return false;
    if (this.s.charCodeAt(p) === 45) {
      p++;
      if (p >= this.s.length) return false;
      const c = this.s.charCodeAt(p);
      return isNameStart(c) || c === 45 || this.isEscape(p);
    }
    return isNameStart(this.s.charCodeAt(p)) || this.isEscape(p);
  }

  readName(): string {
    let b = '';
    while (this.isNameChar(this.p)) {
      if (this.s.charCodeAt(this.p) === 92) b += this.readEscape();
      else b += this.s[this.p++];
    }
    return b;
  }

  readString(): string {
    const quote = this.s.charCodeAt(this.p);
    const start = this.p;
    this.p++;
    let b = '';
    for (;;) {
      if (this.p >= this.s.length) {
        this.p = start;
        this.fail('unterminated string');
      }
      const ch = this.s.charCodeAt(this.p);
      if (ch === quote) {
        this.p++;
        return b;
      }
      if (ch === 92) {
        const next = this.peek(1);
        if (this.p + 1 < this.s.length && (next === 10 || next === 12)) {
          this.p += 2; // an escaped line break continues the string
        } else if (this.p + 2 < this.s.length && next === 13) {
          this.p += this.peek(2) === 10 ? 3 : 2;
        } else {
          b += this.readEscape();
        }
      } else {
        b += this.s[this.p++];
      }
    }
  }

  /** '\' then up to 6 hex digits and one optional whitespace, or any other char as itself. */
  readEscape(): string {
    this.p++; // '\'
    if (this.p >= this.s.length) return '�';
    if (!isHexChar(this.s.charCodeAt(this.p))) {
      const cp = this.s.codePointAt(this.p)!;
      const ch = String.fromCodePoint(cp);
      this.p += ch.length;
      return ch;
    }
    let code = 0;
    let digits = 0;
    while (digits < 6 && this.p < this.s.length && isHexChar(this.s.charCodeAt(this.p))) {
      code = code * 16 + parseInt(this.s[this.p], 16);
      this.p++;
      digits++;
    }
    if (this.p < this.s.length && isCssSpace(this.s.charCodeAt(this.p))) {
      this.p += this.s.charCodeAt(this.p) === 13 && this.peek(1) === 10 ? 2 : 1;
    }
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return String.fromCodePoint(code);
  }
}

function parseInt32(s: string): number | null {
  if (!/^[+-]?\d+$/.test(s)) return null;
  const v = Number(s);
  return v >= -2147483648 && v <= 2147483647 ? v : null;
}

