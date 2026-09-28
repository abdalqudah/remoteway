// Ready-made automations. Texts use {{placeholders}}; the builder opens them for review before saving.
module.exports = [
  { key: 'welcome', trigger: 'employee.created', actions: [
    { type: 'notify', to: 'employee', message: { en: 'Welcome to the team, {{first_name}}! Your first days are set up in RemoteWay.', ar: 'أهلًا بك في الفريق يا {{first_name}}! أيامك الأولى جاهزة في RemoteWay.' } },
    { type: 'notify', to: 'manager', message: { en: '{{name}} joins your team as {{job_title}}.', ar: 'ينضم {{name}} إلى فريقك بوظيفة {{job_title}}.' } },
  ] },
  { key: 'iqama_expiring', trigger: 'document_expiring', days: 60, category: 'iqama', conditions: { nationality: 'non_saudi' }, actions: [
    { type: 'create_task', to: 'role:hr_manager', message: { en: 'Renew Iqama for {{name}} (expires {{date}})', ar: 'تجديد إقامة {{name}} (تنتهي {{date}})' }, due_days: 14 },
    { type: 'notify', to: 'employee', message: { en: 'Your Iqama expires on {{date}}. HR will contact you about the renewal.', ar: 'تنتهي إقامتك في {{date}}. سيتواصل معك فريق الموارد البشرية للتجديد.' } },
  ] },
  { key: 'probation_review', trigger: 'probation_ending', days: 14, actions: [
    { type: 'create_task', to: 'manager', message: { en: 'Probation review for {{name}} — decide before {{date}}', ar: 'تقييم فترة تجربة {{name}} — القرار قبل {{date}}' }, due_days: 10 },
  ] },
  { key: 'check_in_30', trigger: 'days_after_joining', days: 30, actions: [
    { type: 'create_task', to: 'manager', message: { en: '30-day check-in with {{name}}', ar: 'لقاء متابعة بعد 30 يومًا مع {{name}}' }, due_days: 3 },
  ] },
  { key: 'anniversary', trigger: 'work_anniversary', actions: [
    { type: 'notify', to: 'employee', message: { en: 'Happy {{years}}-year work anniversary, {{first_name}}! Thank you for everything.', ar: 'كل عام وأنت بخير يا {{first_name}} بمناسبة إكمال {{years}} سنة معنا! شكرًا لعطائك.' } },
    { type: 'post_chat', message: { en: '🎉 {{name}} celebrates {{years}} year(s) with us today!', ar: '🎉 يحتفل {{name}} اليوم بإكمال {{years}} سنة معنا!' } },
  ] },
  { key: 'long_leave', trigger: 'leave.approved', conditions: { min_days: 10 }, actions: [
    { type: 'notify', to: 'manager', message: { en: '{{name}} will be on {{leave_type}} for {{days}} days from {{date}}. Plan the handover.', ar: '{{name}} في {{leave_type}} لمدة {{days}} يومًا من {{date}}. رتّب التسليم.' } },
  ] },
  { key: 'certificate_expiring', trigger: 'certificate_expiring', days: 30, actions: [
    { type: 'notify', to: 'employee', message: { en: 'Your "{{course}}" certificate expires on {{date}}. Please retake the course.', ar: 'تنتهي شهادة "{{course}}" في {{date}}. يرجى إعادة الدورة.' } },
  ] },
  { key: 'offboarding', trigger: 'employee.terminated', actions: [
    { type: 'create_task', to: 'role:hr_manager', message: { en: 'Offboarding for {{name}}: recover equipment, revoke access, final settlement', ar: 'إنهاء خدمة {{name}}: استلام العهد وإلغاء الصلاحيات والمخالصة النهائية' }, due_days: 3 },
  ] },
];
