'use strict';
const db = require('../db');

// cache detected columns so we only introspect once
let cachedColumns = null;
function loadColumns(cb) {
  if (cachedColumns) return cb(null, cachedColumns);
  db.query('SHOW COLUMNS FROM payment_methods', (err, rows) => {
    if (err) return cb(err);
    cachedColumns = new Set((rows || []).map((r) => r.Field));
    cb(null, cachedColumns);
  });
}

function normalizeRow(row = {}) {
  return {
    id: row.id,
    userId: row.user_id || row.userId,
    brand: row.brand || row.payment_method || null,
    last4: row.last4 || row.payment_last4 || null,
    expMonth: row.exp_month || row.expMonth || null,
    expYear: row.exp_year || row.expYear || null,
    cardholderName: row.cardholder_name || row.cardholderName || null,
    cardToken: row.card_token || row.cardToken || null,
    createdAt: row.created_at || row.createdAt || null
  };
}

const PaymentMethods = {
  listByUser(userId, cb) {
    db.query(
      'SELECT * FROM payment_methods WHERE user_id = ? ORDER BY id DESC',
      [userId],
      (err, rows) => cb(err, (rows || []).map(normalizeRow))
    );
  },

  add(data, cb) {
    loadColumns((colErr, cols) => {
      if (colErr) return cb(colErr);
      const fields = [];
      const values = [];

      // always include user_id
      fields.push('user_id');
      values.push(data.userId);

      if (cols.has('brand')) {
        fields.push('brand');
        values.push(data.brand || null);
      } else if (cols.has('payment_method')) {
        fields.push('payment_method');
        values.push(data.brand || null);
      }

      if (cols.has('last4')) {
        fields.push('last4');
        values.push(data.last4 || null);
      } else if (cols.has('payment_last4')) {
        fields.push('payment_last4');
        values.push(data.last4 || null);
      }

      if (cols.has('exp_month')) {
        fields.push('exp_month');
        values.push(data.expMonth || null);
      }
      if (cols.has('exp_year')) {
        fields.push('exp_year');
        values.push(data.expYear || null);
      }
      if (cols.has('cardholder_name')) {
        fields.push('cardholder_name');
        values.push(data.cardholderName || null);
      }
      if (cols.has('card_token')) {
        fields.push('card_token');
        values.push(data.cardToken || null);
      }

      const placeholders = fields.map(() => '?').join(', ');
      const sql = `INSERT INTO payment_methods (${fields.join(', ')}) VALUES (${placeholders})`;
      db.query(sql, values, cb);
    });
  },

  getForUser(id, userId, cb) {
    db.query(
      'SELECT * FROM payment_methods WHERE id = ? AND user_id = ? LIMIT 1',
      [id, userId],
      (err, rows) => cb(err, rows && rows[0] ? normalizeRow(rows[0]) : null)
    );
  }
};

module.exports = PaymentMethods;
