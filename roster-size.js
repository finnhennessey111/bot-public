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

module.exports = { inferRosterSize };
