// Benchmarks of fasthtmlparser against other JS HTML parsers: parsing pages, and scraping records
// (parse + extract). Every scraper is first checked to return exactly the same records.
//
//   npm install && npm run bench          (in this folder; build the library first: npm run build in ..)
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import * as fh from 'z3l-fasthtmlparser';
import * as cheerio from 'cheerio';
import { parseDocument } from 'htmlparser2';
import { parse as parse5 } from 'parse5';
import { parse as nhpParse } from 'node-html-parser';
import { parseHTML } from 'linkedom';
import { JSDOM } from 'jsdom';

const read = (name) => readFileSync(new URL(`../testdata/${name}`, import.meta.url), 'utf8');
const books = read('books/index.html');
const quotes = read('quotes/page1.html');
const laptops = read('webscraper/laptops.html');
const pages = [
  ['quotes, 11 KB', quotes],
  ['laptops, 38 KB', laptops],
  ['books, 51 KB', books],
  ['books x10, 510 KB', books.repeat(10)],
  ['books without </li> </p>', books.replaceAll('</li>', '').replaceAll('</p>', '')],
];

/** Median time per call in microseconds: batches of calls for about `seconds`, after a warm-up. */
function measure(fn, seconds = 1.5) {
  let batch = 1;
  for (;;) {
    const t = performance.now();
    for (let i = 0; i < batch; i++) fn();
    if (performance.now() - t > 20) break;
    batch *= 2;
  }
  const until = performance.now() + 300;
  while (performance.now() < until) fn(); // warm-up
  globalThis.gc?.();
  const samples = [];
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    const t = performance.now();
    for (let i = 0; i < batch; i++) fn();
    samples.push(((performance.now() - t) * 1000) / batch);
  }
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1];
}

const fmt = (us) => (us >= 1000 ? `${(us / 1000).toFixed(2)} ms` : `${Math.round(us).toLocaleString('en-US')} μs`);

// ----- scrapers -----

const lastWord = (s) => s.slice(s.lastIndexOf(' ') + 1);

const scrapers = {
  books: {
    'fasthtmlparser find': (page) =>
      fh.parse(page).findAll(fh.by(fh.Tag.Article).class('product_pod')).map((pod) => [
        pod.find(fh.by(fh.Tag.H3))?.find(fh.by(fh.Tag.A))?.attr('title'),
        pod.find(fh.by(fh.Tag.P).class('price_color'))?.text(),
        lastWord(pod.find(fh.by(fh.Tag.P).class('star-rating'))?.attr('class') ?? ''),
      ]),
    'fasthtmlparser CSS': (page) =>
      fh.parse(page).css('article.product_pod').map((pod) => [
        pod.cssFirst('h3 a')?.attr('title'),
        pod.cssFirst('p.price_color')?.text(),
        lastWord(pod.cssFirst('p.star-rating')?.attr('class') ?? ''),
      ]),
    'fasthtmlparser XPath': (page) =>
      fh.parse(page).xpath("//article[@class='product_pod']").map((pod) => [
        pod.xpathValue('.//h3/a/@title'),
        pod.xpathValue(".//p[@class='price_color']"),
        lastWord(pod.xpathValue(".//p[contains(@class,'star-rating')]/@class")),
      ]),
    cheerio: (page) => {
      const $ = cheerio.load(page);
      return $('article.product_pod')
        .map((_, pod) => [[
          $(pod).find('h3 a').attr('title'),
          $(pod).find('p.price_color').text().trim(),
          lastWord($(pod).find('p.star-rating').attr('class') ?? ''),
        ]])
        .get();
    },
    'node-html-parser': (page) =>
      nhpParse(page).querySelectorAll('article.product_pod').map((pod) => [
        pod.querySelector('h3 a')?.getAttribute('title'),
        pod.querySelector('p.price_color')?.text.trim(),
        lastWord(pod.querySelector('p.star-rating')?.getAttribute('class') ?? ''),
      ]),
    linkedom: (page) =>
      [...parseHTML(page).document.querySelectorAll('article.product_pod')].map((pod) => [
        pod.querySelector('h3 a')?.getAttribute('title'),
        pod.querySelector('p.price_color')?.textContent.trim(),
        lastWord(pod.querySelector('p.star-rating')?.getAttribute('class') ?? ''),
      ]),
    'jsdom XPath': (page) => {
      const { document, XPathResult } = new JSDOM(page).window;
      const value = (expr, node) => document.evaluate(expr, node, null, XPathResult.STRING_TYPE, null).stringValue;
      const pods = document.evaluate("//article[@class='product_pod']", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = [];
      for (let i = 0; i < pods.snapshotLength; i++) {
        const pod = pods.snapshotItem(i);
        out.push([value('.//h3/a/@title', pod), value(".//p[@class='price_color']", pod).trim(),
          lastWord(value(".//p[contains(@class,'star-rating')]/@class", pod))]);
      }
      return out;
    },
  },
  quotes: {
    'fasthtmlparser find': (page) =>
      fh.parse(page).findAll(fh.by(fh.Tag.Div).class('quote')).map((q) => [
        q.find(fh.by(fh.Tag.Span).class('text'))?.text(),
        q.find(fh.by(fh.Tag.Small).class('author'))?.text(),
        q.findAll(fh.by(fh.Tag.A).class('tag')).map((a) => a.text()).join(','),
      ]),
    'fasthtmlparser CSS': (page) =>
      fh.parse(page).css('div.quote').map((q) => [
        q.cssFirst('span.text')?.text(),
        q.cssFirst('small.author')?.text(),
        q.css('a.tag').map((a) => a.text()).join(','),
      ]),
    cheerio: (page) => {
      const $ = cheerio.load(page);
      return $('div.quote')
        .map((_, q) => [[
          $(q).find('span.text').text().trim(),
          $(q).find('small.author').text().trim(),
          $(q).find('a.tag').map((_, a) => $(a).text().trim()).get().join(','),
        ]])
        .get();
    },
    'node-html-parser': (page) =>
      nhpParse(page).querySelectorAll('div.quote').map((q) => [
        q.querySelector('span.text')?.text.trim(),
        q.querySelector('small.author')?.text.trim(),
        q.querySelectorAll('a.tag').map((a) => a.text.trim()).join(','),
      ]),
    linkedom: (page) =>
      [...parseHTML(page).document.querySelectorAll('div.quote')].map((q) => [
        q.querySelector('span.text')?.textContent.trim(),
        q.querySelector('small.author')?.textContent.trim(),
        [...q.querySelectorAll('a.tag')].map((a) => a.textContent.trim()).join(','),
      ]),
  },
};

// the same records from every scraper
for (const [name, page] of [['books', books], ['quotes', quotes]]) {
  const expected = scrapers[name]['fasthtmlparser find'](page);
  assert.equal(expected.length, name === 'books' ? 20 : 10);
  for (const [lib, scrape] of Object.entries(scrapers[name])) assert.deepEqual(scrape(page), expected, `${name}: ${lib}`);
}
console.log('every scraper returns the same records\n');

// ----- runs -----

const parsers = {
  fasthtmlparser: (p) => fh.parse(p),
  htmlparser2: (p) => parseDocument(p),
  'node-html-parser': (p) => nhpParse(p),
  parse5: (p) => parse5(p),
  'cheerio (parse5)': (p) => cheerio.load(p),
  linkedom: (p) => parseHTML(p),
};

console.log(`Node ${process.version}; median time per call\n`);
console.log('Parse a page:\n');
console.log(`| Page | ${Object.keys(parsers).join(' | ')} |`);
console.log(`|---|${Object.keys(parsers).map(() => '---:').join('|')}|`);
for (const [name, page] of pages) {
  const cells = Object.values(parsers).map((parse) => fmt(measure(() => parse(page))));
  console.log(`| ${name} | ${cells.join(' | ')} |`);
}

console.log('\nScrape a page (parse + extract the records):\n');
console.log('| Task | Time |\n|---|---:|');
for (const [name, page] of [['books', books], ['quotes', quotes]]) {
  for (const [lib, scrape] of Object.entries(scrapers[name])) console.log(`| ${name}, ${lib} | ${fmt(measure(() => scrape(page)))} |`);
}
