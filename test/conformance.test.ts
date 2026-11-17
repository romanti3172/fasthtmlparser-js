// The expected output comes from z3l.FastHtmlParser (.NET) for the same pages (tools/conformance): tag names,
// parents, depths, positions (as UTF-8 byte offsets), visible texts, attribute values, navigation and links,
// and the results of 569 XPath / CSS queries. The JS port must give exactly the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse, CssQuery, XPathQuery, type HtmlNode } from '../src/index.ts';

const dir = new URL('../testdata/conformance/', import.meta.url);
const pageUrl = 'https://Example.com:443/catalog/page-1.html?sort=asc#top'; // as in tools/conformance/Program.cs
const attributes = ['class', 'id', 'href', 'title', 'value', 'alt', 'data-a', 'x', 'a', 'src'];

const inputs = readdirSync(new URL('input/', dir))
  .filter((f) => f.endsWith('.html'))
  .map((f) => f.slice(0, -5))
  .sort();

const readInput = (name: string) => readFileSync(new URL(`input/${name}.html`, dir), 'utf8');
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, dir), 'utf8'));

/** UTF-8 byte offset of each UTF-16 index, as the .NET dump computes it. */
function byteOffsets(source: string): Int32Array {
  const bytes = new Int32Array(source.length + 1);
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i);
    const size = c >= 0xd800 && c <= 0xdbff ? 4 : c >= 0xdc00 && c <= 0xdfff ? 0 : c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    bytes[i + 1] = bytes[i] + size;
  }
  return bytes;
}

const index = (n: HtmlNode | null) => (n === null ? -1 : n.index);

test('inputs present', () => assert.ok(inputs.length >= 100, `${inputs.length} inputs`));

test('tags, texts, attributes, navigation and links', async (t) => {
  for (const name of inputs) {
    await t.test(name, () => {
      const source = readInput(name);
      const expected = readJson(`expected/${name}.json`);
      const doc = parse(source, pageUrl);
      const bytes = byteOffsets(source);
      const last = (i: number) => (i === 0 ? 0 : bytes[i + 1] - 1);
      const problems: string[] = [];
      if (doc.length !== expected.length) problems.push(`tags: ${doc.length}, .NET: ${expected.length}`);
      for (let i = 0; i < Math.min(doc.length, expected.length) && problems.length < 10; i++) {
        const n = doc.nodes[i];
        const e = expected[i];
        const got = {
          name: n.name,
          parent: n.parentIndex,
          depth: n.depth,
          start: bytes[n.start],
          end: last(n.end),
          innerStart: n.innerStart === 0 ? 0 : bytes[n.innerStart],
          innerEnd: n.innerEnd === 0 ? 0 : last(n.innerEnd),
          text: n.text(),
          textLineBreaks: n.textLineBreaks(),
          source: n.source(),
          next: index(n.next()),
          previous: index(n.previous()),
          nextSibling: index(n.nextSibling()),
          previousSibling: index(n.previousSibling()),
          children: n.children().map((c) => c.index).join(','),
          href: n.href(),
          src: n.src(),
          mailto: n.hrefMailTo(),
          tel: n.hrefTelephone(),
          textAfter: n.textAfterTagUntilNextOne(),
          textNoTagsAfter: n.textNoTagsAfterTagUntilNextOne(),
        };
        for (const [key, value] of Object.entries(got)) {
          if (value !== e[key]) {
            problems.push(`[${i}] <${n.name}> ${key}:\n  js:   ${short(value)}\n  .net: ${short(e[key])}`);
          }
        }
        for (const a of attributes) {
          const want = e.attrs[a] ?? '';
          if (n.attr(a) !== want) problems.push(`[${i}] <${n.name}> @${a}: ${JSON.stringify(n.attr(a))}, .NET: ${JSON.stringify(want)}`);
        }
      }
      assert.ok(problems.length === 0, problems.slice(0, 10).join('\n'));
    });
  }
});

function short(v: unknown): string {
  const s = JSON.stringify(v);
  return s.length > 200 ? s.slice(0, 200) + '...' : s;
}

test('which queries compile', () => {
  const expected = readJson('expected/queries/compile.json');
  const problems: string[] = [];
  for (const [x, want] of Object.entries(expected.xpath)) {
    if (okOrError(() => XPathQuery.compile(x)) !== want) problems.push(`XPath ${JSON.stringify(x)}: .NET ${want}`);
  }
  for (const [c, want] of Object.entries(expected.css)) {
    if (okOrError(() => CssQuery.compile(c)) !== want) problems.push(`CSS ${JSON.stringify(c)}: .NET ${want}`);
  }
  assert.ok(problems.length === 0, problems.join('\n'));
});

function okOrError(f: () => unknown): string {
  try {
    f();
    return 'ok';
  } catch {
    return 'error';
  }
}

// page and query where the .NET result depends on the order of an unstable sort (see the Go port):
// snip039 nests 600 divs; text nodes and flattened tags share document-order keys.
const knownDifferences = new Set(['snip039 //div/node()']);

const full = process.env.FASTHTML_FULL !== undefined;

/** [count, hash] of the values, or "throws" when the evaluation throws (.NET throws). */
function result(values: () => string[]): unknown {
  let v: string[];
  try {
    v = values();
  } catch {
    return 'throws';
  }
  if (full) return v;
  const hash = createHash('sha256').update(v.join('\u0001'), 'utf8').digest('hex').slice(0, 16);
  return [String(v.length), hash];
}

const indexes = (nodes: HtmlNode[]) => nodes.map((n) => String(n.index));

test('XPath and CSS results', async (t) => {
  for (const name of inputs) {
    await t.test(name, () => {
      const expected = readJson(`expected/queries/${name}.json`);
      const doc = parse(readInput(name));
      const problems: string[] = [];
      const check = (what: string, want: unknown, got: unknown) => {
        if (problems.length < 10 && JSON.stringify(got) !== JSON.stringify(want)) {
          problems.push(`${what}\n  js:   ${short(got)}\n  .net: ${short(want)}`);
        }
      };

      for (const [x, want] of Object.entries<Record<string, unknown>>(expected.xpath)) {
        if (knownDifferences.has(name + ' ' + x)) continue;
        const q = XPathQuery.compile(x);
        check('XPath tags ' + x, want.tags, result(() => indexes(q.nodes(doc))));
        check('XPath values ' + x, want.values, result(() => q.values(doc)));
        check('XPath value ' + x, want.value, result(() => [q.value(doc) ?? '<null>']));
        const scoped = expected.scopes.map((s: number) => {
          const n = doc.nodes[s];
          return result(() => [...indexes(q.nodesFrom(n)), '|', ...q.valuesFrom(n)]);
        });
        check('XPath scoped ' + x, want.scoped, scoped);
      }

      for (const [c, want] of Object.entries<Record<string, unknown>>(expected.css)) {
        const q = CssQuery.compile(c);
        check('CSS all ' + c, want.all, result(() => indexes(q.all(doc))));
        check('CSS first ' + c, want.first, result(() => [q.first(doc)?.index.toString() ?? '<null>']));
        check('CSS matches ' + c, want.matches, result(() => indexes(doc.nodes.filter((n) => q.matches(n)))));
        const scoped = expected.scopes.map((s: number) => result(() => indexes(q.allIn(doc.nodes[s]))));
        check('CSS scoped ' + c, want.scoped, scoped);
      }
      assert.ok(problems.length === 0, problems.join('\n'));
    });
  }
});
