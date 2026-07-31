// models/Suggestion.js - Centralized suggest-a-feature capture (suggestions.js). One shared
// collection across every guild the bot is installed in — a player anywhere submits via the
// persistent #suggestions channel's button+modal (index.js's suggestion_open/suggestion_modal),
// and it lands here AND gets forwarded live to the developer (suggestions.js's
// forwardSuggestionToOwner). No browsing/review UI on top of this — just reliable capture.

const mongoose = require('mongoose');

const suggestionSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  guildName: { type: String, required: true },
  discordId: { type: String, required: true },
  discordTag: { type: String, required: true },
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.models.Suggestion || mongoose.model('Suggestion', suggestionSchema);
