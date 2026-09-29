# RemoteWay — Changelog

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
