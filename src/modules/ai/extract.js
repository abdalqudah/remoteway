// Turns a stored file into something an AI provider can read: PDFs and images are attached as-is
// (when the provider supports them), Word (.docx) and text files are converted to plain text.
const AdmZip = require('adm-zip');
const storage = require('../../core/storage');
const providers = require('./providers');

const MAX_ATTACH_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 40_000;

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
}

function docxText(buffer) {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntry('word/document.xml');
  if (!entry || entry.header.size > 20 * 1024 * 1024) return '';
  const xml = entry.getData().toString('utf8');
  return decodeXml(xml.replace(/<w:tab\/>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, ''))
    .replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * @returns {Promise<{file?:{mime,name,data}, text?:string, unsupported?:boolean}>}
 */
async function prepare(provider, { storageKey, mime, name, size }) {
  if (!storageKey || !(await storage.exists(storageKey))) return { unsupported: true };
  if (mime === DOCX || /\.docx$/i.test(name || '')) {
    try {
      return { text: docxText(await storage.read(storageKey)).slice(0, MAX_TEXT) };
    } catch {
      return { unsupported: true };
    }
  }
  if (mime === 'text/plain' || mime === 'text/csv') return { text: (await storage.read(storageKey)).toString('utf8').slice(0, MAX_TEXT) };
  if (providers.accepts(provider, mime) && Number(size || 0) <= MAX_ATTACH_BYTES) {
    return { file: { mime, name, data: await storage.read(storageKey) } };
  }
  return { unsupported: true };
}

module.exports = { prepare, docxText };
