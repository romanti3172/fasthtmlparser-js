# z3l-fasthtmlparser

[![CI](https://github.com/romanti3172/fasthtmlparser-js/actions/workflows/ci.yml/badge.svg)](https://github.com/romanti3172/fasthtmlparser-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/z3l-fasthtmlparser)](https://www.npmjs.com/package/z3l-fasthtmlparser)

**Website:** [fasthtmlparser.com](https://fasthtmlparser.com): try the parser on any page, documentation and every language.

JavaScript / TypeScript port of [z3l.FastHtmlParser](https://github.com/romanti3172/z3l.FastHtmlParser): a fast
HTML / XML parser for scraping, with **XPath 1.0** and **CSS selectors**. It is built for extracting data, not for
building a DOM: a page becomes a flat list of tags that hold only positions in the source. Text, attributes and
entities are read when you ask for them, and the values are substrings of the page.

The whole API is ported: the parser, attributes, HTML5 entities, visible text and text with line breaks,
`find` / `findAll`, navigation, links, XPath 1.0, CSS selectors and the one-call shortcuts. The parser is also
available in [other languages](#other-languages).

```
npm install z3l-fasthtmlparser
```

No dependencies. ES modules and CommonJS, TypeScript types included. Node 18 or later, and any modern browser or
runtime (Deno, Bun).

```ts
import { parse, by, Tag, Attr } from 'z3l-fasthtmlparser';

const doc = parse(page, 'https://example.com/catalog/'); // or parse(page); bytes are read as UTF-8

// CSS selectors, as querySelectorAll / querySelector / matches
for (const pod of doc.css('article.product_pod')) {
  const title = pod.cssFirst('h3 a')?.attr('title');
  const price = pod.cssFirst('p.price_color')?.text();
}
doc.cssFirst('ul#menu > li:last-child a')?.attr('href');
doc.css('tr:has(> td.price)');
card.css('> span'); // the children of card

// XPath 1.0
doc.xpath("//div[@class='card']//span[@class='price']");
doc.xpathValues("//a[contains(@href, '/product/')]/@href");
doc.xpathValue("//dt[.='Price']/following-sibling::dd[1]");
doc.xpathValue('count(//table//tr)'); // "12"

// compile once, reuse on any number of pages
import { XPathQuery, CssQuery } from 'z3l-fasthtmlparser';
const titles = XPathQuery.compile('//article//h3/a/@title');
titles.values(doc);

// search by name, class, id, attribute, text
for (const pod of doc.findAll(by(Tag.Article).class('product_pod'))) {
  pod.find(by(Tag.P).class('price_color'))?.text();
}

// one-call shortcuts (findByName*, findAllByName*, isName*, parentByName, nextSiblingByName, attribute*, ...)
const pod = doc.findByNameClass(Tag.Article, 'product_pod');
pod?.findByNameItemprop(Tag.Span, 'price')?.text();
doc.findByNameText(Tag.Dt, 'Price')?.nextSiblingByName(Tag.Dd)?.text();
doc.findByNameClass('my-widget', 'x'); // any name works as a string

// reading a tag
tag.text();           // visible text, entities decoded
tag.textLineBreaks(); // <br> and block elements → new line, <p> and headings → paragraph
tag.attr(Attr.DataSrc); // decoded value; attrRaw(): as written
tag.href();           // absolute URL, resolved against the page URL; src() for src
tag.hrefMailTo();     // the address of a mailto: link; hrefTelephone() for tel:
tag.source();         // the opening tag without '<' and '>'
tag.name; tag.depth; tag.index; tag.start; tag.end;

// navigation
tag.parent(); tag.children(); tag.nextSibling(); tag.previousSibling(); tag.next(); tag.previous();
tag.parentMatching(by(Tag.Table));
tag.textAfterUntil(by(Tag.Br)); // the source between the tag and the next <br>
```

Queries: `by(Tag.Div)`, `by('custom-tag')` or `any()`, then `.class`, `.id`, `.attr`, `.text`, `.idStartsWith`,
`.textStartsWith`, `.body`, `.bodyStartsWith`, `.source`. Queries are immutable. `Tag` and `Attr` cover about 250 tag
and 230 attribute names (HTML, SVG, MathML, RSS, Atom, sitemap); any other name works as a string.

A missing tag is `null` (chain with `?.`), a missing value is `""`. The string methods (`css`, `xpath`, ...) compile
and cache the query and throw `CssSelectorError` / `XPathError` (both `SyntaxError`s) on an invalid one;
`xpath()` on an expression that gives a number or string throws a `TypeError` (use `xpathValue`).

CSS: type, `*`, `#id`, `.class`, attribute selectors with all operators and the `i` / `s` flags, the four combinators,
selector lists, `:first-child`, `:last-child`, `:only-child`, `:*-of-type`, `:nth-child(An+B [of S])` and its
relatives, `:not()`, `:is()`, `:where()`, `:has()`, `:empty`, `:root`, `:scope`, `:link`, `:checked`, `:disabled`,
`:enabled`, `:required`, `:optional`, `:contains("text")`. XPath: all axes except namespace, predicates, `|`, the
operators and all XPath 1.0 functions, plus `ends-with()`, `lower-case()`, `upper-case()`. HTML rules apply: names are
case-insensitive, the string-value of an element is its visible text, attribute values and text are decoded.

Parsing follows what a browser makes of the page where it matters for scraping: HTML5 optional end tags (`<li>`, `<p>`,
`<td>`, `<tr>`, `<option>` without end tags give the same elements as a browser), raw text in `<script>`, `<style>`,
`<textarea>`, `<title>`, comments as HTML5 reads them, void elements, nesting flattened past 512 levels, all 2125
named entities, CR LF read as LF. XML documents (RSS, Atom, sitemaps) are parsed by XML rules. Not done: full HTML5
tree construction (no implied `<tbody>` or `<html>`), and documents are read-only.

## Same results as the .NET version

The conformance tests compare the port with z3l.FastHtmlParser 1.4.1 (.NET) on 117 pages: the test fixtures, the
broken-markup snippets of the .NET cross-check tests, extra edge cases (entities, raw text, comments, XML, custom
elements, 600-deep nesting, Unicode whitespace, links of every kind, line breaks), and every fixture with
`</li> </p> </td> </tr>` left out, plus three copies of each with random end tags dropped, names upper-cased and the
page cut off, and copies saved with CR LF and with a lone CR.

- `test/conformance.test.ts`, every tag (over 15,000): names, parents, depths, positions, visible text, text with line
  breaks, 10 attribute values, the opening tag source, next / previous tag and sibling, children, the resolved href
  and src, mailto: and tel: values, and the text after the tag must be identical.
- The same file, 569 queries: every string of the .NET XPath and CSS tests plus extra ones for the axes, functions and
  selectors. Whether each one compiles must be the same (119 are invalid); the 228 XPath and 222 CSS queries that
  compile are run on every page, on the document and from three tags of the page, and every CSS selector is also
  matched against every tag. Selected tags and values must be identical.

All pass, with one documented exception: on the page nested 600 levels deep, where the .NET result depends on the
order of an unstable sort.

Positions (`start`, `end`) are UTF-16 indexes into the source, as everywhere in JavaScript and in .NET. Intended
differences: `textLineBreaks()` joins lines with `"\n"` on every OS (.NET uses `Environment.NewLine`), and a missing
value is `""` where .NET returns null. Links resolved against the page are written as .NET's `System.Uri` writes them
(host in lower case, no default port, readable escapes); absolute links are returned as written.

The expected output in `testdata/conformance` is produced by `tools/conformance`, a small .NET program that references
the z3l.FastHtmlParser package; it is shared with the Go port.

## Benchmarks

`cd bench && npm install && npm run bench` (Node 26, AMD Ryzen 7 3800X, Windows; median time per call). cheerio
parses with parse5, the others with their own parsers. Before timing, the benchmark checks that every library extracts
exactly the same records.

Parse a page:

| Page | fasthtmlparser | htmlparser2 | node-html-parser | parse5 | cheerio | linkedom |
|---|---:|---:|---:|---:|---:|---:|
| quotes, 11 KB | **69 μs** | 257 μs | 297 μs | 439 μs | 637 μs | 1.26 ms |
| laptops, 38 KB | **197 μs** | 902 μs | 835 μs | 1.50 ms | 1.71 ms | 3.44 ms |
| books, 51 KB | **205 μs** | 865 μs | 922 μs | 1.89 ms | 1.87 ms | 2.73 ms |
| books x10, 510 KB | **2.68 ms** | 10.55 ms | 10.05 ms | 20.74 ms | 27.26 ms | 46.10 ms |
| books without `</li>` `</p>` | **237 μs** | 974 μs | 863 μs | 1.94 ms | 2.86 ms | 2.67 ms |

Scrape a page: parse and extract the records. Books: 20 × title, price, rating; quotes: 10 × text, author, tags.

| Task | fasthtmlparser `find` | CSS | XPath | cheerio | node-html-parser | linkedom | jsdom XPath |
|---|---:|---:|---:|---:|---:|---:|---:|
| books | **275 μs** | 282 μs | 307 μs | 2.81 ms | 1.33 ms | 3.41 ms | 42.67 ms |
| quotes | 110 μs | **100 μs** | | 1.11 ms | 532 μs | 1.48 ms | |

The full output is in `bench-results.txt`.

## Development

```
npm install
npm test            # runs the TypeScript sources directly (Node 22.18+ / 24)
npm run typecheck
npm run build       # dist/esm and dist/cjs
npm run gen         # the tag, attribute and entity tables from the C# sources, and the shortcuts
```

Releases: bump `version` in `package.json`, commit, and push a tag `v<version>`. The `Publish` workflow checks
everything again and publishes to npm with trusted publishing (no stored token) and a provenance statement.

- `src/parse.ts`: the scanner and the HTML5 optional-end-tag rules (port of `ParsingCore.cs`)
- `src/attr.ts`, `decode.ts`, `text.ts`, `textlines.ts`: attributes, character references, visible text, text with line breaks
- `src/document.ts`: `HtmlDocument`, `HtmlNode`, `Query`, search, navigation and the generated shortcuts; `links.ts`: href / src
- `src/css.ts`: CSS selectors; `src/xpath.ts`: XPath 1.0
- `src/names.ts`, `attributes.ts`, `entities.ts`: generated by `tools/gen.mjs` from the C# sources
- `bench/`: benchmarks in their own package, so the library has no dependencies

## Other languages

The same parser is available for:

| Language | Package | Source |
|---|---|---|
| C# (.NET 9 and 10) | [z3l.FastHtmlParser](https://www.nuget.org/packages/z3l.FastHtmlParser) on NuGet | [romanti3172/z3l.FastHtmlParser](https://github.com/romanti3172/z3l.FastHtmlParser) |
| Go | `github.com/romanti3172/fasthtmlparser` | [romanti3172/fasthtmlparser](https://github.com/romanti3172/fasthtmlparser) |
| Rust | [fasthtmlparser](https://crates.io/crates/fasthtmlparser) on crates.io | [romanti3172/fasthtmlparser-rs](https://github.com/romanti3172/fasthtmlparser-rs) |
| JavaScript / TypeScript | [z3l-fasthtmlparser](https://www.npmjs.com/package/z3l-fasthtmlparser) on npm | [romanti3172/fasthtmlparser-js](https://github.com/romanti3172/fasthtmlparser-js) |
| Python | [fasthtmlparser](https://pypi.org/project/fasthtmlparser/) on PyPI | [romanti3172/fasthtmlparser-py](https://github.com/romanti3172/fasthtmlparser-py) |

## License

Source-available, not OSI open source: free for individuals and companies with annual revenue below USD 1,000,000
and fewer than 100 people; a one-time commercial license above that. See [LICENSE.md](LICENSE.md).
