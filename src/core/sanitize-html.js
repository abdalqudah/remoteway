// A small allow-list HTML cleaner for documents written in the online editor (and text pasted from Word):
// keeps headings, paragraphs, lists, tables, bold/italic/underline, links and text alignment, and removes
// everything else — scripts, styles, event handlers, images from elsewhere, unknown attributes.
const ALLOWED = new Set(['p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'hr',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'span', 'a', 'sup', 'sub']);
const VOID = new Set(['br', 'hr']);
const ALIGN = /^\s*text-align\s*:\s*(left|right|center|justify|start|end)\s*;?\s*$/i;

const escapeText = (t) => t.replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cleanAttrs(tag, raw) {
  const out = [];
  const re = /([a-zA-Z-:]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(raw))) {
    const name = m[1].toLowerCase(); const value = m[3] ?? m[4] ?? m[5] ?? '';
    if (name === 'style' && ALIGN.test(value)) out.push(`style="${value.trim().replace(/"/g, '')}"`);
    else if (name === 'dir' && /^(rtl|ltr|auto)$/i.test(value)) out.push(`dir="${value.toLowerCase()}"`);
    else if (tag === 'a' && name === 'href' && /^(https?:|mailto:|tel:)/i.test(value.trim())) out.push(`href="${value.trim().replace(/"/g, '%22')}" rel="noopener" target="_blank"`);
    else if ((tag === 'td' || tag === 'th') && (name === 'colspan' || name === 'rowspan') && /^\d{1,2}$/.test(value)) out.push(`${name}="${value}"`);
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

function sanitizeHtml(input, { maxLength = 200_000 } = {}) {
  let html = String(input || '').slice(0, maxLength);
  html = html.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|noscript|template|svg|math|head|title|xml)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|iframe|object|embed|noscript|template|svg|math|head|title|xml|meta|link|base)\b[^>]*>/gi, '');
  const out = [];
  const stack = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)([^>]*)>|([^<]+)|(<)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[3] !== undefined) { out.push(escapeText(m[3])); continue; } // eslint-disable-line no-continue
    if (m[4] !== undefined) { out.push('&lt;'); continue; } // eslint-disable-line no-continue
    const tag = m[1].toLowerCase(); const closing = m[0][1] === '/';
    if (!ALLOWED.has(tag)) continue; // eslint-disable-line no-continue
    if (closing) {
      const at = stack.lastIndexOf(tag);
      if (at === -1) continue; // eslint-disable-line no-continue
      while (stack.length > at) out.push(`</${stack.pop()}>`);
    } else if (VOID.has(tag)) out.push(`<${tag}>`);
    else { out.push(`<${tag}${cleanAttrs(tag, m[2] || '')}>`); stack.push(tag); }
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join('');
}

module.exports = { sanitizeHtml };
