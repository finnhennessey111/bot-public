// models/Subscription.js - A player's subscription/billing status, scoped per guild.

const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
  discordId: { type: String, required: true },
  guildId: { type: String, required: true },
  plan: { type: String, enum: ['monthly', 'yearly', 'trial'], required: true },
  status: { type: String, enum: ['active', 'expired', 'cancelled'], default: 'active' },
  trialStartDate: Date,
  subscriptionStart: Date,
  subscriptionExpiry: Date,
  stripeCustomerId: String,
});

subscriptionSchema.index({ discordId: 1, guildId: 1 }, { unique: true });

module.exports = mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);
