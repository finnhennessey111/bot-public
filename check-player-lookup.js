// One-off, read-only diagnostic — checks whether a real Player document has epicUsernameLower
// populated, to confirm/deny the hypothesis that pre-existing records (last written before
// epicUsernameLower was introduced) are missing it entirely, causing GET /api/elo/:epicUsername
// to report "not found" for a real, linked, scraped player.
//
// Run on the server with the real .env (MONGODB_URI) present:
//   node check-player-lookup.js "finn444 wwwwwwww"
// Safe to delete after use — this makes no writes.

require('dotenv').config();
const db = require('./db');
const PlayerModel = require('./models/Player');

async function main() {
  const searched = process.argv[2];
  if (!searched) {
    console.error('Usage: node check-player-lookup.js "<epicUsername>"');
    process.exit(1);
  }

  const connected = await db.connect();
  if (!connected) {
    console.error('Could not connect to MongoDB — check MONGODB_URI in .env');
    process.exit(1);
  }

  console.log(`\nSearching for epicUsername matching "${searched}" (case-insensitive, any guild)...\n`);

  const escaped = searched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = await PlayerModel.find({ epicUsername: new RegExp(`^${escaped}$`, 'i') }).lean();

  if (matches.length === 0) {
    console.log('❌ NO Player document found with this epicUsername at all (any casing). This player may not actually be linked, or the username is spelled differently in the DB.');
  } else {
    console.log(`✅ Found ${matches.length} Player document(s) with this epicUsername:\n`);
    for (const doc of matches) {
      console.log('  guildId:            ', doc.guildId);
      console.log('  discordId:          ', doc.discordId);
      console.log('  epicUsername:       ', JSON.stringify(doc.epicUsername));
      console.log('  epicUsernameLower:  ', JSON.stringify(doc.epicUsernameLower), doc.epicUsernameLower == null ? '  <-- MISSING (this is the bug)' : '');
      console.log('  epicId:             ', doc.epicId);
      console.log('  totalPR:            ', doc.totalPR);
      console.log('  lastUpdated:        ', doc.lastUpdated);
      console.log('  registeredAt:       ', doc.registeredAt);
      console.log('  ---');
    }

    const anyMissingLower = matches.some(d => d.epicUsernameLower == null);
    console.log(anyMissingLower
      ? '\n=> CONFIRMED: at least one matching document has no epicUsernameLower field — this is why the lookup returns not-found.'
      : '\n=> epicUsernameLower IS populated on every matching document — the "not found" bug has a different cause, not this.');
  }

  await db.mongoose.connection.close();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
