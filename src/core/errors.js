// Stable, machine-readable error codes shared by the web UI and the API.
class AppError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const E = {
  validation: (details, message = 'Some fields are invalid.') => new AppError('VALIDATION_FAILED', message, 422, details),
  unauthenticated: () => new AppError('UNAUTHENTICATED', 'Please sign in to continue.', 401),
  invalidCredentials: () => new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect.', 401),
  forbidden: (permission) => new AppError('PERMISSION_DENIED', 'You do not have permission to perform this action.', 403, permission ? { permission } : undefined),
  noOrganization: () => new AppError('ORGANIZATION_REQUIRED', 'Select an organization to continue.', 403),
  notFound: (entity = 'Resource') => new AppError('NOT_FOUND', `${entity} not found.`, 404),
  conflict: (code, message) => new AppError(code, message, 409),
  featureNotInPlan: (feature) => new AppError('FEATURE_NOT_IN_PLAN', 'This feature is not included in your current plan.', 402, { feature }),
  featureUnavailable: (feature) => new AppError('FEATURE_NOT_AVAILABLE', 'This feature is not available yet.', 404, { feature }),
  limitReached: (limit, current, max) => new AppError(
    limit === 'employees' ? 'EMPLOYEE_LIMIT_REACHED' : 'USAGE_LIMIT_REACHED',
    limit === 'employees' ? 'Employee limit reached for current subscription.' : `Usage limit reached for ${limit}.`,
    402, { limit, current, max },
  ),
  subscriptionInactive: (status) => new AppError('SUBSCRIPTION_INACTIVE', 'Your subscription is not active. Update billing to continue.', 402, { status }),
  csrf: () => new AppError('CSRF_TOKEN_INVALID', 'Your session expired. Refresh the page and try again.', 419),
  rateLimited: () => new AppError('RATE_LIMITED', 'Too many requests. Please try again later.', 429),
};

module.exports = { AppError, E };
