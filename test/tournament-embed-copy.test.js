// Verifies the tournament embed's current, real copy state. This file originally verified an
// interim change (the "make sure you're actually registered" paragraph replaced by a website
// enticement line) that was itself later reverted — a follow-up task removed the enticement lines
// added across this codebase (holding off on promoting the website's ELO checker until a planned
// comparison feature is ready), which restored the original registration-reminder paragraph in
// these two embeds specifically, since it's exactly what the enticement had replaced. Updated here
// to check the CURRENT real state rather than the interim one — the Fortnite Tracker link and the
// no-footer-duplicate behavior never changed across either revision, so those checks carry over.
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTournamentEmbed, buildRankedCupTournamentEmbed } = require('../embeds');

function futureIso(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
}

test('buildTournamentEmbed: the "make sure you\'re actually registered" reminder paragraph is present', () => {
  const json = buildTournamentEmbed('Test Cup', 'EU', 4, false, futureIso(20), futureIso(40), false, 'ev1').toJSON();
  assert.match(json.description, /actually registered/i);
  assert.match(json.description, /does not register you/i);
});

test('buildTournamentEmbed: the "Check if you\'re eligible" Fortnite Tracker link is present', () => {
  const json = buildTournamentEmbed('Test Cup', 'EU', 4, false, futureIso(20), futureIso(40), false, 'ev1').toJSON();
  assert.match(json.description, /\[Check if you're eligible\]\(https:\/\/fortnitetracker\.com\/events\/ev1\)/);
});

test('buildTournamentEmbed: no website enticement text anywhere in the description', () => {
  const json = buildTournamentEmbed('Test Cup', 'EU', 4, false, futureIso(20), futureIso(40), false, 'ev1').toJSON();
  assert.doesNotMatch(json.description, /matchmakerbot\.xyz/);
});

test('buildTournamentEmbed: the footer is plain "MatchMaker" — no site pitch there either', () => {
  const json = buildTournamentEmbed('Test Cup', 'EU', 4, false, futureIso(20), futureIso(40), false, 'ev1').toJSON();
  assert.equal(json.footer.text, 'MatchMaker');
});

test('buildRankedCupTournamentEmbed: same real copy — registration reminder present, link intact, no enticement anywhere', () => {
  const json = buildRankedCupTournamentEmbed('Ranked Cup', 'EU', {}, false, futureIso(20), futureIso(40), false, 'ev2').toJSON();
  assert.match(json.description, /actually registered/i);
  assert.match(json.description, /\[Check if you're eligible\]\(https:\/\/fortnitetracker\.com\/events\/ev2\)/);
  assert.doesNotMatch(json.description, /matchmakerbot\.xyz/);
  assert.doesNotMatch(json.footer.text, /matchmakerbot\.xyz/);
});

test('buildTournamentEmbed: with no eventId (no Fortnite Tracker link available), the eligibility link is omitted but the registration reminder still appears', () => {
  const json = buildTournamentEmbed('Test Cup', 'EU', 4, false, futureIso(20), futureIso(40), false, null).toJSON();
  assert.doesNotMatch(json.description, /Check if you're eligible/);
  assert.match(json.description, /actually registered/i);
});
