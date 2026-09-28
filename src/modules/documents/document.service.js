const crypto = require('crypto');
const path = require('path');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const storage = require('../../core/storage');
const { E, AppError } = require('../../core/errors');
const { z, validate, optionalString, emptyToUndefined } = require('../../core/validate');
const { isDateStr, todayIn, addDays } = require('../../core/workdays');
const ent = require('../billing/entitlements.service');
const orgs = require('../organizations/organization.service');
const employees = require('../workforce/employee.service');

const CATEGORIES = ['contract', 'id', 'passport', 'iqama', 'certificate', 'policy', 'payslip', 'other'];
const MAX_BYTES = 10 * 1024 * 1024;
const EXPIRY_WINDOW_DAYS = 30;

// Allowed extensions and the file signature ("magic bytes") each must start with.
const TYPES = {
  pdf: { mime: 'application/pdf', sig: (b) => b.slice(0, 4).toString() === '%PDF', inline: true },
  png: { mime: 'image/png', sig: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), inline: true },
  jpg: { mime: 'image/jpeg', sig: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, inline: true },
  jpeg: { mime: 'image/jpeg', sig: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, inline: true },
  webp: { mime: 'image/webp', sig: (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP', inline: true },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sig: (b) => b[0] === 0x50 && b[1] === 0x4b },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sig: (b) => b[0] === 0x50 && b[1] === 0x4b },
  doc: { mime: 'application/msword', sig: (b) => b.slice(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])) },
  xls: { mime: 'application/vnd.ms-excel', sig: (b) => b.slice(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])) },
  txt: { mime: 'text/plain', sig: (b) => !b.includes(0) },
  csv: { mime: 'text/csv', sig: (b) => !b.includes(0) },
};

function checkFile(file) {
  if (!file || !file.buffer || !file.size) throw E.validation({ file: 'Choose a file to upload.' });
  if (file.size > MAX_BYTES) throw E.validation({ file: 'Files must be 10 MB or smaller.' });
  const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
  const type = TYPES[ext];
  if (!type || !type.sig(file.buffer)) throw E.validation({ file: 'This file type is not allowed (PDF, images, Word, Excel, TXT, CSV).' });
  const name = path.basename(file.originalname).replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 200) || `file.${ext}`;
  return { ext, mime: type.mime, name };
}

async function assertStorage(organizationId, bytes) {
  await ent.assertWithinLimit(organizationId, 'storage_mb', Math.ceil(bytes / (1024 * 1024)));
}

const metaSchema = z.object({
  title: z.string().trim().min(1, 'Name is required.').max(190),
  category: z.enum(CATEGORIES).default('other'),
  employee_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  issue_date: z.preprocess(emptyToUndefined, z.string().refine(isDateStr, 'Use YYYY-MM-DD.').optional()),
  expires_at: z.preprocess(emptyToUndefined, z.string().refine(isDateStr, 'Use YYYY-MM-DD.').optional()),
  visible_to_employee: z.preprocess((v) => v === true || v === 'on' || v === 'true', z.boolean()),
  note: optionalString(255),
});

/** Access rule for one document row. */
async function canView(ctx, doc) {
  if (ctx.permissions.has('documents.view') || ctx.permissions.has('documents.manage')) {
    if (!doc.employee_id) return true;
    const ids = await employees.visibleIds(ctx);
    return ids === null || ids.includes(doc.employee_id);
  }
  if (!doc.visible_to_employee) return false;
  if (!doc.employee_id) return true; // company policy shared with everyone
  const self = await employees.linkedEmployeeId(ctx);
  return self === doc.employee_id;
}

async function assertManage(ctx, employeeId) {
  if (!ctx.permissions.has('documents.manage')) throw E.forbidden('documents.manage');
  if (employeeId) {
    const ids = await employees.visibleIds(ctx);
    const emp = await knex('employees').where({ id: employeeId, organization_id: ctx.organizationId }).first('id');
    if (!emp || (ids !== null && !ids.includes(Number(employeeId)))) throw E.validation({ employee_id: 'Employee not found.' });
  }
}

async function upload(ctx, input, file) {
  await ent.assertFeature(ctx.organizationId, 'documents');
  await ent.assertCanWrite(ctx.organizationId);
  const data = validate(metaSchema, input);
  await assertManage(ctx, data.employee_id);
  const f = checkFile(file);
  await assertStorage(ctx.organizationId, file.size);
  const key = storage.newKey(ctx.organizationId, 'documents');
  await storage.put(key, file.buffer);
  try {
    return await knex.transaction(async (trx) => {
      const [id] = await trx('documents').insert({
        organization_id: ctx.organizationId, employee_id: data.employee_id ?? null, category: data.category, title: data.title,
        issue_date: data.issue_date ?? null, expires_at: data.expires_at ?? null, visible_to_employee: data.visible_to_employee, uploaded_by: ctx.userId,
      });
      await trx('document_versions').insert({
        organization_id: ctx.organizationId, document_id: id, version: 1, storage_key: key, original_name: f.name, mime_type: f.mime,
        size_bytes: file.size, sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'), uploaded_by: ctx.userId,
      });
      await audit.record(ctx, 'document.uploaded', { entityType: 'document', entityId: id, newValues: { name: data.title, category: data.category, file: f.name } }, trx);
      return id;
    });
  } catch (err) {
    await storage.remove(key);
    throw err;
  }
}

async function addVersion(ctx, id, file) {
  await ent.assertCanWrite(ctx.organizationId);
  const doc = await knex('documents').where({ id, organization_id: ctx.organizationId }).first();
  if (!doc) throw E.notFound('Document');
  await assertManage(ctx, doc.employee_id);
  const f = checkFile(file);
  await assertStorage(ctx.organizationId, file.size);
  const key = storage.newKey(ctx.organizationId, 'documents');
  await storage.put(key, file.buffer);
  try {
    await knex.transaction(async (trx) => {
      const version = doc.current_version + 1;
      await trx('document_versions').insert({
        organization_id: ctx.organizationId, document_id: id, version, storage_key: key, original_name: f.name, mime_type: f.mime,
        size_bytes: file.size, sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'), uploaded_by: ctx.userId,
      });
      await trx('documents').where({ id }).update({ current_version: version });
      await audit.record(ctx, 'document.version_added', { entityType: 'document', entityId: id, newValues: { name: doc.title, version, file: f.name } }, trx);
    });
  } catch (err) {
    await storage.remove(key);
    throw err;
  }
}

async function updateMeta(ctx, id, input) {
  const doc = await knex('documents').where({ id, organization_id: ctx.organizationId }).first();
  if (!doc) throw E.notFound('Document');
  const data = validate(metaSchema, { ...input, employee_id: doc.employee_id ?? undefined });
  await assertManage(ctx, doc.employee_id);
  const patch = {
    title: data.title, category: data.category, issue_date: data.issue_date ?? null, expires_at: data.expires_at ?? null, visible_to_employee: data.visible_to_employee,
  };
  const d = audit.diff(doc, patch);
  await knex('documents').where({ id }).update(patch);
  if (d.changed) await audit.record(ctx, 'document.updated', { entityType: 'document', entityId: id, oldValues: d.oldValues, newValues: d.newValues });
}

async function remove(ctx, id) {
  const doc = await knex('documents').where({ id, organization_id: ctx.organizationId }).first();
  if (!doc) throw E.notFound('Document');
  await assertManage(ctx, doc.employee_id);
  const versions = await knex('document_versions').where({ document_id: id, organization_id: ctx.organizationId });
  await knex('documents').where({ id }).del();
  for (const v of versions) await storage.remove(v.storage_key);
  await audit.record(ctx, 'document.deleted', { entityType: 'document', entityId: id, oldValues: { name: doc.title, versions: versions.length } });
}

function withStatus(row, today) {
  const exp = row.expires_at ? new Date(row.expires_at).toISOString().slice(0, 10) : null;
  let expiry = 'none';
  if (exp && exp < today) expiry = 'expired';
  else if (exp && exp <= addDays(today, EXPIRY_WINDOW_DAYS)) expiry = 'expiring';
  else if (exp) expiry = 'valid';
  return { ...row, expiry };
}

async function list(ctx, filters = {}) {
  const org = await orgs.get(ctx.organizationId);
  const today = todayIn(org.timezone);
  const q = knex('documents as d').leftJoin('employees as e', 'e.id', 'd.employee_id')
    .leftJoin('document_versions as v', function j() { this.on('v.document_id', 'd.id').andOn('v.version', 'd.current_version'); })
    .where('d.organization_id', ctx.organizationId)
    .select('d.*', 'e.first_name', 'e.last_name', 'v.original_name', 'v.mime_type', 'v.size_bytes', 'v.id as version_id');
  const privileged = ctx.permissions.has('documents.view') || ctx.permissions.has('documents.manage');
  if (privileged) {
    const ids = await employees.visibleIds(ctx);
    if (ids !== null) q.where((w) => w.whereNull('d.employee_id').orWhereIn('d.employee_id', ids.length ? ids : [0]));
  } else {
    const self = await employees.linkedEmployeeId(ctx);
    q.where('d.visible_to_employee', true).where((w) => w.whereNull('d.employee_id').orWhere('d.employee_id', self || 0));
  }
  if (filters.employee_id) q.where('d.employee_id', Number(filters.employee_id));
  if (filters.company) q.whereNull('d.employee_id');
  if (CATEGORIES.includes(filters.category)) q.where('d.category', filters.category);
  if (filters.q) q.where((w) => w.where('d.title', 'like', `%${String(filters.q).replace(/[%_]/g, '\\$&')}%`).orWhereRaw("CONCAT(e.first_name, ' ', e.last_name) LIKE ?", [`%${filters.q}%`]));
  if (filters.expiry === 'expired') q.where('d.expires_at', '<', today);
  if (filters.expiry === 'expiring') q.whereBetween('d.expires_at', [today, addDays(today, EXPIRY_WINDOW_DAYS)]);
  const rows = await q.orderBy('d.id', 'desc').limit(300);
  return rows.map((r) => withStatus(r, today));
}

async function get(ctx, id) {
  const org = await orgs.get(ctx.organizationId);
  const doc = await knex('documents as d').leftJoin('employees as e', 'e.id', 'd.employee_id').where({ 'd.id': id, 'd.organization_id': ctx.organizationId })
    .first('d.*', 'e.first_name', 'e.last_name');
  if (!doc || !(await canView(ctx, doc))) throw E.notFound('Document');
  doc.versions = await knex('document_versions as v').leftJoin('users as u', 'u.id', 'v.uploaded_by').where({ 'v.document_id': id, 'v.organization_id': ctx.organizationId })
    .orderBy('v.version', 'desc').select('v.*', 'u.name as uploaded_by_name');
  return withStatus(doc, todayIn(org.timezone));
}

/** Returns what the route needs to stream a file, after the access check. */
async function openFile(ctx, id, versionId) {
  const doc = await get(ctx, id);
  const v = versionId ? doc.versions.find((x) => x.id === Number(versionId)) : doc.versions[0];
  if (!v) throw E.notFound('Document');
  const ext = path.extname(v.original_name).slice(1).toLowerCase();
  if (!(await storage.exists(v.storage_key))) throw new AppError('FILE_MISSING', 'The file is missing from storage.', 410);
  return { stream: storage.createReadStream(v.storage_key), name: v.original_name, mime: v.mime_type, size: v.size_bytes, inline: Boolean(TYPES[ext]?.inline), doc };
}

/** Compliance-style counts for dashboards and the action center. */
async function expirySummary(organizationId) {
  const org = await orgs.get(organizationId);
  const today = todayIn(org.timezone);
  const [{ expired }] = await knex('documents').where({ organization_id: organizationId }).where('expires_at', '<', today).count({ expired: '*' });
  const [{ expiring }] = await knex('documents').where({ organization_id: organizationId }).whereBetween('expires_at', [today, addDays(today, EXPIRY_WINDOW_DAYS)]).count({ expiring: '*' });
  return { expired: Number(expired), expiring: Number(expiring) };
}

module.exports = { CATEGORIES, MAX_BYTES, TYPES, checkFile, assertStorage, upload, addVersion, updateMeta, remove, list, get, openFile, expirySummary };
