// Minimal, standards-based OpenID Connect client (Authorization Code flow with PKCE).
// Works with Microsoft Entra ID, Google Workspace, Okta, Auth0, Keycloak and any certified provider.
// ID tokens are verified locally: signature against the provider's JWKS, issuer, audience, expiry, nonce.
const crypto = require('crypto');
const cache = require('../../core/cache');
const { request } = require('../../core/http');

class OidcError extends Error {}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

async function getJson(url) {
  const res = await request(url, { method: 'GET', headers: { accept: 'application/json' }, timeoutMs: 10_000, maxBytes: 512 * 1024 });
  if (res.status !== 200) throw new OidcError(`${url} answered HTTP ${res.status}`);
  try { return JSON.parse(res.body); } catch { throw new OidcError(`${url} did not return JSON`); }
}

/** Provider metadata from /.well-known/openid-configuration (cached 1 hour). */
function discover(issuer) {
  const base = String(issuer).replace(/\/+$/, '');
  return cache.remember(`oidc:disc:${base}`, async () => {
    const d = await getJson(`${base}/.well-known/openid-configuration`);
    for (const k of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (!d[k]) throw new OidcError(`The provider metadata has no ${k}.`);
    }
    return d;
  }, 3_600_000);
}

async function jwks(uri, refresh = false) {
  if (refresh) cache.forgetPrefix(`oidc:jwks:${uri}`);
  return cache.remember(`oidc:jwks:${uri}`, async () => (await getJson(uri)).keys || [], 600_000);
}

function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

function authorizationUrl(meta, { clientId, redirectUri, state, nonce, challenge, loginHint }) {
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (loginHint) u.searchParams.set('login_hint', loginHint);
  return u.toString();
}

async function exchangeCode(meta, { clientId, clientSecret, code, redirectUri, verifier }) {
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  const methods = meta.token_endpoint_auth_methods_supported || ['client_secret_basic'];
  if (methods.includes('client_secret_basic') || !methods.includes('client_secret_post')) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
  } else {
    form.set('client_id', clientId);
    form.set('client_secret', clientSecret);
  }
  const res = await request(meta.token_endpoint, { method: 'POST', headers, body: form.toString(), timeoutMs: 15_000, maxBytes: 256 * 1024 });
  let j = {};
  try { j = JSON.parse(res.body); } catch { /* not JSON */ }
  if (res.status !== 200 || !j.id_token) throw new OidcError(`The provider refused the sign-in code (${j.error || `HTTP ${res.status}`}${j.error_description ? `: ${String(j.error_description).slice(0, 160)}` : ''}).`);
  return j;
}

const ALGS = {
  RS256: { hash: 'sha256' }, RS384: { hash: 'sha384' }, RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', padding: crypto.constants.RSA_PKCS1_PSS_PADDING }, PS384: { hash: 'sha384', padding: crypto.constants.RSA_PKCS1_PSS_PADDING },
  ES256: { hash: 'sha256', dsa: true }, ES384: { hash: 'sha384', dsa: true },
};

/** Verifies an ID token and returns its claims. Throws OidcError with a readable reason. */
async function verifyIdToken(meta, idToken, { clientId, nonce, now = Date.now() }) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new OidcError('The ID token is malformed.');
  let header; let claims;
  try {
    header = JSON.parse(fromB64url(parts[0]).toString('utf8'));
    claims = JSON.parse(fromB64url(parts[1]).toString('utf8'));
  } catch { throw new OidcError('The ID token is malformed.'); }
  const alg = ALGS[header.alg];
  if (!alg) throw new OidcError(`Unsupported token algorithm ${header.alg}.`);
  let keys = await jwks(meta.jwks_uri);
  let jwk = keys.find((k) => (!header.kid || k.kid === header.kid) && (!k.use || k.use === 'sig'));
  if (!jwk) { keys = await jwks(meta.jwks_uri, true); jwk = keys.find((k) => (!header.kid || k.kid === header.kid)); }
  if (!jwk) throw new OidcError('The signing key of the ID token is unknown.');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify(alg.hash, Buffer.from(`${parts[0]}.${parts[1]}`), {
    key, ...(alg.padding ? { padding: alg.padding, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST } : {}), ...(alg.dsa ? { dsaEncoding: 'ieee-p1363' } : {}),
  }, fromB64url(parts[2]));
  if (!ok) throw new OidcError('The ID token signature is invalid.');
  const skew = 120;
  const t = Math.floor(now / 1000);
  if (claims.iss !== meta.issuer) throw new OidcError('The ID token was issued by a different provider.');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new OidcError('The ID token is for a different application.');
  if (aud.length > 1 && claims.azp && claims.azp !== clientId) throw new OidcError('The ID token is for a different application.');
  if (!claims.exp || claims.exp + skew < t) throw new OidcError('The ID token has expired.');
  if (claims.iat && claims.iat - skew > t) throw new OidcError('The ID token is not valid yet.');
  if (!nonce || claims.nonce !== nonce) throw new OidcError('The sign-in response does not match this browser session.');
  return claims;
}

/** The user's email from standard claims (Entra may only send preferred_username / upn). */
function emailFrom(claims) {
  const candidates = [claims.email, claims.preferred_username, claims.upn];
  const email = candidates.find((v) => typeof v === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v));
  return email ? email.toLowerCase() : null;
}

module.exports = { OidcError, discover, pkce, authorizationUrl, exchangeCode, verifyIdToken, emailFrom, b64url };
