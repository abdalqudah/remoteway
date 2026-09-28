# RemoteWay

**Workforce Management & Remote Employment SaaS** — Node.js + MySQL, multi-tenant, Arabic/English.

> نظام تشغيل القوى العاملة: وظّف، أدِر، ادفع، طوّر — من منصة واحدة.

| | |
|---|---|
| Runtime | Node.js ≥ 20 (Express 4, server-rendered EJS, no build step) |
| Database | MySQL 8 / MariaDB ≥ 10.3 (all data, including sessions, lives in the database) |
| Hosting | Any cPanel host with **Setup Node.js App** (e.g. Orange Host), or any VPS |
| Status | **Phases 1–9 + Advanced Analytics + Compliance + Automation + Online payments** (SaaS Core, Workforce, Talent, Payroll, Performance, Learning, Integrations, AI, Enterprise, Analytics, Compliance, Automation, Payments) complete and tested (see `docs/ARCHITECTURE.md`) |

---

## What works today

**Platform team, company management and branding:**

- **Platform team** (Super Admin → Platform team): add people with a role — Owner, Administrator, Finance or Support — each seeing only its sections; at least one owner always remains.
- **Companies** (Super Admin → Organizations): plan, status, billing cycle, paid-until date, custom limits, add-ons (quantities), extra features beyond the plan, issue an invoice (list price or an agreed amount), void open invoices.
- **Company logo** (Settings → Branding, every plan): stored in the database; shown on payslips, certificates, printed reports / analytics / compliance (Print / PDF, on the company letterhead) and the careers page. The app keeps the RemoteWay identity.
- **White Label** (Enterprise or add-on): the company's name, logo and colour replace RemoteWay in the app, emails and printouts, and its team can sign in on the company's own domain (after DNS and adding the domain on the server). CSV exports are data only and carry no logo.

**Online payments** (Super Admin → Payments):

- **Saudi gateways:** Moyasar (hosted invoice), Tap Payments (hosted charge), HyperPay COPYandPAY (widget; separate mada and Visa/Mastercard entities) and PayTabs (hosted page, any region). Keys are stored encrypted, each gateway has a connection test, and the platform switches between test and live mode.
- **Pay now** on every open subscription invoice. A payment counts only after RemoteWay reads its status from the gateway itself (on return, from a webhook, or by the 5-minute reconciler) and the amount and currency match; the invoice is then paid and the subscription activated. Double payments are flagged for refund.
- **Renewals:** the renewal invoice is issued a week before a paid period ends; an unpaid renewal moves the subscription to past due with 7 days of grace. Bank transfers can still be recorded by the super admin.
- Recurring automatic card charges (saved cards) are not built yet.

**Advanced Automation** (Professional and Enterprise — Insights → Automation):
- "When … only if … then …" rules. **When:** an event (employee added or leaving, onboarding completed, leave requested/approved/rejected, employee document uploaded, candidate hired, review completed, course completed) or a date (document or training certificate about to expire, probation about to end, N days after joining, work anniversary). **Only if:** department, employment type, nationality, leave type, minimum leave days. **Then (up to 5):** send a notification (employee, manager, department head, anyone with a role, a person), create a task with a due date, assign a course, post to team chat. Messages use placeholders such as {{name}}, {{date}}, {{years}}.
- Event rules are queued in the same transaction as the action (outbox); date rules are checked every 30 minutes and by `scripts/run-jobs.js`. Each rule acts once per occurrence, actions run as the rule's author, and actions performed by automations never trigger other automations.
- Dry-run preview for any employee (nothing is sent), run history with the outcome of every action, pause/resume, and 8 ready-made templates (welcome, Iqama renewal, probation review, 30-day check-in, anniversaries, long leave handover, certificate renewal, offboarding).

**Compliance** (Business plan and above — Insights → Compliance):
- Ten checks on live data, each with who is affected and why: expired documents, required documents per nationality (e.g. contract for everyone, national ID for Saudis, Iqama and passport for non-Saudis — editable), documents expiring soon, Wage Protection readiness (pay details / IBAN / cash pay), GOSI registration, annual leave entitlement (21 days, 30 after five years — Labor Law Art. 109), probation beyond the maximum (Art. 53), weekly hours above 48 (Art. 98), policy acknowledgements, nationality recorded. Saudi-specific checks run for Saudi companies.
- Weighted compliance score (critical/high/medium/low) with daily history, upcoming expiries (documents and training certificates), CSV export, and a one-click fix that raises annual leave to the legal minimum (each change audited).
- **Policy acknowledgements:** mark a company policy as requiring acknowledgement; everyone is notified and sees it in "My work"; progress and pending names on the policy; a new version asks again.
- Rules page: turn checks on/off, required documents, expiry warning days, maximum probation, weekly hours limit. Guidance, not legal advice (stated on the page).

**Advanced Analytics** (Professional, Enterprise or the Advanced Analytics add-on — Insights → Analytics):
- Six sections, one filter row (last 6/12/24 months, department) scoping every KPI and chart: **Workforce** (headcount at month end, joiners/leavers, headcount and Saudization by department, length of service), **Turnover & retention** (monthly turnover, 12-month retention, early attrition, turnover by department, service at exit), **Absence** (absence rate against the company working week, leave days, by type, Bradford factor for sick leave), **Attendance** (on-time arrivals, average hours, overtime by department), **Hiring** (funnel from stage history, applications, time to hire, source effectiveness) and **Payroll cost** (full employer cost of approved runs, cost per employee, contributions share, cost by department).
- Sections appear only for roles that may see that data company-wide. Every chart has a table view, hover tooltips (keyboard too) and CSV export.
- Charts are server-rendered SVG (no chart library, strict CSP kept) in the brand green `#13AA54`, validated for contrast and colour-vision safety in light and dark mode.

**Phase 9 — Enterprise:**
- **Single sign-on (OpenID Connect):** Microsoft Entra ID, Google Workspace, Okta or any OIDC provider (Settings → Single sign-on). Authorization Code + PKCE, ID tokens verified locally (JWKS signature, issuer, audience, expiry, nonce), allowed email domains, optional account creation on first sign-in (JIT) with a default role, and "require SSO" (owners keep a break-glass password). A successful test sign-in is required before enforcing. SAML-only providers are not supported yet.
- **Approval workflows:** multi-step approval chains for leave (direct manager, department head, anyone with a role, a specific person), chosen by leave type and minimum days, with priorities. Steps without an approver are skipped, each approver is notified in turn, the balance is used only after the last approval, and progress is shown on every request.
- **Reports:** 10 ready-made reports (Basic Reports); a report builder over 8 datasets (employees, leave, attendance, payroll, recruitment, learning, goals, documents) with columns, grouping (count/sum/average), period, department and status filters, sorting and CSV export (Advanced Reports); saved and shared reports; scheduled email delivery (daily/weekly/monthly in the company time zone) with the CSV attached, only to recipients allowed to see the data (Enterprise Reporting). Columns are fixed SQL expressions; salaries need `employees.view_salary`.
- **Client success portal:** companies open support tickets (category, priority) and follow the conversation; Super Admin → Support is an inbox ordered by first-response deadline, with assignment, internal notes, status changes, overdue flags and satisfaction ratings. First-response targets: standard 8/24/48/72 h, Enterprise 2/4/8/24 h (urgent/high/normal/low).

**Phase 8 — AI:**
- **Providers:** Anthropic (Claude), OpenAI, Google Gemini or Azure OpenAI, chosen by the Super Admin (Super Admin → AI) with an encrypted API key, connection test, optional token prices for cost estimates, and platform usage (requests, tokens, cost, latency, failures).
- **Governance:** AI features come with the plan (`ai_recruitment`, `ai_documents`, `ai_performance`, `ai_learning`, `ai_analytics`) and each company switches them on in Settings → AI (off by default). Every request is metered against `ai_requests_monthly`; failed requests are not counted. There is a full request log (user, feature, tokens, status).
- **Recruitment:** job posting drafts, and a CV/profile ↔ requirements match with evidence, gaps and interview questions. There is no score, no ranking and no hire/reject advice. Word CVs are read as text; PDFs are sent to the provider.
- **Documents:** summary, parties and key dates, with one-click filling of the issue and expiry dates (saved only when you click Save).
- **Performance:** review summary drafts from ratings, comments, goal progress and feedback. The AI never proposes a rating.
- **Learning:** quiz questions from course content (4 options, one correct), added to the quiz editor for review.
- **AI assistant** (`/app/insights`): answers questions from company-level metrics computed with SQL, limited to what the user may see. It sends no names or salaries per person, and the data used is shown next to the answer.
- **Data minimisation:** emails, phone numbers, IBANs and ID numbers are masked in text before sending, the candidate's name is not sent, and output is validated against a schema before display.

**Phase 7 — Integrations:**
- **Integration hub** (Settings → Integrations) with honest status for every connector. PayWay shows "awaiting API docs" until the provider documentation is available.
- **Outbound webhooks:** choose events (employees, leave, attendance, recruitment, payroll, performance, learning…), HMAC-SHA256 signed payloads (`RemoteWay-Signature: t=…,v1=…`), automatic retries (1m → 24h), delivery log with redeliver, test ping, secret rotation, auto-disable after 15 consecutive failures. Private/internal addresses are blocked.
- **SMS** through Saudi providers (Taqnyat, Unifonic, Msegat) for selected notifications; **team chat** (Slack, Google Chat incoming webhooks). Credentials are encrypted (AES-256-GCM) in the database.
- **Calendar feeds (ICS):** personal and company leave/interview/task feeds for Google Calendar, Outlook and Apple Calendar, with revocable private links.
- **Super Admin:** SMTP email settings from the browser (encrypted, test send) and a **background jobs** monitor (run now, retry failed).
- Background work runs inside the app every 15 seconds. Optional cPanel cron for extra reliability: `*/5 * * * * cd ~/remoteway && node scripts/run-jobs.js`.

**Phase 6 — Learning:**
- **Courses** with ordered lessons: reading (safe formatting), YouTube/Vimeo video played inside the app, documents (private storage), external links and quizzes (single choice, pass mark, best score kept, retries).
- **Catalog & self-enrolment**, mandatory courses, **assignments** by person, department or everyone with due dates (managers can assign to their team), **learning paths** that enrol people in every course.
- **Progress & certificates:** automatic progress, completion, certificates with a unique code, optional expiry (e.g. yearly compliance), printable/PDF certificate and a **public verification page** (`/verify/<code>`); retake to renew.
- **Reports:** completion rate, overdue and expiring certificates, filters, CSV export; Training tab on employee profiles; "to do" on the dashboard.

**Phase 5 — Performance:**
- **Goals & OKRs:** company, department and individual goals, aligned in a hierarchy, with measurable key results (rising or falling targets), automatic progress, health (on track / at risk / off track) and a check-in history.
- **Review cycles:** annual, semi-annual, quarterly or probation; competency library (Arabic/English); goals vs competencies weighting; participants by department; draft → launch → close.
- **Reviews:** self review, then manager review with ratings, comments, strengths and areas to develop; weighted score and final rating (manager override); results hidden from the employee until HR closes the cycle; employee acknowledgement.
- **Feedback:** praise (optionally public) and private suggestions, with notifications.
- Rating distribution per cycle, "waiting for you" on the dashboard, Performance tab on employee profiles, API endpoints.

**Phase 4 — Payroll:**
- **Compensation per employee:** basic salary, recurring allowances/deductions (fixed or % of basic), bank details with IBAN validation (ISO 13616), GOSI registration.
- **Monthly payroll runs:** draft → review → approved (locked) → paid, with optional four-eyes approval (the submitter cannot approve) and a separate `payroll.approve` permission.
- **Calculation engine (Country Policy Engine):** Saudi GOSI (Saudi 9.75% employee / 11.75% employer, non-Saudi 2% employer, contribution wage floor/ceiling — all editable per company), 30-day or calendar-day proration for joiners and leavers, unpaid-leave deductions from the Leave module, one-off adjustments, Labor Law 50% deduction warning, exact money maths (3-decimal currencies supported).
- **Payslips:** printable / save as PDF, visible to the employee once payroll is paid, "My payslips" for everyone.
- **Exports:** payroll register, bank transfer list (IBAN) and GOSI contributions (CSV). Bank-specific WPS file formats arrive with the integrations phase.

**Phase 3 — Talent:**
- **Recruitment (ATS):** jobs (draft → open → closed, counted against the plan's active-jobs limit), candidates with private CV storage, a drag & drop pipeline (applied → screening → shortlisted → interview → assessment → offer → hired / rejected), ratings, internal notes and a full activity timeline.
- **Interviews & assessments:** scheduling in the company time zone, interviewer assignment with notifications, feedback and recommendation from the interviewer (even without recruitment access), scored assessments.
- **Hire:** one step creates the employee record (seat limit enforced), closes the job when all openings are filled and starts onboarding.
- **Public careers page** per company (`/careers/<company>`): open jobs, application form with CV upload, consent, CSRF, rate limiting and a spam honeypot. Turned on from Recruitment.
- **Onboarding:** editable checklist templates (Arabic/English default), plans per new hire with tasks for HR, the manager and the employee, due dates, progress, automatic completion.
- Jobs and candidates in Ctrl/⌘ + K search, "My hiring & onboarding" on the dashboard, REST endpoints under `/api/v1/recruitment` and `/api/v1/onboarding`.

**Phase 2 — Workforce:**
- **Attendance:** clock in/out with breaks, late detection (company hours + grace), daily sheet for HR/managers, monthly timesheets with overtime, audited manual corrections.
- **Leave:** configurable leave types (defaults: annual 21, sick 30, emergency, maternity, unpaid), yearly balances, working-day counting from the company week, overlap/balance checks, manager + HR approvals, cancellations that restore balance, team calendar.
- **Documents:** private storage outside the web root, versions, expiry tracking (30-day alerts), permission-checked downloads, content-based file-type checks, storage limits per plan.
- **Tasks & projects:** board (drag & drop) and list, priorities, due dates, comments, projects with progress (Business+).
- **Notifications:** in-app bell + optional email (SMTP) for leave requests/decisions and task events; invitation emails.
- **CSV import wizard:** upload → map columns (English/Arabic headers) → validate → import, respecting seat limits.

**Phase 1 — SaaS core:**

- **Multi-tenancy:** every record carries `organization_id`; the tenant comes from a verified membership on the server, never from the request.
- **Auth:** sign-up wizard (account → company → plan), login, sessions stored in MySQL, invitations, API tokens (hashed).
- **Organizations:** multiple workspaces per user, organization switcher, company profile, working-week settings from the country policy (Saudi Arabia first).
- **RBAC:** 9 system roles plus a super admin, 39 permissions, a permission matrix, custom roles (Enterprise), team-scoped data for managers, and salary visibility controlled by permission.
- **Subscription engine:** plans, features, limits, add-ons, trials, grace periods, and usage metering all live in the database. Employee, user and API limits are **enforced on the backend**, with row locking.
- **Billing foundation:** invoices with VAT from the country policy. Online payment through Saudi gateways (see above) or offline payments confirmed by a super admin.
- **Employees:** enterprise table (search, filters, sort, column visibility, pagination, CSV export), profile, create/edit, end employment, reactivate, delete.
- **Departments & locations**, **real dashboard** (every number comes from SQL), **action center**, **audit log** with old/new values, **Ctrl/⌘ + K search**.
- **Super Admin:** tenants, subscription overrides and custom limits, plan pricing/limits/features editor, invoices, platform audit log.
- **UI:** RemoteWay brand identity (your logos, the `#1ACC6C / #13AA54 / #000 / #E2E2E2` palette, Montserrat), RTL/LTR, real dark mode, responsive.
- **REST API v1** with standard `{ success, data | error: { code, message } }` responses.

Modules that are not built yet (PayWay and other integrations, AI, analytics…) appear as **Soon / Setup required** with their phase number. Nothing is faked.

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
   - Node.js version: **20** or newer
   - Application mode: **Production**
   - Application root: `remoteway`
   - Application URL: your domain / subdomain
   - Application startup file: **`app.js`**
4. **Environment variables / المتغيرات** — add them in the same screen (or create `/home/USER/remoteway/.env`):

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `APP_URL` | `https://your-domain.com` |
   | `SESSION_SECRET` | a long random string (≥ 32 characters). Also encrypts stored integration credentials unless `APP_KEY` is set — do not change it later, or re-enter those credentials |
   | `AUTO_MIGRATE` | `true` (creates/updates tables on every start) |
   | `DB_HOST` | `localhost` |
   | `DB_NAME` / `DB_USER` / `DB_PASSWORD` | from step 1 |
   | `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` | your platform admin login |
   | `DB_SOCKET` (optional) | `/var/lib/mysql/mysql.sock` if TCP login is refused |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` (optional) | a cPanel mailbox to send invitations & notifications |
   | `STORAGE_PATH` (optional) | where uploaded documents live; defaults to `../remoteway-storage` next to the app |

5. Click **Run NPM Install**, then **Restart**.
6. Open `https://your-domain.com/healthz` → `{"status":"ok"}` means the app is connected to MySQL.
7. Sign in with `SUPER_ADMIN_EMAIL`, then go to **/admin/plans** and set your real prices and limits.
8. Enable HTTPS: cPanel → *SSL/TLS Status* → *Run AutoSSL*.

Using the cPanel **Terminal** instead of `AUTO_MIGRATE` (the exact `source` command is shown at the top of the Node.js App page):

```bash
source /home/USER/nodevenv/remoteway/20/bin/activate && cd ~/remoteway
npm run migrate
```

### Updating — from the browser (recommended)

Super Admin → **System update** (`/admin/system`): upload the `remoteway-dist.zip` package, confirm your password, done.
The app backs up the running version (last 3 kept, one-click restore), replaces the code, installs new dependencies only if they changed,
restarts itself and applies database migrations on start. `.env`, `node_modules` and uploaded documents are never touched.
Backups and the update log live next to the app in `../remoteway-updates` (override with `UPDATES_PATH`).

Build the package with `npm run build` → `remoteway-dist.zip` (files 0644 / folders 0755 so the web server can read them).

Manual alternative: extract the zip over the app folder, click *Run NPM Install*, then *Restart*.

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
