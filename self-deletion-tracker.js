// self-deletion-tracker.js - Lets channel-manager.js (and any other code that deletes a channel on
// the bot's own initiative — a scheduled auto-delete, /cancel-tournament, etc.) tell
// channel-deletion-undo.js's channelDelete listener "this one was expected, don't treat it as an
// accidental deletion" without either module needing to require the other. Both would otherwise
// need each other directly (the undo listener needs channel-manager.js's createTournamentChannel to
// restore a channel; channel-manager.js would need the undo module to mark a deletion as expected)
// — a real circular require. This is the shared, dependency-free signal both sides use instead.
//
// A channelDelete gateway event only ever arrives after the deleting call's own async function has
// already returned (network round trip over the WebSocket vs. the in-process work finishing first),
// so in practice the mark is always set well before the listener checks it. The 5-minute auto-expiry
// below is just a safety net against a mark never getting consumed at all (e.g. the process restarts
// between the delete call and the gateway event arriving) — not something normal operation should
// ever actually hit.
const MARK_TTL_MS = 5 * 60 * 1000;

const recentlySelfDeleted = new Set();

function markSelfDeletion(channelId) {
  recentlySelfDeleted.add(channelId);
  setTimeout(() => recentlySelfDeleted.delete(channelId), MARK_TTL_MS).unref?.();
}

// Consumes (not just checks) the mark — a given channelId's deletion should only ever be evaluated
// once, so the mark is removed on read regardless of the result.
function consumeSelfDeletion(channelId) {
  const wasMarked = recentlySelfDeleted.has(channelId);
  recentlySelfDeleted.delete(channelId);
  return wasMarked;
}

module.exports = { markSelfDeletion, consumeSelfDeletion };
