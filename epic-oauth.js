// epic-oauth.js - Epic Games OAuth (authorization_code grant), the primary path for linking a
// player's Epic account, replacing Yunite (kept as a fallback — see index.js's
// resolveEpicIdentity — for players who haven't linked via Epic OAuth yet, or where a token
// exchange fails).
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
  // Signatures normally match in length; a length mismatch just means "invalid", not something to
  // throw on, so compare lengths first — timingSafeEqual throws on mismatched buffer lengths.
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

// Epic's token endpoint authenticates the client via HTTP Basic Auth (client_id:client_secret in
// the Authorization header), not client_secret in the request body.
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
  if (!data.account_id || !data.dn) {
    throw new Error('Epic token response missing account_id/dn.');
  }

  return { epicId: data.account_id, epicUsername: data.dn };
}

module.exports = { isConfigured, buildAuthorizeUrl, decodeState, exchangeCodeForToken };
