/**
 * z3l-fasthtmlparser: a fast HTML / XML parser for scraping, with XPath 1.0 and CSS selectors.
 * A JavaScript port of z3l.FastHtmlParser (.NET).
 *
 * A document is a flat list of tags in document order; each tag holds only positions in the source.
 * Text, attributes and entities are read lazily, when they are asked for.
 *
 * @example
 * import { parse, Tag } from 'z3l-fasthtmlparser';
 * const doc = parse(html, 'https://example.com/catalog/');
 * for (const pod of doc.css('article.product_pod')) {
 *   const title = pod.cssFirst('h3 a')?.attr('title');
 *   const price = pod.findByNameClass(Tag.P, 'price_color')?.text();
 * }
 * doc.xpathValue("//dt[.='Price']/following-sibling::dd[1]");
 */

export {
  parse,
  HtmlDocument,
  HtmlNode,
  Query,
  by,
  byName,
  any,
  firstLevel,
  firstLevelByName,
  firstLevelByNameClass,
  htmlToText,
  htmlToTextLineBreaks,
  type TagName,
} from './document.ts';
export { CssQuery, CssSelectorError } from './css.ts';
export { XPathQuery, XPathError } from './xpath.ts';
export { decodeHtml } from './decode.ts';
export { Tag, tagNames } from './names.ts';
export { Attr } from './attributes.ts';
