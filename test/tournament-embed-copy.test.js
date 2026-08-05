// Verifies tonight's tournament embed copy change: the "make sure you're actually registered
// through Epic's own competitive system" paragraph is gone, the "Check if you're eligible"
// Fortnite Tracker link is untouched, a new website-enticement line replaces the removed
// paragraph, and the footer no longer duplicates that enticement (consolidated into the one
// description line — buildTournamentEmbed/buildRankedCupTournamentEmbed are the only two embeds
// sharing this description helper, so they're the only two that could ever have carried both).
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTournamentEmbed, buildRankedCupTournamentEmbed } = require('../embeds');

function futureIso(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
}

test('buildTournamentEmbed: the "make sure you\'re actually registered" paragraph is gone', () => {
  const json = buildTournamentEmbed('Test Cup', 'EU', 4, false, futureIso(20), futureIso(40), false, 'ev1').toJSON();
  assert.doesNotMatch(json.description, /actually registered/i);
  assert.doesNotMatch(json.description, /does not register you/i);
});

test('buildTournamentEmbed: the "Check if you\'re eligible" Fortnite Tracker link survives unchanged', () => {
  const json = buildTournamentEmbed('Test Cup', 'EU', 4, false, futureIso(20), futureIso(40), false, 'ev1').toJSON();
  assert.match(json.description, /\[Check if you're eligible\]\(https:\/\/fortnitetracker\.com\/events\/ev1\)/);
});

test('buildTournamentEmbed: a new website-enticement line replaces the removed paragraph', () => {
  const json = buildTournamentEmbed('Test Cup', 'EU', 4, false, futureIso(20), futureIso(40), false, 'ev1').toJSON();
  assert.match(json.description, /matchmakerbot\.xyz/);
  assert.match(json.description, /Power Ranking/i);
});

test('buildTournamentEmbed: the footer no longer carries the (now duplicate) enticement text', () => {
  const json = buildTournamentEmbed('Test Cup', 'EU', 4, false, futureIso(20), futureIso(40), false, 'ev1').toJSON();
  assert.doesNotMatch(json.footer.text, /matchmakerbot\.xyz/, 'the site pitch now lives once, in the description, not duplicated in the footer too');
});

test('buildRankedCupTournamentEmbed: same copy change applies — no old paragraph, link intact, new enticement, no footer duplicate', () => {
  const json = buildRankedCupTournamentEmbed('Ranked Cup', 'EU', {}, false, futureIso(20), futureIso(40), false, 'ev2').toJSON();
  assert.doesNotMatch(json.description, /actually registered/i);
  assert.match(json.description, /\[Check if you're eligible\]\(https:\/\/fortnitetracker\.com\/events\/ev2\)/);
  assert.match(json.description, /matchmakerbot\.xyz/);
  assert.doesNotMatch(json.footer.text, /matchmakerbot\.xyz/);
});

test('buildTournamentEmbed: with no eventId (no Fortnite Tracker link available), the eligibility link is omitted but the new enticement still appears', () => {
  const json = buildTournamentEmbed('Test Cup', 'EU', 4, false, futureIso(20), futureIso(40), false, null).toJSON();
  assert.doesNotMatch(json.description, /Check if you're eligible/);
  assert.match(json.description, /matchmakerbot\.xyz/);
});
