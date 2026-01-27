'use strict';
const db = require('../db');

let walletTableReady = false;
let walletTableError = null;

function ensureWalletTable(cb) {
  if (walletTableReady) return cb(null);
  if (walletTableError) return cb(walletTableError);
  const sql = `
    CREATE TABLE IF NOT EXISTS wallets (
      user_id INT NOT NULL PRIMARY KEY,
      balance DECIMAL(10, 2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_wallet_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `;
  db.query(sql, (err) => {
    if (err) {
      walletTableError = err;
      return cb(err);
    }
    walletTableReady = true;
    cb(null);
  });
}

function normalizeBalance(val) {
  const num = Number(val);
  return Number.isFinite(num) ? num : 0;
}

const Wallet = {
  getBalance(userId, cb) {
    if (!userId) return cb(null, 0);
    ensureWalletTable((err) => {
      if (err) return cb(err);
      db.query('SELECT balance FROM wallets WHERE user_id = ? LIMIT 1', [userId], (qErr, rows) => {
        if (qErr) return cb(qErr);
        const balance = rows && rows[0] ? normalizeBalance(rows[0].balance) : 0;
        cb(null, balance);
      });
    });
  },

  addFunds(userId, amount, cb) {
    if (!userId) return cb(new Error('Missing user'));
    const topup = normalizeBalance(amount);
    if (!Number.isFinite(topup) || topup <= 0) return cb(new Error('Invalid amount'));
    ensureWalletTable((err) => {
      if (err) return cb(err);
      const sql = `
        INSERT INTO wallets (user_id, balance)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)
      `;
      db.query(sql, [userId, topup], (qErr) => {
        if (qErr) return cb(qErr);
        Wallet.getBalance(userId, cb);
      });
    });
  },

  charge(userId, amount, cb) {
    if (!userId) return cb(new Error('Missing user'));
    const chargeAmount = normalizeBalance(amount);
    if (!Number.isFinite(chargeAmount) || chargeAmount <= 0) {
      return cb(new Error('Invalid amount'));
    }
    ensureWalletTable((err) => {
      if (err) return cb(err);
      db.query(
        'INSERT IGNORE INTO wallets (user_id, balance) VALUES (?, 0)',
        [userId],
        (seedErr) => {
          if (seedErr) return cb(seedErr);
          db.query(
            'UPDATE wallets SET balance = balance - ? WHERE user_id = ? AND balance >= ?',
            [chargeAmount, userId, chargeAmount],
            (qErr, result) => {
              if (qErr) return cb(qErr);
              if (!result || result.affectedRows === 0) {
                return cb(null, { ok: false });
              }
              Wallet.getBalance(userId, (balErr, balance) => {
                if (balErr) return cb(balErr);
                cb(null, { ok: true, balance });
              });
            }
          );
        }
      );
    });
  }
};

module.exports = Wallet;
