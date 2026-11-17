import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parse, by, any, byName, firstLevelByName, Tag, Attr, CssQuery, CssSelectorError, XPathQuery, XPathError,
  htmlToText, htmlToTextLineBreaks, decodeHtml, type HtmlNode,
} from '../src/index.ts';

const fixture = (path: string) => readFileSync(new URL(`../testdata/${path}`, import.meta.url), 'utf8');

// The shortcuts on the books page give what the scraper code of the .NET examples expects.
test('shortcuts', () => {
  const doc = parse(fixture('books/index.html'), 'https://books.toscrape.com/index.html');
  const pods = doc.findAllByNameClass(Tag.Article, 'product_pod');
  assert.equal(pods.length, 20);
  const first = pods[0];
  assert.equal(first.findByName(Tag.H3)?.findByName(Tag.A)?.attributeTitle(), 'A Light in the Attic');
  assert.equal(first.findByNameClass(Tag.P, 'price_color')?.text(), '£51.77');
  assert.equal(first.findByNameClassTextStartsWith(Tag.P, 'price_color', '£5')?.attributeClass(), 'price_color');
  assert.equal(first.findByName(Tag.A)?.href(), 'https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html');
  assert.equal(first.findByName(Tag.Img)?.src(), 'https://books.toscrape.com/media/cache/2c/da/2cdad67c44b002e7ead0cc35693c0e8b.jpg');
  assert.equal(first.findByName(Tag.Img)?.parentByName(Tag.Article)?.attributeClass(), 'product_pod');
  assert.equal(first.findByName(Tag.H3)?.nextSiblingByName(Tag.Div)?.attributeClass(), 'product_price');
  // names as strings work too
  assert.equal(first.findByNameClass('p', 'price_color')?.text(), '£51.77');

  assert.equal(firstLevelByName(doc.findAll(any()), Tag.Html).length, 1);
  assert.ok(first.isNameClass(Tag.Article, 'product_pod'));
  assert.ok(!first.isNameClass(Tag.Div, 'product_pod'));
  assert.equal(doc.findByNameTextStartsWith(Tag.A, ''), null, 'an empty criterion of the older shortcuts gives null');
  assert.equal(doc.findById(''), null);
});

test('scraping with Find, CSS and XPath gives the same records', () => {
  const doc = parse(fixture('books/index.html'));
  const byFind = doc.findAll(by(Tag.Article).class('product_pod')).map((pod) => [
    pod.find(by(Tag.H3))?.find(by(Tag.A))?.attr(Attr.Title),
    pod.find(by(Tag.P).class('price_color'))?.text(),
    pod.find(by(Tag.P).class('star-rating'))?.attr(Attr.Class),
  ]);
  const byCss = doc.css('article.product_pod').map((pod) => [
    pod.cssFirst('h3 a')?.attr('title'),
    pod.cssFirst('p.price_color')?.text(),
    pod.cssFirst('p.star-rating')?.attr('class'),
  ]);
  const byXPath = doc.xpath("//article[@class='product_pod']").map((pod) => [
    pod.xpathValue('.//h3/a/@title'),
    pod.xpathValue(".//p[@class='price_color']"),
    pod.xpathValue(".//p[contains(@class,'star-rating')]/@class"),
  ]);
  assert.equal(byFind.length, 20);
  assert.deepEqual(byCss, byFind);
  assert.deepEqual(byXPath, byFind);
});

// CR LF and a lone CR are LF in values, as a browser reads the page; a CR written as a character reference stays.
test('line breaks are read as in a browser', () => {
  const doc = parse(
    '<meta name="d" content="one\r\ntwo\rthree&#13;four">' +
      '<textarea>a\r\nb</textarea><pre>c\r\nd</pre><div class="x\r\ny">t</div>',
  );
  const div = doc.find(by(Tag.Div))!;
  assert.equal(doc.find(by(Tag.Meta))?.attr('content'), 'one\ntwo\nthree\rfour');
  assert.equal(doc.find(by(Tag.Textarea))?.text(), 'a\nb');
  assert.equal(doc.find(by(Tag.Pre))?.text(), 'c\nd');
  assert.equal(doc.xpathValue('//textarea/text()'), 'a\nb');
  assert.equal(doc.xpathValue('//meta/@content'), 'one\ntwo\nthree\rfour');
  assert.equal(div.attrRaw('class'), 'x\r\ny');
  assert.ok(div.hasClass('y'));
  assert.ok(div.is(any().attr('class', 'x\ny')));
  assert.equal(doc.css('div[class="x\\a y"]').length, 1);
});

test('optional end tags, as in a browser', () => {
  const doc = parse('<ul><li>one<li>two<ul><li>a<li>b</ul><li>three</ul><table><tr><td>1<td>2<tr><td>3</table><p>x<div>y</div>');
  assert.deepEqual(doc.css('ul > li').map((n) => n.name + n.depth), ['li1', 'li1', 'li3', 'li3', 'li1']);
  assert.deepEqual(doc.cssFirst('ul')!.css('> li').map((n) => n.textLineBreaks()), ['one', 'two\na\nb', 'three']);
  assert.deepEqual(doc.css('tr').map((n) => n.children().length), [2, 1]);
  assert.equal(doc.cssFirst('div')?.parent(), null, '<div> ends an open <p>');
});

test('text, entities, raw text and comments', () => {
  const doc = parse('<div> a &amp;&nbsp;b <script>var x = "<b>";</script><!-- c --> <i>d</i>&copy2024 </div><title>a &lt; b</title>');
  assert.equal(doc.cssFirst('div')?.text(), 'a & b d©2024');
  assert.equal(doc.cssFirst('title')?.text(), 'a < b');
  assert.equal(doc.xpathValue('//comment()'), ' c ');
  assert.equal(htmlToText('<p>one</p><p>two&nbsp;three</p>'), 'onetwo three');
  assert.equal(htmlToTextLineBreaks('<p>one</p><p>two<br>three</p><td>x</td><td>y</td>'), 'one\n\ntwo\nthree\n\nx y');
  assert.equal(decodeHtml('&lt;&#x41;&#66;&bogus;'), '<AB&bogus;');
});

test('attributes', () => {
  const doc = parse(`<a href=/p?a=1&copy=2 title="see id=5" data-x='<b>' id=main CLASS="One two" hidden>x</a>`);
  const a = doc.cssFirst('a')!;
  assert.equal(a.attr('href'), '/p?a=1&copy=2');
  assert.equal(a.attr('id'), 'main');
  assert.equal(a.attr('data-x'), '<b>');
  assert.equal(a.attr('hidden'), '');
  assert.equal(a.attr('missing'), '');
  assert.ok(a.hasClass('one') && a.hasClass('TWO') && !a.hasClass('on'));
  assert.deepEqual(a.attrs().map(([n]) => n), ['href', 'title', 'data-x', 'id', 'CLASS', 'hidden']);
  assert.ok(a.isCss('[hidden]') && a.isCss('a#main.One'));
  assert.equal(a.source(), `a href=/p?a=1&copy=2 title="see id=5" data-x='<b>' id=main CLASS="One two" hidden`);
});

test('links', () => {
  const doc = parse(
    '<a href="../x/y.html?q=1#f">1</a><a href="//cdn.example.com/a b">2</a><a href="">3</a>' +
      '<a href="mailto:me@example.com?subject=hi">4</a><a href="tel:+1 555">5</a><a href="https://Other.org/%7Ea">6</a>',
    'https://Example.com:443/catalog/page/index.html?sort=asc#top',
  );
  const [a, b, c, d, e, f] = doc.css('a');
  assert.equal(a.href(), 'https://example.com/catalog/x/y.html?q=1#f');
  assert.equal(b.href(), 'https://cdn.example.com/a b');
  assert.equal(c.href(), 'https://Example.com:443/catalog/page/index.html?sort=asc#top');
  assert.equal(d.hrefMailTo(), 'me@example.com?subject=hi');
  assert.equal(e.hrefTelephone(), '+1 555');
  assert.equal(f.href(), 'https://Other.org/%7Ea', 'absolute links are returned as written');
  assert.equal(a.hrefFrom('http://h.test/a/b/'), 'http://h.test/a/x/y.html?q=1#f');
});

test('compiled queries and errors', () => {
  const doc = parse('<ul><li>1</li><li>2</li><li>3</li></ul>');
  const q = XPathQuery.compile('//li[position() > 1]');
  assert.deepEqual(q.values(doc), ['2', '3']);
  assert.equal(XPathQuery.compile('//nothing').value(doc), null);
  assert.equal(doc.xpathValue('sum(//li) div count(//li)'), '2');
  assert.equal(doc.xpathValue('1 div 3'), '0.3333333333333333');
  assert.equal(doc.xpathValue('1000000 * 1000000 * 1000000 * 1000'), '1000000000000000000000');
  assert.equal(doc.xpathValue('1 div 10000000'), '0.0000001');
  assert.throws(() => XPathQuery.compile('//li['), XPathError);
  assert.throws(() => doc.xpath('count(//li)'), TypeError);
  assert.throws(() => CssQuery.compile('li::before'), CssSelectorError);
  assert.throws(() => doc.css('li:unknown'), CssSelectorError);
  const css = CssQuery.compile('li:nth-child(2n+1)');
  assert.deepEqual(css.all(doc).map((n) => n.text()), ['1', '3']);
  assert.ok(css.matches(doc.nodes[1]));
  assert.deepEqual(doc.cssFirst('ul')!.css('> li:last-child').map((n) => n.text()), ['3']);
  assert.ok(byName('LI').matches(doc.nodes[1]));
});

test('navigation', () => {
  const doc = parse('<div><h2>A</h2><p>1</p><p>2</p><h2>B</h2></div>after');
  const h2 = doc.cssFirst('h2')!;
  assert.equal(h2.nextSibling()?.text(), '1');
  assert.equal(h2.nextSiblingByName(Tag.H2)?.text(), 'B');
  assert.equal(h2.next()?.name, 'p');
  assert.equal(doc.css('h2')[1].previousSiblingByName(Tag.H2)?.text(), 'A');
  assert.equal(h2.parent()?.name, 'div');
  assert.deepEqual(doc.cssFirst('div')!.children().map((n: HtmlNode) => n.name), ['h2', 'p', 'p', 'h2']);
  assert.equal(doc.cssFirst('div')!.textAfterTagUntilNextOne(), 'after');
  assert.equal(h2.textAfterUntilTagByName(Tag.H2), '<p>1</p><p>2</p>');
  assert.equal(doc.cssFirst('div')!.body(), '<h2>A</h2><p>1</p><p>2</p><h2>B</h2>');
  assert.equal(doc.length, 5);
});

test('bytes are read as UTF-8', () => {
  const doc = parse(new TextEncoder().encode('<p>héllo 😀</p>'));
  assert.equal(doc.cssFirst('p')?.text(), 'héllo 😀');
});

// Descendant and ancestor steps on nodes inside one another: n nested input nodes would collect about n² nodes
// before the duplicates were removed. They stay linear.
test('XPath on nested nodes is linear', async (t) => {
  const many = 100_000;
  const pages: Record<string, string> = {
    'unclosed nesting': '<div><span>'.repeat(many / 2) + '<a href="/x">link</a>',
    'many links in deep nesting': '<span>'.repeat(1000) + '<a href="/x">x</a>'.repeat(many),
    'nested lists': '<div><ul><li><a href="/x">x</a>'.repeat(many / 4),
  };
  for (const [name, page] of Object.entries(pages)) {
    await t.test(name, () => {
      const doc = parse(page);
      const links = doc.findAll(by(Tag.A));
      const started = performance.now();
      const descendants = doc.xpath('//*//*//a').length;
      const inDiv = doc.xpath('//div//a[@href]').length;
      const ancestors = doc.xpathValue('count(//a/ancestor::*)');
      const self = doc.xpath('//a/ancestor-or-self::*[@href]').length;
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 10_000, `took ${elapsed} ms`);

      let wantDescendants = 0;
      let wantInDiv = 0;
      const seen = new Set<HtmlNode>();
      for (const a of links) {
        if (a.depth >= 2) wantDescendants++;
        if (a.parentByName(Tag.Div) !== null) wantInDiv++;
        for (let p = a.parent(); p !== null && !seen.has(p); p = p.parent()) seen.add(p);
      }
      assert.deepEqual([descendants, inDiv, ancestors, self], [wantDescendants, wantInDiv, String(seen.size), links.length]);
    });
  }
});
