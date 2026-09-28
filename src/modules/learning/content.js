// Safe lesson content helpers (no HTML from users ever reaches the page unescaped).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Very small, safe text format: "# " / "## " headings, "- " bullet lists, "1. " numbered lists, **bold**, blank lines = paragraphs. */
function renderText(text) {
  const inline = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const out = [];
  let list = null;
  const flush = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); flush(); continue; }
    if ((m = line.match(/^(#{1,2})\s+(.*)$/))) { flushPara(); flush(); out.push(`<h${m[1].length + 2}>${inline(m[2])}</h${m[1].length + 2}>`); continue; }
    if ((m = line.match(/^\s*[-•]\s+(.*)$/))) { flushPara(); if (!list || list.tag !== 'ul') { flush(); list = { tag: 'ul', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (!list || list.tag !== 'ol') { flush(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); continue; }
    flush();
    para.push(line);
  }
  flushPara(); flush();
  return out.join('\n');
}

/** YouTube / Vimeo URL → privacy-friendly embed URL, or null. */
function videoEmbed(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^www\.|^m\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else if (/^\/(embed|shorts|live)\//.test(u.pathname)) id = u.pathname.split('/')[2];
  }
  if (id && /^[A-Za-z0-9_-]{6,20}$/.test(id)) return `https://www.youtube-nocookie.com/embed/${id}`;
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = u.pathname.match(/(\d{5,12})/);
    if (m) return `https://player.vimeo.com/video/${m[1]}`;
  }
  return null;
}

const isHttpsUrl = (url) => { try { return new URL(String(url)).protocol === 'https:'; } catch { return false; } };

module.exports = { renderText, videoEmbed, isHttpsUrl, esc };
