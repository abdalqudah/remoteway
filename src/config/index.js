const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const env = process.env.NODE_ENV || 'development';

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

const isTest = env === 'test';

const arabicFontInstalled = require('fs').existsSync(path.join(__dirname, '..', '..', 'public', 'fonts', 'MontserratArabic-Regular.woff2'));

module.exports = {
  arabicFontInstalled,
  env,
  isProd: env === 'production',
  isTest,
  port: Number(process.env.PORT || 3000),
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  appName: 'RemoteWay',
  sessionSecret: required('SESSION_SECRET', isTest ? 'test-secret-test-secret-test-secret' : undefined),
  trustProxy: process.env.TRUST_PROXY !== 'false',
  autoMigrate: process.env.AUTO_MIGRATE === 'true',
  db: {
    host: required('DB_HOST', 'localhost'),
    port: Number(process.env.DB_PORT || 3306),
    user: required('DB_USER'),
    password: process.env.DB_PASSWORD || '',
    database: required(isTest ? 'DB_NAME_TEST' : 'DB_NAME', isTest ? process.env.DB_NAME_TEST : undefined),
  },
  bcryptRounds: isTest ? 4 : 12,
  cacheTtlMs: Number(process.env.CACHE_TTL_MS || 60_000),
  defaultLocale: 'en',
  locales: ['en', 'ar'],
};
