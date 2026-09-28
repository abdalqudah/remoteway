# RemoteWay

**Workforce Management & Remote Employment SaaS** — Node.js + MySQL, multi-tenant, Arabic/English.

> نظام تشغيل القوى العاملة: وظّف، أدِر، ادفع، طوّر — من منصة واحدة.

| | |
|---|---|
| Runtime | Node.js ≥ 18.18 (Express 4, server-rendered EJS, no build step) |
| Database | MySQL 8 / MariaDB ≥ 10.3 (all data, including sessions, lives in the database) |
| Hosting | Any cPanel host with **Setup Node.js App** (e.g. Orange Host), or any VPS |
| Status | **Phase 1 — SaaS Core** complete and tested (see `docs/ARCHITECTURE.md`) |

---

## What works today (Phase 1)

- **Multi-tenancy:** every record carries `organization_id`; the tenant comes from a verified membership on the server, never from the request.
- **Auth:** sign-up wizard (account → company → plan), login, sessions stored in MySQL, invitations, API tokens (hashed).
- **Organizations:** multiple workspaces per user, organization switcher, company profile, working-week settings from the country policy (Saudi Arabia first).
- **RBAC:** 9 system roles plus a super admin, 34 permissions, a permission matrix, custom roles (Enterprise), team-scoped data for managers, and salary visibility controlled by permission.
- **Subscription engine:** plans, features, limits, add-ons, trials, grace periods, and usage metering all live in the database. Employee, user and API limits are **enforced on the backend**, with row locking.
- **Billing foundation:** invoices with VAT from the country policy. Offline payments are confirmed by a super admin; there is no card gateway yet, and the app says so.
- **Employees:** enterprise table (search, filters, sort, column visibility, pagination, CSV export), profile, create/edit, end employment, reactivate, delete.
- **Departments & locations**, **real dashboard** (every number comes from SQL), **action center**, **audit log** with old/new values, **Ctrl/⌘ + K search**.
- **Super Admin:** tenants, subscription overrides and custom limits, plan pricing/limits/features editor, invoices, platform audit log.
- **UI:** RemoteWay brand identity (your logos, the `#1ACC6C / #13AA54 / #000 / #E2E2E2` palette, Montserrat), RTL/LTR, real dark mode, responsive.
- **REST API v1** with standard `{ success, data | error: { code, message } }` responses.

Modules that are not built yet (attendance, leave, payroll, recruitment, PayWay, AI…) appear as **Soon / Setup required** with their phase number. Nothing is faked.

---

## Local development

```bash
cp .env.example .env          # fill DB_* and SESSION_SECRET
npm install
npm run migrate               # schema + plans/permissions/roles + super admin from .env
npm run seed:demo             # optional: "RemoteWay Demo Company"
npm run dev                   # http://localhost:3000
npm test                      # needs DB_NAME_TEST (a separate, empty database)
npm run build                 # dist/ = production-only copy to upload to the server
```

Demo logins (password `Demo@12345`, override with `DEMO_PASSWORD`):
`owner@`, `hr@`, `finance@`, `manager@`, `employee@` + `demo.remoteway.local`. Super admin = `SUPER_ADMIN_EMAIL` from `.env`.

---

## Deploying on Orange Host (cPanel) — خطوات الرفع على أورانج هوست

1. **Database / قاعدة البيانات** — cPanel → *MySQL® Databases*:
   create a database (e.g. `user_remoteway`) and a user, then *Add User To Database* → **ALL PRIVILEGES**.
2. **Upload the code / رفع الملفات** — run `npm run build` and upload the contents of **`dist/`**
   (zip it, upload with *File Manager*, then *Extract*), or clone the repo with cPanel → *Git™ Version Control*.
   Put it **outside** `public_html`, e.g. `/home/USER/remoteway`. Do **not** upload `node_modules`.
3. **Create the app / إنشاء التطبيق** — cPanel → *Setup Node.js App* → *Create Application*:
   - Node.js version: **20** (or the newest offered, minimum 18)
   - Application mode: **Production**
   - Application root: `remoteway`
   - Application URL: your domain / subdomain
   - Application startup file: **`app.js`**
4. **Environment variables / المتغيرات** — add them in the same screen (or create `/home/USER/remoteway/.env`):

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `APP_URL` | `https://your-domain.com` |
   | `SESSION_SECRET` | a long random string (≥ 32 characters) |
   | `AUTO_MIGRATE` | `true` (creates/updates tables on every start) |
   | `DB_HOST` | `localhost` |
   | `DB_NAME` / `DB_USER` / `DB_PASSWORD` | from step 1 |
   | `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` | your platform admin login |

5. Click **Run NPM Install**, then **Restart**.
6. Open `https://your-domain.com/healthz` → `{"status":"ok"}` means the app is connected to MySQL.
7. Sign in with `SUPER_ADMIN_EMAIL`, then go to **/admin/plans** and set your real prices and limits.
8. Enable HTTPS: cPanel → *SSL/TLS Status* → *Run AutoSSL*.

Using the cPanel **Terminal** instead of `AUTO_MIGRATE` (the exact `source` command is shown at the top of the Node.js App page):

```bash
source /home/USER/nodevenv/remoteway/20/bin/activate && cd ~/remoteway
npm run migrate
```

Updating: pull the new version (Git Version Control → *Update from Remote*), click *Run NPM Install*, then *Restart*. Migrations run automatically when `AUTO_MIGRATE=true`.

> Do not run `npm run seed:demo` on production. It refuses to run when `NODE_ENV=production`.

### Brand font (Arabic)

The brand guide specifies **Montserrat / Montserrat Arabic**. Montserrat (OFL) is bundled.
*Montserrat Arabic* is licensed separately. To use it, place `MontserratArabic-Regular.woff2`,
`MontserratArabic-SemiBold.woff2` and `MontserratArabic-Bold.woff2` in `public/fonts/` and restart; the app picks them up automatically.
Until then, Arabic text falls back to the system font.

---

## Project layout

```
app.js                       cPanel/Passenger entry point
src/
  config/                    environment
  db/migrations/             knex migrations (MySQL)
  db/catalog.js              permissions, roles, features, plans, add-ons, countries (seed data)
  core/                      errors, validation, cache, audit, i18n, formatting
  middleware/                auth, tenant context, permissions, CSRF, errors
  modules/<module>/          *.service.js (business logic) + web.js (pages)
  routes/api.js              REST API v1
  views/                     EJS layouts, partials, pages
  locales/{en,ar}.json       translations
public/                      css, js, fonts, icons, brand logos
tests/                       node:test + supertest against a real MySQL test DB
docs/ARCHITECTURE.md         architecture report, ERD, matrices, roadmap
```
