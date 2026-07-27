require('dotenv').config();

module.exports = {
  token: process.env.DISCORD_TOKEN,

  // Progressive queue widening — max allowed Total PR difference between two units,
  // based on how long a unit has been waiting in queue.
  matchWideningSchedule: [
    { afterSeconds: 0, maxPRDiff: 150 },
    { afterSeconds: 45, maxPRDiff: 300 },
    { afterSeconds: 90, maxPRDiff: Infinity },
  ],

  // Soft PR-distance penalty — inflates the ranking diff (not eligibility) for candidates
  // further apart in Total PR, so closer matches are still preferred once both are eligible.
  prDistancePenalties: [
    { maxDiff: 150, scorePenalty: 0 },
    { maxDiff: 300, scorePenalty: 0.20 },
    { maxDiff: Infinity, scorePenalty: 0.40 },
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

  // Cross-region Match Score penalties (applied to player's Match Score)
  regionPenalties: {
    'ME': { 'NAC': 0.10, 'EU': 0.25 },
    'NAC': { 'EU': 0.15 },
    'EU': {},
  },

  // Placement score conversion — bounded 0-100 scale. Worst possible placement in any
  // tournament is #10,000 (confirmed), so this is fully bounded rather than open-ended; bands
  // are calibrated against the actual player base, where top-10/top-50 finishes essentially
  // never happen.
  placementScores: [
    { threshold: 300,   score: 100 },
    { threshold: 1000,  score: 70  },
    { threshold: 2000,  score: 40  },
    { threshold: 5000,  score: 15  },
    { threshold: 10000, score: 5   },
  ],

  // Channel lifecycle
  channelCreateHoursBefore: 24,  // midday day before = ~24hrs
  channelDeleteHoursAfter: 1,    // delete 1hr after tournament starts

  // Fortnite Tracker URL templates
  ftUrls: {
  EU:  'https://fortnitetracker.com/profile/all/{slug}/events?region=EU&id={epicId}',
  NAC: 'https://fortnitetracker.com/profile/all/{slug}/events?region=NAC&id={epicId}',
  ME:  'https://fortnitetracker.com/profile/all/{slug}/events?region=ME&id={epicId}',
},
};