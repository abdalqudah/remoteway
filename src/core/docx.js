// Word templates (.docx): find the {placeholders} written in the document and fill them for one customer.
// Word often splits typed text into several runs ("{comp" + "any_name}"), so each paragraph's text is joined
// before replacing; a paragraph that holds a placeholder keeps the formatting of its first run.
const AdmZip = require('adm-zip');

const PART = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
const PLACEHOLDER = /\{([\p{L}\p{N}_]{1,40})\}/gu;
const xmlEscape = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const T_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t(?:\s[^>]*)?\/>/g;

function open(buffer) {
  let zip;
  try { zip = new AdmZip(buffer); } catch { return null; }
  if (!zip.getEntry('word/document.xml')) return null;
  return zip;
}

function paragraphTexts(xml) {
  const out = [];
  for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []) {
    out.push([...p.matchAll(T_RE)].map((m) => xmlUnescape(m[1] || '')).join(''));
  }
  return out;
}

/** The placeholder names used in a .docx (null when it is not a Word document). */
function placeholders(buffer) {
  const zip = open(buffer);
  if (!zip) return null;
  const names = new Set();
  for (const e of zip.getEntries()) {
    if (!PART.test(e.entryName)) continue; // eslint-disable-line no-continue
    for (const text of paragraphTexts(e.getData().toString('utf8'))) for (const m of text.matchAll(PLACEHOLDER)) names.add(m[1]);
  }
  return [...names];
}

function fillParagraph(p, values) {
  const runs = [...p.matchAll(T_RE)];
  if (!runs.length) return p;
  const text = runs.map((m) => xmlUnescape(m[1] || '')).join('');
  if (!PLACEHOLDER.test(text)) return p;
  PLACEHOLDER.lastIndex = 0;
  const filled = text.replace(PLACEHOLDER, (m, k) => (values[k] !== undefined ? String(values[k]) : m));
  let first = true;
  return p.replace(T_RE, () => {
    if (!first) return '<w:t xml:space="preserve"></w:t>';
    first = false;
    return `<w:t xml:space="preserve">${xmlEscape(filled)}</w:t>`;
  });
}

/** A copy of the .docx with the placeholders replaced by `values` (unknown ones are left as typed). */
function fill(buffer, values) {
  const zip = open(buffer);
  if (!zip) throw new Error('Not a Word document');
  for (const e of zip.getEntries()) {
    if (!PART.test(e.entryName)) continue; // eslint-disable-line no-continue
    const xml = e.getData().toString('utf8');
    const out = xml.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (p) => fillParagraph(p, values));
    if (out !== xml) zip.updateFile(e.entryName, Buffer.from(out, 'utf8'));
  }
  return zip.toBuffer();
}

module.exports = { placeholders, fill, PLACEHOLDER };
