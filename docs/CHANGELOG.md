# RemoteWay — Changelog

## 1.9.2 — Job seekers' menu

- The account menu of a job seeker (personal account without a company) no longer offers “Create a company workspace”. Companies still sign up from the sign-up page.
- Test fix: the weekly working-hours compliance test no longer depends on the day of the week it runs.

## 1.9.1 — Works on MySQL 5.7 and older MariaDB

- Fixed the SQL error `near 'RECURSIVE team AS (…'` on servers running MySQL 5.7 or MariaDB before 10.2 (common on shared hosting): a manager's reporting line (team view, leave approvals, attendance) is now worked out in the app from one simple query instead of `WITH RECURSIVE`.
- A test now stops SQL that these versions do not support from coming back.

## 1.9.0 — Flexible SMTP (any mail server)

- **One SMTP form for the platform (Super Admin → Email) and for each company (Settings → Email).** Provider presets only fill suggested values — Custom SMTP, Gmail / Google Workspace, Google SMTP Relay, Microsoft 365, Outlook.com, Hosting / cPanel — and every field stays editable, so any SMTP server works.
- New fields: **Security** (None / STARTTLS / SSL-TLS), **Authentication** (Username & password, or None / IP authentication / relay), From email, From name and **Reply-To**. With “None” no username or password is sent at all (Google SMTP Relay with an IP allowlist, internal relays).
- **Test SMTP connection** (connect, TLS, login — sends nothing) and **Send test email** to any address, each showing exactly where it failed with the error type (ENOTFOUND, ECONNREFUSED, ETIMEDOUT, ECONNRESET, EAUTH / 535, 530, 550, TLS, certificate) and what to check. Warnings for common mismatches (587 with SSL, 465 without SSL, password without encryption, From different from the username).
- **Recent SMTP checks and failures** table on both pages (host, port, security, error code) — passwords are never logged.
- Passwords stay encrypted and are never returned (`GET /admin/email/settings` and `/app/settings/email/settings` show `********`); saving without retyping the password keeps the stored one.
- `.env` fallback: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_AUTH`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM` (settings saved in the admin take priority). Existing settings keep working unchanged (security is derived from the port as before).

## 1.8.1 — Emails from test companies

- Test companies now send emails like real ones (the company mailbox when connected, otherwise the platform email — even when company mailboxes are required), with **[TEST]** at the start of every subject.
- The generated test addresses (`@….sandbox.remoteway.local`) are never emailed, since they do not exist.
- “Send emails” can be switched on or off per test company (on by default) from Super Admin → Test environment.


## 1.8.0 — Test environment

- **Super Admin → Test environment:** create test companies on the live platform for the team to try everything — with realistic sample data (20 employees, departments, attendance, leave, payroll, recruitment, performance, learning) or empty like a new customer, on any plan.
- Each test company has ready accounts for every role (owner, HR, finance, manager, employee) with one password shown on the page, a link like `/test-xxxx`, and a banner inside the app saying it is a test company. Team members can also be added with their own accounts and a role.
- Kept apart from real customers: no email is ever sent from or to it, its jobs never reach the public jobs board, it is left out of the overview figures and the CRM, and it is always active (no trial, no invoices). Marked “Test” in the companies list.
- **Reset with fresh data** (team access kept) and **Delete with all data** — every record, uploaded file and generated account; team members' own accounts stay. Both ask for your password.
- `npm run seed:demo` now uses the same sample-company builder.


## 1.7.0 — Company email

- **Settings → Email:** each company connects its own mailbox (SMTP — cPanel hosting, Google Workspace, Microsoft 365, Zoho presets). A test message is sent first; the mailbox is used only when it arrives. Password stored encrypted; internal network addresses refused; clear messages for wrong password, blocked port, TLS and sender problems.
- Company emails — invitations, notifications (leave, tasks, payslips, reviews…), scheduled reports, talent invitations — are sent from the company's address and sender name.
- **Super Admin → Email → Company mailboxes:** “Companies must connect their own email” (on by default). While a company has not connected one, RemoteWay does not email its people from the platform address; its admins see a reminder banner and a dot on Settings → Email. Account emails (confirm address, reset password) always use the platform email.


## 1.6.0 — Menus that fit the person, owner as employee or not

- **Sidebar:** each item appears only when it applies: “My interviews” only for people who interview candidates; onboarding only for HR or people with an onboarding plan; “My payslips”, performance and learning for employees; locked (not in plan) modules and “coming soon” items only for people who manage the subscription. Empty groups are hidden.
- **Settings → My account → “Do you also work here as an employee?”** (owners and admins): “Yes” links you to an employee record (the one with your email, or a new one) so you get clock-in, your own leave, payslips and reviews; “No” removes those from your account and keeps the employee record for HR history.
- Leave opens on approvals/calendar for people without their own leave; “My goals” is hidden for non-employees.
- The dashboard card “My recruitment and onboarding” is now “Waiting for you” (training, reviews, policies, onboarding tasks, interviews).


## 1.5.2 — In-app QR scanner

- “Scan the QR code at the office” on the employee's dashboard is now a real button: it opens the phone camera inside RemoteWay (Attendance → Scan), reads the screen's code and records the attendance — no separate scanner app needed. Uses jsQR (Apache-2.0), served from the site itself.
- Clear messages when camera access is refused or not available, and when the camera sees a different QR code.
- Phone layout: dashboards no longer run wider than the screen.


## 1.5.1 — QR scanning fixes

- “Same network only” now recognises phones on the same Wi-Fi over IPv6 (each device has its own IPv6 address; the check now compares the /64 network) and remembers the screen's IPv4 and IPv6 networks from the last 30 minutes.
- Links (including the one inside the QR code) always use https in production, so the sign-in session is kept after scanning.
- The screen warns when it is opened on localhost (phones cannot reach it); the phone explains what to do when it is not on the office Wi-Fi.
- Tested end to end: a new employee scans while signed out, signs in with the temporary password, chooses their own password and is clocked in.


## 1.5.0 — Employee sign-in with a temporary password

- **Employee page → Sign-in account** (needs “Manage users”): create the employee's account with an email, a role and a temporary password — typed by the admin or generated (easy to read, e.g. `atyc-4823-qDWe`). The details to hand over (sign-in link, email, password) are shown once. No email set-up needed.
- **First sign-in:** the employee must choose their own password before opening anything else (can be turned off per account). The temporary password stops working.
- **Forgot password:** the admin can set a new temporary password from the same box; the employee is signed out of other devices.
- Safety: only for accounts that live entirely inside the company (not the owner, not yourself, not someone who also uses the account elsewhere); an email that already has a RemoteWay account must be invited instead.


## 1.4.2 — QR screen address fix

- The QR screen link and the code inside the QR now use the address the site was opened on (e.g. remoteway.net) when APP_URL is missing or still set to localhost — before, “Open screen” could go to localhost:3000 and phones could not open the scanned link.
- Super Admin shows a warning with the exact value to set when APP_URL is missing or points to localhost (emails, password resets and Google/SSO sign-in need it).


## 1.4.1 — QR every 10 seconds

- The attendance QR screen now shows a new code every 10 seconds (was every minute). Any number of employees can scan the same code at the same moment; a scanned code is accepted for up to 30 seconds so slow phone cameras still get through.


## 1.4.0 — Company database copy

- **Settings → Your database** (white-label companies): connect your own MySQL/MariaDB or PostgreSQL database and RemoteWay keeps a copy of your data there — employees, departments and locations, basic salaries, attendance, leave (types, requests, balances), payroll runs and payslips, recruitment (jobs, candidates, applications) and tasks.
- Tables are created with a prefix (`rw_employees`, `rw_attendance`, …) and refreshed every hour, every day or on demand; each table is replaced inside a transaction, deletions follow, new columns are added automatically, and `rw_sync_info` shows the last copy. Other tables in your database are never touched. The copy is one-way.
- "Save and test" checks the connection and that tables can be created; clear messages for wrong password, missing database, firewall and SSL problems; a log of the last 50 copies.
- Security: password stored encrypted; SSL on by default; addresses inside RemoteWay's own network are refused; payroll and salary data can only be chosen by someone allowed to see it; one copy at a time per company.


## 1.3.0 — Search, marketing, Google sign-in, custom domains

- **Search & AI visibility** (Super Admin → Search & AI visibility): site name, description and keywords (AR/EN); title, description and "hide from search engines" per public page; share image from the media library; canonical and Arabic/English alternate links (hreflang) on every public page; Google/Bing/Yandex verification; a quick health check.
- **AEO (structured data):** Organization (logo, social profiles, contact), WebSite with search, SoftwareApplication with the plans and prices, FAQPage from the website's FAQ section, and JobPosting on marketplace job pages (Google for Jobs).
- **GEO:** switches for AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot…) in robots.txt, and an editable `/llms.txt` (generated from the site content by default). Sitemap now lists both languages.
- **Marketing:** social media accounts (X, LinkedIn, Instagram, Facebook, YouTube, TikTok, Snapchat, WhatsApp, Telegram, Threads) as footer icons; pixels for GA4, Google Tag Manager, Meta, TikTok, Snap, LinkedIn and X. Pixels load only on public pages and only after the visitor accepts (accept / essential only; changeable on the privacy page); the privacy policy lists them automatically; conversions (company sign-up, individual sign-up, demo request) are reported once.
- **Sign in with Google:** set up from Super Admin with a Google Cloud OAuth client; buttons on sign-in, individual sign-up and company pages. Existing accounts are linked by verified email; new addresses become individual accounts (optional). Two-step verification and company SSO enforcement still apply; the platform team cannot use it. Users can unlink it from Account security.
- **White-label custom domains:** a domain goes live only after DNS proves ownership (TXT `_remoteway.<domain>`) and points to the platform (CNAME, or A with `SERVER_IP`). Companies see the records and "Check now"; Super Admin → Custom domains lists every domain with approve / stop / resume, and can add verified domains to cPanel as alias domains with AutoSSL (optional API token, stored encrypted). Domains saved before 1.3.0 stay live.


## 1.2.0 — Website media and alignment

- **Media library** (Super Admin → Website → Media library): upload images (JPG, PNG, WebP, GIF up to 8 MB) and videos (MP4, WebM up to 30 MB), or add YouTube/Vimeo links. Files are checked by their content (no SVG), stored outside the app folder and served with range support.
- **Every section** gets title alignment (start/center/end), text alignment (start/center/end/justified) and an image or video: above, below, beside (either side), as a background with a dark layer, or — in the hero — instead of the green panel. Sizes small/medium/large/full; videos with controls or auto-play (muted, looping).
- **Cards and feature-grid items** can show an image instead of an icon.

## 1.1.0 — Editable website

- **Landing page editor** (Super Admin → Website): every text on the public site, in Arabic and English, from the header to the footer. Add, delete, hide, duplicate and reorder sections; edit, add, remove and reorder the items inside each section (cards, modules, list items, questions, numbers, menu and footer links); choose icons from 169; restore the original page at any time.
- Section types: hero, numbers, latest jobs, talent, cards with buttons, modules grid, list with badges, feature grid, pricing, FAQ, free text, call-to-action band. Jobs, talent and pricing cards stay live; their headings and buttons are editable. The pricing heading is also used on /pricing.
- Links accept site paths, anchors, http(s), mailto and tel only; all texts are escaped.

## 1.0.0 — Launch release

The first production release. Everything below ships together; install it from Super Admin → System update.

### Launch hardening (since 0.16)
- **Account security:** password reset by email (one-time, 60 min); reset links created by company admins or the platform team when email is not set up (24 h, audited); change password from *Account security*; two-step verification (authenticator app + recovery codes), optionally required for the platform team; sign-in slowed after repeated wrong passwords and a 15-minute pause after 5 wrong codes; other devices signed out after a password change.
- **Email verification:** new accounts confirm their address (48 h link); unconfirmed accounts cannot invite people or apply to jobs, and must confirm after 7 days. Only active once email sending is configured.
- **Backups:** pure-Node database backups (no shell needed), daily schedule, retention, download, upload, restore with a safety copy.
- **Error log** in Super Admin (secrets hidden, 90-day retention).
- **Privacy (PDPL):** editable Arabic/English privacy policy and terms, essential-cookies notice, personal data export, account deletion (anonymisation), `robots.txt` and `sitemap.xml`.
- **Launch readiness page:** live checks with fix links; one-click removal of the demo data (owner only, safety backup first).
- **Security review fixes:** SSO can no longer link or sign in accounts outside the company or the platform team, and SSO sessions only reach their company; SSRF guard covers IPv6 literals; the public careers form never overwrites an existing candidate; marketplace applications only link a company's candidate record when safe; department managers cannot edit other departments' goals; Arabic pages keep right-to-left layout everywhere.
- **Second security review (1.0.0):** a company admin can only see a reset link for accounts that live entirely inside the company (otherwise it is emailed to the person); wrong passwords slow sign-in down but can no longer lock the real owner out or reveal which emails exist; QR screens default to “same network only”, off-network scans are flagged, and a new screen link cancels open scans; choosing an area on a company page switches company only through a form post; X-Forwarded-For is trusted only from the local web server by default (`TRUST_PROXY`).

### New in 1.0.0
- **Company link:** every company chooses `remoteway.net/<name>`; the page shows its name and logo and asks who is signing in (employee, manager, HR, payroll, recruitment, admin).
- **QR attendance:** office screens show a code that changes every minute; employees scan with their phone to clock in and out. Optional “same network only” and “QR required” policies.

### Earlier versions
| Version | Content |
|---|---|
| 0.16 | Internal CRM for the RemoteWay team (contacts, pipeline, email/SMS/WhatsApp, follow-ups, AI insights) |
| 0.15 | Talent & Jobs Marketplace (profiles, jobs board, discover talent, AI matching) |
| 0.14 | Platform team roles, company management, company logos, white label |
| 0.13 | Online payments: Moyasar, Tap, HyperPay, PayTabs |
| 0.12 | Advanced automation |
| 0.11 | Compliance (Saudi labour-law checks, score, policy acknowledgements) |
| 0.10 | Advanced analytics |
| 0.9 | Enterprise: SSO, approval workflows, reports, client success portal |
| 0.8 | AI layer (Claude, OpenAI, Gemini, Azure OpenAI) |
| 0.7 | Integrations: webhooks, SMS, chat, calendar feeds |
| 0.6 | Learning |
| 0.5 | Performance |
| 0.4 | Payroll with Saudi GOSI |
| 0.3 | Recruitment (ATS), careers page, onboarding |
| 0.2 | Attendance, leave, documents, tasks, notifications |
| 0.1 | Foundation: multi-company workspaces, roles, subscriptions, Super Admin |
