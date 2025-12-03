'use strict';
const db = require('../db');

let columnCache = null;

function buildColumnCache(cb) {
  if (columnCache) return cb(null, columnCache);
  db.query('SHOW COLUMNS FROM products', (err, rows) => {
    if (err) return cb(err);
    const cols = rows.map(r => r.Field);
    const pick = (candidates) => candidates.find(c => cols.includes(c));
    const stockCol = pick(['quantity','stock','qty','amount','inventory']) || null;
    columnCache = { stockCol };
    cb(null, columnCache);
  });
}

/**
 * Decrease stock/quantity for each cart item. Fails fast if any item would drop below zero.
 * Expects cart items shaped like { id, quantity|qty, name }.
 */
function adjustStockForCart(cartItems, cb) {
  buildColumnCache((err, cache) => {
    if (err) return cb(err);
    if (!cache.stockCol) {
      return cb(null, { skipped: true, reason: 'No stock/quantity column detected on products table' });
    }

    const items = (cartItems || [])
      .map((item, idx) => {
        const qty = Number.parseInt(item.quantity ?? item.qty, 10);
        return {
          id: item.id ?? item.productId ?? item.product_id,
          quantity: Number.isFinite(qty) && qty > 0 ? qty : 0,
          name: item.name || item.productName || `Item ${idx + 1}`
        };
      })
      .filter((item) => item.id && item.quantity > 0);

    if (!items.length) return cb(null, { updated: 0, skipped: true, reason: 'No purchasable items found' });

    const updateOne = (index) => {
      if (index >= items.length) return cb(null, { updated: items.length });

      const { id, quantity, name } = items[index];
      db.query(`SELECT ${cache.stockCol} AS stock FROM products WHERE id = ?`, [id], (selectErr, rows) => {
        if (selectErr) return cb(selectErr);
        const row = rows && rows[0];
        if (!row) return cb(new Error(`Product ${id} not found`));

        const currentStock = Number(row.stock);
        if (!Number.isFinite(currentStock)) {
          return cb(new Error(`Invalid stock value for product ${id}`));
        }

        const newStock = currentStock - quantity;
        if (newStock < 0) {
          const error = new Error(`Insufficient stock for ${name || id}`);
          error.code = 'INSUFFICIENT_STOCK';
          error.productId = id;
          error.productName = name;
          error.available = currentStock;
          error.requested = quantity;
          return cb(error);
        }

        db.query(`UPDATE products SET ${cache.stockCol} = ? WHERE id = ?`, [newStock, id], (updateErr) => {
          if (updateErr) return cb(updateErr);
          updateOne(index + 1);
        });
      });
    };

    updateOne(0);
  });
}

module.exports = { adjustStockForCart };
