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

  // Placement score conversion
  placementScores: [
    { threshold: 10,   score: 400 },
    { threshold: 50,   score: 300 },
    { threshold: 100,  score: 200 },
    { threshold: 500,  score: 100 },
    { threshold: 1000, score: 50  },
    { threshold: 5000, score: 20  },
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