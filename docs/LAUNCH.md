# RemoteWay — Launch checklist (cPanel / Orange Host)

Super Admin → **Launch readiness** runs these checks live. Fix every red item; yellow items are strongly recommended.

## 1. Server (.env — cPanel → Setup Node.js App → Environment variables, then Restart)
| Setting | Value |
|---|---|
| `NODE_ENV` | `production` (secure cookies, no error details on screen) |
| `APP_URL` | `https://your-domain.com` — enable SSL first (cPanel → SSL/TLS Status → AutoSSL) |
| `SESSION_SECRET` | 48+ random characters: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `APP_KEY` | a different 48+ character random value. Set once, **before** entering gateway/SMTP/AI keys. Changing it later makes saved keys and 2FA unreadable. |
| `STORAGE_PATH`, `BACKUP_PATH` | folders outside the app folder (defaults are next to it) |
| Node.js | 20 or newer |

## 2. Security
- Change the default super-admin password (`Admin@12345`): top bar → shield icon → Account security → Change password.
- Turn on two-step verification for your account (top bar → shield icon), then Super Admin → Platform team → **Require two-step verification**.
- Remove the demo data: Launch readiness → **Demo data** → Remove (platform owner only; a safety backup is taken first; only `@demo.remoteway.local` accounts and their companies are touched).
- Keep the recovery codes of the owner account somewhere offline.

## 3. Operations
- **Email**: Super Admin → Email — add the cPanel mailbox SMTP. Password reset and invitations need it.
- **Backups**: Super Admin → Backups — daily backup is on by default (02:00 UTC = 05:00 Riyadh), keeps 14. Take one now and **download a copy** off the server weekly. Restore takes a safety backup first.
- **Cron (recommended)**: cPanel → Cron Jobs → every 5 minutes: `cd ~/remoteway && node scripts/run-jobs.js` (covers quiet hours when the app sleeps; also runs the daily backup).
- **Error log**: Super Admin → Error log shows unexpected errors (kept 90 days, secrets hidden).

## 4. Business
- **Payments**: finish sandbox tests for your gateway, then switch to **Live**.
- **Privacy & terms**: Super Admin → Privacy & terms — enter your legal entity (as on the CR) and privacy email. The starting texts follow the Saudi PDPL but are a template: have a lawyer review them.
- **Plans**: check prices, VAT and trial days in Super Admin → Plans.
- **AI** (optional): add a provider key in Super Admin → AI.

## 4b. Email verification
New accounts (company sign-up and individual sign-up) get a confirmation link valid for 48 hours. Until it is confirmed, the account works but cannot invite people or apply to jobs, and after 7 days it must confirm before continuing. Accepting an invitation, using a password-reset link or signing in through a company's SSO also confirms the address. Accounts created before this release count as confirmed. **This only switches on once email sending is configured** — without SMTP nobody is blocked.

## 4c. Password recovery
- **Forgot password** on the sign-in page emails a one-time link (60 minutes). Without email set up, the page says so instead of pretending to send.
- **Company admins** (Settings → Users → *Reset password*) create a link for a member of their company.
- **Platform team** (Super Admin → Users, or a company's page → Company users) finds any account and creates a link. Roles: owner, admin, support.
- These links last 24 hours, work once, are emailed when email works, and are otherwise shown to copy and send privately. Every link is recorded in the audit log.

## 5. Personal data rights (PDPL)
Every user can, from **Account security**:
- download their data (JSON);
- delete their account — the account and career profile are removed and personal details anonymised; employer records stay without the name. Company owners must transfer or close the company first.

## 6. After launch
- Watch Launch readiness and the Error log daily in the first week.
- Search engines: `https://your-domain.com/sitemap.xml` (submit it in Google Search Console); `robots.txt` blocks private areas.

## 7. Measured capacity (one Node process, production mode, 50–100 concurrent users)
| Page | Requests / second | Median latency |
|---|---|---|
| Home page (carousels cached 60 s) | ~210 | ~230 ms |
| Jobs board | ~450 | ~105 ms |
| Pricing | ~330 | ~145 ms |
| Login page | ~1,000 | ~95 ms |
| Signed-in dashboard / employees (dev mode) | ~65 | ~450 ms |

Measured with `autocannon` on the build server; a shared host will be slower, but a single process comfortably serves hundreds of daily active companies. If pages slow down, raise the Node.js app's memory/CPU in cPanel before anything else.
