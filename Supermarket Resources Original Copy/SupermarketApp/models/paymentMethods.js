'use strict';
const db = require('../db');

const PaymentMethods = {
  listByUser(userId, cb) {
    db.query(
      'SELECT id, user_id AS userId, brand, last4, exp_month AS expMonth, exp_year AS expYear, cardholder_name AS cardholderName, created_at AS createdAt FROM payment_methods WHERE user_id = ? ORDER BY id DESC',
      [userId],
      (err, rows) => cb(err, rows || [])
    );
  },

  add({ userId, brand, last4, expMonth, expYear, cardholderName, cardToken }, cb) {
    const sql = `
      INSERT INTO payment_methods (user_id, brand, last4, exp_month, exp_year, cardholder_name, card_token)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    db.query(sql, [userId, brand || null, last4, expMonth || null, expYear || null, cardholderName || null, cardToken || null], cb);
  },

  getForUser(id, userId, cb) {
    db.query(
      'SELECT id, user_id AS userId, brand, last4, exp_month AS expMonth, exp_year AS expYear, cardholder_name AS cardholderName, card_token AS cardToken FROM payment_methods WHERE id = ? AND user_id = ? LIMIT 1',
      [id, userId],
      (err, rows) => cb(err, rows && rows[0])
    );
  }
};

module.exports = PaymentMethods;
