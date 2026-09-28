const { z } = require('zod');
const { E } = require('./errors');

// Parses input with a zod schema and throws a VALIDATION_FAILED AppError with per-field messages.
function validate(schema, input) {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const details = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    if (!details[key]) details[key] = issue.message;
  }
  throw E.validation(details);
}

// Treat empty strings (HTML forms) and null (API clients) as "not provided".
const emptyToUndefined = (v) => (v === null || (typeof v === 'string' && v.trim() === '') ? undefined : v);
const optionalString = (max = 255) => z.preprocess(emptyToUndefined, z.string().trim().max(max).optional());
const optionalId = () => z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional());
const email = () => z.string().trim().toLowerCase().email('Enter a valid email address.').max(190);
const password = () => z.string().min(8, 'Password must be at least 8 characters.').max(128);

module.exports = { z, validate, optionalString, optionalId, email, password, emptyToUndefined };
