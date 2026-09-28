const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

describe('Phase 2 — documents, tasks, import, notifications', () => {
  let C; let owner; let emp; let empUser; let empEmp; let otherEmp;

  before(async () => {
    await h.resetDatabase();
    C = await h.createCompany({ plan: 'business' });
    owner = await h.login(C.email, C.password);
    empUser = await h.addMember(C.organizationId, 'employee');
    empEmp = (await h.createEmployee(owner, { first_name: 'Doc', email: empUser.email })).body.data;
    otherEmp = (await h.createEmployee(owner, { first_name: 'Other' })).body.data;
    emp = await h.login(empUser.email, empUser.password);
  });
  after(() => h.knex.destroy());

  const upload = (s, fields, buffer = PDF, name = 'file.pdf', token = s.csrf) => {
    const req = s.agent.post('/app/documents').field('_csrf', token);
    for (const [k, v] of Object.entries(fields)) req.field(k, String(v));
    return req.attach('file', buffer, name);
  };

  let empDocId; let otherDocId;
  test('HR uploads documents; files are stored privately with a checksum', async () => {
    const r1 = await upload(owner, { title: 'Contract', category: 'contract', employee_id: empEmp.id, visible_to_employee: 'on' });
    assert.equal(r1.status, 302, r1.text.slice(0, 300));
    const r2 = await upload(owner, { title: 'Other ID', category: 'id', employee_id: otherEmp.id, visible_to_employee: 'on' });
    assert.equal(r2.status, 302);
    const docs = await h.knex('documents').orderBy('id');
    [empDocId, otherDocId] = docs.map((d) => d.id);
    const v = await h.knex('document_versions').where({ document_id: empDocId }).first();
    assert.equal(v.sha256.length, 64);
    assert.match(v.storage_key, /^org-\d+\/documents\/[a-f0-9]{32}$/);
  });

  test('uploads without a CSRF token, or with a spoofed type, are refused', async () => {
    const noToken = await upload(owner, { title: 'X' }, PDF, 'x.pdf', 'wrong-token');
    assert.equal(noToken.status, 302); // CSRF failure redirects back with a flash
    assert.equal(await h.knex('documents').where({ title: 'X' }).first(), undefined);
    const fake = await upload(owner, { title: 'Fake' }, Buffer.from('<script>alert(1)</script>'), 'evil.pdf');
    assert.equal(fake.status, 422);
    const exe = await upload(owner, { title: 'Exe' }, Buffer.from('MZ....'), 'tool.exe');
    assert.equal(exe.status, 422);
  });

  test('multipart requests cannot bypass CSRF on other routes', async () => {
    const res = await owner.agent.post(`/app/employees/${otherEmp.id}/terminate`).field('x', '1').attach('file', PDF, 'a.pdf');
    assert.equal(res.status, 302);
    assert.equal((await h.knex('employees').where({ id: otherEmp.id }).first()).status, 'active');
  });

  test('employees download only their own documents', async () => {
    const own = await emp.get(`/app/documents/${empDocId}/download`);
    assert.equal(own.status, 200);
    assert.equal(own.headers['content-type'], 'application/pdf');
    assert.match(own.headers['content-disposition'], /attachment/);
    assert.equal((await emp.get(`/app/documents/${otherDocId}/download`)).status, 404);
    assert.equal((await emp.get(`/app/documents/${otherDocId}`)).status, 404);
    const list = await emp.api('get', '/api/v1/documents');
    assert.deepEqual(list.body.data.map((d) => d.id), [empDocId]);
    // Employees cannot upload.
    assert.equal((await upload(emp, { title: 'Mine', employee_id: empEmp.id })).status, 403);
  });

  test('documents are tenant isolated', async () => {
    const other = await h.createCompany({ plan: 'business' });
    const o = await h.login(other.email, other.password);
    assert.equal((await o.get(`/app/documents/${empDocId}/download`)).status, 404);
    assert.deepEqual((await o.api('get', '/api/v1/documents')).body.data, []);
  });

  test('storage limit is enforced', async () => {
    await h.knex('subscriptions').where({ organization_id: C.organizationId }).update({ custom_limits: JSON.stringify({ storage_mb: 0 }) });
    h.cache.clear();
    const res = await upload(owner, { title: 'Too much' });
    assert.equal(res.status, 402);
    await h.knex('subscriptions').where({ organization_id: C.organizationId }).update({ custom_limits: null });
    h.cache.clear();
  });

  test('tasks: employees only see their own tasks and cannot assign others', async () => {
    const t1 = await owner.api('post', '/api/v1/tasks', { title: 'For employee', assignee_user_id: empUser.userId, priority: 'high' });
    assert.equal(t1.status, 201);
    const t2 = await owner.api('post', '/api/v1/tasks', { title: 'Private to owner' });
    const mine = await emp.api('get', '/api/v1/tasks');
    assert.deepEqual(mine.body.data.map((t) => t.id), [t1.body.data.id]);
    assert.equal((await emp.api('get', `/api/v1/tasks/${t2.body.data.id}`)).status, 404);
    const selfTask = await emp.api('post', '/api/v1/tasks', { title: 'Try assign', assignee_user_id: C.userId });
    assert.equal(selfTask.body.data.assignee_user_id, empUser.userId);
    // Assignee can move status; notifications reach the creator.
    assert.equal((await emp.api('patch', `/api/v1/tasks/${t1.body.data.id}`, { status: 'done' })).status, 200);
    assert.ok((await owner.api('get', '/api/v1/notifications')).body.data.some((n) => n.type === 'task_completed'));
    assert.ok((await emp.api('get', '/api/v1/notifications')).body.data.some((n) => n.type === 'task_assigned'));
    // Employee cannot delete someone else's task.
    assert.equal((await emp.api('delete', `/api/v1/tasks/${t1.body.data.id}`)).status, 403);
  });

  test('projects require the projects feature (not on Starter)', async () => {
    const s = await h.createCompany({ plan: 'starter' });
    const st = await h.login(s.email, s.password);
    assert.equal((await st.form('/app/projects', { name: 'Nope' })).status, 402);
    assert.equal((await st.api('post', '/api/v1/tasks', { title: 'Allowed on Starter' })).status, 201);
  });

  test('CSV import: parse → map → preview → import with seat limit', async () => {
    const s = await h.createCompany({ plan: 'starter' }); // 10 seats
    const st = await h.login(s.email, s.password);
    const rows = ['First Name,Last Name,Email,Department,Joining Date'];
    for (let i = 0; i < 12; i += 1) rows.push(`Emp${i},Test,e${i}@x.io,Sales,2025-01-0${(i % 9) + 1}`);
    const up = await st.agent.post('/app/employees/import').field('_csrf', st.csrf).attach('file', Buffer.from(rows.join('\n')), 'people.csv');
    assert.equal(up.status, 302);
    const map = await st.get('/app/employees/import');
    assert.match(map.text, /map_first_name/);
    const preview = await st.form('/app/employees/import/preview', { map_first_name: 0, map_last_name: 1, map_email: 2, map_department: 3, map_joining_date: 4, create_missing: 'on' });
    assert.equal(preview.status, 200);
    assert.match(preview.text, /seats are left|المتبقي/); // 12 valid rows but only 10 seats
    const blocked = await st.form('/app/employees/import/run', {});
    assert.equal(blocked.status, 402);
    await h.knex('subscriptions').where({ organization_id: s.organizationId }).update({ custom_limits: JSON.stringify({ employees: 20 }) });
    h.cache.clear();
    const run = await st.form('/app/employees/import/run', {});
    assert.equal(run.status, 200);
    const [{ n }] = await h.knex('employees').where({ organization_id: s.organizationId }).count({ n: '*' });
    assert.equal(Number(n), 12);
    assert.ok(await h.knex('departments').where({ organization_id: s.organizationId, name: 'Sales' }).first());
  });

  test('CSV parser handles quotes, commas, BOM and CRLF', () => {
    const { parseCsv } = require('../src/modules/workforce/import.service');
    const rows = parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n');
    assert.deepEqual(rows, [['a', 'b'], ['x, y', 'he said "hi"']]);
  });
});
