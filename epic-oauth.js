// epic-oauth.js - Epic Games OAuth (authorization_code grant), the sole path for linking a
// player's Epic account. A player who hasn't completed this flow just falls back to their
// Discord display name (see index.js's resolveEpicIdentity) — there's no other lookup.
//
// The callback (webhook-server.js's GET /epic-callback) is a bare redirect from Epic with no
// Discord context of its own, so `state` is how it learns which Discord user/guild initiated the
// flow. It's signed (HMAC-SHA256, keyed on EPIC_CLIENT_SECRET) and time-boxed rather than just a
// raw discordId — a raw ID would let anyone who completes their *own* Epic login craft a callback
// request with someone else's Discord ID as state and link their Epic account onto that person
// instead.

const crypto = require('crypto');

const AUTHORIZE_URL = 'https://www.epicgames.com/id/authorize';
const TOKEN_URL = 'https://api.epicgames.dev/epic/oauth/v2/token';
const STATE_TTL_MS = 10 * 60 * 1000;

function isConfigured() {
  return !!(process.env.EPIC_CLIENT_ID && process.env.EPIC_CLIENT_SECRET && process.env.EPIC_REDIRECT_URI);
}

function sign(payload) {
  return crypto.createHmac('sha256', process.env.EPIC_CLIENT_SECRET).update(payload).digest('base64url');
}

function encodeState(discordId, guildId) {
  const payload = Buffer.from(JSON.stringify({ discordId, guildId, ts: Date.now() })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

// Returns { discordId, guildId } or null if state is missing, malformed, tampered with, or expired.
function decodeState(state) {
  if (!state || typeof state !== 'string') return null;

  const dotIndex = state.indexOf('.');
  if (dotIndex === -1) return null;
  const payload = state.slice(0, dotIndex);
  const signature = state.slice(dotIndex + 1);
  if (!payload || !signature) return null;

  const expected = sign(payload);
  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (signatureBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(signatureBuf, expectedBuf)) {
    return null;
  }

  try {
    const { discordId, guildId, ts } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!discordId || !guildId || typeof ts !== 'number') return null;
    if (Date.now() - ts > STATE_TTL_MS) return null;
    return { discordId, guildId };
  } catch {
    return null;
  }
}

function buildAuthorizeUrl(discordId, guildId) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', process.env.EPIC_CLIENT_ID);
  url.searchParams.set('redirect_uri', process.env.EPIC_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'basic_profile');
  url.searchParams.set('state', encodeState(discordId, guildId));
  return url.toString();
}

// Decodes a JWT's payload segment (no signature verification needed here — this token just came
// directly from Epic's own token endpoint over HTTPS, it wasn't handed to us by the client).
function decodeJwtPayload(jwt) {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('access_token is not a valid JWT.');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

// Epic's token endpoint authenticates the client via HTTP Basic Auth (client_id:client_secret in
// the Authorization header), not client_secret in the request body.
//
// account_id is a top-level field on the token response, but the display name (dn) is NOT —
// Epic only includes it as a claim inside the access_token JWT itself, so it has to be decoded
// out from there rather than read directly off the response body.
async function exchangeCodeForToken(code) {
  const basicAuth = Buffer.from(`${process.env.EPIC_CLIENT_ID}:${process.env.EPIC_CLIENT_SECRET}`).toString('base64');

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code }).toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Epic token exchange failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  if (!data.account_id) {
    throw new Error('Epic token response missing account_id.');
  }
  if (!data.access_token) {
    throw new Error('Epic token response missing access_token.');
  }

  const jwtPayload = decodeJwtPayload(data.access_token);
  if (!jwtPayload.dn) {
    throw new Error('Epic access_token JWT missing dn claim.');
  }

  return { epicId: data.account_id, epicUsername: jwtPayload.dn };
}

module.exports = { isConfigured, buildAuthorizeUrl, decodeState, exchangeCodeForToken };
