// Writes the one-call shortcuts of z3l.FastHtmlParser (findByNameClass, findAllByNameItemprop, isNameClass,
// parentByName, ...) into src/document.ts, between the "// <shortcuts ...>" markers. Each one builds a Query and
// calls find, findAll, is or a navigation method; find and findAll shortcuts go to both HtmlDocument and HtmlNode.
//
//   node tools/gen-shortcuts.mjs
import { readFileSync, writeFileSync } from 'node:fs';

// [name, params, query, guard, doc]
const finds = [
  ['findById', 'id: string', 'any().id(id)', "id === ''", 'the first tag with the id'],
  ['findByName', 'name: TagName', 'by(name)', '', 'the first tag with the name'],
  ['findByNameBody', 'name: TagName, body: string', 'by(name).body(body)', '', 'the first tag with the name and the inner HTML'],
  ['findByNameAttribute', 'name: TagName, attribute: string, value: string', 'by(name).attr(attribute, value)', '', 'the first tag with the name and the decoded attribute value'],
  ['findByNameClass', 'name: TagName, cls: string', 'by(name).class(cls)', '', 'the first tag with the name and the class'],
  ['findByNameClassBody', 'name: TagName, cls: string, body: string', 'by(name).class(cls).body(body)', '', 'the first tag with the name, the class and the inner HTML'],
  ['findByNameClassText', 'name: TagName, cls: string, text: string', 'optText(optClass(by(name), cls), text)', '', 'the first tag with the name, and the class and visible text when they are not empty'],
  ['findByNameIdText', 'name: TagName, id: string, text: string', 'optText(optId(by(name), id), text)', '', 'the first tag with the name, and the id and visible text when they are not empty'],
  ['findByNameText', 'name: TagName, text: string', 'by(name).text(text)', '', 'the first tag with the name and the visible text'],
  ['findByNameId', 'name: TagName, id: string', 'by(name).id(id)', '', 'the first tag with the name and the id'],
  ['findByNameIdStartsWith', 'name: TagName, idPrefix: string', 'by(name).idStartsWith(idPrefix)', '', 'the first tag with the name whose id starts with the prefix'],
  ['findByNameBodyStartsWith', 'name: TagName, bodyPrefix: string', 'by(name).bodyStartsWith(bodyPrefix)', '', 'the first tag with the name whose inner HTML starts with the prefix'],
  ['findByNameTextStartsWith', 'name: TagName, textPrefix: string', 'by(name).textStartsWith(textPrefix)', "textPrefix === ''", 'the first tag with the name whose visible text starts with the prefix'],
  ['findByNameClassTextStartsWith', 'name: TagName, cls: string, textPrefix: string', 'by(name).class(cls).textStartsWith(textPrefix)', "textPrefix === ''", 'the first tag with the name and the class whose visible text starts with the prefix'],
  ['findByNameItemprop', 'name: TagName, itemprop: string', 'by(name).attr(Attr.Itemprop, itemprop)', '', 'the first tag with the name and the itemprop'],
];

const findAlls = [
  ['findAllByName', 'name: TagName', 'by(name)', 'all tags with the name'],
  ['findAllByNameAttribute', 'name: TagName, attribute: string, value: string', 'by(name).attr(attribute, value)', 'all tags with the name and the decoded attribute value'],
  ['findAllByNameClass', 'name: TagName, cls: string', 'by(name).class(cls)', 'all tags with the name and the class'],
  ['findAllByNameId', 'name: TagName, id: string', 'by(name).id(id)', 'all tags with the name and the id'],
  ['findAllByNameIdStartsWith', 'name: TagName, idPrefix: string', 'by(name).idStartsWith(idPrefix)', 'all tags with the name whose id starts with the prefix'],
  ['findAllByNameItemprop', 'name: TagName, itemprop: string', 'by(name).attr(Attr.Itemprop, itemprop)', 'all tags with the name and the itemprop'],
  ['findAllByNameBodyStartsWith', 'name: TagName, bodyPrefix: string', 'by(name).bodyStartsWith(bodyPrefix)', 'all tags with the name whose inner HTML starts with the prefix'],
];

const iss = [
  ['isNameAttribute', 'name: TagName, attribute: string, value: string', 'by(name).attr(attribute, value)', 'the tag has the name and the decoded attribute value'],
  ['isNameBody', 'name: TagName, body: string', 'by(name).body(body)', 'the tag has the name and the inner HTML'],
  ['isNameText', 'name: TagName, text: string', 'by(name).text(text)', 'the tag has the name and the visible text'],
  ['isNameClass', 'name: TagName, cls: string', 'by(name).class(cls)', 'the tag has the name and the class'],
  ['isNameClassBody', 'name: TagName, cls: string, body: string', 'by(name).class(cls).body(body)', 'the tag has the name, the class and the inner HTML'],
  ['isNameClassIdBody', 'name: TagName, cls: string, id: string, body: string', 'optBody(optId(optClass(by(name), cls), id), body)', 'the tag has the name, and the class, id and inner HTML when they are not empty'],
  ['isNameClassText', 'name: TagName, cls: string, text: string', 'optText(optClass(by(name), cls), text)', 'the tag has the name, and the class and visible text when they are not empty'],
  ['isNameIdText', 'name: TagName, id: string, text: string', 'optText(optId(by(name), id), text)', 'the tag has the name, and the id and visible text when they are not empty'],
  ['isNameId', 'name: TagName, id: string', 'by(name).id(id)', 'the tag has the name and the id'],
  ['isNameTextStartsWith', 'name: TagName, textPrefix: string', 'by(name).textStartsWith(textPrefix)', 'the tag has the name and its visible text starts with the prefix'],
  ['isNameBodyStartsWith', 'name: TagName, bodyPrefix: string', 'by(name).bodyStartsWith(bodyPrefix)', 'the tag has the name and its inner HTML starts with the prefix'],
  ['isNameClassTextStartsWith', 'name: TagName, cls: string, textPrefix: string', 'by(name).class(cls).textStartsWith(textPrefix)', 'the tag has the name and the class and its visible text starts with the prefix'],
  ['isNameIdStartsWith', 'name: TagName, idPrefix: string', 'by(name).idStartsWith(idPrefix)', 'the tag has the name and its id starts with the prefix'],
  ['isNameItemprop', 'name: TagName, itemprop: string', 'by(name).attr(Attr.Itemprop, itemprop)', 'the tag has the name and the itemprop'],
  ['isNameSource', 'name: TagName, source: string', 'by(name).source(source)', "the tag has the name and its opening tag (without '<' and '>') equals source"],
];

// [name, params, call, result, doc]
const navs = [
  ['parentByName', 'name: TagName', 'this.parentMatching(by(name))', 'HtmlNode | null', 'the nearest enclosing tag with the name'],
  ['parentByNameClass', 'name: TagName, cls: string', 'this.parentMatching(by(name).class(cls))', 'HtmlNode | null', 'the nearest enclosing tag with the name and the class'],
  ['nextByName', 'name: TagName', 'this.nextMatching(by(name))', 'HtmlNode | null', 'the first tag with the name after the end of this one'],
  ['nextByNameClass', 'name: TagName, cls: string', 'this.nextMatching(by(name).class(cls))', 'HtmlNode | null', 'the first tag with the name and the class after the end of this one'],
  ['nextSiblingByName', 'name: TagName', 'this.nextSiblingMatching(by(name))', 'HtmlNode | null', 'the next sibling with the name'],
  ['nextSiblingByNameClass', 'name: TagName, cls: string', 'this.nextSiblingMatching(by(name).class(cls))', 'HtmlNode | null', 'the next sibling with the name and the class'],
  ['previousSiblingByName', 'name: TagName', 'this.previousSiblingMatching(by(name))', 'HtmlNode | null', 'the nearest previous sibling with the name'],
  ['textAfterUntilTagByName', 'name: TagName', 'this.textAfterUntil(by(name))', 'string', 'the source between the end of this tag and the next tag with the name'],
  ['textAfterUntilTagByNameClass', 'name: TagName, cls: string', 'this.textAfterUntil(by(name).class(cls))', 'string', 'the source between the end of this tag and the next tag with the name and the class'],
];

const attributes = [
  ['attributeAlt', 'Alt'], ['attributeClass', 'Class'], ['attributeContent', 'Content'],
  ['attributeId', 'Id'], ['attributeItemProp', 'Itemprop'], ['attributeName', 'Name'],
  ['attributeStyle', 'Style'], ['attributeTitle', 'Title'], ['attributeValue', 'Value'],
];

function block(scope) {
  let b = '  // Generated by tools/gen-shortcuts.mjs; do not edit by hand.\n\n';
  for (const [name, params, query, guard, doc] of finds) {
    b += `  /** Returns ${doc} ${scope}, or null. */\n  ${name}(${params}): HtmlNode | null {\n`;
    if (guard) b += `    if (${guard}) return null;\n`;
    b += `    return this.find(${query});\n  }\n\n`;
  }
  for (const [name, params, query, doc] of findAlls) {
    b += `  /** Returns ${doc} ${scope}. */\n  ${name}(${params}): HtmlNode[] {\n    return this.findAll(${query});\n  }\n\n`;
  }
  return b;
}

let node = block('inside the tag');
for (const [name, params, query, doc] of iss) {
  node += `  /** Whether ${doc}. */\n  ${name}(${params}): boolean {\n    return this.is(${query});\n  }\n\n`;
}
for (const [name, params, call, result, doc] of navs) {
  node += `  /** Returns ${doc}. */\n  ${name}(${params}): ${result} {\n    return ${call};\n  }\n\n`;
}
for (const [method, constant] of attributes) {
  node += `  /** The decoded value of the ${Object.is(constant, 'Itemprop') ? 'itemprop' : constant.toLowerCase()} attribute. */\n  ${method}(): string {\n    return this.attr(Attr.${constant});\n  }\n\n`;
}

const file = new URL('../src/document.ts', import.meta.url);
let text = readFileSync(file, 'utf8');
for (const [scope, code] of [['document', block('in the document')], ['node', node]]) {
  const open = `  // <shortcuts ${scope}>\n`;
  const close = `  // </shortcuts ${scope}>\n`;
  const a = text.indexOf(open);
  const z = text.indexOf(close);
  if (a < 0 || z < 0) throw new Error('markers for ' + scope + ' not found');
  text = text.slice(0, a + open.length) + code.trimEnd() + '\n' + text.slice(z);
}
writeFileSync(file, text);
console.log(`${2 * (finds.length + findAlls.length) + iss.length + navs.length + attributes.length} shortcuts`);
