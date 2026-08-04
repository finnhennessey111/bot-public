// build-mode.js - Shared build-mode classification for tournament titles: Battle Royale, Zero
// Build, or Reload — the three modes confirmed to actually appear in real Fortnite Tracker titles
// (tournament-scraper.js's isRankedCupTitle doc comment: "(Battle Royale)"/"(Zero Build)"/
// "(Reload)" is the full set observed, one per build mode per region). Used by
// tournament-scraper.js (stamping every scraped tournament with an auto-detected default),
// channel-manager.js (routing a tournament into the correct one of the 9 region×build-mode
// forums), and tournament-approval.js/embeds.js (the approval DM's build-mode select menu,
// pre-selected to this detected default, changeable before approving).
//
// Deliberately NOT the same thing as channel-manager.js's abbreviateBuildMode: that only handles
// Battle Royale/Zero Build (no Reload at all) and exists purely to reshape a channel NAME string
// (move a BR/ZB tag to the front) — it was never a general classifier, and reusing its regex here
// would have silently left Reload tournaments undetected. This is a genuine three-way
// classification used for routing, kept in its own module rather than bolted onto that one.

const BUILD_MODES = [
  { key: 'battle_royale', label: 'Battle Royale', abbreviation: 'BR' },
  { key: 'zero_build', label: 'Zero Build', abbreviation: 'ZB' },
  { key: 'reload', label: 'Reload', abbreviation: 'Reload' },
];

// Defaults to Battle Royale when no explicit marker is present — the overwhelming majority of real
// titles with no build-mode word at all (regular cash cups, skin/creator cups) ARE Battle Royale,
// Fortnite's default competitive mode; a title that's genuinely Zero Build or Reload always says
// so explicitly in real Fortnite Tracker data (confirmed — see tournament-scraper.js's doc comment
// on abbreviateBuildMode/isBareBuildModeLabel). "zb"/"br" abbreviations (no full words) are
// recognized too — confirmed real via titles like "Console Duos ZB Cash Cup" — same word-boundary
// convention tournament-scraper.js's isBareBuildModeLabel already uses for these.
function detectBuildMode(nameLower) {
  if (/\bzero build\b/.test(nameLower) || /\bzb\b/.test(nameLower)) return 'zero_build';
  if (/\breload\b/.test(nameLower)) return 'reload';
  return 'battle_royale';
}

function buildModeSpec(key) {
  return BUILD_MODES.find(m => m.key === key) ?? BUILD_MODES[0];
}

// Structural cross-check for detectBuildMode above, using Epic's OWN id strings (confirmed live via
// epic-api.js against real api-fortnite.com data — e.g. "Season41_RankedCupDuosZB" vs
// "Season41_RankedCupDuos" vs "Season41_RankedCupReloadDuos", "EventTemplate_RankedCupDuosZB") —
// see tournament-scraper.js's enrichWithEpicBuildMode. Accepts multiple candidate id-like strings
// (an event's own id, its eventTemplateId, etc.) because build-mode isn't always on the SAME field:
// one real counter-example seen live had two calendar entries sharing an identical top-level id/name
// ("Champion Aphrodite FNCS Cup") that only differed in a secondary, unconfirmed-field-name token —
// exactly the kind of case this can't cover, so it returns null (no signal, caller keeps whatever it
// already had) rather than risk a wrong default. Unlike detectBuildMode, this deliberately has NO
// Battle-Royale fallback: a real id with no explicit ZB/Reload marker is not evidence the tournament
// IS Battle Royale, just that this particular id happens not to say — the title-based detectBuildMode
// above already owns that inference.
//
// No \b word-boundary regex here on purpose: real ids glue the marker straight onto an adjacent word
// with no separator (e.g. "...DuosZB", "...SoloReload") — \bzb\b would never match "DuosZB" since
// there's no non-word character between "s" and "Z".
function detectBuildModeFromEpicId(...idLikeStrings) {
  const combined = idLikeStrings.filter(Boolean).join(' ');
  if (!combined) return null;
  if (/zb/i.test(combined)) return 'zero_build';
  if (/reload/i.test(combined)) return 'reload';
  return null;
}

module.exports = { BUILD_MODES, detectBuildMode, detectBuildModeFromEpicId, buildModeSpec };
