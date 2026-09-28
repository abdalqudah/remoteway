// CSV import wizard for employees: parse → map columns → validate/preview → import.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E, AppError } = require('../../core/errors');
const ent = require('../billing/entitlements.service');
const employees = require('./employee.service');
const structure = require('./structure.service');

const MAX_ROWS = 500;
const MAX_BYTES = 1024 * 1024;

const FIELDS = ['first_name', 'last_name', 'email', 'phone', 'employee_number', 'job_title', 'department', 'location', 'manager_email',
  'employment_type', 'work_mode', 'joining_date', 'nationality', 'base_salary'];
const REQUIRED = ['first_name', 'last_name'];

// Header aliases (English and Arabic) used to pre-select the mapping.
const ALIASES = {
  first_name: ['first name', 'firstname', 'first', 'الاسم الأول', 'الاسم'],
  last_name: ['last name', 'lastname', 'surname', 'family name', 'اسم العائلة', 'العائلة'],
  email: ['email', 'e-mail', 'work email', 'البريد', 'البريد الإلكتروني'],
  phone: ['phone', 'mobile', 'الهاتف', 'الجوال'],
  employee_number: ['employee id', 'employee number', 'emp id', 'id', 'الرقم الوظيفي'],
  job_title: ['job title', 'title', 'position', 'المسمى الوظيفي', 'الوظيفة'],
  department: ['department', 'dept', 'القسم'],
  location: ['location', 'office', 'الموقع'],
  manager_email: ['manager email', 'manager', 'بريد المدير', 'المدير'],
  employment_type: ['employment type', 'type', 'نوع التوظيف'],
  work_mode: ['work mode', 'mode', 'نمط العمل'],
  joining_date: ['joining date', 'start date', 'hire date', 'تاريخ الالتحاق', 'تاريخ التعيين'],
  nationality: ['nationality', 'country', 'الجنسية'],
  base_salary: ['salary', 'base salary', 'الراتب', 'الراتب الأساسي'],
};

/** RFC 4180 CSV parser (quotes, escaped quotes, CRLF, BOM). */
function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

function parseUpload(file) {
  if (!file || !file.buffer?.length) throw E.validation({ file: 'Choose a CSV file.' });
  if (file.size > MAX_BYTES) throw E.validation({ file: 'CSV files must be 1 MB or smaller.' });
  const text = file.buffer.toString('utf8');
  if (text.includes('\u0000')) throw E.validation({ file: 'This does not look like a CSV file.' });
  const rows = parseCsv(text);
  if (rows.length < 2) throw E.validation({ file: 'The file needs a header row and at least one employee.' });
  if (rows.length - 1 > MAX_ROWS) throw E.validation({ file: `Import up to ${MAX_ROWS} employees at a time.` });
  const headers = rows[0].map((h) => h.trim());
  const norm = (s) => s.toLowerCase().replace(/[_-]+/g, ' ').trim();
  const mapping = {};
  for (const f of FIELDS) {
    const idx = headers.findIndex((h) => norm(h) === f.replace(/_/g, ' ') || ALIASES[f].includes(norm(h)));
    mapping[f] = idx >= 0 ? idx : '';
  }
  return { headers, rows: rows.slice(1).map((r) => r.map((c) => c.trim())), mapping };
}

const TYPE_ALIASES = { 'full time': 'full_time', 'full-time': 'full_time', 'part time': 'part_time', 'part-time': 'part_time', 'دوام كامل': 'full_time', 'دوام جزئي': 'part_time', عقد: 'contract', متدرب: 'intern' };
const MODE_ALIASES = { 'on-site': 'onsite', 'on site': 'onsite', office: 'onsite', 'عن بعد': 'remote', 'عن بُعد': 'remote', هجين: 'hybrid', 'من المقر': 'onsite' };

/** Builds employee payloads from the mapping and validates them without writing anything. */
async function preview(ctx, { rows, mapping }, { createMissing = false } = {}) {
  for (const f of REQUIRED) if (mapping[f] === '' || mapping[f] === undefined) throw E.validation({ [`map_${f}`]: 'Map this column.' });
  const [departments, locations, existing] = await Promise.all([
    structure.listDepartments(ctx.organizationId), structure.listLocations(ctx.organizationId),
    knex('employees').where({ organization_id: ctx.organizationId }).select('id', 'email', 'employee_number'),
  ]);
  const deptBy = Object.fromEntries(departments.map((d) => [d.name.toLowerCase(), d.id]));
  const locBy = Object.fromEntries(locations.map((l) => [l.name.toLowerCase(), l.id]));
  const emailsTaken = new Set(existing.map((e) => (e.email || '').toLowerCase()).filter(Boolean));
  const numbersTaken = new Set(existing.map((e) => e.employee_number));
  const fileEmails = new Set();
  const get = (r, f) => (mapping[f] === '' || mapping[f] === undefined ? '' : String(r[Number(mapping[f])] ?? '').trim());

  const items = rows.map((r, i) => {
    const errors = [];
    const p = {
      first_name: get(r, 'first_name'), last_name: get(r, 'last_name'), email: get(r, 'email').toLowerCase(), phone: get(r, 'phone'),
      employee_number: get(r, 'employee_number'), job_title: get(r, 'job_title'), joining_date: get(r, 'joining_date'),
      nationality: get(r, 'nationality').toUpperCase(), base_salary: get(r, 'base_salary').replace(/[, ]/g, ''),
    };
    const et = get(r, 'employment_type').toLowerCase();
    p.employment_type = TYPE_ALIASES[et] || et.replace(/[ -]/g, '_') || 'full_time';
    const wm = get(r, 'work_mode').toLowerCase();
    p.work_mode = MODE_ALIASES[wm] || wm || 'onsite';
    const dept = get(r, 'department');
    if (dept) {
      if (deptBy[dept.toLowerCase()]) p.department_id = deptBy[dept.toLowerCase()];
      else if (createMissing) p.new_department = dept;
      else errors.push(`Unknown department "${dept}"`);
    }
    const loc = get(r, 'location');
    if (loc) {
      if (locBy[loc.toLowerCase()]) p.location_id = locBy[loc.toLowerCase()];
      else if (createMissing) p.new_location = loc;
      else errors.push(`Unknown location "${loc}"`);
    }
    p.manager_email = get(r, 'manager_email').toLowerCase();
    if (!p.first_name) errors.push('First name is required');
    if (!p.last_name) errors.push('Last name is required');
    if (p.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) errors.push('Invalid email');
    if (p.email && (emailsTaken.has(p.email) || fileEmails.has(p.email))) errors.push('Email already used');
    if (p.email) fileEmails.add(p.email);
    if (p.employee_number && numbersTaken.has(p.employee_number)) errors.push('Employee ID already used');
    if (p.joining_date && !/^\d{4}-\d{2}-\d{2}$/.test(p.joining_date)) errors.push('Joining date must be YYYY-MM-DD');
    if (!employees.EMPLOYMENT_TYPES.includes(p.employment_type)) errors.push('Unknown employment type');
    if (!employees.WORK_MODES.includes(p.work_mode)) errors.push('Unknown work mode');
    if (p.nationality && !/^[A-Z]{2}$/.test(p.nationality)) errors.push('Nationality must be a 2-letter country code');
    if (p.base_salary && !/^\d+(\.\d{1,2})?$/.test(p.base_salary)) errors.push('Invalid salary');
    return { line: i + 2, data: p, errors };
  });
  const ent0 = await ent.getEntitlements(ctx.organizationId);
  const usage = await ent.getUsage(ctx.organizationId);
  const valid = items.filter((x) => !x.errors.length).length;
  const max = ent0.limits.employees;
  const seatsLeft = max === null || max === undefined ? null : Math.max(0, max - usage.employees);
  return { items, valid, invalid: items.length - valid, seatsLeft, fitsSeats: seatsLeft === null || valid <= seatsLeft };
}

async function run(ctx, parsed, opts) {
  await ent.assertCanWrite(ctx.organizationId);
  const result = await preview(ctx, parsed, opts);
  if (!result.valid) throw new AppError('IMPORT_NOTHING_VALID', 'No valid rows to import.', 422);
  if (!result.fitsSeats) {
    const e0 = await ent.getEntitlements(ctx.organizationId);
    throw E.limitReached('employees', (await ent.getUsage(ctx.organizationId)).employees, e0.limits.employees);
  }
  const deptIds = {};
  const locIds = {};
  const created = [];
  const failed = [];
  for (const item of result.items.filter((x) => !x.errors.length)) {
    const p = { ...item.data };
    try {
      if (p.new_department) {
        const k = p.new_department.toLowerCase();
        deptIds[k] = deptIds[k] || await structure.saveDepartment(ctx, null, { name: p.new_department });
        p.department_id = deptIds[k];
      }
      if (p.new_location) {
        const k = p.new_location.toLowerCase();
        locIds[k] = locIds[k] || await structure.saveLocation(ctx, null, { name: p.new_location });
        p.location_id = locIds[k];
      }
      const e = await employees.create(ctx, p);
      created.push({ id: e.id, manager_email: p.manager_email });
    } catch (err) {
      failed.push({ line: item.line, error: err.details ? Object.values(err.details).join(', ') : err.message });
    }
  }
  // Second pass: managers may be other rows of the same file.
  for (const c of created.filter((x) => x.manager_email)) {
    const mgr = await knex('employees').where({ organization_id: ctx.organizationId, email: c.manager_email }).first('id');
    if (mgr && mgr.id !== c.id) await knex('employees').where({ id: c.id, organization_id: ctx.organizationId }).update({ manager_id: mgr.id });
  }
  await audit.record(ctx, 'employee.imported', { entityType: 'employee', newValues: { imported: created.length, failed: failed.length } });
  return { imported: created.length, failed, skipped: result.invalid };
}

const TEMPLATE = `${FIELDS.join(',')}\nSara,Al-Ghamdi,sara@example.com,+966500000000,,Software Engineer,Engineering,Riyadh HQ,,full_time,hybrid,2025-01-15,SA,15000\n`;

module.exports = { FIELDS, REQUIRED, MAX_ROWS, parseCsv, parseUpload, preview, run, TEMPLATE };
