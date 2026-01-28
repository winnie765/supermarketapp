'use strict';
const Wallet = require('../models/wallet');
const PayPal = require('../services/paypal');
const netsQr = require('../services/nets');

function renderWallet(req, res) {
  const userId = req.session.user && req.session.user.id;
  Wallet.getBalance(userId, (err, balance) => {
    if (err) console.error('Wallet balance fetch failed:', err);
    res.render('wallet', {
      user: req.session.user,
      balance: Number(balance) || 0,
      paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
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
  const method = String(req.body.paymentMethod || 'card');
  const cardNumber = String(req.body.cardNumber || '').replace(/\s+/g, '');
  const cardExpiry = String(req.body.cardExpiry || '').trim();
  const cardCvv = String(req.body.cardCvv || '').trim();
  const cardName = String(req.body.cardName || '').trim();

  const errors = [];
  if (!Number.isFinite(amount) || amount <= 0) errors.push('Enter a valid top-up amount.');
  if (method === 'card') {
    if (!cardName) errors.push('Cardholder name is required.');
    if (cardNumber.length < 12) errors.push('Enter a valid card number.');
    if (!cardExpiry) errors.push('Enter card expiry.');
    if (cardCvv.length < 3) errors.push('Enter a valid CVV.');
  }

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

async function createPayPalTopUpOrder(req, res) {
  try {
    const userId = req.session.user && req.session.user.id;
    if (!userId) {
      return res.status(401).json({ error: 'Please log in to top up your wallet.' });
    }
    const amountRaw = req.body && req.body.amount;
    const parsedAmount = Number.parseFloat(amountRaw);
    const amount = Number.isFinite(parsedAmount) ? Math.round(parsedAmount * 100) / 100 : NaN;
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Enter a valid top-up amount.' });
    }

    const topUpRef = `TOPUP-${Date.now().toString().slice(-8)}`;
    const order = await PayPal.createOrder(amount.toFixed(2), topUpRef);
    req.session.pendingPayPalTopUp = {
      amount,
      userId,
      orderId: order.id,
      createdAt: new Date().toISOString()
    };
    return res.json({ id: order.id });
  } catch (err) {
    console.error('PayPal wallet top-up createOrder failed:', err);
    return res.status(500).json({ error: 'Unable to start PayPal top-up.' });
  }
}

async function capturePayPalTopUp(req, res) {
  try {
    const pending = req.session.pendingPayPalTopUp;
    const orderId = req.body && req.body.orderId;
    if (!pending || !pending.amount || !pending.userId) {
      return res.status(400).json({ error: 'No pending PayPal top-up found.' });
    }
    if (!orderId) {
      return res.status(400).json({ error: 'Missing PayPal order ID.' });
    }
    const capture = await PayPal.captureOrder(orderId);
    const captureUnit = capture && capture.purchase_units && capture.purchase_units[0];
    const captureInfo = captureUnit && captureUnit.payments && captureUnit.payments.captures && captureUnit.payments.captures[0];
    const status = captureInfo && captureInfo.status ? captureInfo.status : capture.status;
    if (status && status !== 'COMPLETED') {
      return res.status(400).json({ error: `PayPal capture status: ${status}` });
    }

    return Wallet.addFunds(pending.userId, pending.amount, (err, balance) => {
      req.session.pendingPayPalTopUp = null;
      if (err) {
        console.error('Wallet top-up after PayPal capture failed:', err);
        return res.status(500).json({ error: 'Unable to top up wallet after payment.' });
      }
      return res.json({
        ok: true,
        redirectUrl: '/wallet',
        message: `Wallet topped up by $${pending.amount.toFixed(2)}. New balance: $${Number(balance).toFixed(2)}.`
      });
    });
  } catch (err) {
    console.error('PayPal wallet top-up capture failed:', err);
    return res.status(500).json({ error: 'Unable to capture PayPal payment.' });
  }
}

function startNetsTopUp(req, res) {
  const userId = req.session.user && req.session.user.id;
  if (!userId) {
    req.flash('error', 'Please log in to top up your wallet.');
    return res.redirect('/login');
  }
  const amountRaw = req.body && req.body.amount;
  const parsedAmount = Number.parseFloat(amountRaw);
  const amount = Number.isFinite(parsedAmount) ? Math.round(parsedAmount * 100) / 100 : NaN;
  if (!Number.isFinite(amount) || amount <= 0) {
    req.flash('error', 'Enter a valid top-up amount.');
    return res.redirect('/wallet');
  }

  req.session.pendingNetsTopUp = {
    amount,
    userId,
    createdAt: new Date().toISOString()
  };
  req.body.cartTotal = amount.toFixed(2);
  req.netsContext = {
    title: 'Wallet Top-Up',
    successUrl: '/wallet/nets/success',
    failUrl: '/wallet/nets/fail',
    cancelUrl: '/wallet'
  };
  return req.session.save(() => netsQr.generateQrCode(req, res));
}

function finalizeNetsTopUp(req, res) {
  const pending = req.session.pendingNetsTopUp;
  if (!pending || !pending.userId || !pending.amount) {
    req.flash('error', 'No pending NETS top-up found.');
    return res.redirect('/wallet');
  }
  return Wallet.addFunds(pending.userId, pending.amount, (err, balance) => {
    req.session.pendingNetsTopUp = null;
    if (err) {
      console.error('Wallet top-up after NETS failed:', err);
      req.flash('error', 'Unable to top up wallet after NETS payment.');
      return res.redirect('/wallet');
    }
    req.flash('success', `Wallet topped up by $${pending.amount.toFixed(2)}. New balance: $${Number(balance).toFixed(2)}.`);
    return res.redirect('/wallet');
  });
}

function failNetsTopUp(req, res) {
  req.session.pendingNetsTopUp = null;
  req.flash('error', 'NETS top-up was not completed. Please try again.');
  return res.redirect('/wallet');
}

module.exports = {
  renderWallet,
  topUpWallet,
  createPayPalTopUpOrder,
  capturePayPalTopUp,
  startNetsTopUp,
  finalizeNetsTopUp,
  failNetsTopUp
};
