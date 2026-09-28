// Reference data for the platform. Seeded by `npm run seed` (idempotent upserts).
// Prices, limits and plan contents live in the database after seeding and are
// managed from Super Admin → Plans. Nothing here is read at request time.

const PERMISSIONS = [
  ['organization.manage', 'organization', 'Edit company profile and settings'],
  ['settings.manage', 'organization', 'Manage organization settings'],
  ['users.view', 'users', 'View workspace users'],
  ['users.manage', 'users', 'Invite, disable and assign roles to users'],
  ['roles.manage', 'users', 'Create and edit roles'],
  ['billing.view', 'billing', 'View subscription, usage and invoices'],
  ['billing.manage', 'billing', 'Change plan and add-ons'],
  ['audit.view', 'organization', 'View audit log'],
  ['api.manage', 'integrations', 'Create and revoke API tokens'],
  ['integrations.manage', 'integrations', 'Configure integrations'],
  ['employees.view', 'employees', 'View all employees'],
  ['team.view', 'employees', 'View own team (direct and indirect reports)'],
  ['employees.create', 'employees', 'Add employees'],
  ['employees.edit', 'employees', 'Edit employees'],
  ['employees.delete', 'employees', 'Terminate or delete employees'],
  ['employees.view_salary', 'employees', 'View salary information'],
  ['departments.manage', 'employees', 'Manage departments'],
  ['locations.manage', 'employees', 'Manage locations'],
  ['attendance.view', 'attendance', 'View attendance'],
  ['attendance.manage', 'attendance', 'Manage attendance'],
  ['leave.view', 'leave', 'View leave'],
  ['leave.request', 'leave', 'Request leave'],
  ['leave.approve', 'leave', 'Approve or reject leave'],
  ['payroll.view', 'payroll', 'View payroll'],
  ['payroll.process', 'payroll', 'Process payroll'],
  ['payroll.approve', 'payroll', 'Approve payroll'],
  ['performance.view', 'performance', 'View performance'],
  ['performance.manage', 'performance', 'Manage performance'],
  ['recruitment.view', 'recruitment', 'View recruitment'],
  ['recruitment.manage', 'recruitment', 'Manage recruitment'],
  ['documents.view', 'documents', 'View documents'],
  ['documents.manage', 'documents', 'Manage documents'],
  ['payway.view', 'payway', 'View PayWay integration'],
  ['payway.manage', 'payway', 'Manage PayWay integration'],
  ['reports.view', 'reports', 'View reports'],
  ['tasks.view', 'tasks', 'View all tasks and projects'],
  ['tasks.manage', 'tasks', 'Create, assign and manage tasks and projects'],
  ['onboarding.manage', 'onboarding', 'Run onboarding plans and templates'],
  ['learning.manage', 'learning', 'Create courses, assign training and see learning reports'],
];

const ALL = PERMISSIONS.map((p) => p[0]);

const ROLE_TEMPLATES = [
  { key: 'owner', name: 'Organization Owner', description: 'Full control including billing', permissions: ALL },
  {
    key: 'admin', name: 'Organization Admin', description: 'Full administration except plan changes',
    permissions: ALL.filter((p) => p !== 'billing.manage'),
  },
  {
    key: 'hr_manager', name: 'HR Manager', description: 'Manages people, structure and HR processes',
    permissions: ['users.view', 'employees.view', 'employees.create', 'employees.edit', 'employees.delete', 'employees.view_salary',
      'departments.manage', 'locations.manage', 'attendance.view', 'attendance.manage', 'leave.view', 'leave.request', 'leave.approve',
      'performance.view', 'performance.manage', 'recruitment.view', 'recruitment.manage', 'documents.view', 'documents.manage', 'reports.view',
      'tasks.view', 'tasks.manage', 'onboarding.manage', 'learning.manage'],
  },
  {
    key: 'recruiter', name: 'Recruiter', description: 'Runs hiring pipelines',
    permissions: ['employees.view', 'recruitment.view', 'recruitment.manage', 'documents.view', 'leave.request', 'onboarding.manage'],
  },
  {
    key: 'finance_manager', name: 'Finance Manager', description: 'Financial visibility and billing',
    permissions: ['employees.view', 'employees.view_salary', 'billing.view', 'payroll.view', 'payroll.approve', 'payway.view', 'reports.view', 'leave.request'],
  },
  {
    key: 'payroll_manager', name: 'Payroll Manager', description: 'Prepares and processes payroll',
    permissions: ['employees.view', 'employees.view_salary', 'attendance.view', 'leave.view', 'payroll.view', 'payroll.process',
      'payway.view', 'payway.manage', 'reports.view', 'leave.request'],
  },
  {
    key: 'department_manager', name: 'Department Manager', description: 'Leads a department',
    permissions: ['team.view', 'attendance.view', 'leave.view', 'leave.request', 'leave.approve', 'performance.view', 'performance.manage', 'reports.view',
      'tasks.manage'],
  },
  {
    key: 'team_manager', name: 'Team Manager', description: 'Leads a team',
    permissions: ['team.view', 'attendance.view', 'leave.view', 'leave.request', 'leave.approve', 'performance.view', 'tasks.manage'],
  },
  { key: 'employee', name: 'Employee', description: 'Self-service access', permissions: ['leave.request'] },
];

// availability: available | coming_soon | integration_required
const FEATURES = [
  ['employees', 'Employee Management', 'workforce', 'available'],
  ['departments', 'Departments & Locations', 'workforce', 'available'],
  ['attendance', 'Attendance', 'workforce', 'available'],
  ['leave', 'Leave', 'workforce', 'available'],
  ['documents', 'Documents', 'workforce', 'available'],
  ['tasks', 'Tasks', 'remote_work', 'available'],
  ['basic_reports', 'Basic Reports', 'analytics', 'coming_soon'],
  ['recruitment', 'Recruitment (ATS)', 'talent', 'available'],
  ['onboarding', 'Onboarding', 'talent', 'available'],
  ['payroll', 'Payroll', 'payroll', 'available'],
  ['performance', 'Performance', 'performance', 'available'],
  ['learning', 'Learning', 'learning', 'available'],
  ['projects', 'Projects', 'remote_work', 'available'],
  ['advanced_reports', 'Advanced Reports', 'analytics', 'coming_soon'],
  ['integrations', 'Integrations', 'integrations', 'coming_soon'],
  ['analytics', 'Advanced Analytics', 'analytics', 'coming_soon'],
  ['compliance', 'Compliance', 'compliance', 'coming_soon'],
  ['api', 'API Access', 'integrations', 'available'],
  ['advanced_permissions', 'Advanced Permissions', 'security', 'available'],
  ['custom_roles', 'Custom Roles', 'security', 'available'],
  ['automation', 'Advanced Automation', 'automation', 'coming_soon'],
  ['sso', 'Single Sign-On', 'security', 'coming_soon'],
  ['custom_workflows', 'Custom Workflows', 'automation', 'coming_soon'],
  ['enterprise_reporting', 'Enterprise Reporting', 'analytics', 'coming_soon'],
  ['payway', 'PayWay Integration', 'integrations', 'integration_required'],
  ['ai_recruitment', 'AI Recruitment', 'ai', 'coming_soon'],
  ['ai_documents', 'AI Documents', 'ai', 'coming_soon'],
  ['ai_performance', 'AI Performance', 'ai', 'coming_soon'],
  ['ai_analytics', 'AI Analytics', 'ai', 'coming_soon'],
  ['client_success', 'Client Success Portal', 'client_success', 'coming_soon'],
];

const STARTER = ['employees', 'departments', 'attendance', 'leave', 'documents', 'tasks', 'basic_reports'];
const BUSINESS = [...STARTER, 'recruitment', 'onboarding', 'payroll', 'performance', 'advanced_reports', 'projects', 'learning', 'integrations', 'compliance'];
const PROFESSIONAL = [...BUSINESS, 'analytics', 'ai_recruitment', 'ai_documents', 'ai_performance', 'ai_analytics', 'api', 'advanced_permissions', 'automation'];
const ENTERPRISE = [...PROFESSIONAL, 'sso', 'custom_roles', 'custom_workflows', 'enterprise_reporting', 'client_success'];

const LIMIT_KEYS = ['employees', 'users', 'storage_mb', 'api_calls_monthly', 'ai_requests_monthly', 'active_jobs'];

// Initial values only. Edit prices/limits in Super Admin → Plans after seeding.
const PLANS = [
  {
    key: 'starter', name: 'Starter', sort_order: 1, price_monthly: 199, price_yearly: 1990, trial_days: 14,
    tagline: 'Core HR for small teams', tagline_ar: 'أساسيات الموارد البشرية للفرق الصغيرة',
    features: STARTER,
    limits: { employees: 10, users: 5, storage_mb: 5120, api_calls_monthly: 0, ai_requests_monthly: 0, active_jobs: 0 },
  },
  {
    key: 'business', name: 'Business', sort_order: 2, price_monthly: 699, price_yearly: 6990, trial_days: 14,
    tagline: 'Hire, pay and grow your team', tagline_ar: 'وظّف وادفع وطوّر فريقك',
    features: BUSINESS,
    limits: { employees: 50, users: 25, storage_mb: 51200, api_calls_monthly: 0, ai_requests_monthly: 0, active_jobs: 20 },
  },
  {
    key: 'professional', name: 'Professional', sort_order: 3, price_monthly: 2499, price_yearly: 24990, trial_days: 14,
    tagline: 'Analytics, automation, AI and API', tagline_ar: 'تحليلات وأتمتة وذكاء اصطناعي وواجهة برمجية',
    features: PROFESSIONAL,
    limits: { employees: 250, users: 100, storage_mb: 256000, api_calls_monthly: 50000, ai_requests_monthly: 5000, active_jobs: 100 },
  },
  {
    key: 'enterprise', name: 'Enterprise', sort_order: 4, price_monthly: null, price_yearly: null, trial_days: 0, is_custom: true,
    tagline: 'Custom scale, security and support', tagline_ar: 'حجم وأمان ودعم مخصص',
    features: ENTERPRISE,
    limits: { employees: null, users: null, storage_mb: null, api_calls_monthly: null, ai_requests_monthly: null, active_jobs: null },
  },
];

const ADDONS = [
  { key: 'recruitment', name: 'Recruitment Add-on', price_monthly: 299, feature: 'recruitment' },
  { key: 'advanced_payroll', name: 'Advanced Payroll', price_monthly: 399, feature: 'payroll' },
  { key: 'advanced_analytics', name: 'Advanced Analytics', price_monthly: 399, feature: 'analytics' },
  { key: 'learning', name: 'Learning', price_monthly: 199, feature: 'learning' },
  { key: 'ai_pack', name: 'AI Pack', price_monthly: 499, feature: 'ai_recruitment', limit_key: 'ai_requests_monthly', limit_increment: 5000 },
  { key: 'payway', name: 'PayWay Integration', price_monthly: 0, feature: 'payway' },
  { key: 'api_access', name: 'API Access', price_monthly: 299, feature: 'api', limit_key: 'api_calls_monthly', limit_increment: 50000 },
  { key: 'sso', name: 'SSO', price_monthly: 499, feature: 'sso' },
  { key: 'extra_employees', name: 'Extra 10 Employees', price_monthly: 150, limit_key: 'employees', limit_increment: 10 },
  { key: 'extra_storage', name: 'Extra 10 GB Storage', price_monthly: 49, limit_key: 'storage_mb', limit_increment: 10240 },
];

const SUN_THU = ['sun', 'mon', 'tue', 'wed', 'thu'];
const MON_FRI = ['mon', 'tue', 'wed', 'thu', 'fri'];
const COUNTRIES = [
  { country_code: 'SA', name: 'Saudi Arabia', name_ar: 'المملكة العربية السعودية', currency: 'SAR', timezone: 'Asia/Riyadh', default_locale: 'ar', working_days: SUN_THU, vat_rate: 15 },
  { country_code: 'AE', name: 'United Arab Emirates', name_ar: 'الإمارات العربية المتحدة', currency: 'AED', timezone: 'Asia/Dubai', default_locale: 'ar', working_days: MON_FRI, vat_rate: 5 },
  { country_code: 'KW', name: 'Kuwait', name_ar: 'الكويت', currency: 'KWD', timezone: 'Asia/Kuwait', default_locale: 'ar', working_days: SUN_THU, vat_rate: 0 },
  { country_code: 'QA', name: 'Qatar', name_ar: 'قطر', currency: 'QAR', timezone: 'Asia/Qatar', default_locale: 'ar', working_days: SUN_THU, vat_rate: 0 },
  { country_code: 'BH', name: 'Bahrain', name_ar: 'البحرين', currency: 'BHD', timezone: 'Asia/Bahrain', default_locale: 'ar', working_days: SUN_THU, vat_rate: 10 },
  { country_code: 'OM', name: 'Oman', name_ar: 'عُمان', currency: 'OMR', timezone: 'Asia/Muscat', default_locale: 'ar', working_days: SUN_THU, vat_rate: 5 },
  { country_code: 'JO', name: 'Jordan', name_ar: 'الأردن', currency: 'JOD', timezone: 'Asia/Amman', default_locale: 'ar', working_days: SUN_THU, vat_rate: 16 },
  { country_code: 'EG', name: 'Egypt', name_ar: 'مصر', currency: 'EGP', timezone: 'Africa/Cairo', default_locale: 'ar', working_days: SUN_THU, vat_rate: 14 },
  { country_code: 'US', name: 'United States', name_ar: 'الولايات المتحدة', currency: 'USD', timezone: 'America/New_York', default_locale: 'en', working_days: MON_FRI, vat_rate: 0 },
  { country_code: 'GB', name: 'United Kingdom', name_ar: 'المملكة المتحدة', currency: 'GBP', timezone: 'Europe/London', default_locale: 'en', working_days: MON_FRI, vat_rate: 20 },
];

// Default leave types created for each organization the first time Leave is opened.
// They are starting points only: HR edits days and rules per company (Settings → Leave types).
const LEAVE_TYPE_DEFAULTS = [
  { key: 'annual', name: 'Annual leave', name_ar: 'إجازة سنوية', days_per_year: 21, has_balance: true, is_paid: true, color: '#1ACC6C' },
  { key: 'sick', name: 'Sick leave', name_ar: 'إجازة مرضية', days_per_year: 30, has_balance: true, is_paid: true, requires_document: true, color: '#F59E0B' },
  { key: 'emergency', name: 'Emergency leave', name_ar: 'إجازة طارئة', days_per_year: 5, has_balance: true, is_paid: true, color: '#DC2626' },
  { key: 'maternity', name: 'Maternity leave', name_ar: 'إجازة وضع', days_per_year: 70, has_balance: true, is_paid: true, requires_document: true, color: '#8B5CF6' },
  { key: 'unpaid', name: 'Unpaid leave', name_ar: 'إجازة بدون راتب', days_per_year: 0, has_balance: false, is_paid: false, color: '#767676' },
];

// Default onboarding checklist (HR edits it per company). due = days relative to the start date.
const ONBOARDING_DEFAULT = [
  { title: 'Sign the employment contract', title_ar: 'توقيع عقد العمل', category: 'contract', assignee: 'hr', due: -3 },
  { title: 'Prepare laptop and equipment', title_ar: 'تجهيز الجهاز والمعدات', category: 'equipment', assignee: 'hr', due: -1 },
  { title: 'Create email and system accounts', title_ar: 'إنشاء البريد وحسابات الأنظمة', category: 'accounts', assignee: 'hr', due: -1 },
  { title: 'Collect ID / Iqama copy', title_ar: 'استلام صورة الهوية / الإقامة', category: 'documents', assignee: 'hr', due: 0 },
  { title: 'Provide bank details (IBAN)', title_ar: 'تزويد بيانات الحساب البنكي (IBAN)', category: 'bank', assignee: 'employee', due: 0 },
  { title: 'Welcome meeting and team introduction', title_ar: 'اجتماع الترحيب والتعريف بالفريق', category: 'manager', assignee: 'manager', due: 0 },
  { title: 'Read and accept company policies', title_ar: 'قراءة سياسات الشركة والموافقة عليها', category: 'policies', assignee: 'employee', due: 2 },
  { title: 'Complete first-week training', title_ar: 'إكمال تدريب الأسبوع الأول', category: 'training', assignee: 'employee', due: 5 },
  { title: '30-day check-in', title_ar: 'لقاء متابعة بعد 30 يوماً', category: 'manager', assignee: 'manager', due: 30 },
];

module.exports = { PERMISSIONS, ROLE_TEMPLATES, FEATURES, PLANS, ADDONS, COUNTRIES, LIMIT_KEYS, LEAVE_TYPE_DEFAULTS, ONBOARDING_DEFAULT };
