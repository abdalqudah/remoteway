// Report datasets: the tables a report can read, the columns it may show (SQL expressions, never user
// input), and who may use them. Every query is scoped to the organization. Employee-level datasets need
// company-wide access (employees.view) so managers never see beyond what their role allows elsewhere.
const name = (a) => `CONCAT(${a}.first_name, ' ', ${a}.last_name)`;

const DATASETS = {
  employees: {
    feature: 'employees', permissions: ['employees.view'],
    base: (k, org) => k('employees as e').leftJoin('departments as d', 'd.id', 'e.department_id').leftJoin('locations as l', 'l.id', 'e.location_id')
      .leftJoin('employees as m', 'm.id', 'e.manager_id').where('e.organization_id', org),
    date: 'e.joining_date', department: 'e.department_id', status: { expr: 'e.status', values: ['active', 'probation', 'on_leave', 'terminated'], labels: 'statuses.' },
    columns: {
      employee_number: { expr: 'e.employee_number', type: 'text' },
      name: { expr: name('e'), type: 'text' },
      job_title: { expr: 'e.job_title', type: 'text' },
      department: { expr: 'd.name', type: 'text' },
      location: { expr: 'l.name', type: 'text' },
      manager: { expr: name('m'), type: 'text' },
      employment_type: { expr: 'e.employment_type', type: 'enum', labels: 'employment_types.' },
      work_mode: { expr: 'e.work_mode', type: 'enum', labels: 'work_modes.' },
      status: { expr: 'e.status', type: 'enum', labels: 'statuses.' },
      joining_date: { expr: 'e.joining_date', type: 'date' },
      joining_month: { expr: "DATE_FORMAT(e.joining_date, '%Y-%m')", type: 'text', groupOnly: true },
      termination_date: { expr: 'e.termination_date', type: 'date' },
      nationality: { expr: 'e.nationality', type: 'text' },
      base_salary: { expr: 'e.base_salary', type: 'money', permission: 'employees.view_salary' },
    },
    defaults: ['employee_number', 'name', 'job_title', 'department', 'status', 'joining_date'], sort: 'name',
  },
  leave: {
    feature: 'leave', permissions: ['employees.view', 'leave.view'],
    base: (k, org) => k('leave_requests as r').join('employees as e', 'e.id', 'r.employee_id').join('leave_types as t', 't.id', 'r.leave_type_id')
      .leftJoin('departments as d', 'd.id', 'e.department_id').leftJoin('users as u', 'u.id', 'r.decided_by').where('r.organization_id', org),
    date: 'r.start_date', department: 'e.department_id', status: { expr: 'r.status', values: ['pending', 'approved', 'rejected', 'cancelled'], labels: 'leave.status_' },
    columns: {
      employee: { expr: name('e'), type: 'text' },
      department: { expr: 'd.name', type: 'text' },
      leave_type: { expr: 't.name', type: 'text' },
      start_date: { expr: 'r.start_date', type: 'date' },
      end_date: { expr: 'r.end_date', type: 'date' },
      month: { expr: "DATE_FORMAT(r.start_date, '%Y-%m')", type: 'text', groupOnly: true },
      days: { expr: 'r.days', type: 'number' },
      status: { expr: 'r.status', type: 'enum', labels: 'leave.status_' },
      decided_by: { expr: 'u.name', type: 'text' },
      requested_at: { expr: 'r.created_at', type: 'date' },
    },
    defaults: ['employee', 'department', 'leave_type', 'start_date', 'end_date', 'days', 'status'], sort: 'start_date', desc: true,
  },
  attendance: {
    feature: 'attendance', permissions: ['employees.view', 'attendance.view'],
    base: (k, org) => k('attendance as a').join('employees as e', 'e.id', 'a.employee_id').leftJoin('departments as d', 'd.id', 'e.department_id').where('a.organization_id', org),
    date: 'a.work_date', department: 'e.department_id', status: null,
    columns: {
      employee: { expr: name('e'), type: 'text' },
      department: { expr: 'd.name', type: 'text' },
      work_date: { expr: 'a.work_date', type: 'date' },
      clock_in: { expr: 'a.clock_in', type: 'datetime' },
      clock_out: { expr: 'a.clock_out', type: 'datetime' },
      worked_hours: { expr: 'ROUND(a.worked_minutes / 60, 2)', type: 'number' },
      late_minutes: { expr: 'a.late_minutes', type: 'number' },
      overtime_hours: { expr: 'ROUND(a.overtime_minutes / 60, 2)', type: 'number' },
    },
    defaults: ['employee', 'department', 'work_date', 'worked_hours', 'late_minutes', 'overtime_hours'], sort: 'work_date', desc: true,
  },
  payroll: {
    feature: 'payroll', permissions: ['payroll.view'],
    base: (k, org) => k('payslips as p').join('payroll_runs as r', 'r.id', 'p.run_id').where('p.organization_id', org).whereNot('r.status', 'cancelled'),
    date: 'r.period_start', department: null, status: { expr: 'r.status', values: ['draft', 'review', 'approved', 'paid'], labels: 'payroll.status_' },
    columns: {
      period: { expr: 'r.period', type: 'text' },
      employee_number: { expr: 'p.employee_number', type: 'text' },
      employee: { expr: 'p.employee_name', type: 'text' },
      department: { expr: 'p.department_name', type: 'text' },
      gross: { expr: 'p.gross', type: 'money' },
      deductions: { expr: 'p.total_deductions', type: 'money' },
      net: { expr: 'p.net', type: 'money' },
      employer_cost: { expr: 'p.employer_cost', type: 'money' },
      currency: { expr: 'r.currency', type: 'text' },
      run_status: { expr: 'r.status', type: 'enum', labels: 'payroll.status_' },
    },
    defaults: ['period', 'employee', 'department', 'gross', 'deductions', 'net'], sort: 'period', desc: true,
  },
  recruitment: {
    feature: 'recruitment', permissions: ['recruitment.view'],
    base: (k, org) => k('applications as a').join('candidates as c', 'c.id', 'a.candidate_id').join('jobs as j', 'j.id', 'a.job_id')
      .leftJoin('departments as d', 'd.id', 'j.department_id').where('a.organization_id', org),
    date: 'a.created_at', department: 'j.department_id',
    status: { expr: 'a.stage', values: ['applied', 'screening', 'shortlisted', 'interview', 'assessment', 'offer', 'hired', 'rejected'], labels: 'recruitment.stage_' },
    columns: {
      job: { expr: 'j.title', type: 'text' },
      department: { expr: 'd.name', type: 'text' },
      candidate: { expr: name('c'), type: 'text' },
      current_title: { expr: 'c.current_title', type: 'text' },
      source: { expr: 'c.source', type: 'enum', labels: 'recruitment.source_' },
      stage: { expr: 'a.stage', type: 'enum', labels: 'recruitment.stage_' },
      rating: { expr: 'a.rating', type: 'number', agg: 'avg' },
      applied_on: { expr: 'a.created_at', type: 'date' },
      days_in_process: { expr: 'DATEDIFF(COALESCE(a.stage_changed_at, NOW()), a.created_at)', type: 'number', agg: 'avg' },
    },
    defaults: ['job', 'candidate', 'source', 'stage', 'applied_on'], sort: 'applied_on', desc: true,
  },
  learning: {
    feature: 'learning', permissions: ['learning.manage'],
    base: (k, org) => k('enrollments as n').join('courses as c', 'c.id', 'n.course_id').join('employees as e', 'e.id', 'n.employee_id')
      .leftJoin('departments as d', 'd.id', 'e.department_id').where('n.organization_id', org),
    date: 'n.created_at', department: 'e.department_id', status: { expr: 'n.status', values: ['not_started', 'in_progress', 'completed'], labels: 'learning.status_' },
    columns: {
      course: { expr: 'c.title', type: 'text' },
      employee: { expr: name('e'), type: 'text' },
      department: { expr: 'd.name', type: 'text' },
      source: { expr: 'n.source', type: 'enum', labels: 'learning.source_' },
      status: { expr: 'n.status', type: 'enum', labels: 'learning.status_' },
      progress: { expr: 'n.progress', type: 'number', agg: 'avg' },
      score: { expr: 'n.score', type: 'number', agg: 'avg' },
      due_date: { expr: 'n.due_date', type: 'date' },
      completed_at: { expr: 'n.completed_at', type: 'date' },
    },
    defaults: ['course', 'employee', 'department', 'status', 'progress', 'due_date'], sort: 'course',
  },
  goals: {
    feature: 'performance', permissions: ['employees.view', 'performance.view'],
    base: (k, org) => k('goals as g').leftJoin('employees as e', 'e.id', 'g.employee_id').leftJoin('departments as d', function joinDept() { this.on('d.id', '=', k.raw('COALESCE(g.department_id, e.department_id)')); })
      .where('g.organization_id', org),
    date: 'g.due_date', department: 'd.id', status: { expr: 'g.status', values: ['active', 'done', 'cancelled'], labels: 'performance.status_' },
    columns: {
      title: { expr: 'g.title', type: 'text' },
      scope: { expr: 'g.scope', type: 'enum', labels: 'performance.scope_' },
      owner: { expr: name('e'), type: 'text' },
      department: { expr: 'd.name', type: 'text' },
      progress: { expr: 'g.progress', type: 'number', agg: 'avg' },
      health: { expr: 'g.health', type: 'enum', labels: 'performance.health_' },
      status: { expr: 'g.status', type: 'enum', labels: 'performance.status_' },
      due_date: { expr: 'g.due_date', type: 'date' },
    },
    defaults: ['title', 'scope', 'owner', 'department', 'progress', 'health', 'due_date'], sort: 'due_date',
  },
  documents: {
    feature: 'documents', permissions: ['employees.view', 'documents.view'],
    base: (k, org) => k('documents as doc').leftJoin('employees as e', 'e.id', 'doc.employee_id').leftJoin('departments as d', 'd.id', 'e.department_id')
      .where('doc.organization_id', org),
    date: 'doc.expires_at', department: 'e.department_id', status: null,
    columns: {
      title: { expr: 'doc.title', type: 'text' },
      category: { expr: 'doc.category', type: 'enum', labels: 'documents.cat_' },
      employee: { expr: name('e'), type: 'text' },
      department: { expr: 'd.name', type: 'text' },
      issue_date: { expr: 'doc.issue_date', type: 'date' },
      expires_at: { expr: 'doc.expires_at', type: 'date' },
      version: { expr: 'doc.current_version', type: 'number', agg: 'avg' },
    },
    defaults: ['title', 'category', 'employee', 'expires_at'], sort: 'expires_at',
  },
};

// Ready-made reports (Basic Reports). Dates are resolved when the report runs.
const TEMPLATES = [
  { key: 'headcount_by_department', dataset: 'employees', config: { columns: ['department'], group_by: 'department', filters: { status: ['active', 'probation', 'on_leave'] } } },
  { key: 'employee_directory', dataset: 'employees', config: { columns: ['employee_number', 'name', 'job_title', 'department', 'location', 'manager', 'status'], filters: { status: ['active', 'probation', 'on_leave'] } } },
  { key: 'new_hires', dataset: 'employees', config: { columns: ['name', 'job_title', 'department', 'joining_date'], filters: { period: 'last_90_days' } } },
  { key: 'leave_by_type', dataset: 'leave', config: { columns: ['leave_type', 'days'], group_by: 'leave_type', filters: { period: 'this_year', status: ['approved'] } } },
  { key: 'leave_register', dataset: 'leave', config: { columns: ['employee', 'department', 'leave_type', 'start_date', 'end_date', 'days', 'status'], filters: { period: 'this_month' } } },
  { key: 'attendance_last_month', dataset: 'attendance', config: { columns: ['employee', 'worked_hours', 'late_minutes', 'overtime_hours'], group_by: 'employee', filters: { period: 'last_month' } } },
  { key: 'payroll_by_period', dataset: 'payroll', config: { columns: ['period', 'gross', 'deductions', 'net', 'employer_cost'], group_by: 'period', filters: { period: 'this_year' } } },
  { key: 'hiring_funnel', dataset: 'recruitment', config: { columns: ['stage'], group_by: 'stage', filters: { period: 'last_90_days' } } },
  { key: 'training_completion', dataset: 'learning', config: { columns: ['course', 'progress'], group_by: 'course', filters: {} } },
  { key: 'expiring_documents', dataset: 'documents', config: { columns: ['title', 'category', 'employee', 'expires_at'], filters: { period: 'next_60_days' } } },
];

const PERIODS = ['this_month', 'last_month', 'this_year', 'last_90_days', 'last_12_months', 'next_30_days', 'next_60_days', 'custom', 'all'];

module.exports = { DATASETS, TEMPLATES, PERIODS };
