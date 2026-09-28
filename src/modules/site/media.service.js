// Website media library: images and videos uploaded by the platform team (stored outside the app
// folder, like documents) and YouTube/Vimeo links. Files are checked by their content, not their name;
// SVG is not accepted (it can carry scripts).
const crypto = require('crypto');
const path = require('path');
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const storage = require('../../core/storage');
const { videoEmbed } = require('../learning/content');
const { E } = require('../../core/errors');

const IMAGE_MAX = 8 * 1024 * 1024;
const VIDEO_MAX = 30 * 1024 * 1024;

/** Real type from the first bytes of the file. */
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return { kind: 'image', mime: 'image/png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'image', mime: 'image/jpeg' };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (buf.toString('ascii', 0, 4) === 'GIF8') return { kind: 'image', mime: 'image/gif' };
  if (buf.toString('ascii', 4, 8) === 'ftyp') return { kind: 'video', mime: 'video/mp4' };
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { kind: 'video', mime: 'video/webm' };
  return null;
}

const cleanName = (n, fallback) => String(n || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[\r\n<>]/g, ' ').trim().slice(0, 150) || fallback;

async function upload(ctx, file, name) {
  if (!file || !file.buffer?.length) throw E.validation({ file: 'Choose an image or a video.' });
  const type = sniff(file.buffer);
  if (!type) throw E.validation({ file: 'Use a JPG, PNG, WebP or GIF image, or an MP4 or WebM video.' });
  if (type.kind === 'image' && file.buffer.length > IMAGE_MAX) throw E.validation({ file: 'Images must be 8 MB or smaller.' });
  if (type.kind === 'video' && file.buffer.length > VIDEO_MAX) throw E.validation({ file: 'Videos must be 30 MB or smaller. For longer videos use a YouTube or Vimeo link.' });
  const key = `site/${crypto.randomUUID().replace(/-/g, '')}`;
  await storage.put(key, file.buffer);
  const [id] = await knex('site_media').insert({
    kind: type.kind, mime: type.mime, size: file.buffer.length, storage_key: key, sha: crypto.createHash('sha256').update(file.buffer).digest('hex').slice(0, 16),
    name: cleanName(name, cleanName(file.originalname, type.kind)), created_by: ctx.userId,
  });
  cache.forgetPrefix('site:');
  await audit.record(ctx, 'platform.site_media_uploaded', { entityType: 'site_media', entityId: id, newValues: { kind: type.kind, size: file.buffer.length } });
  return id;
}

async function addEmbed(ctx, url, name) {
  const embed = videoEmbed(url);
  if (!embed) throw E.validation({ url: 'Paste a YouTube or Vimeo link.' });
  const [id] = await knex('site_media').insert({ kind: 'embed', name: cleanName(name, 'Video'), embed_url: embed, created_by: ctx.userId });
  cache.forgetPrefix('site:');
  await audit.record(ctx, 'platform.site_media_uploaded', { entityType: 'site_media', entityId: id, newValues: { kind: 'embed' } });
  return id;
}

const list = () => knex('site_media').orderBy('id', 'desc');

/** id → what the page needs to show it. */
async function map() {
  return cache.remember('site:media', async () => {
    const rows = await knex('site_media').select('id', 'kind', 'name', 'mime', 'sha', 'embed_url');
    return Object.fromEntries(rows.map((m) => [String(m.id), { id: m.id, kind: m.kind, name: m.name, url: m.kind === 'embed' ? m.embed_url : `/site-media/${m.id}/${m.sha}` }]));
  }, 60_000);
}

async function remove(ctx, id) {
  const m = await knex('site_media').where({ id: Number(id) }).first();
  if (!m) throw E.notFound('File');
  await knex('site_media').where({ id: m.id }).del();
  if (m.storage_key) await storage.remove(m.storage_key).catch(() => {});
  cache.forgetPrefix('site:');
  await audit.record(ctx, 'platform.site_media_deleted', { entityType: 'site_media', entityId: m.id });
}

/** Absolute path of a stored file (served with range support for video seeking). */
async function file(id, sha) {
  const m = await knex('site_media').where({ id: Number(id) }).whereIn('kind', ['image', 'video']).first();
  if (!m || m.sha !== sha) return null;
  return { path: path.join(storage.root, m.storage_key), mime: m.mime };
}

module.exports = { sniff, upload, addEmbed, list, map, remove, file, IMAGE_MAX, VIDEO_MAX };
