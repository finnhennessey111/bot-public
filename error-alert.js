// error-alert.js - Real-time DM alerting for genuine application errors, as opposed to routine/
// expected conditions (a guild not having configured a channel, an optional env var being unset,
// etc. — those already just log a console.warn or take a normal early-return branch elsewhere in
// the codebase, and never reach here). Deliberately NOT a blanket hook on console.error: most
// console.error call sites in this codebase are per-item failures inside loops (one message failed
// to pin, one player's Epic OAuth exchange failed) — genuine but expected-to-happen-sometimes, and
// alerting on each would be pure noise. Only a curated set of call sites (uncaught exceptions,
// MongoDB connection loss, a tournament scrape failing outright, etc.) call alertError.
//
// Reuses discord-dm.js's dmUser exactly like suggestions.js/tournament-approval.js/index.js's
// /refresh-all-servers already do for owner DMs — same helper, same fail-soft behavior (a closed-
// DMs recipient never breaks the caller).

const { dmUser } = require('./discord-dm');

const BOT_OWNER_DISCORD_ID = process.env.BOT_OWNER_DISCORD_ID || null;
const JACOB_DISCORD_ID = process.env.JACOB_DISCORD_ID || null;

// Keyed by `area` (a short stable string identifying the failure site, e.g. 'MongoDB') — so a
// crash-looping error fires at most one DM pair per window instead of flooding both recipients
// once per occurrence.
const ALERT_COOLDOWN_MS = 10 * 60 * 1000;
const lastAlertAtByArea = new Map();

// summary should be a clear, concise sentence (what failed, where, brief context) — not a raw
// stack trace dump. detail is optional short extra context (still no stack traces), shown as a
// separate embed field.
async function alertError(client, { area, summary, detail = null }) {
  const now = Date.now();
  const last = lastAlertAtByArea.get(area);
  if (last && now - last < ALERT_COOLDOWN_MS) return;
  lastAlertAtByArea.set(area, now);

  const recipients = [BOT_OWNER_DISCORD_ID, JACOB_DISCORD_ID].filter(Boolean);
  if (recipients.length === 0) {
    console.warn(`[error-alert] Neither BOT_OWNER_DISCORD_ID nor JACOB_DISCORD_ID is set — "${area}" error not DMed to anyone.`);
    return;
  }

  const payload = {
    embeds: [{
      title: `🚨 ${area}`,
      description: summary,
      color: 0xE74C3C,
      fields: detail ? [{ name: 'Context', value: String(detail).slice(0, 1000) }] : [],
      timestamp: new Date().toISOString(),
    }],
  };

  await Promise.all(recipients.map(id => dmUser(client, id, payload)));
}

module.exports = { alertError };
