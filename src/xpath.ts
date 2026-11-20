// XPath 1.0 over the flat tag list: the root, elements, comments, text nodes (runs of source text between tags)
// and attributes (positions in the opening tag).

import { equalFold, isUnicodeSpace, trimSpace } from './chars.ts';
import { AttrScanner, attrEquals } from './attr.ts';
import { decode, needsDecoding, normalizeNewlines } from './decode.ts';
import { Tag } from './names.ts';
import { rawTextEnds } from './parse.ts';
import { clearTags } from './text.ts';
import { byName, type HtmlDocument, type HtmlNode, type Query } from './document.ts';
import { isElement } from './css.ts';

/** Thrown by `XPathQuery.compile` (and the string methods) for an invalid expression. */
export class XPathError extends SyntaxError {
  override name = 'XPathError';
}

/**
 * A compiled XPath 1.0 expression. Compile once and reuse it on any number of documents; the string methods
 * (`node.xpath(...)`, `doc.xpathValue(...)`, ...) compile and cache expressions automatically.
 *
 * All axes (except namespace), predicates, `|`, the operators and the XPath 1.0 functions are supported, plus
 * `ends-with()`, `lower-case()` and `upper-case()`. HTML rules apply: names are case-insensitive, the string-value
 * of an element is its visible text (as `node.text()`), attribute values and text are decoded. Variables are not
 * supported. On a node, relative paths start at the node; '/' and '//' search the whole document.
 */
export class XPathQuery {
  /** The source of the expression. */
  readonly expression: string;
  /** @internal */
  readonly expr: XExpr;

  private constructor(expression: string, expr: XExpr) {
    this.expression = expression;
    this.expr = expr;
  }

  /** Compiles an XPath 1.0 expression; throws `XPathError` on an invalid one. */
  static compile(expression: string): XPathQuery {
    const c = new XPathCompiler(expression);
    const expr = c.parseExpr();
    if (c.peek(0).kind !== T.End) c.fail('unexpected ' + c.describe(c.peek(0)));
    return new XPathQuery(expression, expr);
  }

  toString(): string {
    return this.expression;
  }

  /**
   * The selected tags (elements and comments) in document order, evaluated on the document.
   * Throws a TypeError when the expression does not give a node-set (use `value`).
   */
  nodes(d: HtmlDocument): HtmlNode[] {
    return this.tagsOf(rootNode(d));
  }

  /** `nodes` evaluated on a tag: relative paths start at it. */
  nodesFrom(n: HtmlNode): HtmlNode[] {
    return this.tagsOf(tagNode(n));
  }

  /**
   * The string-values of the selected nodes, or the result of an expression that gives a number, string or
   * boolean (count(//a), concat(...)) as one value.
   */
  values(d: HtmlDocument): string[] {
    return this.valuesOf(rootNode(d));
  }

  /** `values` evaluated on a tag. */
  valuesFrom(n: HtmlNode): string[] {
    return this.valuesOf(tagNode(n));
  }

  /** The string-value of the first selected node, or the result of the expression; null when it selects no node. */
  value(d: HtmlDocument): string | null {
    return this.valueOf(rootNode(d));
  }

  /** `value` evaluated on a tag. */
  valueFrom(n: HtmlNode): string | null {
    return this.valueOf(tagNode(n));
  }

  private evaluate(context: XNode): XValue {
    return this.expr.eval(new Ctx(context, 1, 1, new EvalState(context.doc)));
  }

  private tagsOf(context: XNode): HtmlNode[] {
    if (this.expr.type !== XType.NodeSet) {
      throw new TypeError(`the XPath ${JSON.stringify(this.expression)} gives a ${typeNames[this.expr.type]}, not tags; use xpathValue`);
    }
    const set = this.evaluate(context) as XNode[];
    const tags: HtmlNode[] = [];
    for (const n of set) if (n.kind === K.Element || n.kind === K.Comment) tags.push(n.tag!);
    return tags;
  }

  private valuesOf(context: XNode): string[] {
    const result = this.evaluate(context);
    if (!Array.isArray(result)) return [toString(result)];
    return result.map(stringValue);
  }

  private valueOf(context: XNode): string | null {
    const result = this.evaluate(context);
    if (Array.isArray(result)) return result.length === 0 ? null : stringValue(result[0]);
    return toString(result);
  }
}

const cache = new Map<string, XPathQuery>();

/** @internal */
export function cachedXPath(expression: string): XPathQuery {
  let q = cache.get(expression);
  if (q === undefined) {
    q = XPathQuery.compile(expression);
    if (cache.size >= 1024) cache.clear(); // dynamically built expressions must not grow the cache forever
    cache.set(expression, q);
  }
  return q;
}

// ----- the data model over the flat tag list -----

const K = { Root: 0, Element: 1, Comment: 2, Text: 3, Attribute: 4 } as const;

/** A node of the XPath data model. */
class XNode {
  readonly kind: number;
  readonly doc: HtmlDocument;
  /** element / comment: the tag; text / attribute: the parent element (null: the root) */
  readonly tag: HtmlNode | null;
  /** text: first char and length; attribute: name start and length */
  readonly start: number;
  readonly length: number;
  /** attribute: value start (-1 for no value) and length */
  readonly valueStart: number;
  readonly valueLength: number;
  constructor(kind: number, doc: HtmlDocument, tag: HtmlNode | null, start: number = 0, length: number = 0, valueStart: number = 0, valueLength: number = 0) {
    this.kind = kind;
    this.doc = doc;
    this.tag = tag;
    this.start = start;
    this.length = length;
    this.valueStart = valueStart;
    this.valueLength = valueLength;
  }

  /** Document order and identity: tags and text nodes by their first char; attributes right after their element. */
  get major(): number {
    switch (this.kind) {
      case K.Root:
        return -1;
      case K.Text:
        return this.start;
    }
    return this.tag!.start;
  }

  get minor(): number {
    return this.kind === K.Attribute ? this.start : 0;
  }

  /** The source positions the node covers (for following / preceding). */
  rangeStart(): number {
    switch (this.kind) {
      case K.Root:
        return -1;
      case K.Text:
        return this.start;
    }
    return this.tag!.start;
  }

  rangeEnd(): number {
    switch (this.kind) {
      case K.Root:
        return Number.MAX_SAFE_INTEGER;
      case K.Element:
      case K.Comment:
        return this.tag!.end;
      case K.Text:
        return this.start + this.length - 1;
    }
    return this.tag!.start; // attribute: the children of its element follow it
  }

  attrName(): string {
    return this.doc.source.slice(this.start, this.start + this.length);
  }
}

function compareKeys(a: XNode, b: XNode): number {
  return a.major - b.major || a.minor - b.minor;
}

function rootNode(d: HtmlDocument): XNode {
  return new XNode(K.Root, d, null);
}

function tagNode(n: HtmlNode): XNode {
  return new XNode(n.key === Tag.Comment ? K.Comment : K.Element, n.document, n);
}

// ----- node tests -----

const TK = {
  Name: 0,
  Prefix: 1, // dc:*
  Wildcard: 2, // *
  Node: 3, // node()
  Text: 4, // text()
  Comment: 5, // comment()
  PI: 6, // processing-instruction(): never matches
  Container: 7, // internal: the root and elements (// before a child or attribute step)
} as const;

class NodeTest {
  readonly query: Query | null;
  readonly kind: number;
  readonly name: string;
  constructor(kind: number, name: string = '') {
    this.kind = kind;
    this.name = name;
    this.query = kind === TK.Name ? byName(name) : null;
  }

  matchesText(): boolean {
    return this.kind === TK.Node || this.kind === TK.Text;
  }

  matchesTags(): boolean {
    return this.kind !== TK.Text && this.kind !== TK.PI;
  }

  matchesTag(n: HtmlNode): boolean {
    switch (this.kind) {
      case TK.Name:
        return this.query!.matches(n);
      case TK.Prefix: {
        const name = n.name;
        return isElement(n) && name.length >= this.name.length && equalFold(name.slice(0, this.name.length), this.name);
      }
      case TK.Wildcard:
      case TK.Container:
        return isElement(n);
      case TK.Node:
        return isElement(n) || n.key === Tag.Comment;
      case TK.Comment:
        return n.key === Tag.Comment;
    }
    return false;
  }

  matchesAttribute(name: string): boolean {
    switch (this.kind) {
      case TK.Name:
        return equalFold(name, this.name);
      case TK.Prefix:
        return name.length >= this.name.length && equalFold(name.slice(0, this.name.length), this.name);
      case TK.Wildcard:
      case TK.Node:
        return true;
    }
    return false;
  }

  matches(x: XNode, attributeAxis: boolean): boolean {
    switch (x.kind) {
      case K.Root:
        return this.kind === TK.Node || this.kind === TK.Container;
      case K.Element:
      case K.Comment:
        return this.matchesTag(x.tag!);
      case K.Text:
        return this.matchesText();
    }
    if (attributeAxis) return this.matchesAttribute(x.attrName());
    return this.kind === TK.Node;
  }
}

const anyNodeTest = new NodeTest(TK.Node);
const containersTest = new NodeTest(TK.Container);

// ----- navigation -----

/** Appends the children of the root or an element that match the test, text nodes included, in document order. */
function addChildren(x: XNode, test: NodeTest, out: XNode[]): XNode[] {
  const wantText = test.matchesText();
  const wantTags = test.matchesTags();
  if (!wantText && !wantTags) return out;
  let first: number, end: number, childDepth: number, p: number, textEnd: number;
  if (x.kind === K.Root) {
    first = 0;
    end = Number.MAX_SAFE_INTEGER;
    childDepth = 0;
    p = 0;
    textEnd = x.doc.source.length;
  } else if (x.kind === K.Element && x.tag!.innerStart > 0 && x.tag!.innerEnd > 0) {
    const t = x.tag!;
    first = t.index + 1;
    end = t.end;
    childDepth = t.depth + 1;
    p = t.innerStart;
    textEnd = t.innerEnd + 1;
  } else {
    return out;
  }
  const nodes = x.doc.nodes;
  const parent = x.kind === K.Element ? x.tag : null;
  for (let i = first; i < nodes.length; i++) {
    const t = nodes[i];
    if (t.end > end) break;
    if (t.depth !== childDepth) continue;
    if (wantText && t.start > p) addText(x.doc, parent, p, Math.min(t.start, textEnd), out);
    if (wantTags && test.matchesTag(t)) out.push(tagNode(t));
    p = t.end + 1;
  }
  if (wantText && textEnd > p) addText(x.doc, parent, p, textEnd, out);
  return out;
}

function addText(d: HtmlDocument, parent: HtmlNode | null, start: number, end: number, out: XNode[]): void {
  if (end > start) out.push(new XNode(K.Text, d, parent, start, end - start));
}

/** Appends the descendants of the root or an element that match the test, in document order. */
function addDescendants(x: XNode, test: NodeTest, out: XNode[]): XNode[] {
  if (test.matchesText()) return addDescendantsWithText(x, test, out);
  if (!test.matchesTags()) return out;
  let first: number, end: number;
  if (x.kind === K.Root) {
    first = 0;
    end = Number.MAX_SAFE_INTEGER;
  } else if (x.kind === K.Element && x.tag!.innerStart > 0 && x.tag!.innerEnd > 0) {
    first = x.tag!.index + 1;
    end = x.tag!.end;
  } else {
    return out;
  }
  // tags only: one linear scan of the flat list
  const nodes = x.doc.nodes;
  for (let i = first; i < nodes.length; i++) {
    const t = nodes[i];
    if (t.end > end) break;
    if (test.matchesTag(t)) out.push(tagNode(t));
  }
  return out;
}

function addDescendantsWithText(x: XNode, test: NodeTest, out: XNode[]): XNode[] {
  for (const child of addChildren(x, anyNodeTest, [])) {
    if (test.matches(child, false)) out.push(child);
    if (child.kind === K.Element) addDescendantsWithText(child, test, out);
  }
  return out;
}

function parentNode(x: XNode): XNode | null {
  switch (x.kind) {
    case K.Root:
      return null;
    case K.Text:
    case K.Attribute:
      return x.tag !== null ? tagNode(x.tag) : rootNode(x.doc);
  }
  const t = x.tag!;
  return t.depth > 0 && t.parentIndex >= 0 ? tagNode(x.doc.nodes[t.parentIndex]) : rootNode(x.doc);
}

function addAttributes(x: XNode, test: NodeTest, out: XNode[]): XNode[] {
  if (x.kind !== K.Element) return out;
  const s = new AttrScanner(x.tag!);
  while (s.next()) {
    if (test.matchesAttribute(s.name)) {
      out.push(new XNode(K.Attribute, x.doc, x.tag, s.nameStart, s.nameLength, s.valueStart, s.valueLength));
    }
  }
  return out;
}

/** The raw value of the first attribute with the name; null when the element has none. */
function attributeOf(x: XNode, name: string): string | null {
  if (x.kind !== K.Element) return null;
  const s = new AttrScanner(x.tag!);
  while (s.next()) if (equalFold(s.name, name)) return s.rawValue;
  return null;
}

/** The root and elements give their visible text; text nodes and attributes their decoded value; comments their content. */
function stringValue(x: XNode): string {
  switch (x.kind) {
    case K.Root:
      return clearTags(x.doc.source);
    case K.Element:
      return x.tag!.text();
    case K.Attribute:
      return x.valueStart < 0 ? '' : decode(x.doc.source.slice(x.valueStart, x.valueStart + x.valueLength), true);
    case K.Text: {
      const text = x.doc.source.slice(x.start, x.start + x.length);
      if (x.tag !== null && x.tag.key >= 0 && rawTextEnds[x.tag.key] !== '') return normalizeNewlines(text);
      return decode(text, false);
    }
  }
  // comment
  const t = x.tag!;
  let source = t.document.source.slice(t.start, t.end + 1);
  if (source.startsWith('<!--')) source = source.slice(4);
  if (source.endsWith('-->')) source = source.slice(0, -3);
  return source;
}

/** name() / local-name(): the lower-case tag or attribute name; "" for other nodes. */
function nodeName(x: XNode): string {
  if (x.kind === K.Element) return x.tag!.name;
  if (x.kind === K.Attribute) return x.attrName().toLowerCase();
  return '';
}

// ----- values -----

const XType = { NodeSet: 0, Number: 1, String: 2, Boolean: 3 } as const;
const typeNames = ['node-set', 'number', 'string', 'boolean'];

type XValue = XNode[] | number | string | boolean;

function toBoolean(v: XValue): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v !== '';
  return v.length > 0;
}

function toNumber(v: XValue): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') return stringToNumber(v);
  return v.length === 0 ? NaN : stringToNumber(stringValue(v[0]));
}

/** Optional '-', digits with an optional decimal point; anything else is NaN. */
function stringToNumber(value: string): number {
  const s = trimSpace(value);
  const body = s.startsWith('-') ? s.slice(1) : s;
  let digits = 0;
  let point = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (c >= 48 && c <= 57) digits++;
    else if (c === 46) point++;
    else return NaN;
  }
  if (digits === 0 || point > 1) return NaN;
  return Number(s);
}

function toString(v: XValue): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return numberToString(v);
  return v.length === 0 ? '' : stringValue(v[0]);
}

/** The shortest round-trip digits, written without an exponent (XPath has none). */
export function numberToString(d: number): string {
  if (Number.isNaN(d)) return 'NaN';
  if (d === Infinity) return 'Infinity';
  if (d === -Infinity) return '-Infinity';
  if (d === 0) return '0';
  const s = String(d);
  const e = s.indexOf('e');
  if (e < 0) return s;
  // expand d.ddde±x
  const negative = s.startsWith('-');
  const mantissa = s.slice(negative ? 1 : 0, e);
  const exponent = Number(s.slice(e + 1));
  const dot = mantissa.indexOf('.');
  const digits = mantissa.replace('.', '');
  const pointAt = (dot < 0 ? mantissa.length : dot) + exponent; // position of the decimal point in digits
  let out: string;
  if (pointAt <= 0) out = '0.' + '0'.repeat(-pointAt) + digits;
  else if (pointAt >= digits.length) out = digits + '0'.repeat(pointAt - digits.length);
  else out = digits.slice(0, pointAt) + '.' + digits.slice(pointAt);
  return negative ? '-' + out : out;
}

/** Puts the nodes in document order without duplicates. */
function sortUnique(nodes: XNode[]): XNode[] {
  if (nodes.length < 2) return nodes;
  let sorted = true;
  for (let i = 1; i < nodes.length; i++) {
    if (compareKeys(nodes[i - 1], nodes[i]) >= 0) {
      sorted = false;
      break;
    }
  }
  if (sorted) return nodes;
  nodes.sort(compareKeys); // stable
  let w = 1;
  for (let i = 1; i < nodes.length; i++) {
    if (compareKeys(nodes[i], nodes[w - 1]) !== 0) nodes[w++] = nodes[i];
  }
  nodes.length = w;
  return nodes;
}

// ----- evaluation -----

class EvalState {
  private all: XNode[] | null = null; // every element, comment and text node in document order
  readonly doc: HtmlDocument;
  constructor(doc: HtmlDocument) {
    this.doc = doc;
  }

  allNodes(): XNode[] {
    return (this.all ??= addDescendants(rootNode(this.doc), anyNodeTest, []));
  }
}

class Ctx {
  readonly node: XNode;
  readonly position: number;
  readonly size: number;
  readonly state: EvalState;
  constructor(node: XNode, position: number, size: number, state: EvalState) {
    this.node = node;
    this.position = position;
    this.size = size;
    this.state = state;
  }
}

interface XExpr {
  readonly type: number;
  /** whether position() or last() is used in the current context (not inside nested predicates) */
  usesPosition(): boolean;
  eval(c: Ctx): XValue;
  evalBool(c: Ctx): boolean;
}

function evalNodes(e: XExpr, c: Ctx): XNode[] {
  const v = e.eval(c);
  if (Array.isArray(v)) return v;
  throw new TypeError('the XPath expression does not give a node-set');
}

const evalString = (e: XExpr, c: Ctx) => toString(e.eval(c));
const evalNumber = (e: XExpr, c: Ctx) => toNumber(e.eval(c));

/** A number compares with the position, anything else is converted to boolean. */
function evalPredicate(e: XExpr, c: Ctx): boolean {
  if (e.type === XType.Boolean) return e.evalBool(c);
  const v = e.eval(c);
  if (typeof v === 'number') return v === c.position;
  return toBoolean(v);
}

/** Whether the predicate depends on the position of the node (a number, position(), last()). */
const isPositional = (e: XExpr) => e.type === XType.Number || e.usesPosition();

class LiteralExpr implements XExpr {
  readonly type = XType.String;
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  usesPosition() {
    return false;
  }
  eval() {
    return this.value;
  }
  evalBool() {
    return this.value !== '';
  }
}

class NumberExpr implements XExpr {
  readonly type = XType.Number;
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
  usesPosition() {
    return false;
  }
  eval() {
    return this.value;
  }
  evalBool() {
    return toBoolean(this.value);
  }
}

class LogicExpr implements XExpr {
  readonly type = XType.Boolean;
  readonly and: boolean;
  readonly left: XExpr;
  readonly right: XExpr;
  constructor(and: boolean, left: XExpr, right: XExpr) {
    this.and = and;
    this.left = left;
    this.right = right;
  }
  usesPosition() {
    return this.left.usesPosition() || this.right.usesPosition();
  }
  eval(c: Ctx) {
    return this.evalBool(c);
  }
  evalBool(c: Ctx): boolean {
    return this.and ? this.left.evalBool(c) && this.right.evalBool(c) : this.left.evalBool(c) || this.right.evalBool(c);
  }
}

const Op = { Eq: 0, Neq: 1, Lt: 2, Le: 3, Gt: 4, Ge: 5 } as const;

class CompareExpr implements XExpr {
  readonly type = XType.Boolean;
  readonly op: number;
  readonly left: XExpr;
  readonly right: XExpr;
  constructor(op: number, left: XExpr, right: XExpr) {
    this.op = op;
    this.left = left;
    this.right = right;
  }
  usesPosition() {
    return this.left.usesPosition() || this.right.usesPosition();
  }
  eval(c: Ctx) {
    return this.evalBool(c);
  }
  evalBool(c: Ctx): boolean {
    return compare(this.op, this.left.eval(c), this.right.eval(c));
  }
}

function compare(op: number, a: XValue, b: XValue): boolean {
  if (Array.isArray(a)) {
    if (Array.isArray(b)) {
      if (a.length === 0 || b.length === 0) return false;
      const valuesB = b.map(stringValue);
      for (const x of a) {
        const value = stringValue(x);
        for (const other of valuesB) if (compareAtoms(op, value, other)) return true;
      }
      return false;
    }
    return compareWithNodes(op, a, b, true);
  }
  if (Array.isArray(b)) return compareWithNodes(op, b, a, false);
  return compareAtoms(op, a, b);
}

function compareWithNodes(op: number, nodes: XNode[], other: XValue, nodesOnLeft: boolean): boolean {
  if (typeof other === 'boolean') {
    const asBool = nodes.length > 0;
    return nodesOnLeft ? compareAtoms(op, asBool, other) : compareAtoms(op, other, asBool);
  }
  const isNumber = typeof other === 'number';
  for (const n of nodes) {
    const s = stringValue(n);
    const value: XValue = isNumber ? stringToNumber(s) : s;
    if (nodesOnLeft ? compareAtoms(op, value, other) : compareAtoms(op, other, value)) return true;
  }
  return false;
}

function compareAtoms(op: number, a: XValue, b: XValue): boolean {
  if (op === Op.Eq || op === Op.Neq) {
    let eq: boolean;
    if (typeof a === 'boolean' || typeof b === 'boolean') eq = toBoolean(a) === toBoolean(b);
    else if (typeof a === 'number' || typeof b === 'number') eq = toNumber(a) === toNumber(b);
    else eq = toString(a) === toString(b);
    return eq === (op === Op.Eq);
  }
  const x = toNumber(a);
  const y = toNumber(b);
  switch (op) {
    case Op.Lt:
      return x < y;
    case Op.Le:
      return x <= y;
    case Op.Gt:
      return x > y;
  }
  return x >= y;
}

const Arith = { Add: 0, Sub: 1, Mul: 2, Div: 3, Mod: 4 } as const;

class ArithExpr implements XExpr {
  readonly type = XType.Number;
  readonly op: number;
  readonly left: XExpr;
  readonly right: XExpr;
  constructor(op: number, left: XExpr, right: XExpr) {
    this.op = op;
    this.left = left;
    this.right = right;
  }
  usesPosition() {
    return this.left.usesPosition() || this.right.usesPosition();
  }
  evalBool(c: Ctx) {
    return toBoolean(this.eval(c));
  }
  eval(c: Ctx): number {
    const x = evalNumber(this.left, c);
    const y = evalNumber(this.right, c);
    switch (this.op) {
      case Arith.Add:
        return x + y;
      case Arith.Sub:
        return x - y;
      case Arith.Mul:
        return x * y;
      case Arith.Div:
        return x / y;
    }
    return x % y;
  }
}

class NegateExpr implements XExpr {
  readonly type = XType.Number;
  readonly operand: XExpr;
  constructor(operand: XExpr) {
    this.operand = operand;
  }
  usesPosition() {
    return this.operand.usesPosition();
  }
  eval(c: Ctx) {
    return -evalNumber(this.operand, c);
  }
  evalBool(c: Ctx) {
    return toBoolean(this.eval(c));
  }
}

class UnionExpr implements XExpr {
  readonly type = XType.NodeSet;
  readonly left: XExpr;
  readonly right: XExpr;
  constructor(left: XExpr, right: XExpr) {
    this.left = left;
    this.right = right;
  }
  usesPosition() {
    return this.left.usesPosition() || this.right.usesPosition();
  }
  evalBool(c: Ctx) {
    return toBoolean(this.eval(c));
  }
  eval(c: Ctx): XNode[] {
    return sortUnique([...evalNodes(this.left, c), ...evalNodes(this.right, c)]);
  }
}

/** @name = 'literal', compared in place without building a node-set. */
class AttributeEqualsExpr implements XExpr {
  readonly type = XType.Boolean;
  readonly name: string;
  readonly value: string;
  readonly negate: boolean;
  constructor(name: string, value: string, negate: boolean) {
    this.name = name;
    this.value = value;
    this.negate = negate;
  }
  usesPosition() {
    return false;
  }
  eval(c: Ctx) {
    return this.evalBool(c);
  }
  evalBool(c: Ctx): boolean {
    // '!=' is true when the attribute exists and differs (a missing attribute is an empty node-set)
    const raw = attributeOf(c.node, this.name);
    return raw !== null && attrEquals(raw, this.value) !== this.negate;
  }
}

/**
 * contains/starts-with/ends-with(concat('prefix', @name, 'suffix'), 'needle') (prefix and suffix may be empty):
 * tested on the attribute value in place, without a node-set and a concatenated string for every element.
 */
class AttributeTestExpr implements XExpr {
  readonly type = XType.Boolean;
  readonly fn: string;
  readonly prefix: string;
  readonly name: string;
  readonly suffix: string;
  readonly needle: string;
  constructor(fn: string, prefix: string, name: string, suffix: string, needle: string) {
    this.fn = fn;
    this.prefix = prefix;
    this.name = name;
    this.suffix = suffix;
    this.needle = needle;
  }
  usesPosition() {
    return false;
  }
  eval(c: Ctx) {
    return this.evalBool(c);
  }
  evalBool(c: Ctx): boolean {
    const raw = attributeOf(c.node, this.name);
    // a missing attribute is an empty node-set, whose string-value is ""
    const value = raw === null ? '' : needsDecoding(raw) ? decode(raw, true) : raw;
    const { prefix, suffix, needle } = this;
    const length = prefix.length + value.length + suffix.length;
    const n = needle.length;
    if (n > length) return false;
    if (this.fn === 'starts-with') return this.matchesAt(value, 0);
    if (this.fn === 'ends-with') return this.matchesAt(value, length - n);
    // inside the value (a native search), or overlapping the prefix or the suffix: a few positions
    if (n <= value.length && value.includes(needle)) return true;
    const p = prefix.length;
    for (let at = 0; at < p && at <= length - n; at++) if (this.matchesAt(value, at)) return true;
    for (let at = Math.max(p, p + value.length - n + 1); at <= length - n; at++) if (this.matchesAt(value, at)) return true;
    return false;
  }
  /** Whether the needle is at `at` in prefix + value + suffix. */
  private matchesAt(value: string, at: number): boolean {
    const { prefix, suffix, needle } = this;
    for (let k = 0; k < needle.length; k++) {
      let i = at + k;
      let ch: number;
      if (i < prefix.length) ch = prefix.charCodeAt(i);
      else if ((i -= prefix.length) < value.length) ch = value.charCodeAt(i);
      else ch = suffix.charCodeAt(i - value.length);
      if (ch !== needle.charCodeAt(k)) return false;
    }
    return true;
  }
}

/** [@name] */
class AttributeExistsExpr implements XExpr {
  readonly type = XType.Boolean;
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  usesPosition() {
    return false;
  }
  eval(c: Ctx) {
    return this.evalBool(c);
  }
  evalBool(c: Ctx): boolean {
    return attributeOf(c.node, this.name) !== null;
  }
}

const Axis = {
  Child: 0,
  Descendant: 1,
  DescendantOrSelf: 2,
  Self: 3,
  Parent: 4,
  Ancestor: 5,
  AncestorOrSelf: 6,
  FollowingSibling: 7,
  PrecedingSibling: 8,
  Following: 9,
  Preceding: 10,
  Attribute: 11,
} as const;

class Step {
  readonly axis: number;
  readonly test: NodeTest;
  readonly predicates: XExpr[];
  constructor(axis: number, test: NodeTest, predicates: XExpr[] = []) {
    this.axis = axis;
    this.test = test;
    this.predicates = predicates;
  }

  isReverse(): boolean {
    const a = this.axis;
    return a === Axis.Ancestor || a === Axis.AncestorOrSelf || a === Axis.Preceding || a === Axis.PrecedingSibling;
  }

  hasPositionalPredicates(): boolean {
    return this.predicates.some(isPositional);
  }

  apply(input: XNode[], state: EvalState): XNode[] {
    if (input.length === 1) return this.selectFrom(input[0], [], state);

    // Nested input nodes (//div//a on divs inside divs, //a/ancestor::* on links in one list) give the same nodes
    // again and again: n nested nodes would collect about n² nodes before the duplicates are removed. When the
    // predicates do not depend on the position, a node passes them or not whichever input node it comes from,
    // so the input nodes whose results are already collected are skipped: the work stays linear.
    if (!this.hasPositionalPredicates()) {
      switch (this.axis) {
        case Axis.Descendant:
        case Axis.DescendantOrSelf:
          if (!this.test.matchesText() && inDocumentOrder(input)) return sortUnique(this.selectDescendantsOfNested(input, state));
          break;
        case Axis.Ancestor:
        case Axis.AncestorOrSelf:
          return sortUnique(this.selectSharedAncestors(input, state));
      }
    }

    const out: XNode[] = [];
    for (const x of input) this.selectFrom(x, out, state);
    return sortUnique(out);
  }

  /**
   * The descendant axes (tags only) on input nodes in document order. A tag that lies in the part of the tag list
   * already scanned for an earlier input node is skipped: that scan has tested it and every tag its own scan would test.
   */
  selectDescendantsOfNested(input: XNode[], state: EvalState): XNode[] {
    const nodes = state.doc.nodes;
    const out: XNode[] = [];
    let scannedTo = -1; // the tags before this index were scanned for an earlier input node
    for (const x of input) {
      if (x.kind === K.Element || x.kind === K.Comment) {
        const t = x.tag!;
        if (t.index < scannedTo) continue;
        this.selectFrom(x, out, state);
        // where addDescendants stops for this tag
        if (x.kind === K.Element && t.innerStart > 0 && t.innerEnd > 0) {
          let k = t.index + 1;
          while (k < nodes.length && nodes[k].end <= t.end) k++;
          scannedTo = Math.max(scannedTo, k);
        }
      } else {
        this.selectFrom(x, out, state);
        if (x.kind === K.Root) scannedTo = Number.MAX_SAFE_INTEGER;
      }
    }
    return out;
  }

  /**
   * The walk up from an input node stops at an ancestor already reached from an earlier one, because that walk has
   * gone on to the root. Only the root and elements are marked: they are the only parents.
   */
  selectSharedAncestors(input: XNode[], state: EvalState): XNode[] {
    const visited = new Set<number>();
    const visit = (x: XNode) => {
      const k = x.major;
      if (visited.has(k)) return false;
      visited.add(k);
      return true;
    };
    const out: XNode[] = [];
    for (const x of input) {
      const start = out.length;
      let current = x;
      if (this.axis === Axis.AncestorOrSelf) {
        if ((current.kind === K.Root || current.kind === K.Element) && !visit(current)) continue;
        if (this.test.matches(current, false)) out.push(current);
      }
      for (;;) {
        const p = parentNode(current);
        if (p === null || !visit(p)) break;
        current = p;
        if (this.test.matches(current, false)) out.push(current);
      }
      if (this.predicates.length > 0 && out.length > start) {
        const kept = filter(out.slice(start), this.predicates, state);
        out.length = start;
        out.push(...kept);
      }
    }
    return out;
  }

  /** Appends the nodes of the axis that pass the test and the predicates, in document order. */
  selectFrom(x: XNode, out: XNode[], state: EvalState): XNode[] {
    if (this.predicates.length === 0 && !this.isReverse()) return this.collect(x, out, state);
    const selected = filter(this.collect(x, [], state), this.predicates, state);
    if (this.isReverse()) selected.reverse();
    for (const n of selected) out.push(n);
    return out;
  }

  /** Appends the nodes of the axis that pass the node test, in axis order (reverse axes: nearest first). */
  collect(x: XNode, out: XNode[], state: EvalState): XNode[] {
    const test = this.test;
    switch (this.axis) {
      case Axis.Child:
        return addChildren(x, test, out);
      case Axis.Descendant:
        return addDescendants(x, test, out);
      case Axis.DescendantOrSelf:
        if (test.matches(x, false)) out.push(x);
        return addDescendants(x, test, out);
      case Axis.Self:
        if (test.matches(x, false)) out.push(x);
        return out;
      case Axis.Parent: {
        const p = parentNode(x);
        if (p !== null && test.matches(p, false)) out.push(p);
        return out;
      }
      case Axis.Ancestor:
      case Axis.AncestorOrSelf: {
        let current: XNode | null = x;
        if (this.axis === Axis.AncestorOrSelf && test.matches(current, false)) out.push(current);
        while ((current = parentNode(current)) !== null) if (test.matches(current, false)) out.push(current);
        return out;
      }
      case Axis.FollowingSibling:
      case Axis.PrecedingSibling:
        return collectSiblings(x, test, out, this.axis === Axis.FollowingSibling);
      case Axis.Following:
        return collectFollowing(x, test, out, state);
      case Axis.Preceding:
        return collectPreceding(x, test, out, state);
      case Axis.Attribute:
        return addAttributes(x, test, out);
    }
    return out;
  }
}

function inDocumentOrder(nodes: XNode[]): boolean {
  for (let i = 1; i < nodes.length; i++) if (compareKeys(nodes[i - 1], nodes[i]) >= 0) return false;
  return true;
}

function collectSiblings(x: XNode, test: NodeTest, out: XNode[], following: boolean): XNode[] {
  if (x.kind === K.Root || x.kind === K.Attribute) return out;
  if (!test.matchesText() && x.kind !== K.Text) {
    // tags only: walk the flat list; deeper tags are inside the siblings, a shallower one ends the parent
    const t = x.tag!;
    const nodes = t.document.nodes;
    const stepBy = following ? 1 : -1;
    for (let i = t.index + stepBy; i >= 0 && i < nodes.length; i += stepBy) {
      const item = nodes[i];
      if (item.depth < t.depth) break;
      if (item.depth === t.depth && test.matchesTag(item)) out.push(tagNode(item));
    }
    return out;
  }
  const parent = parentNode(x);
  if (parent === null) return out;
  const siblings = addChildren(parent, anyNodeTest, []);
  const index = siblings.findIndex((s) => compareKeys(s, x) === 0);
  if (index < 0) return out;
  if (following) {
    for (let i = index + 1; i < siblings.length; i++) if (test.matches(siblings[i], false)) out.push(siblings[i]);
  } else {
    for (let i = index - 1; i >= 0; i--) if (test.matches(siblings[i], false)) out.push(siblings[i]);
  }
  return out;
}

function collectFollowing(x: XNode, test: NodeTest, out: XNode[], state: EvalState): XNode[] {
  if (x.kind === K.Root) return out;
  const after = x.rangeEnd();
  if (test.matchesText()) {
    for (const n of state.allNodes()) if (n.rangeStart() > after && test.matches(n, false)) out.push(n);
    return out;
  }
  const nodes = state.doc.nodes;
  const first = x.kind === K.Element || x.kind === K.Comment ? x.tag!.index + 1 : 0;
  for (let i = first; i < nodes.length; i++) {
    if (nodes[i].start > after && test.matchesTag(nodes[i])) out.push(tagNode(nodes[i]));
  }
  return out;
}

function collectPreceding(x: XNode, test: NodeTest, out: XNode[], state: EvalState): XNode[] {
  if (x.kind === K.Root) return out;
  const before = x.rangeStart();
  if (test.matchesText()) {
    const all = state.allNodes();
    for (let i = all.length - 1; i >= 0; i--) if (all[i].rangeEnd() < before && test.matches(all[i], false)) out.push(all[i]);
    return out;
  }
  const nodes = state.doc.nodes;
  const last = x.kind === K.Element || x.kind === K.Comment ? x.tag!.index - 1 : nodes.length - 1;
  for (let i = last; i >= 0; i--) {
    if (nodes[i].end < before && test.matchesTag(nodes[i])) out.push(tagNode(nodes[i]));
  }
  return out;
}

/** Applies the predicates one after another; positions are 1-based in the order of the list. */
function filter(nodes: XNode[], predicates: XExpr[], state: EvalState): XNode[] {
  for (const p of predicates) {
    const size = nodes.length;
    let w = 0;
    for (let i = 0; i < size; i++) {
      if (evalPredicate(p, new Ctx(nodes[i], i + 1, size, state))) nodes[w++] = nodes[i];
    }
    nodes.length = w;
  }
  return nodes;
}

/** A location path, absolute or relative, optionally starting from a filter expression: (//a)[1]/@href. */
class PathExpr implements XExpr {
  readonly type = XType.NodeSet;
  readonly start: XExpr | null;
  readonly absolute: boolean;
  readonly steps: Step[];
  constructor(start: XExpr | null, absolute: boolean, steps: Step[]) {
    this.start = start;
    this.absolute = absolute;
    this.steps = steps;
  }
  usesPosition() {
    return this.start !== null && this.start.usesPosition();
  }
  evalBool(c: Ctx) {
    return toBoolean(this.eval(c));
  }
  eval(c: Ctx): XNode[] {
    let current: XNode[];
    if (this.start !== null) current = evalNodes(this.start, c);
    else if (this.absolute) current = [rootNode(c.state.doc)];
    else current = [c.node];
    for (const s of this.steps) {
      if (current.length === 0) break;
      current = s.apply(current, c.state);
    }
    return current;
  }
}

/** A primary expression with predicates: (//li)[last()]. */
class FilterExpr implements XExpr {
  readonly type = XType.NodeSet;
  readonly primary: XExpr;
  readonly predicates: XExpr[];
  constructor(primary: XExpr, predicates: XExpr[]) {
    this.primary = primary;
    this.predicates = predicates;
  }
  usesPosition() {
    return this.primary.usesPosition();
  }
  evalBool(c: Ctx) {
    return toBoolean(this.eval(c));
  }
  eval(c: Ctx): XNode[] {
    return filter([...evalNodes(this.primary, c)], this.predicates, c.state);
  }
}

// ----- functions -----

interface FnInfo {
  min: number;
  max: number;
  type: number;
}

const functions: Record<string, FnInfo> = {
  last: { min: 0, max: 0, type: XType.Number },
  position: { min: 0, max: 0, type: XType.Number },
  count: { min: 1, max: 1, type: XType.Number },
  name: { min: 0, max: 1, type: XType.String },
  'local-name': { min: 0, max: 1, type: XType.String },
  string: { min: 0, max: 1, type: XType.String },
  concat: { min: 2, max: Infinity, type: XType.String },
  'starts-with': { min: 2, max: 2, type: XType.Boolean },
  'ends-with': { min: 2, max: 2, type: XType.Boolean },
  contains: { min: 2, max: 2, type: XType.Boolean },
  'substring-before': { min: 2, max: 2, type: XType.String },
  'substring-after': { min: 2, max: 2, type: XType.String },
  substring: { min: 2, max: 3, type: XType.String },
  'string-length': { min: 0, max: 1, type: XType.Number },
  'normalize-space': { min: 0, max: 1, type: XType.String },
  translate: { min: 3, max: 3, type: XType.String },
  'lower-case': { min: 1, max: 1, type: XType.String },
  'upper-case': { min: 1, max: 1, type: XType.String },
  not: { min: 1, max: 1, type: XType.Boolean },
  true: { min: 0, max: 0, type: XType.Boolean },
  false: { min: 0, max: 0, type: XType.Boolean },
  boolean: { min: 1, max: 1, type: XType.Boolean },
  number: { min: 0, max: 1, type: XType.Number },
  sum: { min: 1, max: 1, type: XType.Number },
  floor: { min: 1, max: 1, type: XType.Number },
  ceiling: { min: 1, max: 1, type: XType.Number },
  round: { min: 1, max: 1, type: XType.Number },
};

function round(v: number): number {
  if (!Number.isFinite(v)) return v;
  return Math.floor(v + 0.5);
}

/** Splits on Unicode whitespace and joins with one space. */
function normalizeSpace(s: string): string {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && isUnicodeSpace(s.charCodeAt(i))) i++;
    const start = i;
    while (i < n && !isUnicodeSpace(s.charCodeAt(i))) i++;
    if (i > start) out += (out.length > 0 ? ' ' : '') + s.slice(start, i);
  }
  return out;
}

class FunctionExpr implements XExpr {
  readonly fn: string;
  readonly args: XExpr[];
  readonly type: number;
  constructor(fn: string, args: XExpr[], type: number) {
    this.fn = fn;
    this.args = args;
    this.type = type;
  }

  usesPosition(): boolean {
    return this.fn === 'position' || this.fn === 'last' || this.args.some((a) => a.usesPosition());
  }

  evalBool(c: Ctx) {
    return toBoolean(this.eval(c));
  }

  private arg(i: number, c: Ctx): string {
    return evalString(this.args[i], c);
  }

  private contextOrArg(c: Ctx): string {
    return this.args.length === 0 ? stringValue(c.node) : this.arg(0, c);
  }

  eval(c: Ctx): XValue {
    switch (this.fn) {
      case 'last':
        return c.size;
      case 'position':
        return c.position;
      case 'count':
        return evalNodes(this.args[0], c).length;
      case 'name':
      case 'local-name': {
        let name = '';
        if (this.args.length === 0) name = nodeName(c.node);
        else {
          const set = evalNodes(this.args[0], c);
          if (set.length > 0) name = nodeName(set[0]);
        }
        return this.fn === 'local-name' ? name.slice(name.lastIndexOf(':') + 1) : name;
      }
      case 'string':
        return this.contextOrArg(c);
      case 'concat': {
        let s = '';
        for (const a of this.args) s += evalString(a, c);
        return s;
      }
      case 'starts-with':
        return this.arg(0, c).startsWith(this.arg(1, c));
      case 'ends-with':
        return this.arg(0, c).endsWith(this.arg(1, c));
      case 'contains':
        return this.arg(0, c).includes(this.arg(1, c));
      case 'substring-before': {
        const s = this.arg(0, c);
        const i = s.indexOf(this.arg(1, c));
        return i >= 0 ? s.slice(0, i) : '';
      }
      case 'substring-after': {
        const s = this.arg(0, c);
        const t = this.arg(1, c);
        const i = s.indexOf(t);
        return i >= 0 ? s.slice(i + t.length) : '';
      }
      case 'substring':
        return this.substring(c);
      case 'string-length':
        return this.contextOrArg(c).length; // UTF-16 units, as .NET counts
      case 'normalize-space':
        return normalizeSpace(this.contextOrArg(c));
      case 'translate': {
        const s = this.arg(0, c);
        const from = Array.from(this.arg(1, c));
        const to = Array.from(this.arg(2, c));
        let out = '';
        for (const ch of s) {
          const i = from.indexOf(ch);
          if (i < 0) out += ch;
          else if (i < to.length) out += to[i];
        }
        return out;
      }
      case 'lower-case':
        return this.arg(0, c).toLowerCase();
      case 'upper-case':
        return this.arg(0, c).toUpperCase();
      case 'not':
        return !this.args[0].evalBool(c);
      case 'true':
        return true;
      case 'false':
        return false;
      case 'boolean':
        return this.args[0].evalBool(c);
      case 'number':
        return this.args.length === 0 ? stringToNumber(stringValue(c.node)) : evalNumber(this.args[0], c);
      case 'sum': {
        let sum = 0;
        for (const n of evalNodes(this.args[0], c)) sum += stringToNumber(stringValue(n));
        return sum;
      }
      case 'floor':
        return Math.floor(evalNumber(this.args[0], c));
      case 'ceiling':
        return Math.ceil(evalNumber(this.args[0], c));
      case 'round':
        return round(evalNumber(this.args[0], c));
    }
    throw new Error('unknown XPath function ' + this.fn);
  }

  /** XPath 1.0: the chars at 1-based positions p with round(start) <= p < round(start) + round(length). */
  private substring(c: Ctx): string {
    const s = this.arg(0, c);
    const from = round(evalNumber(this.args[1], c));
    const to = this.args.length > 2 ? from + round(evalNumber(this.args[2], c)) : Infinity;
    if (Number.isNaN(from) || Number.isNaN(to)) return '';
    const n = s.length;
    const first = from <= 1 ? 0 : from > n ? n : from - 1;
    const end = to >= n + 1 ? n : to <= 1 ? 0 : to - 1;
    return end > first ? s.slice(first, end) : '';
  }
}

// ----- tokenizer and parser -----

const T = {
  End: 0, Slash: 1, DoubleSlash: 2, LParen: 3, RParen: 4, LBracket: 5, RBracket: 6, Dot: 7, DotDot: 8, At: 9,
  Comma: 10, ColonColon: 11, Pipe: 12, Plus: 13, Minus: 14, Eq: 15, Neq: 16, Lt: 17, Le: 18, Gt: 19, Ge: 20,
  Star: 21, // name test *
  Multiply: 22, // operator *
  And: 23, Or: 24, Div: 25, Mod: 26, Name: 27, Literal: 28, Number: 29, Dollar: 30,
} as const;

interface Token {
  kind: number;
  text: string;
  number: number;
  position: number; // in code points
}

const isXNameStart = (ch: string) => /^[\p{L}_]$/u.test(ch);
const isXNameChar = (ch: string) => /^[\p{L}\p{Nd}_\-.]$/u.test(ch);
const isDigit = (ch: string) => ch >= '0' && ch <= '9' && ch.length === 1;
const nodeTypes = new Set(['node', 'text', 'comment', 'processing-instruction']);

const axes: Record<string, number> = {
  child: Axis.Child,
  descendant: Axis.Descendant,
  'descendant-or-self': Axis.DescendantOrSelf,
  self: Axis.Self,
  parent: Axis.Parent,
  ancestor: Axis.Ancestor,
  'ancestor-or-self': Axis.AncestorOrSelf,
  'following-sibling': Axis.FollowingSibling,
  'preceding-sibling': Axis.PrecedingSibling,
  following: Axis.Following,
  preceding: Axis.Preceding,
  attribute: Axis.Attribute,
};

/** Whether the expression is a bare @name (one attribute step, no predicates). */
function attributeName(e: XExpr): string | null {
  if (!(e instanceof PathExpr) || e.start !== null || e.absolute || e.steps.length !== 1) return null;
  const s = e.steps[0];
  if (s.axis !== Axis.Attribute || s.predicates.length > 0 || s.test.kind !== TK.Name) return null;
  return s.test.name;
}

/** @name = 'literal' is compared in place; everything else by the general rules. */
function makeEquality(op: number, left: XExpr, right: XExpr): XExpr {
  const l = attributeName(left);
  if (l !== null && right instanceof LiteralExpr) return new AttributeEqualsExpr(l, right.value, op === Op.Neq);
  const r = attributeName(right);
  if (r !== null && left instanceof LiteralExpr) return new AttributeEqualsExpr(r, left.value, op === Op.Neq);
  return new CompareExpr(op, left, right);
}

/**
 * //x is descendant-or-self::node()/child::x. Without positional predicates on x it is the same as descendant::x:
 * one linear scan of the tag list instead of the children of every node.
 */
function optimize(steps: Step[]): Step[] {
  for (let i = 0; i < steps.length - 1; i++) {
    const s = steps[i];
    if (s.axis !== Axis.DescendantOrSelf || s.test !== anyNodeTest || s.predicates.length > 0) continue;
    const next = steps[i + 1];
    if (next.axis === Axis.Child && !next.hasPositionalPredicates()) {
      steps[i] = new Step(Axis.Descendant, next.test, next.predicates);
      steps.splice(i + 1, 1);
    } else if (next.axis === Axis.Child || next.axis === Axis.Attribute) {
      // only the root and elements have children or attributes: skip the text nodes
      steps[i] = new Step(Axis.DescendantOrSelf, containersTest);
    }
  }
  return steps;
}

class XPathCompiler {
  readonly source: string[]; // code points
  readonly tokens: Token[] = [];
  index = 0;

  readonly expression: string;
  constructor(expression: string) {
    this.expression = expression;
    this.source = Array.from(expression);
    this.tokenize();
  }

  failAt(msg: string, position: number): never {
    throw new XPathError(`invalid XPath ${JSON.stringify(this.expression)} at position ${position}: ${msg}`);
  }

  fail(msg: string): never {
    this.failAt(msg, this.peek(0).position);
  }

  private tokenize(): void {
    const s = this.source;
    let i = 0;
    const at = (k: number) => (k < s.length ? s[k] : '');
    for (;;) {
      while (i < s.length && s[i].length === 1 && isUnicodeSpace(s[i].charCodeAt(0))) i++;
      if (i >= s.length) {
        this.tokens.push({ kind: T.End, text: '', number: 0, position: i });
        return;
      }
      const start = i;
      const ch = s[i];
      const next = at(i + 1);

      // XPath 1.0 lexical rule: after a token that can end an operand, '*' and and/or/div/mod are operators
      let operatorExpected = false;
      if (this.tokens.length > 0) {
        switch (this.tokens[this.tokens.length - 1].kind) {
          case T.RParen: case T.RBracket: case T.Dot: case T.DotDot: case T.Star: case T.Name: case T.Literal: case T.Number:
            operatorExpected = true;
        }
      }

      const tok: Token = { kind: T.End, text: '', number: 0, position: start };
      const single: Record<string, number> = { '(': T.LParen, ')': T.RParen, '[': T.LBracket, ']': T.RBracket, '@': T.At,
        ',': T.Comma, '|': T.Pipe, '+': T.Plus, '-': T.Minus, '=': T.Eq, $: T.Dollar };
      if (ch === '/') {
        if (next === '/') {
          tok.kind = T.DoubleSlash;
          i += 2;
        } else {
          tok.kind = T.Slash;
          i++;
        }
      } else if (single[ch] !== undefined) {
        tok.kind = single[ch];
        i++;
      } else if (ch === '*') {
        tok.kind = operatorExpected ? T.Multiply : T.Star;
        i++;
      } else if (ch === '!') {
        if (next !== '=') this.failAt("'!' must be followed by '='", i);
        tok.kind = T.Neq;
        i += 2;
      } else if (ch === '<' || ch === '>') {
        if (next === '=') {
          tok.kind = ch === '<' ? T.Le : T.Ge;
          i += 2;
        } else {
          tok.kind = ch === '<' ? T.Lt : T.Gt;
          i++;
        }
      } else if (ch === ':') {
        if (next !== ':') this.failAt("unexpected ':'", i);
        tok.kind = T.ColonColon;
        i += 2;
      } else if (ch === '"' || ch === "'") {
        let end = -1;
        for (let k = i + 1; k < s.length; k++) {
          if (s[k] === ch) {
            end = k;
            break;
          }
        }
        if (end < 0) this.failAt('unterminated string literal', i);
        tok.kind = T.Literal;
        tok.text = s.slice(i + 1, end).join('');
        i = end + 1;
      } else if (ch === '.' && next === '.') {
        tok.kind = T.DotDot;
        i += 2;
      } else if (ch === '.' && !isDigit(next)) {
        tok.kind = T.Dot;
        i++;
      } else if (isDigit(ch) || ch === '.') {
        while (i < s.length && isDigit(s[i])) i++;
        if (i < s.length && s[i] === '.') {
          i++;
          while (i < s.length && isDigit(s[i])) i++;
        }
        tok.kind = T.Number;
        tok.number = Number(s.slice(start, i).join(''));
      } else if (isXNameStart(ch)) {
        i++;
        while (i < s.length) {
          if (isXNameChar(s[i])) {
            i++;
          } else if (s[i] === ':' && i + 1 < s.length && s[i + 1] !== ':' && (isXNameStart(s[i + 1]) || s[i + 1] === '*')) {
            // a prefixed name (dc:creator) or prefix:*
            i += 2;
            if (s[i - 1] === '*') break;
          } else {
            break;
          }
        }
        tok.kind = T.Name;
        tok.text = s.slice(start, i).join('');
        if (operatorExpected) {
          const ops: Record<string, number> = { and: T.And, or: T.Or, div: T.Div, mod: T.Mod };
          if (ops[tok.text] === undefined) this.failAt(`expected an operator, found '${tok.text}'`, start);
          tok.kind = ops[tok.text];
        }
      } else {
        this.failAt(`unexpected character '${ch}'`, i);
      }
      this.tokens.push(tok);
    }
  }

  // ----- parser helpers -----

  peek(offset: number): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)];
  }

  private advance(): Token {
    return this.tokens[this.index++];
  }

  private accept(kind: number): boolean {
    if (this.peek(0).kind !== kind) return false;
    this.index++;
    return true;
  }

  private expect(kind: number, what: string): void {
    if (!this.accept(kind)) this.fail(`expected ${what}, found ${this.describe(this.peek(0))}`);
  }

  describe(t: Token): string {
    switch (t.kind) {
      case T.End:
        return 'the end of the expression';
      case T.Name:
      case T.Literal:
        return "'" + t.text + "'";
      case T.Number:
        return numberToString(t.number);
    }
    return "'" + this.source.slice(t.position, t.position + 2).join('').trimEnd() + "'";
  }

  // ----- grammar (XPath 1.0, section 3) -----

  parseExpr(): XExpr {
    return this.parseOr();
  }

  private parseOr(): XExpr {
    let left = this.parseAnd();
    while (this.accept(T.Or)) left = new LogicExpr(false, left, this.parseAnd());
    return left;
  }

  private parseAnd(): XExpr {
    let left = this.parseEquality();
    while (this.accept(T.And)) left = new LogicExpr(true, left, this.parseEquality());
    return left;
  }

  private parseEquality(): XExpr {
    let left = this.parseRelational();
    for (;;) {
      let op: number;
      if (this.accept(T.Eq)) op = Op.Eq;
      else if (this.accept(T.Neq)) op = Op.Neq;
      else return left;
      left = makeEquality(op, left, this.parseRelational());
    }
  }

  private parseRelational(): XExpr {
    let left = this.parseAdditive();
    for (;;) {
      let op: number;
      if (this.accept(T.Lt)) op = Op.Lt;
      else if (this.accept(T.Le)) op = Op.Le;
      else if (this.accept(T.Gt)) op = Op.Gt;
      else if (this.accept(T.Ge)) op = Op.Ge;
      else return left;
      left = new CompareExpr(op, left, this.parseAdditive());
    }
  }

  private parseAdditive(): XExpr {
    let left = this.parseMultiplicative();
    for (;;) {
      if (this.accept(T.Plus)) left = new ArithExpr(Arith.Add, left, this.parseMultiplicative());
      else if (this.accept(T.Minus)) left = new ArithExpr(Arith.Sub, left, this.parseMultiplicative());
      else return left;
    }
  }

  private parseMultiplicative(): XExpr {
    let left = this.parseUnary();
    for (;;) {
      if (this.accept(T.Multiply)) left = new ArithExpr(Arith.Mul, left, this.parseUnary());
      else if (this.accept(T.Div)) left = new ArithExpr(Arith.Div, left, this.parseUnary());
      else if (this.accept(T.Mod)) left = new ArithExpr(Arith.Mod, left, this.parseUnary());
      else return left;
    }
  }

  private parseUnary(): XExpr {
    if (this.accept(T.Minus)) return new NegateExpr(this.parseUnary());
    return this.parseUnion();
  }

  private parseUnion(): XExpr {
    let left = this.parsePath();
    while (this.peek(0).kind === T.Pipe) {
      const position = this.advance().position;
      const right = this.parsePath();
      if (left.type !== XType.NodeSet || right.type !== XType.NodeSet) this.failAt("'|' needs node-sets on both sides", position);
      left = new UnionExpr(left, right);
    }
    return left;
  }

  private parsePath(): XExpr {
    const t = this.peek(0);
    const isFilter =
      t.kind === T.Literal || t.kind === T.Number || t.kind === T.LParen || t.kind === T.Dollar ||
      (t.kind === T.Name && this.peek(1).kind === T.LParen && !nodeTypes.has(t.text));
    if (!isFilter) return this.parseLocationPath();

    const position = t.position;
    let primary = this.parsePrimary();
    const predicates = this.parsePredicates();
    if (predicates.length > 0) {
      if (primary.type !== XType.NodeSet) this.failAt('a predicate needs a node-set', position);
      primary = new FilterExpr(primary, predicates);
    }
    const k = this.peek(0).kind;
    if (k !== T.Slash && k !== T.DoubleSlash) return primary;
    if (primary.type !== XType.NodeSet) this.failAt("'/' needs a node-set on the left", position);
    return new PathExpr(primary, false, optimize(this.parseRelativeSteps([], true)));
  }

  private parseLocationPath(): XExpr {
    let steps: Step[] = [];
    let absolute = false;
    if (this.accept(T.Slash)) {
      absolute = true;
      if (canStartStep(this.peek(0))) steps = this.parseRelativeSteps(steps, false);
    } else if (this.peek(0).kind === T.DoubleSlash) {
      absolute = true;
      steps = this.parseRelativeSteps(steps, true);
    } else {
      if (!canStartStep(this.peek(0))) this.fail('unexpected ' + this.describe(this.peek(0)));
      steps = this.parseRelativeSteps(steps, false);
    }
    return new PathExpr(null, absolute, optimize(steps));
  }

  /** Steps separated by '/' or '//'; afterSlash: the next token is a '/' or '//' to read first. */
  private parseRelativeSteps(steps: Step[], afterSlash: boolean): Step[] {
    if (!afterSlash) steps.push(this.parseStep());
    for (;;) {
      if (this.accept(T.Slash)) {
        steps.push(this.parseStep());
      } else if (this.accept(T.DoubleSlash)) {
        steps.push(new Step(Axis.DescendantOrSelf, anyNodeTest));
        steps.push(this.parseStep());
      } else {
        return steps;
      }
    }
  }

  private parseStep(): Step {
    if (this.accept(T.Dot)) return new Step(Axis.Self, anyNodeTest);
    if (this.accept(T.DotDot)) return new Step(Axis.Parent, anyNodeTest);
    let axis: number = Axis.Child;
    if (this.accept(T.At)) {
      axis = Axis.Attribute;
    } else if (this.peek(0).kind === T.Name && this.peek(1).kind === T.ColonColon) {
      const name = this.advance();
      const a = Object.hasOwn(axes, name.text) ? axes[name.text] : undefined;
      if (a === undefined) {
        if (name.text === 'namespace') this.failAt('the namespace axis is not supported', name.position);
        this.failAt(`unknown axis '${name.text}'`, name.position);
      }
      axis = a;
      this.advance();
    }
    const test = this.parseNodeTest();
    return new Step(axis, test, this.parsePredicates());
  }

  private parseNodeTest(): NodeTest {
    if (this.accept(T.Star)) return new NodeTest(TK.Wildcard);
    const t = this.peek(0);
    if (t.kind !== T.Name) this.fail('expected a node test, found ' + this.describe(t));
    this.advance();
    const name = t.text;
    if (this.peek(0).kind === T.LParen && nodeTypes.has(name)) {
      this.advance();
      if (name === 'processing-instruction') this.accept(T.Literal);
      this.expect(T.RParen, "')'");
      switch (name) {
        case 'node':
          return anyNodeTest;
        case 'text':
          return new NodeTest(TK.Text);
        case 'comment':
          return new NodeTest(TK.Comment);
      }
      return new NodeTest(TK.PI);
    }
    if (name.endsWith(':*')) return new NodeTest(TK.Prefix, name.slice(0, -1));
    return new NodeTest(TK.Name, name);
  }

  private parsePredicates(): XExpr[] {
    const predicates: XExpr[] = [];
    while (this.accept(T.LBracket)) {
      let p = this.parseExpr();
      this.expect(T.RBracket, "']'");
      // [@name]: an existence check instead of a node-set
      const name = attributeName(p);
      if (name !== null) p = new AttributeExistsExpr(name);
      predicates.push(p);
    }
    return predicates;
  }

  private parsePrimary(): XExpr {
    const t = this.advance();
    switch (t.kind) {
      case T.Literal:
        return new LiteralExpr(t.text);
      case T.Number:
        return new NumberExpr(t.number);
      case T.LParen: {
        const e = this.parseExpr();
        this.expect(T.RParen, "')'");
        return e;
      }
      case T.Dollar:
        this.failAt('variables are not supported', t.position);
    }

    // function call
    const info = Object.hasOwn(functions, t.text) ? functions[t.text] : undefined;
    if (info === undefined) this.failAt(`unknown function '${t.text}()'`, t.position);
    this.expect(T.LParen, "'('");
    const args: XExpr[] = [];
    if (!this.accept(T.RParen)) {
      do args.push(this.parseExpr());
      while (this.accept(T.Comma));
      this.expect(T.RParen, "')'");
    }
    if (args.length < info.min || args.length > info.max) this.failAt(`wrong number of arguments for ${t.text}()`, t.position);
    if (['count', 'sum', 'name', 'local-name'].includes(t.text) && args.length > 0 && args[0].type !== XType.NodeSet) {
      this.failAt(`${t.text}() needs a node-set argument`, t.position);
    }
    return makeAttributeTest(t.text, args, info.type);
  }
}

/**
 * contains(@a, 'x'), starts-with(...), ends-with(...), also with the attribute wrapped in literals
 * (contains(concat(' ', @class, ' '), ' x '), the usual class test), are evaluated on the attribute in place.
 */
function makeAttributeTest(fn: string, args: XExpr[], type: number): XExpr {
  const needle = args[1];
  if ((fn === 'contains' || fn === 'starts-with' || fn === 'ends-with') && needle instanceof LiteralExpr) {
    const arg = args[0];
    const name = attributeName(arg);
    if (name !== null) return new AttributeTestExpr(fn, '', name, '', needle.value);
    if (arg instanceof FunctionExpr && arg.fn === 'concat' && arg.args.length === 3) {
      const [prefix, attribute, suffix] = arg.args;
      const inner = attributeName(attribute);
      if (inner !== null && prefix instanceof LiteralExpr && suffix instanceof LiteralExpr) {
        return new AttributeTestExpr(fn, prefix.value, inner, suffix.value, needle.value);
      }
    }
  }
  return new FunctionExpr(fn, args, type);
}

function canStartStep(t: Token): boolean {
  return t.kind === T.Dot || t.kind === T.DotDot || t.kind === T.At || t.kind === T.Star || t.kind === T.Name;
}
