require('dotenv').config();

module.exports = {
  token: process.env.DISCORD_TOKEN,

  // Soft PR-distance penalty — inflates the ranking diff (not eligibility) for candidates
  // further apart in raw Total PR, so closer matches are still preferred once both are eligible.
  // Distinct from tournamentWideningSchedule/creativeWideningSchedule below (which gate
  // ELIGIBILITY via logPR distance) — this only runs in queue.js's rankingDiff, which is exclusively
  // used to pick the best match AMONG candidates that already passed that eligibility gate. It
  // exists specifically to stop a modifier-inflated matchScore (soloModifier/ownTournamentModifier
  // can make two very-different-raw-PR players look deceptively close on matchScore alone) from
  // winning a tie-break it shouldn't — confirmed via investigation this is a genuinely distinct
  // purpose from the logPR eligibility gate, not a redundant leftover, so it was rescaled rather
  // than removed when the score formula went PR-native (queue.js's rankingDiff.js was previously
  // tuned against the old ~10-15x-scaled matchScore magnitude). 100/350 are real target values, not
  // a back-calculated rescale; 225/0.20 preserves the original table's shape (an interpolated
  // midpoint at half the max penalty) rather than jumping straight from 0 to 0.40.
  prDistancePenalties: [
    { maxDiff: 100, scorePenalty: 0 },
    { maxDiff: 225, scorePenalty: 0.20 },
    { maxDiff: 350, scorePenalty: 0.40 },
  ],

  matchSweepIntervalSeconds: 15,

  // Creative queue widening — gates on logPR distance (Math.log(totalPR + 1) * 100), not raw
  // PR, and ties the platform restriction to the same tiers: tight band + same-platform-only
  // early on, wider band + any platform once both units have waited long enough. 60 logPR is
  // a hard ceiling — deliberately no later "Infinity" tier, so e.g. a 100 PR player and a
  // 5000 PR player never get paired no matter how long either waits.
  creativeWideningSchedule: [
    { afterSeconds: 0,  maxLogPRDiff: 40, samePlatformOnly: true },
    { afterSeconds: 25, maxLogPRDiff: 60, samePlatformOnly: false },
  ],

  // Tournament queue widening — same logPR-distance approach as creativeWideningSchedule, but
  // unlike creative's permanent 60-logPR ceiling, ends with an unlimited tier after a longer
  // wait (same philosophy as the old raw-PR matchWideningSchedule's final Infinity tier) —
  // tournament lobbies are large enough that an eventual any-PR pairing is preferable to an
  // unfilled queue.
  tournamentWideningSchedule: [
    { afterSeconds: 0,  maxLogPRDiff: 50, samePlatformOnly: true },
    { afterSeconds: 45, maxLogPRDiff: 80, samePlatformOnly: false },
    { afterSeconds: 90, maxLogPRDiff: Infinity, samePlatformOnly: false },
  ],

  // 6s/8s creative team queue — post-formation channel lifecycle and vote-kick timings.
  // PR/platform matching itself reuses creativeWideningSchedule above, not a separate schedule.
  teamQueue: {
    lockSeconds: 30,
    readyCheckSeconds: 60,
    backfillRetrySeconds: 30,
    voteKickMinChannelAgeSeconds: 120,
    voteKickWindowSeconds: 60,
    voteKickMajority: 0.75,
    voteKickFailCooldownSeconds: 600,
    teamMethodVoteSeconds: 60,
    teamChoiceSeconds: 60,
  },

  // Channel lifecycle
  channelCreateHoursBefore: 24,  // midday day before = ~24hrs
  channelDeleteHoursAfter: 1,    // delete 1hr after tournament starts

  // Fortnite Tracker profile URL template — {platform} is a real Tracker input-method segment
  // (confirmed live: kbm, gamepad, touch, all all resolve to real profile pages), not a device
  // field of its own. competitive=pr narrows the response to PR-affecting events only, mirroring
  // what scraper.js's parseProfileData already discards client-side (event.isPrEvent) anyway — so
  // this is a pure reduction in what gets downloaded/parsed, no behavior change.
  ftUrlTemplate: 'https://fortnitetracker.com/profile/{platform}/{slug}/events?region={region}&id={epicId}&competitive=pr',

  // Which Tracker input-method segment stands in for each of this bot's platform roles — the
  // closest real proxy Tracker exposes for "this platform's own PR" (confirmed real segments via
  // live Tracker profiles, e.g. fortnitetracker.com/profile/gamepad/Typical%20Gamer and
  // .../profile/kbm/Hamlinz). Only used when a query actually needs a platform-specific context
  // (players.js's getStatsForContext) — every other lookup stays on the 'all' (combined) segment,
  // unchanged from prior behavior. Mobile has no entry: platform-aware PR is scoped to PC/Console
  // per the actual task this shipped for; a Mobile player's PR context is untouched.
  ftPlatformSegments: { PC: 'kbm', Console: 'gamepad' },

  // Fortnite Tracker /events calendar query params — competitive=pr narrows the calendar to real
  // PR-tracked tournaments (see tournament-scraper.js's fetchRawCalendar). playlist is fetched once
  // per confirmed real value this bot actually needs (duos, trios — solo is irrelevant, this bot
  // never queues solo tournaments) and merged, rather than one big unfiltered fetch discarding most
  // of it client-side via BLOCKED_KEYWORDS.
  ftCalendarPlaylists: ['duos', 'trios'],
};