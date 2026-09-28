# RemoteWay — Changelog

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
