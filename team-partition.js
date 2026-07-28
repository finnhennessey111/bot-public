// team-partition.js - Exact (not greedy) partitioning of pre-formed units (parties or solo
// queuers) into two equal-size teams. Used by both creative-team-queue.js (to gate which unit
// combinations are even allowed to complete a match) and team-match-lifecycle.js (to actually
// split a completed match into two teams). Pure functions, no dependencies — kept in their own
// module specifically to avoid a circular require between those two.
//
// "Exact" matters because a party must never be split across the two teams if a whole-unit
// partition exists at all — greedy first-fit bin-packing (the previous approach) can miss a valid
// split that a full search would find, and can't distinguish "greedy failed" from "genuinely
// impossible" (e.g. three 2-person duos can never split cleanly into two 3-player teams: no subset
// of {2,2,2} sums to 3). Unit counts here are always small (a target match is 6 or 8 players, each
// unit at least 1 player, so at most 8 units) — brute-force over every subset is trivial.

function unitSize(unit) {
  return unit.players.length;
}

function unitTotalPR(unit) {
  return unit.players.reduce((sum, p) => sum + p.totalPR, 0);
}

function teamTotalPR(team) {
  return team.reduce((sum, p) => sum + p.totalPR, 0);
}

// Returns the indices of a subset of `sizes` summing to exactly `target`, or null if none exists.
// Plain recursive search — always over a small array in practice (see module doc), so this is
// effectively instant despite being exponential in the worst case.
function findSubsetSummingTo(sizes, target) {
  function search(index, remaining) {
    if (remaining === 0) return [];
    if (remaining < 0 || index >= sizes.length) return null;

    const withIt = search(index + 1, remaining - sizes[index]);
    if (withIt !== null) return [index, ...withIt];

    return search(index + 1, remaining);
  }
  return search(0, target);
}

// True if some subset of unitSizes sums to exactly `target` — used both as a hard feasibility
// gate (creative-team-queue.js, before a join/merge is allowed to complete a match) and internally
// by bestPartitionByPR below.
function canPartitionIntoHalves(unitSizes, target) {
  return findSubsetSummingTo(unitSizes, target) !== null;
}

// Exhaustively tries every subset of `units` summing to exactly `target` (by player count) and
// returns the one minimizing the resulting PR gap between the two sides, or null if no subset
// sums to `target` at all.
function bestSubsetForTarget(units, target, seedPR1, seedPR2) {
  const sizes = units.map(unitSize);
  const totalPR = units.reduce((sum, u) => sum + unitTotalPR(u), 0);
  let best = null;

  function search(index, remaining, chosen, chosenPR) {
    if (remaining === 0) {
      const team1PR = seedPR1 + chosenPR;
      const team2PR = seedPR2 + (totalPR - chosenPR);
      const diff = Math.abs(team1PR - team2PR);
      if (!best || diff < best.diff) best = { chosen: [...chosen], diff };
      return;
    }
    if (remaining < 0 || index >= units.length) return;

    chosen.push(units[index]);
    search(index + 1, remaining - sizes[index], chosen, chosenPR + unitTotalPR(units[index]));
    chosen.pop();

    search(index + 1, remaining, chosen, chosenPR);
  }

  search(0, target, [], 0);
  return best;
}

// Original greedy largest-first bin-packing (team-match-lifecycle.js's previous
// assignPartyAwareTeams) — used only when bestPartitionByPR's exact search finds no whole-unit
// partition at all, i.e. splitting a unit is genuinely unavoidable (see module doc's three-duos
// example). The only legitimate real-world case for actually reaching this fallback is a single
// unit that by itself already fills the whole lobby (e.g. 6 friends queueing together for 6s) —
// creative-team-queue.js's join/merge gate (using canPartitionIntoHalves) prevents any *other*
// unsplittable combination from ever completing a match in the first place.
function fallbackSplit(units, halfSize, seedTeam1, seedTeam2) {
  const team1 = [...seedTeam1];
  const team2 = [...seedTeam2];

  const sortedUnits = [...units].sort((a, b) => unitSize(b) - unitSize(a) || unitTotalPR(b) - unitTotalPR(a));

  for (const unit of sortedUnits) {
    const room1 = halfSize - team1.length;
    const room2 = halfSize - team2.length;
    const size = unitSize(unit);
    const fitsTeam1 = size <= room1;
    const fitsTeam2 = size <= room2;

    if (fitsTeam1 && fitsTeam2) {
      (teamTotalPR(team1) <= teamTotalPR(team2) ? team1 : team2).push(...unit.players);
    } else if (fitsTeam1) {
      team1.push(...unit.players);
    } else if (fitsTeam2) {
      team2.push(...unit.players);
    } else {
      // Doesn't fit whole in either — split across both, filling whatever room remains and
      // handing the higher-PR half of the party to whichever team is currently lower on PR.
      const playersDesc = [...unit.players].sort((a, b) => b.totalPR - a.totalPR);
      for (const p of playersDesc) {
        const r1 = halfSize - team1.length;
        const r2 = halfSize - team2.length;
        if (r1 <= 0) team2.push(p);
        else if (r2 <= 0) team1.push(p);
        else (teamTotalPR(team1) <= teamTotalPR(team2) ? team1 : team2).push(p);
      }
    }
  }

  return { team1, team2 };
}

// Places every unit (party or solo) into one of two equal-size teams (halfSize each, minus
// whatever's already pre-seeded), keeping each unit together whenever any whole-unit partition
// exists at all — and picking the PR-balanced one among every partition that does. seedTeam1/
// seedTeam2 let callers pre-seed with already-decided placements (e.g. manual picks in team-
// match-lifecycle.js's "Choose Own Teams" leftover-unit assignment) and have this only place the
// remaining units around them.
function bestPartitionByPR(units, halfSize, seedTeam1 = [], seedTeam2 = []) {
  const room1 = halfSize - seedTeam1.length;
  const room2 = halfSize - seedTeam2.length;
  const seedPR1 = teamTotalPR(seedTeam1);
  const seedPR2 = teamTotalPR(seedTeam2);
  const total = units.reduce((sum, u) => sum + unitSize(u), 0);

  if (room1 >= 0 && room2 >= 0 && total === room1 + room2) {
    const best = bestSubsetForTarget(units, room1, seedPR1, seedPR2);
    if (best) {
      const chosenSet = new Set(best.chosen);
      return {
        team1: [...seedTeam1, ...best.chosen.flatMap(u => u.players)],
        team2: [...seedTeam2, ...units.filter(u => !chosenSet.has(u)).flatMap(u => u.players)],
      };
    }
  }

  return fallbackSplit(units, halfSize, seedTeam1, seedTeam2);
}

module.exports = { canPartitionIntoHalves, bestPartitionByPR };
