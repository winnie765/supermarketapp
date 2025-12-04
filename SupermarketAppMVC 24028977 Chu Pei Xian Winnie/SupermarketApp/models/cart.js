'use strict';
const db = require('../db');

function mapRowToItem(row) {
  return {
    id: String(row.productId),
    name: row.name || row.productName || `Product ${row.productId}`,
    price: Number(row.price) || 0,
    image: row.image || null,
    qty: Number(row.quantity) || 0
  };
}

module.exports = {
  getUserCart(userId, cb) {
    const sql = `
      SELECT c.userId, c.productId, c.quantity, p.productName AS name, p.price, p.image
      FROM carts c
      JOIN products p ON p.id = c.productId
      WHERE c.userId = ?
      ORDER BY c.id ASC
    `;
    db.query(sql, [userId], (err, rows) => {
      if (err) return cb(err);
      const items = Array.isArray(rows) ? rows.map(mapRowToItem) : [];
      cb(null, items);
    });
  },

  upsertItem(userId, productId, quantity, cb) {
    const qty = Number.isFinite(Number(quantity)) && Number(quantity) > 0 ? Number(quantity) : 1;
    const sql = `
      INSERT INTO carts (userId, productId, quantity)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)
    `;
    db.query(sql, [userId, productId, qty], cb);
  },

  updateQuantity(userId, productId, quantity, cb) {
    const qty = Number.isFinite(Number(quantity)) ? Number(quantity) : 0;
    if (qty <= 0) {
      return this.removeItem(userId, productId, cb);
    }
    const sql = `
      INSERT INTO carts (userId, productId, quantity)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)
    `;
    db.query(sql, [userId, productId, qty], cb);
  },

  removeItem(userId, productId, cb) {
    db.query('DELETE FROM carts WHERE userId = ? AND productId = ?', [userId, productId], cb);
  },

  clearUserCart(userId, cb) {
    db.query('DELETE FROM carts WHERE userId = ?', [userId], cb);
  }
};
