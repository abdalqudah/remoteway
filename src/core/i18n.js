const fs = require('fs');
const path = require('path');
const config = require('../config');

const dictionaries = {};
for (const locale of config.locales) {
  dictionaries[locale] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', `${locale}.json`), 'utf8'));
}

function lookup(dict, key) {
  return key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), dict);
}

function translator(locale) {
  const dict = dictionaries[locale] || dictionaries[config.defaultLocale];
  const fallback = dictionaries[config.defaultLocale];
  return function t(key, vars) {
    let text = lookup(dict, key);
    if (typeof text !== 'string') text = lookup(fallback, key);
    if (typeof text !== 'string') return key;
    if (vars) text = text.replace(/\{(\w+)\}/g, (m, name) => (vars[name] !== undefined ? vars[name] : m));
    return text;
  };
}

function resolveLocale(req) {
  const fromQuery = req.query?.lang;
  const fromCookie = req.cookies?.rw_lang;
  const fromUser = req.user?.locale;
  for (const candidate of [fromQuery, fromCookie, fromUser]) {
    if (candidate && config.locales.includes(candidate)) return candidate;
  }
  const header = req.headers['accept-language'] || '';
  return header.toLowerCase().startsWith('ar') ? 'ar' : config.defaultLocale;
}

module.exports = { translator, resolveLocale, dictionaries };

// Field-level validation messages are authored in English; Arabic uses the `vmsg` table.
function translateMessage(locale, message) {
  if (locale === 'en') return message;
  const table = dictionaries[locale]?.vmsg || {};
  return table[message] || table._fallback || message;
}

module.exports.translateMessage = translateMessage;
