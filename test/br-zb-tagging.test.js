// Verifies the "untagged third copy" bug for tournaments that render byte-identical visible text
// for both their Battle Royale and Zero Build variants (e.g. "PlayStation Typical Gamer Icon
// Cup"). Confirmed against a REAL live scrape of fortnite.com/competitive/schedule (not guessed):
//
//   1. The real hrefs for this exact tournament are:
//        /competitive/events/S41_PSTypicalGamer_ZB?round=S41_PSTypicalGamer_ZB_Qualifier_EU  (ZB)
//        /competitive/events/S41_PSTypicalGamer?round=S41_PSTypicalGamer_Qualifier_EU         (BR)
//        /competitive/events/S41_PSTypicalGamer?round=S41_PSTypicalGamer_Final_EU             (dropped)
//      The BR href has no build-mode marker in it at all — the code only ever explicitly tagged
//      ZB, so this entry silently kept its plain, untagged name.
//   2. A real scrape also has 105 raw /events/ anchors on the EU page vs. 76 actual parsed text
//      entries — extra anchors are exact-duplicate consecutive hrefs (a leaderboard player-name
//      sub-line gets its own anchor), which used to desync the whole positional href correlation
//      from that point in the page onward, so even a same-page ZB entry could get some unrelated
//      tournament's href attached instead of its own.
//
// Both are fixed together: dedupeConsecutiveHrefs realigns the anchor list, and
// parseScheduleBodyText's second pass infers Battle Royale for any entry sharing an exact name
// with a confirmed Zero Build sibling.
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseScheduleBodyText, dedupeConsecutiveHrefs } = require('../tournament-scraper');

// --- dedupeConsecutiveHrefs: the real duplicate-anchor pattern ------------------------------

test('dedupeConsecutiveHrefs: collapses consecutive duplicates but keeps a later genuine repeat', () => {
  const hrefs = [
    '/competitive/events/S41_RankedCupSolo?round=S41_RankedCupSolo_Event4_EU',
    '/competitive/events/S41_RankedCupSolo?round=S41_RankedCupSolo_Event4_EU', // consecutive dup
    '/competitive/events/S41_PSTypicalGamer_ZB?round=S41_PSTypicalGamer_ZB_Qualifier_EU',
    '/competitive/events/S41_PSTypicalGamer?round=S41_PSTypicalGamer_Qualifier_EU',
    '/competitive/events/S41_PSTypicalGamer?round=S41_PSTypicalGamer_Final_EU',
    '/competitive/events/S41_RankedCupSolo?round=S41_RankedCupSolo_Event5_EU', // genuinely different day
  ];

  assert.deepEqual(dedupeConsecutiveHrefs(hrefs), [
    '/competitive/events/S41_RankedCupSolo?round=S41_RankedCupSolo_Event4_EU',
    '/competitive/events/S41_PSTypicalGamer_ZB?round=S41_PSTypicalGamer_ZB_Qualifier_EU',
    '/competitive/events/S41_PSTypicalGamer?round=S41_PSTypicalGamer_Qualifier_EU',
    '/competitive/events/S41_PSTypicalGamer?round=S41_PSTypicalGamer_Final_EU',
    '/competitive/events/S41_RankedCupSolo?round=S41_RankedCupSolo_Event5_EU',
  ]);
});

test('dedupeConsecutiveHrefs: matches the real EU scrape count (105 raw -> 76 deduped)', () => {
  // A representative slice, not the full 105 — enough duplicate/non-duplicate pairs to prove the
  // collapse logic generalizes, without hardcoding the entire real page dump into a test fixture.
  const hrefs = [
    'a', 'a', 'b', 'c', 'd', 'e', 'f', 'f', 'g', 'g', 'h', 'i', 'i', 'j',
  ];
  assert.deepEqual(dedupeConsecutiveHrefs(hrefs), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
});

// --- parseScheduleBodyText: the real "PlayStation Typical Gamer Icon Cup" slugs -------------

// Minimal grammar-valid page fragment carrying the three real, confirmed sessions for this
// tournament (ZB, the untagged-until-now BR/"Qualifier" round, and the restricted Final round),
// in the same document order the real page uses them.
const REAL_BODY_TEXT = [
  'WEDNESDAY',
  'July 29, 2026',
  '6:00 PM',
  'SESSION 2 - ROUND 1',
  'PlayStation Typical Gamer Icon Cup',
  '6:00 PM',
  'SESSION 2 - ROUND 1',
  'PlayStation Typical Gamer Icon Cup',
  '6:00 PM',
  'SESSION 2 - ROUND 2',
  'PlayStation Typical Gamer Icon Cup',
].join('\n');

const REAL_EVENT_LINKS = [
  { href: '/competitive/events/S41_PSTypicalGamer_ZB?round=S41_PSTypicalGamer_ZB_Qualifier_EU' },
  { href: '/competitive/events/S41_PSTypicalGamer?round=S41_PSTypicalGamer_Qualifier_EU' },
  { href: '/competitive/events/S41_PSTypicalGamer?round=S41_PSTypicalGamer_Final_EU' },
];

test('parseScheduleBodyText: the real BR ("Qualifier") slug now resolves to Battle Royale instead of falling through untagged', () => {
  const sessions = parseScheduleBodyText(REAL_BODY_TEXT, 'EU', REAL_EVENT_LINKS);

  // Exactly 2 channel-eligible sessions: Final is dropped (restricted to already-qualified
  // players), ZB and BR both survive, tagged, and — critically — nothing untagged remains.
  const names = sessions.map(s => s.name).sort();
  assert.deepEqual(names, [
    'PlayStation Typical Gamer Icon Cup (Battle Royale)',
    'PlayStation Typical Gamer Icon Cup (Zero Build)',
  ]);
  assert.ok(!names.includes('PlayStation Typical Gamer Icon Cup'), 'no untagged duplicate should survive');
});

test('parseScheduleBodyText: a tournament with no Zero Build sibling is left completely untouched', () => {
  const bodyText = [
    'THURSDAY',
    'July 30, 2026',
    '7:00 PM',
    'WEEK 4 - ROUND 1',
    'FNCS Division 1',
  ].join('\n');
  const eventLinks = [
    { href: '/competitive/events/S41_FNCSDivisionalCup_Division1?round=S41_FNCSDivisionalCup_Division1_Week4_EU' },
  ];

  const sessions = parseScheduleBodyText(bodyText, 'EU', eventLinks);
  assert.deepEqual(sessions.map(s => s.name), ['FNCS Division 1']); // no spurious "(Battle Royale)"
});
