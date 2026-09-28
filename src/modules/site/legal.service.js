// Privacy policy and terms of service. Starting texts (Arabic + English) follow the Saudi Personal
// Data Protection Law (PDPL); the platform owner edits them from the admin panel. They should still
// be reviewed by a lawyer before launch — the admin page says so.
// Format: plain text with "## " headings, "- " bullets and blank lines between paragraphs.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');

const KINDS = ['privacy', 'terms'];

const DEFAULTS = {
  privacy: {
    en: `This policy explains how {company} ("we") collects, uses and protects personal data on the RemoteWay platform, in line with the Saudi Personal Data Protection Law (PDPL) and its implementing regulations.

## Who we are
{company} operates RemoteWay, a workforce-management and remote-hiring platform. For data that companies enter about their own employees and candidates, the company is the controller and we process it on its behalf. For your own RemoteWay account and career profile, we are the controller.

## Data we collect
- Account data: name, email, phone, password (stored only as a one-way hash) and language.
- Company data entered by your employer: job, department, attendance, leave, payroll, documents, performance and learning records.
- Career profile data you add yourself: photo, CV, skills, experience, education and job applications.
- Technical data: IP address, browser, sign-in times and a security log of important actions.
- Billing data: invoices and payment status. Card details are entered on the payment provider's page and never reach our servers.

## Why we use it
- To provide the service you or your employer signed up for.
- To keep accounts secure (sign-in checks, two-step verification, fraud prevention).
- To send service messages such as invitations, password resets and invoices.
- To show your career profile to companies, only when you choose to make it visible.
- To meet legal and tax obligations.
We do not sell personal data, and we do not use it for advertising.

## Artificial intelligence
Some features use an AI provider to summarise or suggest. Only the text needed for the request is sent, results are suggestions for a person to review, and no automatic decision with legal effect is made about you.

## Sharing
We share data only with service providers needed to run the platform (hosting, email, SMS, payment gateways, AI provider), under contracts that protect it, or when the law requires it. If data is transferred outside the Kingdom, we do so only as the PDPL allows.

## How long we keep it
Account data is kept while the account is active. When an account is deleted, personal details are removed or anonymised within 30 days, except records we must keep by law (for example invoices). Company data is kept for as long as the company's subscription requires and is deleted on its request.

## Your rights
Under the PDPL you have the right to be informed, to access your data, to get a copy, to correct it, and to ask for its deletion. You can download your data and delete your account at any time from "Account security" in your account. For company records (such as payroll), contact your employer, who controls them. You may also complain to the Saudi Data & AI Authority (SDAIA).

## Security
We use encrypted connections (HTTPS), hashed passwords, optional two-step verification, encrypted storage of secrets, role-based access and daily backups.

## Cookies
We use only essential cookies: one to keep you signed in, and others to remember your language and theme. We do not use advertising or tracking cookies.

## Contact
For privacy questions or requests: {email}.
We may update this policy; the date below shows the latest version. Last updated: {updated}.`,
    ar: `توضح هذه السياسة كيف تجمع {company} ("نحن") البيانات الشخصية على منصة RemoteWay وتستخدمها وتحميها، وفقًا لنظام حماية البيانات الشخصية في المملكة العربية السعودية ولوائحه التنفيذية.

## من نحن
تشغّل {company} منصة RemoteWay لإدارة القوى العاملة والتوظيف عن بُعد. بالنسبة للبيانات التي تُدخلها الشركات عن موظفيها ومرشحيها، تكون الشركة هي جهة التحكم ونعالجها نيابة عنها. أما حسابك الشخصي وملفك المهني فنحن جهة التحكم فيهما.

## البيانات التي نجمعها
- بيانات الحساب: الاسم والبريد والجوال وكلمة المرور (تُحفظ مشفّرة تشفيرًا أحادي الاتجاه) واللغة.
- بيانات الشركة التي يُدخلها صاحب العمل: الوظيفة والقسم والحضور والإجازات والرواتب والمستندات والأداء والتدريب.
- بيانات الملف المهني التي تضيفها بنفسك: الصورة والسيرة الذاتية والمهارات والخبرات والتعليم وطلبات التوظيف.
- بيانات تقنية: عنوان IP والمتصفح وأوقات الدخول وسجل أمني للعمليات المهمة.
- بيانات الفوترة: الفواتير وحالة الدفع. تُدخل بيانات البطاقة في صفحة مزود الدفع ولا تصل إلى خوادمنا.

## لماذا نستخدمها
- لتقديم الخدمة التي اشتركت فيها أنت أو صاحب العمل.
- لحماية الحسابات (التحقق عند الدخول، التحقق بخطوتين، منع الاحتيال).
- لإرسال رسائل الخدمة مثل الدعوات واستعادة كلمة المرور والفواتير.
- لعرض ملفك المهني على الشركات، فقط إذا اخترت إظهاره.
- للوفاء بالالتزامات النظامية والضريبية.
لا نبيع البيانات الشخصية ولا نستخدمها للإعلانات.

## الذكاء الاصطناعي
تستخدم بعض الميزات مزود ذكاء اصطناعي للتلخيص أو الاقتراح. يُرسل فقط النص اللازم للطلب، والنتائج اقتراحات يراجعها شخص، ولا يُتخذ بشأنك أي قرار آلي له أثر نظامي.

## المشاركة
لا نشارك البيانات إلا مع مزودي الخدمات اللازمين لتشغيل المنصة (الاستضافة، البريد، الرسائل النصية، بوابات الدفع، مزود الذكاء الاصطناعي) بموجب عقود تحميها، أو عندما يلزم النظام بذلك. وإذا نُقلت بيانات خارج المملكة فيكون ذلك وفق ما يسمح به النظام فقط.

## مدة الاحتفاظ
نحتفظ ببيانات الحساب ما دام نشطًا. عند حذف الحساب تُحذف البيانات الشخصية أو تُجهَّل خلال 30 يومًا، باستثناء ما يلزم النظام بحفظه (مثل الفواتير). وتُحفظ بيانات الشركة طوال مدة اشتراكها وتُحذف بطلب منها.

## حقوقك
يمنحك النظام الحق في العلم، والوصول إلى بياناتك، والحصول على نسخة منها، وتصحيحها، وطلب إتلافها. يمكنك تنزيل بياناتك وحذف حسابك في أي وقت من صفحة "أمان الحساب". أما سجلات الشركة (مثل الرواتب) فتواصل بشأنها مع صاحب العمل بصفته جهة التحكم. ويحق لك تقديم شكوى إلى الهيئة السعودية للبيانات والذكاء الاصطناعي (سدايا).

## الأمان
نستخدم اتصالًا مشفّرًا (HTTPS) وتشفير كلمات المرور والتحقق بخطوتين الاختياري وتشفير البيانات السرية والصلاحيات حسب الدور ونسخًا احتياطية يومية.

## ملفات تعريف الارتباط
نستخدم ملفات ضرورية فقط: واحد لإبقائك مسجلًا، وأخرى لتذكّر اللغة والمظهر. لا نستخدم ملفات إعلانية أو تتبعية.

## التواصل
للاستفسارات أو الطلبات المتعلقة بالخصوصية: {email}.
قد نحدّث هذه السياسة، ويوضح التاريخ أدناه آخر نسخة. آخر تحديث: {updated}.`,
  },
  terms: {
    en: `These terms govern the use of RemoteWay, operated by {company}. By creating an account or using the platform you agree to them.

## Accounts
- You must give accurate information and keep your password and verification codes private.
- A company account is opened by a person authorised to act for the company, who is responsible for the users it invites.
- Tell us immediately at {email} if you suspect unauthorised use.

## Subscriptions and payment
- Paid plans are billed in advance for the chosen period (monthly or yearly), with VAT where applicable.
- Free trials end automatically; features that need a paid plan stop until a plan is chosen.
- If an invoice is not paid on time, the account may be limited after notice. Data is not deleted because of late payment without further notice.
- Fees already paid are not refundable, except where the law requires otherwise.

## Acceptable use
You may not use the platform to break the law, upload harmful software, try to access data of other companies or users, overload or attack the service, or post false or discriminatory job adverts.

## Your content
Companies and users keep ownership of the data they enter. You give us the permission needed to host and process it only to provide the service. Companies are responsible for having a lawful basis for the employee and candidate data they enter.

## Job marketplace
RemoteWay connects companies and individuals but is not a party to any employment agreement between them and does not guarantee a hire. Companies are responsible for their hiring decisions and job adverts.

## Availability and changes
We work to keep the service available and back it up daily, but we do not guarantee it will be uninterrupted. We may improve or change features; we will give notice of material changes to these terms.

## Liability
To the extent the law allows, our total liability for any claim is limited to the fees paid for the service in the three months before the claim, and we are not liable for indirect losses.

## Ending the service
You may close your account at any time. We may suspend accounts that break these terms. After a company closes its account it can ask for an export of its data within 30 days.

## Law
These terms are governed by the laws of the Kingdom of Saudi Arabia, and its competent courts have jurisdiction.

## Contact
{email}. Last updated: {updated}.`,
    ar: `تنظّم هذه الشروط استخدام منصة RemoteWay التي تشغّلها {company}. بإنشاء حساب أو استخدام المنصة فإنك توافق عليها.

## الحسابات
- يجب تقديم معلومات صحيحة والحفاظ على سرية كلمة المرور ورموز التحقق.
- يفتح حساب الشركة شخص مخوّل بتمثيلها، ويكون مسؤولًا عن المستخدمين الذين يدعوهم.
- أبلغنا فورًا على {email} إذا اشتبهت في استخدام غير مصرح به.

## الاشتراكات والدفع
- تُفوتر الباقات المدفوعة مقدمًا عن المدة المختارة (شهرية أو سنوية) مع ضريبة القيمة المضافة حيث تنطبق.
- تنتهي الفترة التجريبية تلقائيًا، وتتوقف الميزات المدفوعة حتى اختيار باقة.
- إذا لم تُسدَّد فاتورة في موعدها فقد يُقيَّد الحساب بعد الإشعار، ولا تُحذف البيانات بسبب التأخر دون إشعار إضافي.
- الرسوم المدفوعة غير قابلة للاسترداد إلا حيث يوجب النظام ذلك.

## الاستخدام المقبول
لا يجوز استخدام المنصة لمخالفة الأنظمة، أو رفع برمجيات ضارة، أو محاولة الوصول لبيانات شركات أو مستخدمين آخرين، أو إرهاق الخدمة أو مهاجمتها، أو نشر إعلانات وظائف مضللة أو تمييزية.

## المحتوى الخاص بك
تبقى ملكية البيانات للشركات والمستخدمين الذين يُدخلونها، وتمنحنا الإذن اللازم لاستضافتها ومعالجتها لتقديم الخدمة فقط. والشركات مسؤولة عن وجود أساس نظامي لبيانات الموظفين والمرشحين التي تُدخلها.

## سوق الوظائف
تربط RemoteWay بين الشركات والأفراد لكنها ليست طرفًا في أي عقد عمل بينهم ولا تضمن التوظيف. والشركات مسؤولة عن قرارات التوظيف وإعلانات الوظائف.

## التوفر والتغييرات
نعمل على إتاحة الخدمة ونأخذ نسخًا احتياطية يومية، لكن لا نضمن عدم انقطاعها. وقد نطوّر الميزات أو نغيّرها، وسنُشعر بأي تغيير جوهري على هذه الشروط.

## المسؤولية
في الحدود التي يسمح بها النظام، تقتصر مسؤوليتنا الإجمالية عن أي مطالبة على الرسوم المدفوعة خلال الأشهر الثلاثة السابقة لها، ولا نتحمل الخسائر غير المباشرة.

## إنهاء الخدمة
يمكنك إغلاق حسابك في أي وقت، ويجوز لنا تعليق الحسابات المخالفة لهذه الشروط. وبعد إغلاق حساب الشركة يمكنها طلب نسخة من بياناتها خلال 30 يومًا.

## النظام المطبق
تخضع هذه الشروط لأنظمة المملكة العربية السعودية، وتختص محاكمها المختصة بأي نزاع.

## التواصل
{email}. آخر تحديث: {updated}.`,
  },
};

async function stored() {
  const row = await knex('platform_settings').where({ key: 'legal' }).first();
  return row ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : {};
}

async function details() {
  const s = await stored();
  return {
    company: s.company || 'RemoteWay',
    email: s.email || process.env.PRIVACY_EMAIL || process.env.SMTP_FROM || process.env.MAIL_FROM || '',
    updated_at: s.updated_at || null,
    custom: { privacy: s.privacy || {}, terms: s.terms || {} },
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Plain text → safe HTML: "## " headings, "- " bullets, blank-line paragraphs, emails become links. */
function toHtml(text) {
  const link = (s) => esc(s).replace(/([\w.+-]+@[\w-]+\.[\w.-]+)/g, '<a class="link" href="mailto:$1">$1</a>');
  return String(text).replace(/\r/g, '').split(/\n{2,}/).map((block) => {
    const lines = block.split('\n').filter((l) => l.trim());
    if (!lines.length) return '';
    const out = [];
    let list = [];
    const flush = () => { if (list.length) { out.push(`<ul>${list.map((l) => `<li>${link(l)}</li>`).join('')}</ul>`); list = []; } };
    let para = [];
    const flushP = () => { if (para.length) { out.push(`<p>${para.map(link).join('<br>')}</p>`); para = []; } };
    for (const l of lines) {
      if (l.startsWith('## ')) { flush(); flushP(); out.push(`<h2>${esc(l.slice(3))}</h2>`); } else if (/^- /.test(l)) { flushP(); list.push(l.slice(2)); } else { flush(); para.push(l); }
    }
    flush(); flushP();
    return out.join('');
  }).join('\n');
}

/** The text for one page in one language, with the details filled in. */
async function page(kind, locale) {
  if (!KINDS.includes(kind)) throw E.notFound('Page');
  const d = await details();
  const lang = locale === 'ar' ? 'ar' : 'en';
  const raw = d.custom[kind][lang] || DEFAULTS[kind][lang];
  const updated = d.updated_at ? new Date(d.updated_at).toISOString().slice(0, 10) : '2026-10-01';
  const text = raw.replace(/\{company\}/g, d.company).replace(/\{email\}/g, d.email || (lang === 'ar' ? 'نموذج التواصل في المنصة' : 'the contact form on the platform')).replace(/\{updated\}/g, updated);
  return { kind, html: toHtml(text), updated, customised: Boolean(d.custom[kind][lang]) };
}

async function save(ctx, input) {
  const s = await stored();
  const clean = (v, n) => String(v || '').replace(/\r/g, '').trim().slice(0, n);
  const next = { ...s, company: clean(input.company, 200) || 'RemoteWay', email: clean(input.email, 200), updated_at: new Date().toISOString() };
  if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) throw E.validation({ email: 'Enter a valid email address.' });
  for (const kind of KINDS) {
    next[kind] = {};
    for (const lang of ['en', 'ar']) {
      const v = clean(input[`${kind}_${lang}`], 60000);
      // Saving the unchanged starting text keeps following future updates to it.
      if (v && v !== DEFAULTS[kind][lang].trim()) next[kind][lang] = v;
    }
  }
  const value = JSON.stringify(next);
  await knex('platform_settings').insert({ key: 'legal', value }).onConflict('key').merge({ value, updated_at: new Date() });
  await audit.record(ctx, 'platform.legal_updated', { newValues: { company: next.company, email: next.email } });
}

module.exports = { KINDS, DEFAULTS, details, page, save, toHtml };
