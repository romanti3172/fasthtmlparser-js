// Links: href / src made absolute against the page URL, written as .NET's System.Uri writes them.
//
// Resolution follows RFC 3986 the way the Go port does it (net/url: Parse + ResolveReference), byte for byte:
// URLs are handled as "byte strings" (one char per UTF-8 byte), so percent-escapes of non-ASCII text work as in Go.

import { equalFold, isHexChar, trimSpace } from './chars.ts';
import { decode } from './decode.ts';

/** A parsed URL; every string is a byte string (char codes 0..255, the UTF-8 bytes). */
export interface Url {
  scheme: string;
  opaque: string;
  user: string | null; // the userinfo as written back (escaped), or null
  host: string;
  path: string; // decoded
  rawPath: string; // the path as written, when it differs from the default escaping of path
  forceQuery: boolean;
  rawQuery: string;
  fragment: string; // decoded
  rawFragment: string;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

function toBytes(s: string): string {
  let ascii = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (ascii) return s;
  const bytes = utf8Encoder.encode(s);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function fromBytes(b: string): string {
  let ascii = true;
  for (let i = 0; i < b.length; i++) {
    if (b.charCodeAt(i) >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (ascii) return b;
  const bytes = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i);
  return utf8Decoder.decode(bytes);
}

function isValidUtf8(b: string): boolean {
  let i = 0;
  while (i < b.length) {
    const c = b.charCodeAt(i);
    let need: number;
    let min: number;
    if (c < 0x80) {
      i++;
      continue;
    } else if (c >= 0xc2 && c <= 0xdf) {
      need = 1;
      min = 0x80;
    } else if (c >= 0xe0 && c <= 0xef) {
      need = 2;
      min = 0x800;
    } else if (c >= 0xf0 && c <= 0xf4) {
      need = 3;
      min = 0x10000;
    } else return false;
    let cp = c & (need === 1 ? 0x1f : need === 2 ? 0x0f : 0x07);
    for (let k = 1; k <= need; k++) {
      if (i + k >= b.length) return false;
      const d = b.charCodeAt(i + k);
      if ((d & 0xc0) !== 0x80) return false;
      cp = (cp << 6) | (d & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
    i += need + 1;
  }
  return true;
}

// ----- net/url escaping -----

const Mode = { Path: 0, Host: 1, UserPassword: 2, Fragment: 3 } as const;
type Mode = (typeof Mode)[keyof typeof Mode];

class UrlError extends Error {}

function isAlnumByte(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57);
}

function shouldEscape(c: number, mode: Mode): boolean {
  if (isAlnumByte(c)) return false;
  if (mode === Mode.Host) {
    switch (c) {
      case 33: case 36: case 38: case 39: case 40: case 41: case 42: case 43: case 44: case 59: case 61: case 58:
      case 91: case 93: case 60: case 62: case 34: // ! $ & ' ( ) * + , ; = : [ ] < > "
        return false;
    }
  }
  switch (c) {
    case 45: case 95: case 46: case 126: // - _ . ~
      return false;
    case 36: case 38: case 43: case 44: case 47: case 58: case 59: case 61: case 63: case 64: // $ & + , / : ; = ? @
      switch (mode) {
        case Mode.Path:
          return c === 63;
        case Mode.UserPassword:
          return c === 64 || c === 47 || c === 63 || c === 58;
        case Mode.Fragment:
          return false;
      }
  }
  if (mode === Mode.Fragment && (c === 33 || c === 40 || c === 41 || c === 42)) return false;
  return true;
}

function unhex(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  return c - 55;
}

function unescape(s: string, mode: Mode): string {
  let n = 0;
  for (let i = 0; i < s.length; ) {
    const c = s.charCodeAt(i);
    if (c === 37) {
      n++;
      if (i + 2 >= s.length || !isHexChar(s.charCodeAt(i + 1)) || !isHexChar(s.charCodeAt(i + 2))) {
        throw new UrlError('invalid URL escape');
      }
      // in the host, %-encoding is only for non-ASCII bytes (and %25)
      if (mode === Mode.Host && unhex(s.charCodeAt(i + 1)) < 8 && s.slice(i, i + 3) !== '%25') {
        throw new UrlError('invalid URL escape');
      }
      i += 3;
    } else {
      if (mode === Mode.Host && c < 0x80 && shouldEscape(c, mode)) throw new UrlError('invalid character in host name');
      i++;
    }
  }
  if (n === 0) return s;
  let out = '';
  for (let i = 0; i < s.length; ) {
    if (s.charCodeAt(i) === 37) {
      out += String.fromCharCode((unhex(s.charCodeAt(i + 1)) << 4) | unhex(s.charCodeAt(i + 2)));
      i += 3;
    } else {
      out += s[i++];
    }
  }
  return out;
}

const upperHex = '0123456789ABCDEF';

function escape(s: string, mode: Mode): string {
  let out = '';
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (shouldEscape(c, mode)) {
      out += s.slice(from, i) + '%' + upperHex[c >> 4] + upperHex[c & 15];
      from = i + 1;
    }
  }
  return from === 0 ? s : out + s.slice(from);
}

function validEncoded(s: string, mode: Mode): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 33: case 36: case 38: case 39: case 40: case 41: case 42: case 43: case 44: case 59: case 61: case 58: case 64:
      case 91: case 93: case 37:
        break;
      default:
        if (shouldEscape(c, mode)) return false;
    }
  }
  return true;
}

// ----- parsing -----

function newUrl(): Url {
  return { scheme: '', opaque: '', user: null, host: '', path: '', rawPath: '', forceQuery: false, rawQuery: '', fragment: '', rawFragment: '' };
}

function getScheme(raw: string): [string, string] {
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) continue;
    if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
      if (i === 0) return ['', raw];
      continue;
    }
    if (c === 58) {
      if (i === 0) throw new UrlError('missing protocol scheme');
      return [raw.slice(0, i), raw.slice(i + 1)];
    }
    return ['', raw];
  }
  return ['', raw];
}

function setPath(u: Url, p: string): void {
  u.path = unescape(p, Mode.Path);
  u.rawPath = escape(u.path, Mode.Path) === p ? '' : p;
}

function escapedPath(u: Url): string {
  if (u.rawPath !== '' && validEncoded(u.rawPath, Mode.Path)) {
    try {
      if (unescape(u.rawPath, Mode.Path) === u.path) return u.rawPath;
    } catch {
      // fall through
    }
  }
  if (u.path === '*') return '*';
  return escape(u.path, Mode.Path);
}

function escapedFragment(u: Url): string {
  if (u.rawFragment !== '' && validEncoded(u.rawFragment, Mode.Fragment)) {
    try {
      if (unescape(u.rawFragment, Mode.Fragment) === u.fragment) return u.rawFragment;
    } catch {
      // fall through
    }
  }
  return escape(u.fragment, Mode.Fragment);
}

function validOptionalPort(port: string): boolean {
  if (port === '') return true;
  if (port.charCodeAt(0) !== 58) return false;
  for (let i = 1; i < port.length; i++) {
    const c = port.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

function parseHost(host: string): string {
  if (host.startsWith('[')) {
    const i = host.lastIndexOf(']');
    if (i < 0) throw new UrlError("missing ']' in host");
    if (!validOptionalPort(host.slice(i + 1))) throw new UrlError('invalid port');
  } else {
    const i = host.lastIndexOf(':');
    if (i >= 0 && !validOptionalPort(host.slice(i))) throw new UrlError('invalid port');
  }
  return unescape(host, Mode.Host);
}

function validUserinfo(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isAlnumByte(c)) continue;
    if ("-._:~!$&'()*+,;=%@".indexOf(s[i]) < 0) return false;
  }
  return true;
}

function parseAuthority(u: Url, authority: string): void {
  const i = authority.lastIndexOf('@');
  u.host = parseHost(i < 0 ? authority : authority.slice(i + 1));
  if (i < 0) return;
  const userinfo = authority.slice(0, i);
  if (!validUserinfo(userinfo)) throw new UrlError('invalid userinfo');
  const colon = userinfo.indexOf(':');
  if (colon < 0) {
    u.user = escape(unescape(userinfo, Mode.UserPassword), Mode.UserPassword);
  } else {
    const name = unescape(userinfo.slice(0, colon), Mode.UserPassword);
    const password = unescape(userinfo.slice(colon + 1), Mode.UserPassword);
    u.user = escape(name, Mode.UserPassword) + ':' + escape(password, Mode.UserPassword);
  }
}

function hasCtlByte(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** net/url Parse on a byte string; throws UrlError. */
function parseUrl(rawUrl: string): Url {
  const hash = rawUrl.indexOf('#');
  const rest0 = hash < 0 ? rawUrl : rawUrl.slice(0, hash);
  const u = parseNoFragment(rest0);
  if (hash >= 0) {
    const frag = rawUrl.slice(hash + 1);
    u.fragment = unescape(frag, Mode.Fragment);
    u.rawFragment = escape(u.fragment, Mode.Fragment) === frag ? '' : frag;
  }
  return u;
}

function parseNoFragment(raw: string): Url {
  if (hasCtlByte(raw)) throw new UrlError('invalid control character in URL');
  const u = newUrl();
  if (raw === '*') {
    u.path = '*';
    return u;
  }
  let rest: string;
  [u.scheme, rest] = getScheme(raw);
  u.scheme = u.scheme.toLowerCase();

  if (rest.endsWith('?') && rest.indexOf('?') === rest.length - 1) {
    u.forceQuery = true;
    rest = rest.slice(0, -1);
  } else {
    const q = rest.indexOf('?');
    if (q >= 0) {
      u.rawQuery = rest.slice(q + 1);
      rest = rest.slice(0, q);
    }
  }

  if (!rest.startsWith('/')) {
    if (u.scheme !== '') {
      // rootless paths are opaque (RFC 3986)
      u.opaque = rest;
      return u;
    }
    // a relative-path reference: the first segment cannot contain ':'
    const slash = rest.indexOf('/');
    if ((slash < 0 ? rest : rest.slice(0, slash)).indexOf(':') >= 0) {
      throw new UrlError('first path segment in URL cannot contain colon');
    }
  }

  if ((u.scheme !== '' || !rest.startsWith('///')) && rest.startsWith('//')) {
    let authority = rest.slice(2);
    rest = '';
    const slash = authority.indexOf('/');
    if (slash >= 0) {
      rest = authority.slice(slash);
      authority = authority.slice(0, slash);
    }
    parseAuthority(u, authority);
  }
  setPath(u, rest);
  return u;
}

function resolvePath(base: string, ref: string): string {
  let full: string;
  if (ref === '') full = base;
  else if (ref.charCodeAt(0) !== 47) full = base.slice(0, base.lastIndexOf('/') + 1) + ref;
  else full = ref;
  if (full === '') return '';

  let dst = '/';
  let first = true;
  let remaining = full;
  let found = true;
  let elem = '';
  while (found) {
    const slash = remaining.indexOf('/');
    found = slash >= 0;
    elem = found ? remaining.slice(0, slash) : remaining;
    remaining = found ? remaining.slice(slash + 1) : '';
    if (elem === '.') {
      first = false;
      continue;
    }
    if (elem === '..') {
      const str = dst.slice(1);
      const index = str.lastIndexOf('/');
      dst = '/';
      if (index === -1) first = true;
      else dst += str.slice(0, index);
    } else {
      if (!first) dst += '/';
      dst += elem;
      first = false;
    }
  }
  if (elem === '.' || elem === '..') dst += '/';
  if (dst.length > 1 && dst.charCodeAt(1) === 47) dst = dst.slice(1);
  return dst;
}

/** net/url ResolveReference. */
function resolveReference(base: Url, ref: Url): Url {
  const url: Url = { ...ref };
  if (ref.scheme === '') url.scheme = base.scheme;
  if (ref.scheme !== '' || ref.host !== '' || ref.user !== null) {
    setPath(url, resolvePath(escapedPath(ref), ''));
    return url;
  }
  if (ref.opaque !== '') {
    url.user = null;
    url.host = '';
    url.path = '';
    return url;
  }
  if (ref.path === '' && !ref.forceQuery && ref.rawQuery === '') {
    url.rawQuery = base.rawQuery;
    if (ref.fragment === '') {
      url.fragment = base.fragment;
      url.rawFragment = base.rawFragment;
    }
  }
  if (ref.path === '' && base.opaque !== '') {
    url.opaque = base.opaque;
    url.user = null;
    url.host = '';
    url.path = '';
    return url;
  }
  url.host = base.host;
  url.user = base.user;
  setPath(url, resolvePath(escapedPath(base), escapedPath(ref)));
  return url;
}

const defaultPorts: Record<string, string> = { http: '80', https: '443', ftp: '21', ws: '80', wss: '443' };

function splitHostPort(hostPort: string): [string, string] {
  let host = hostPort;
  let port = '';
  const colon = host.lastIndexOf(':');
  if (colon !== -1 && validOptionalPort(host.slice(colon))) {
    port = host.slice(colon + 1);
    host = host.slice(0, colon);
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return [host, port];
}

const reservedForDisplay = "%/?#[]@:!$&'()*+,;=";

/**
 * Decodes %XX escapes except those of reserved and control characters; escaped bytes of non-ASCII text are decoded
 * when they form valid UTF-8 (byte string in, byte string out).
 */
function unescapeForDisplay(s: string): string {
  if (s.indexOf('%') < 0) return s;
  let out = '';
  for (let i = 0; i < s.length; ) {
    if (s.charCodeAt(i) !== 37 || i + 2 >= s.length || !isHexChar(s.charCodeAt(i + 1)) || !isHexChar(s.charCodeAt(i + 2))) {
      out += s[i++];
      continue;
    }
    const c = (unhex(s.charCodeAt(i + 1)) << 4) | unhex(s.charCodeAt(i + 2));
    if (c < 0x80) {
      if (c < 0x20 || c === 0x7f || reservedForDisplay.indexOf(String.fromCharCode(c)) >= 0) out += s.slice(i, i + 3);
      else out += String.fromCharCode(c);
      i += 3;
      continue;
    }
    // a run of escaped bytes >= 0x80: decoded together when it is valid UTF-8
    let j = i;
    let run = '';
    while (j + 2 < s.length && s.charCodeAt(j) === 37 && isHexChar(s.charCodeAt(j + 1)) && isHexChar(s.charCodeAt(j + 2))) {
      const v = (unhex(s.charCodeAt(j + 1)) << 4) | unhex(s.charCodeAt(j + 2));
      if (v < 0x80) break;
      run += String.fromCharCode(v);
      j += 3;
    }
    out += isValidUtf8(run) ? run : s.slice(i, j);
    i = j;
  }
  return out;
}

/**
 * Writes a resolved URL as the .NET version does (System.Uri.ToString): the scheme and host in lower case,
 * no default port, an empty path as "/", and percent-escapes decoded except those of the characters that delimit
 * URL parts ("%2F" stays) and of control characters; non-ASCII text is written as is.
 */
function displayString(u: Url): string {
  let b = u.scheme.toLowerCase() + ':';
  if (u.opaque !== '') {
    b += u.opaque;
  } else {
    if (u.host !== '' || u.user !== null) {
      b += '//';
      if (u.user !== null) b += u.user + '@';
      const [host, port] = splitHostPort(u.host);
      b += toBytes(fromBytes(host).toLowerCase());
      if (port !== '' && port !== defaultPorts[u.scheme.toLowerCase()]) b += ':' + port;
    }
    let path = escapedPath(u);
    if (path === '' && u.host !== '') path = '/';
    b += unescapeForDisplay(path);
  }
  if (u.rawQuery !== '' || u.forceQuery) b += '?' + unescapeForDisplay(u.rawQuery);
  if (u.fragment !== '') b += '#' + unescapeForDisplay(escapedFragment(u));
  return fromBytes(b);
}

/** Parses a page URL with its own scheme and host; null for anything else. */
export function absoluteUrl(s: string): Url | null {
  if (s === '') return null;
  try {
    const u = parseUrl(toBytes(s));
    if (u.scheme === '' || (u.host === '' && u.opaque === '' && !equalFold(u.scheme, 'file'))) return null;
    return u;
  } catch (e) {
    if (e instanceof UrlError) return null;
    throw e;
  }
}

/** A link with its own scheme ("https://…", "mailto:…", "file:…"). "/path" and "//host/path" are relative. */
function isAbsoluteLink(link: string): boolean {
  try {
    return parseUrl(toBytes(trimSpace(link))).scheme !== '';
  } catch (e) {
    if (e instanceof UrlError) return false;
    throw e;
  }
}

/**
 * The raw attribute value with its character references decoded and made absolute against the page.
 * Percent-escapes are part of the URL and are kept. An empty link gives the page URL.
 */
export function correctLink(raw: string, pageUrl: string, base: Url | null): string {
  if (raw === '') return pageUrl;
  const link = decode(raw, true);
  if (base === null || isAbsoluteLink(link)) return link;
  let ref: Url;
  try {
    ref = parseUrl(toBytes(trimSpace(link)));
  } catch (e) {
    if (e instanceof UrlError) return link;
    throw e;
  }
  return displayString(resolveReference(base, ref));
}

/** Everything after the first ':' of a link with the scheme (mailto, tel), or "". */
export function afterScheme(rawHref: string, scheme: string): string {
  const href = trimSpace(decode(rawHref, true));
  if (href.length < scheme.length || !equalFold(href.slice(0, scheme.length), scheme)) return '';
  const i = href.indexOf(':');
  return i >= 0 ? href.slice(i + 1) : '';
}
