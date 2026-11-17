// The built package works as an ES module and as CommonJS (run after `npm run build`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const page = '<ul><li class="a">one</li><li>two &amp; three</li></ul>';

function check(lib) {
  const doc = lib.parse(page, 'https://example.com/');
  assert.equal(doc.cssFirst('li.a').text(), 'one');
  assert.equal(doc.xpathValue('//li[2]'), 'two & three');
  assert.equal(doc.findByNameClass(lib.Tag.Li, 'a').text(), 'one');
  assert.equal(lib.XPathQuery.compile('count(//li)').value(doc), '2');
}

test('ES module', async () => check(await import('z3l-fasthtmlparser')));
test('CommonJS', () => check(createRequire(import.meta.url)('z3l-fasthtmlparser')));
