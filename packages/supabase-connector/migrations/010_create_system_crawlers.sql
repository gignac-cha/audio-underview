-- Migration: System-owned crawlers that any caller can run by name

-- System user. It has no accounts row, so nobody can sign in as it.
INSERT INTO users (uuid) VALUES ('00000000-0000-0000-0000-000000000001')
ON CONFLICT (uuid) DO NOTHING;

-- A system crawler is looked up by name, so names are unique among system crawlers.
CREATE UNIQUE INDEX crawlers_system_name_unique_index
  ON crawlers (name)
  WHERE user_uuid = '00000000-0000-0000-0000-000000000001';

INSERT INTO crawlers (user_uuid, name, type, url_pattern, code)
VALUES ('00000000-0000-0000-0000-000000000001', 'geeknews-list', 'web', '^https://news\.hada\.io.*$', $system_crawler$
(html) => {
  const BASE = 'https://news.hada.io/';
  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', middot: '\u00b7', bull: '\u2022', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d' };
  const decode = (t) => t.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body.charCodeAt(0) === 35) {
      const isHex = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88;
      const cp = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff) { try { return String.fromCodePoint(cp); } catch (e) { return whole; } }
      return whole;
    }
    const r = NAMED[body.toLowerCase()];
    return r === undefined ? whole : r;
  });
  const strip = (h) => h.replace(/<[^>]+>/g, '');
  const resolve = (c, b) => { try { return new URL(c, b).href; } catch (e) { return c; } };
  const rowStart = /<div\s+class=['"]?topic_row['"]?[^>]*\bdata-topic-state-id=['"](\d+)['"]/gi;
  const starts = [];
  let m;
  while ((m = rowStart.exec(html)) !== null) starts.push({ topicId: m[1], index: m.index });
  const entries = [];
  for (let i = 0; i < starts.length; i++) {
    const block = html.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : html.length);
    const topicId = starts[i].topicId;
    const discussionUrl = resolve('topic?id=' + topicId, BASE);
    const tm = block.match(/<a\s+([^>]*?)>\s*<h2[^>]*class=['"][^'"]*topic-title-heading[^'"]*['"][^>]*>([\s\S]*?)<\/h2>/i);
    if (tm === null) continue;
    const title = decode(strip(tm[2])).replace(/\s+/g, ' ').trim();
    const hm = tm[1].match(/\bhref=['"]([^'"]+)['"]/i);
    const originalUrl = resolve(hm !== null ? hm[1] : 'topic?id=' + topicId, BASE);
    entries.push({ title, discussionUrl, originalUrl });
  }
  return entries;
}
$system_crawler$);

INSERT INTO crawlers (user_uuid, name, type, url_pattern, code)
VALUES ('00000000-0000-0000-0000-000000000001', 'geeknews-summary', 'web', '^https://news\.hada\.io/topic.*$', $system_crawler$
(html) => {
  if (typeof html !== 'string' || html.length === 0) return '';
  const MAX = 8000;
  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', middot: '\u00b7', bull: '\u2022', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d' };
  const decode = (t) => t.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body.charCodeAt(0) === 35) {
      const isHex = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88;
      const cp = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff) { try { return String.fromCodePoint(cp); } catch (e) { return whole; } }
      return whole;
    }
    const r = NAMED[body.toLowerCase()];
    return r === undefined ? whole : r;
  });
  const strip = (h) => h.replace(/<[^>]+>/g, '');
  const toText = (h) => {
    let t = h.replace(/<br\b[^>]*>/gi, '\n');
    t = t.replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|blockquote|pre)\s*>/gi, '\n');
    t = strip(t); t = decode(t);
    t = t.replace(/[ \t\f\v\u00a0]+/g, ' ');
    t = t.replace(/ *\n */g, '\n');
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  };
  const matchEnd = (h, openStart) => {
    const p = /<(\/?)div\b[^>]*>/gi;
    p.lastIndex = openStart;
    let depth = 0, mm;
    while ((mm = p.exec(h)) !== null) {
      if (mm[1] === '') depth++;
      else { depth--; if (depth === 0) return mm.index + mm[0].length; }
    }
    return null;
  };
  let inner = null;
  const bodyOpen = /<div\s+id=['"]?topic_contents['"]?\s*>/i.exec(html);
  if (bodyOpen !== null) {
    const end = matchEnd(html, bodyOpen.index);
    if (end !== null) inner = html.slice(bodyOpen.index + bodyOpen[0].length, end - 6);
  }
  if (inner === null) {
    const classOpen = /<div\s+class=['"]?topic_contents['"]?[^>]*>/i.exec(html);
    if (classOpen !== null) {
      const end = matchEnd(html, classOpen.index);
      if (end !== null) inner = html.slice(classOpen.index + classOpen[0].length, end - 6);
    }
  }
  if (inner === null) return '';
  const ct = inner.search(/<div[^>]*\bid=['"]?comment_thread/i);
  if (ct !== -1) inner = inner.slice(0, ct);
  const text = toText(inner);
  return text.length > MAX ? text.slice(0, MAX) : text;
}
$system_crawler$);

INSERT INTO crawlers (user_uuid, name, type, url_pattern, code)
VALUES ('00000000-0000-0000-0000-000000000001', 'article-content', 'web', '^https?://.+$', $system_crawler$
(html) => {
  if (typeof html !== 'string' || html.length === 0) return '';
  if (!/<[a-zA-Z!/]/.test(html)) return '';
  const MAX = 24000;
  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', middot: '\u00b7', bull: '\u2022', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', laquo: '\u00ab', raquo: '\u00bb', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0', times: '\u00d7', divide: '\u00f7' };
  const decode = (t) => t.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body.charCodeAt(0) === 35) {
      const isHex = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88;
      const cp = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff) { try { return String.fromCodePoint(cp); } catch (e) { return whole; } }
      return whole;
    }
    const r = NAMED[body.toLowerCase()];
    return r === undefined ? whole : r;
  });
  const strip = (h) => h.replace(/<[^>]+>/g, '');
  const removeBlocks = (h, tags) => {
    let w = h;
    for (const tag of tags) {
      w = w.replace(new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '>', 'gi'), ' ');
      w = w.replace(new RegExp('<' + tag + '\\b[^>]*\\/?>', 'gi'), ' ');
    }
    return w;
  };
  const longest = (h, tag) => {
    const p = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'gi');
    let best = null, mm;
    while ((mm = p.exec(h)) !== null) { if (best === null || mm[1].length > best.length) best = mm[1]; }
    return best;
  };
  const toText = (h) => {
    let t = h.replace(/<br\b[^>]*>/gi, '\n');
    t = t.replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|blockquote|pre)\s*>/gi, '\n');
    t = strip(t); t = decode(t);
    t = t.replace(/[ \t\f\v\u00a0]+/g, ' ');
    t = t.replace(/ *\n */g, '\n');
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  };
  let w = html.replace(/<!--[\s\S]*?-->/g, ' ');
  w = removeBlocks(w, ['script', 'style', 'noscript', 'template', 'svg', 'head', 'iframe', 'form', 'nav', 'aside']);
  const region = longest(w, 'article') || longest(w, 'main') || longest(w, 'body') || w;
  const text = toText(region);
  return text.length > MAX ? text.slice(0, MAX) : text;
}
$system_crawler$);

INSERT INTO crawlers (user_uuid, name, type, url_pattern, code)
VALUES ('00000000-0000-0000-0000-000000000001', 'hn-search', 'web', '^https://hn\.algolia\.com/api/v1/search.*$', $system_crawler$
(body) => {
  let data;
  try { data = JSON.parse(body); } catch (e) { return null; }
  const hits = data && Array.isArray(data.hits) ? data.hits : [];
  let best = null;
  for (const h of hits) {
    if (!h || typeof h.objectID !== 'string' || h.objectID.length === 0) continue;
    if (best === null || (h.points || 0) > (best.points || 0)) best = h;
  }
  if (best === null) return null;
  return {
    objectID: best.objectID,
    itemsUrl: 'https://hn.algolia.com/api/v1/items/' + encodeURIComponent(best.objectID),
  };
}
$system_crawler$);

INSERT INTO crawlers (user_uuid, name, type, url_pattern, code)
VALUES ('00000000-0000-0000-0000-000000000001', 'hn-items', 'web', '^https://hn\.algolia\.com/api/v1/items/.*$', $system_crawler$
(body) => {
  let item;
  try { item = JSON.parse(body); } catch (e) { return ''; }
  if (!item || typeof item !== 'object') return '';
  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026' };
  const decode = (t) => t.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, b) => {
    if (b.charCodeAt(0) === 35) {
      const isHex = b.charCodeAt(1) === 120 || b.charCodeAt(1) === 88;
      const cp = Number.parseInt(b.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff) { try { return String.fromCodePoint(cp); } catch (e) { return whole; } }
      return whole;
    }
    const r = NAMED[b.toLowerCase()];
    return r === undefined ? whole : r;
  });
  const strip = (h) => h.replace(/<[^>]+>/g, '');
  const clean = (h) => {
    let t = h.replace(/<\/?p\b[^>]*>/gi, ' ').replace(/<br\b[^>]*>/gi, ' ');
    t = strip(t); t = decode(t);
    return t.replace(/\s+/g, ' ').trim();
  };
  const maxComments = 60, maxChars = 20000;
  const queue = Array.isArray(item.children) ? item.children.slice() : [];
  const texts = [];
  while (queue.length > 0 && texts.length < maxComments) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (typeof node.text === 'string' && node.text.length > 0 && typeof node.author === 'string' && node.author.length > 0) {
      const c = clean(node.text);
      if (c.length > 0) texts.push(c);
    }
    if (Array.isArray(node.children)) for (const ch of node.children) queue.push(ch);
  }
  const kept = [];
  let total = 0;
  for (const c of texts) {
    if (kept.length > 0 && total + c.length > maxChars) break;
    kept.push(c);
    total += c.length + 1;
    if (total >= maxChars) break;
  }
  const joined = kept.join('\n');
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}
$system_crawler$);

-- Same owner permission a crawler gets when a user creates one.
INSERT INTO crawler_permissions (crawler_id, user_uuid, level)
SELECT id, user_uuid, 'owner'
FROM crawlers
WHERE user_uuid = '00000000-0000-0000-0000-000000000001'
ON CONFLICT (crawler_id, user_uuid) DO NOTHING;
