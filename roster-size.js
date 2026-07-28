// Shared team-size-from-title keyword inference. Used by scraper.js (a player's per-event roster
// size, for calculateMatchScore's soloModifier) and tournament-scraper.js (a tournament's isTrios
// flag) — one canonical implementation so both scrapers agree on what counts as solo/duo/trio/squad
// in a title, rather than each guessing independently or drifting out of sync.
//
// Word-boundary match only, against an already-lowercased title. Deliberately returns null (never
// a guessed default) when the title has no team-size word at all — callers decide what null means
// for their own purposes (e.g. scraper.js logs it as unclassified; tournament-scraper.js's isTrios
// just becomes false, same as any other non-trios title).
function inferRosterSize(nameLower) {
  if (/\bsolos?\b/.test(nameLower)) return 1;
  if (/\bduos?\b/.test(nameLower)) return 2;
  if (/\btrios?\b/.test(nameLower)) return 3;
  if (/\bsquads?\b/.test(nameLower)) return 4;
  return null;
}

// Manually-verified roster sizes for specific recurring tournament/event names that have no
// team-size keyword in their title at all — confirmed by direct observation of the tournament's
// actual format, not guessed. Keep this small, and only add an entry once it's actually confirmed;
// an unconfirmed guess here is exactly the failure mode inferRosterSize's "leave unclassified, log
// it" behavior was built to avoid. Matched by substring so a name with a build-mode suffix
// appended (e.g. "PlayStation Typical Gamer Icon Cup (Zero Build)") still resolves correctly.
const KNOWN_TOURNAMENT_ROSTER_SIZES = {
  'playstation typical gamer icon cup': 1, // confirmed solo format
};

// Resolution order: manually-verified override, then keyword inference, then null (unclassified)
// — callers decide what null means for their own purposes.
function resolveRosterSize(nameLower) {
  for (const [knownName, size] of Object.entries(KNOWN_TOURNAMENT_ROSTER_SIZES)) {
    if (nameLower.includes(knownName)) return size;
  }
  return inferRosterSize(nameLower);
}

module.exports = { inferRosterSize, resolveRosterSize };
