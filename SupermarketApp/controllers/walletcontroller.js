'use strict';
const Wallet = require('../models/wallet');

function renderWallet(req, res) {
  const userId = req.session.user && req.session.user.id;
  Wallet.getBalance(userId, (err, balance) => {
    if (err) console.error('Wallet balance fetch failed:', err);
    res.render('wallet', {
      user: req.session.user,
      balance: Number(balance) || 0,
      messages: res.locals.messages || { error: [], success: [] }
    });
  });
}

function topUpWallet(req, res) {
  const userId = req.session.user && req.session.user.id;
  if (!userId) {
    req.flash('error', 'Please log in to top up your wallet.');
    return res.redirect('/login');
  }

  const amountRaw = req.body && req.body.amount;
  const parsedAmount = Number.parseFloat(amountRaw);
  const amount = Number.isFinite(parsedAmount) ? Math.round(parsedAmount * 100) / 100 : NaN;
  const cardNumber = String(req.body.cardNumber || '').replace(/\s+/g, '');
  const cardExpiry = String(req.body.cardExpiry || '').trim();
  const cardCvv = String(req.body.cardCvv || '').trim();
  const cardName = String(req.body.cardName || '').trim();

  const errors = [];
  if (!Number.isFinite(amount) || amount <= 0) errors.push('Enter a valid top-up amount.');
  if (!cardName) errors.push('Cardholder name is required.');
  if (cardNumber.length < 12) errors.push('Enter a valid card number.');
  if (!cardExpiry) errors.push('Enter card expiry.');
  if (cardCvv.length < 3) errors.push('Enter a valid CVV.');

  if (errors.length) {
    errors.forEach(msg => req.flash('error', msg));
    return res.redirect('/wallet');
  }

  return Wallet.addFunds(userId, amount, (err, balance) => {
    if (err) {
      console.error('Wallet top-up failed:', err);
      req.flash('error', 'Unable to top up your wallet right now. Please try again.');
      return res.redirect('/wallet');
    }
    req.flash('success', `Wallet topped up by $${amount.toFixed(2)}. New balance: $${Number(balance).toFixed(2)}.`);
    return res.redirect('/wallet');
  });
}

module.exports = {
  renderWallet,
  topUpWallet
};
