// Verifies the real production bug fix: the public "check your ELO" endpoint (elo.js) used to
// always read a player's HOME-context stats (player.totalPR/recentEvents — Fortnite Tracker's
// combined "all"-input-method segment) regardless of which tournament type was being checked or
// what platform the player is registered as. Confirmed real symptom: a Console player checking
// "Console Duos Victory Cup" saw their kbm/PC-segment PR, not their gamepad-segment PR — the SAME
// platform-aware segment resolution queue.js's buildPlayer already applies for a real queue join
// (players.js's getStatsForContext) was never reused here.
//
// The fix (elo.js's resolvePlayerDataForContext) reuses that EXACT segment-resolution rule
// (Console + console-exclusive tournament -> gamepad, Console + non-console-exclusive -> kbm, PC ->
// always "all") but is deliberately READ-ONLY: it only reads whatever's already cached on the
// player doc (home fields for "all", statsByContext for kbm/gamepad — both populated lazily by a
// real queue join), never triggers a live scrape. This file's top doc comment guarantees this
// endpoint never scrapes live at request time (a public, unauthenticated, potentially-hammered
// route) — calling players.js's getStatsForContext directly (which scrapes on a cache miss) would
// have silently broken that guarantee and let an unauthenticated request trigger a real headless-
// Chromium launch, so this is tested explicitly (no PlayerModel.findOne/scraper stubs are wired up
// at all in these tests — if the fix accidentally called into that path, these tests would hang or
// throw against a real Mongoose connection instead of passing).
const test = require('node:test');
const assert = require('node:assert/strict');

const { computeMatchScoreBreakdown, computeOwnTournamentModifier } = require('../scraper');
const PlayerModel = require('../models/Player');
const elo = require('../elo');

function stubPlayerFind(players) {
  return (filter) => ({
    lean: async () => {
      if (filter.totalPR) return players.filter(p => p.totalPR != null);
      if (filter.epicUsernameLower) return players.filter(p => p.epicUsernameLower === filter.epicUsernameLower);
      if (filter.epicId) return players.filter(p => p.epicId === filter.epicId);
      if (filter.epicUsername instanceof RegExp) return players.filter(p => filter.epicUsername.test(p.epicUsername));
      return [];
    },
  });
}

test('elo.js: a Console player checking Console Duos Victory Cup gets their GAMEPAD-segment PR/history from statsByContext, not their home "all"-segment numbers', async () => {
  const original = PlayerModel.find;
  const player = {
    epicUsername: 'ConsolePlayer', epicUsernameLower: 'consoleplayer', epicId: 'console1',
    region: 'EU', platform: 'Console',
    totalPR: 300, recentEvents: [{ name: 'Solo Cash Cup', placement: 500, prPoints: 10, rosterSize: 1 }], lastUpdated: new Date(),
    // The gamepad-context snapshot a real queue join for a console-exclusive tournament would have
    // populated (players.js's getContextualPlayerStats) — genuinely different numbers than home, so
    // a test that read the wrong one would visibly fail rather than coincidentally pass.
    statsByContext: {
      'EU|gamepad': {
        totalPR: 900, recentEvents: [{ name: 'Console Duos Victory Cup', placement: 3, prPoints: 250, rosterSize: 2 }],
      },
    },
  };
  PlayerModel.find = stubPlayerFind([player]);
  try {
    const result = await elo.getPublicElo('ConsolePlayer');
    const victoryCup = result.tournaments.find(t => t.tournamentType === 'Console Duos Victory Cup');

    assert.equal(victoryCup.components.currentPR, 900, 'must use the gamepad-context totalPR (900), not the home "all"-segment totalPR (300)');
    assert.equal(victoryCup.hasHistory, true, 'must see the gamepad-context Console Duos Victory Cup event, which only exists in the gamepad snapshot');
    assert.notEqual(victoryCup.components.currentPR, result.creative.components.currentPR, 'creative uses a DIFFERENT (kbm) context for a Console player, so these must genuinely differ');
  } finally {
    PlayerModel.find = original;
  }
});

test('elo.js: a Console player checking FNCS Division (NOT console-exclusive) gets their KBM-segment PR, distinct from both home and the gamepad context', async () => {
  const original = PlayerModel.find;
  const player = {
    epicUsername: 'ConsolePlayer2', epicUsernameLower: 'consoleplayer2', epicId: 'console2',
    region: 'EU', platform: 'Console',
    totalPR: 300, recentEvents: [], lastUpdated: new Date(),
    statsByContext: {
      'EU|kbm': { totalPR: 450, recentEvents: [{ name: 'FNCS Division 2', placement: 10, prPoints: 120, rosterSize: 3 }] },
      'EU|gamepad': { totalPR: 900, recentEvents: [{ name: 'Console Duos Victory Cup', placement: 3, prPoints: 250, rosterSize: 2 }] },
    },
  };
  PlayerModel.find = stubPlayerFind([player]);
  try {
    const result = await elo.getPublicElo('ConsolePlayer2');
    const fncs = result.tournaments.find(t => t.tournamentType === 'FNCS Division');
    const victoryCup = result.tournaments.find(t => t.tournamentType === 'Console Duos Victory Cup');

    assert.equal(fncs.components.currentPR, 450, 'FNCS Division is not console-exclusive -> must use the kbm-context PR for a Console player');
    assert.equal(victoryCup.components.currentPR, 900, 'Console Duos Victory Cup IS console-exclusive -> must use the gamepad-context PR');
    assert.equal(result.creative.components.currentPR, 450, 'creative has no console-exclusive-mode concept -> same kbm context as the non-console-exclusive tournament type');
  } finally {
    PlayerModel.find = original;
  }
});

test('elo.js: a PC player is completely unaffected by platform-scoping — always reads the home "all"-segment fields regardless of tournament type', async () => {
  const original = PlayerModel.find;
  const player = {
    epicUsername: 'PcPlayer', epicUsernameLower: 'pcplayer', epicId: 'pc1',
    region: 'EU', platform: 'PC',
    totalPR: 600, recentEvents: [{ name: 'FNCS Division 1', placement: 4, prPoints: 180, rosterSize: 3 }], lastUpdated: new Date(),
    // Even if a statsByContext entry somehow existed, a PC player's segment is always "all" — it
    // must never be consulted.
    statsByContext: { 'EU|kbm': { totalPR: 999999, recentEvents: [] } },
  };
  PlayerModel.find = stubPlayerFind([player]);
  try {
    const result = await elo.getPublicElo('PcPlayer');
    assert.equal(result.creative.components.currentPR, 600);
    for (const t of result.tournaments) {
      assert.equal(t.components.currentPR, 600, `${t.tournamentType} must use the home totalPR for a PC player, never the statsByContext decoy value`);
    }
  } finally {
    PlayerModel.find = original;
  }
});

test('elo.js: a Console player who has NEVER queued a console-exclusive tournament (no gamepad statsByContext entry yet) falls back to home stats rather than showing 0 or hanging on a live scrape', async () => {
  const original = PlayerModel.find;
  const player = {
    epicUsername: 'NewConsolePlayer', epicUsernameLower: 'newconsoleplayer', epicId: 'console3',
    region: 'NAC', platform: 'Console',
    totalPR: 250, recentEvents: [], lastUpdated: new Date(),
    statsByContext: {}, // never queued anything context-specific yet
  };
  PlayerModel.find = stubPlayerFind([player]);
  try {
    const result = await elo.getPublicElo('NewConsolePlayer');
    const victoryCup = result.tournaments.find(t => t.tournamentType === 'Console Duos Victory Cup');
    assert.equal(victoryCup.components.currentPR, 250, 'no gamepad context cached yet -> falls back to the home snapshot rather than 0');
  } finally {
    PlayerModel.find = original;
  }
});

test('elo.js: a Console player with home totalPR still null, but a real gamepad statsByContext entry, is NOT reported as "no stats yet" (the hasStats gating bug)', async () => {
  const original = PlayerModel.find;
  const player = {
    epicUsername: 'ContextOnlyPlayer', epicUsernameLower: 'contextonlyplayer', epicId: 'console4',
    region: 'EU', platform: 'Console',
    totalPR: null, recentEvents: [], lastUpdated: null, // home "all" segment never scraped (never ran /refresh-stats)
    statsByContext: { 'EU|gamepad': { totalPR: 700, recentEvents: [] } }, // but HAS queued a console-exclusive tournament for real
  };
  PlayerModel.find = stubPlayerFind([player]);
  try {
    const result = await elo.getPublicElo('ContextOnlyPlayer');
    assert.equal(result.hasStats, true, 'real statsByContext history exists — must not be reported as having no stats at all');
    const victoryCup = result.tournaments.find(t => t.tournamentType === 'Console Duos Victory Cup');
    assert.equal(victoryCup.components.currentPR, 700);
  } finally {
    PlayerModel.find = original;
  }
});

test('elo.js: a player with genuinely no stats anywhere (no home fields, no statsByContext) still gets the honest "no stats yet" response', async () => {
  const original = PlayerModel.find;
  const player = {
    epicUsername: 'TrulyNew', epicUsernameLower: 'trulynew', epicId: 'console5',
    region: 'EU', platform: 'Console', totalPR: null, recentEvents: [], lastUpdated: null,
  };
  PlayerModel.find = stubPlayerFind([player]);
  try {
    const result = await elo.getPublicElo('TrulyNew');
    assert.equal(result.hasStats, false);
    assert.equal(result.creative, undefined);
  } finally {
    PlayerModel.find = original;
  }
});

test('elo.js: resolvePlayerDataForContext\'s platform-scoped playerData feeds the SAME real formula as computeMatchScoreBreakdown directly — no parallel scoring logic', async () => {
  const original = PlayerModel.find;
  const gamepadEvents = [{ name: 'Console Duos Victory Cup', placement: 1, prPoints: 300, rosterSize: 2 }];
  const player = {
    epicUsername: 'FormulaCheck', epicUsernameLower: 'formulacheck', epicId: 'console6',
    region: 'EU', platform: 'Console', totalPR: 100, recentEvents: [], lastUpdated: new Date(),
    statsByContext: { 'EU|gamepad': { totalPR: 800, recentEvents: gamepadEvents } },
  };
  PlayerModel.find = stubPlayerFind([player]);
  try {
    const result = await elo.getPublicElo('FormulaCheck');
    const victoryCup = result.tournaments.find(t => t.tournamentType === 'Console Duos Victory Cup');
    // Reproduces elo.js's own real computation (base+solo via a never-matching name, then
    // computeOwnTournamentModifier separately via the lowercase-substring keyword match — the exact
    // two-step buildTournamentElo itself performs) against the gamepad-context playerData, as an
    // independent cross-check rather than asserting elo.js agrees with itself.
    const { base, soloModifier } = computeMatchScoreBreakdown({ totalPR: 800, recentEvents: gamepadEvents }, '__never_matches__');
    const { modifier: ownTournamentModifier } = computeOwnTournamentModifier(gamepadEvents, e => e.name.toLowerCase().includes('console duos victory cup'), base);
    const expectedScore = Math.round(base * (1 + soloModifier + ownTournamentModifier));
    assert.equal(victoryCup.score, expectedScore, 'must be the real formula applied to the gamepad context, not a re-derived number');
  } finally {
    PlayerModel.find = original;
  }
});
