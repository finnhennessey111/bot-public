// discord-oauth.js - Discord OAuth2 (identify scope) so the website can find out who's visiting
// and hand off into billing.js's createCheckoutSession, which needs a Discord ID up front.
//
// Reuses CLIENT_ID (already set for the bot's invite link) rather than a separate OAuth client id
// — only DISCORD_CLIENT_SECRET is new. Unlike epic-oauth.js, `state` here isn't signed: the
// discordId this flow acts on always comes from Discord's own /users/@me response after the token
// exchange, never from client-supplied state, so there's nothing sensitive for state to protect.
// state only carries which plan (monthly/yearly) was selected before the redirect to Discord.

const AUTHORIZE_URL = 'https://discord.com/api/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const USER_URL = 'https://discord.com/api/users/@me';

function isConfigured() {
  return !!(process.env.CLIENT_ID && process.env.DISCORD_CLIENT_SECRET && process.env.DISCORD_OAUTH_REDIRECT_URI);
}

function buildAuthUrl(plan) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', process.env.CLIENT_ID);
  url.searchParams.set('redirect_uri', process.env.DISCORD_OAUTH_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify');
  url.searchParams.set('state', plan);
  return url.toString();
}

async function exchangeCodeForUser(code) {
  const tokenResponse = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      code,
      redirect_uri: process.env.DISCORD_OAUTH_REDIRECT_URI,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text().catch(() => '');
    throw new Error(`Discord token exchange failed: ${tokenResponse.status} ${text}`);
  }

  const { access_token: accessToken } = await tokenResponse.json();
  if (!accessToken) {
    throw new Error('Discord token response missing access_token.');
  }

  const userResponse = await fetch(USER_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!userResponse.ok) {
    const text = await userResponse.text().catch(() => '');
    throw new Error(`Discord user lookup failed: ${userResponse.status} ${text}`);
  }

  const user = await userResponse.json();
  if (!user.id) {
    throw new Error('Discord user response missing id.');
  }

  return { discordId: user.id };
}

module.exports = { isConfigured, buildAuthUrl, exchangeCodeForUser };
