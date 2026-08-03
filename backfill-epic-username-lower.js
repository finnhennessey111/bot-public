// backfill-epic-username-lower.js - One-time backfill: populates epicUsernameLower on every
// Player document that has a real epicUsername but is missing the derived lowercase mirror —
// introduced after those records were last written (players.js's upsertPlayer only sets
// epicUsernameLower on a write that touches epicUsername, so a record nobody has re-linked or
// re-scraped since that field shipped never picks it up on its own). Confirmed against real
// production data: every pre-existing Player document has this gap.
//
// Without this, GET /api/elo/:epicUsername falls back to a slower, unindexed regex scan
// (players.js's findCanonicalByEpicUsername) for every such record, forever — this is what lets
// the fast indexed path actually apply to them.
//
// Idempotent — the filter only ever matches documents where epicUsernameLower is still missing, so
// running this more than once is safe; a second run updates 0 documents. Makes no other change to
// any document.
//
// Run on the server with the real .env (MONGODB_URI) present:
//   node backfill-epic-username-lower.js

require('dotenv').config();
const db = require('./db');
const PlayerModel = require('./models/Player');

// MongoDB's `{ field: null }` query matches BOTH documents missing the field entirely AND ones
// where it's explicitly set to null — covers both possible "not populated yet" shapes in one
// filter, no separate $exists check needed.
function missingLowerFilter() {
  return {
    epicUsername: { $nin: [null, ''] },
    epicUsernameLower: null,
  };
}

async function main() {
  const connected = await db.connect();
  if (!connected) {
    console.error('Could not connect to MongoDB — check MONGODB_URI in .env');
    process.exit(1);
  }

  const filter = missingLowerFilter();
  const beforeCount = await PlayerModel.countDocuments(filter);
  console.log(`Found ${beforeCount} Player document(s) with an epicUsername but no epicUsernameLower.`);

  if (beforeCount === 0) {
    console.log('Nothing to do.');
    await db.mongoose.connection.close();
    return;
  }

  // Aggregation-pipeline update ($set computed from the document's own field via $toLower) — one
  // atomic server-side operation instead of reading every document into Node and writing them back
  // one at a time, so this stays cheap even against a large collection.
  const result = await PlayerModel.updateMany(filter, [
    { $set: { epicUsernameLower: { $toLower: '$epicUsername' } } },
  ]);

  console.log(`\nDone — updated ${result.modifiedCount} document(s).`);
  await db.mongoose.connection.close();
}

// Guarded so a test can require() this file (for missingLowerFilter, or to call main() itself
// against a stubbed Model) without the script immediately trying a real DB connection as a side
// effect of being loaded — only runs automatically via `node backfill-epic-username-lower.js`.
if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}

module.exports = { missingLowerFilter, main };
