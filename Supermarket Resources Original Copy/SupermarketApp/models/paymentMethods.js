'use strict';
const db = require('../db');

// always load columns fresh to reflect schema changes
function loadColumns(cb) {
  db.query('SHOW COLUMNS FROM payment_methods', (err, rows) => {
    if (err) return cb(err);
    const cols = new Set((rows || []).map((r) => r.Field));
    cb(null, cols);
  });
}

function normalizeRow(row = {}) {
  const expiryRaw = row.expiry || row.exp || row.exp_date;
  let expMonth = row.exp_month || row.expMonth || null;
  let expYear = row.exp_year || row.expYear || null;
  if ((!expMonth || !expYear) && typeof expiryRaw === 'string') {
    const parts = expiryRaw.replace(/\s+/g, '').split(/[\/-]/);
    if (parts[0]) expMonth = parts[0];
    if (parts[1]) expYear = parts[1];
  }
  return {
    id: row.id,
    userId: row.user_id || row.userId,
    brand: row.brand || row.payment_method || row.label || 'Card',
    last4: row.last4 || row.payment_last4 || null,
    expMonth,
    expYear,
    cardholderName: row.cardholder_name || row.cardholderName || row.card_name || null,
    cardToken: row.card_token || row.cardToken || null,
    label: row.label || row.brand || 'Card',
    expiry: expiryRaw || null,
    cvv: row.cvv || null,
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
      const updateSets = [];
      const updateValues = [];

      // always include user_id
      fields.push('user_id');
      values.push(data.userId);
      updateSets.push('user_id = VALUES(user_id)');

      if (cols.has('brand')) {
        fields.push('brand');
        values.push(data.brand || null);
        updateSets.push('brand = VALUES(brand)');
      } else if (cols.has('payment_method')) {
        fields.push('payment_method');
        values.push(data.brand || null);
        updateSets.push('payment_method = VALUES(payment_method)');
      }

      if (cols.has('last4')) {
        fields.push('last4');
        values.push(data.last4 || null);
        updateSets.push('last4 = VALUES(last4)');
      } else if (cols.has('payment_last4')) {
        fields.push('payment_last4');
        values.push(data.last4 || null);
        updateSets.push('payment_last4 = VALUES(payment_last4)');
      }

      if (cols.has('exp_month')) {
        fields.push('exp_month');
        values.push(data.expMonth || null);
        updateSets.push('exp_month = VALUES(exp_month)');
      }
      if (cols.has('exp_year')) {
        fields.push('exp_year');
        values.push(data.expYear || null);
        updateSets.push('exp_year = VALUES(exp_year)');
      }
      if (cols.has('cardholder_name')) {
        fields.push('cardholder_name');
        values.push(data.cardholderName || null);
        updateSets.push('cardholder_name = VALUES(cardholder_name)');
      } else if (cols.has('card_name')) {
        fields.push('card_name');
        values.push(data.cardholderName || null);
        updateSets.push('card_name = VALUES(card_name)');
      }
      if (cols.has('card_token')) {
        fields.push('card_token');
        values.push(data.cardToken || null);
        updateSets.push('card_token = VALUES(card_token)');
      }
      if (cols.has('label')) {
        fields.push('label');
        values.push(data.label || data.brand || null);
        updateSets.push('label = VALUES(label)');
      }
      if (cols.has('expiry')) {
        fields.push('expiry');
        values.push(data.expiry || null);
        updateSets.push('expiry = VALUES(expiry)');
      }
      if (cols.has('cvv')) {
        fields.push('cvv');
        values.push(data.cvv || null);
        updateSets.push('cvv = VALUES(cvv)');
      }

      const placeholders = fields.map(() => '?').join(', ');
      const sql = `INSERT INTO payment_methods (${fields.join(', ')}) VALUES (${placeholders})`;

      db.query(sql, values, (err, result) => {
        if (err && err.code === 'ER_DUP_ENTRY' && updateSets.length) {
          // fallback: update existing row for this user_id when unique constraint blocks insert
          const updateSql = `UPDATE payment_methods SET ${updateSets.join(', ')} WHERE user_id = ?`;
          const updateVals = [...values.slice(1), data.userId]; // skip user_id already at values[0]
          return db.query(updateSql, updateVals, cb);
        }
        cb(err, result);
      });
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
