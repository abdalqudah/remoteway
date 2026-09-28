// Encryption for credentials stored in the database (SMTP passwords, SMS API keys, webhook secrets).
// AES-256-GCM with a key derived from APP_KEY (or SESSION_SECRET when APP_KEY is not set).
// Changing that secret makes stored credentials unreadable — they then have to be entered again.
const crypto = require('crypto');

let cachedKey;
function key() {
  if (cachedKey) return cachedKey;
  const base = process.env.APP_KEY || process.env.SESSION_SECRET || (process.env.NODE_ENV === 'test' ? 'test-only-secret' : '');
  if (!base) throw new Error('APP_KEY or SESSION_SECRET is required to store credentials.');
  cachedKey = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(base), Buffer.from('remoteway'), Buffer.from('credentials-v1'), 32));
  return cachedKey;
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/** Returns the decrypted value, or null if it cannot be read (tampered, or the key changed). */
function decrypt(payload) {
  if (!payload) return null;
  try {
    const [v, iv, tag, data] = String(payload).split(':');
    if (v !== 'v1') return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

/** "abcd…wxyz" style hint for showing that a secret is set without revealing it. */
const mask = (s) => { const v = String(s || ''); return v.length <= 8 ? '••••' : `${v.slice(0, 3)}…${v.slice(-3)}`; };

module.exports = { encrypt, decrypt, mask };
