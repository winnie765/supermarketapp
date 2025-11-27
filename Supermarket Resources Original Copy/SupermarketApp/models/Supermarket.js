'use strict';
const db = require('../db');

let columnCache = null; // { nameCol, priceCol, descCol, imageCol, stockCol, categoryCol, selectAll, selectById }

function buildColumnCache(cb) {
  if (columnCache) return cb(null, columnCache);
  db.query('SHOW COLUMNS FROM products', (err, rows) => {
    if (err) return cb(err);
    const cols = rows.map(r => r.Field);
    const pick = (candidates) => candidates.find(c => cols.includes(c));
    const nameCol = pick(['productName','name']) || null;
    const priceCol = pick(['price','productPrice','cost']) || null;
    const descCol  = pick(['description','details','info','productDescription']) || null;
    const imageCol = pick(['image','Product','products','productImage','photo']) || null;
    const stockCol = pick(['quantity','stock','qty','amount','inventory']) || null;
    const categoryCol = pick(['category','productCategory','type','categoryName']) || null;

    // Build SELECT parts only for existing columns, else NULL AS alias
    const selName = nameCol ? `${nameCol} AS name` : `NULL AS name`;
    const selPrice = priceCol ? `${priceCol} AS price` : `NULL AS price`;
    const selDesc = descCol ? `${descCol} AS description` : `NULL AS description`;
    const selImage = imageCol ? `${imageCol} AS image` : `NULL AS image`;
    const selStock = stockCol ? `${stockCol} AS stock` : `NULL AS stock`;
    const selCategory = categoryCol ? `${categoryCol} AS category` : `NULL AS category`;

    const baseSelect = `SELECT id, ${selName}, ${selPrice}, ${selDesc}, ${selImage}, ${selStock}, ${selCategory} FROM products`;
    const selectAll = `${baseSelect} ORDER BY id DESC`;
    const selectById = `${baseSelect} WHERE id = ?`;

    columnCache = { nameCol, priceCol, descCol, imageCol, stockCol, categoryCol, selectAll, selectById };
    cb(null, columnCache);
  });
}

module.exports = {
  getAllProducts(cb) {
    buildColumnCache((err, cache) => {
      if (err) return cb(err);
      db.query(cache.selectAll, (e, rows) => cb(e, rows));
    });
  },

  getProductById(id, cb) {
    buildColumnCache((err, cache) => {
      if (err) return cb(err);
      db.query(cache.selectById, [id], (e, rows) => cb(e, rows && rows[0]));
    });
  },

  // Safe add only if columns exist
  addProduct(data, cb) {
    buildColumnCache((err, cache) => {
      if (err) return cb(err);
      const fields = [];
      const values = [];
      if (cache.nameCol && data.name) { fields.push(cache.nameCol); values.push(data.name); }
      if (cache.priceCol && data.price !== undefined) { fields.push(cache.priceCol); values.push(data.price); }
      if (cache.descCol && data.description !== undefined) { fields.push(cache.descCol); values.push(data.description); }
      if (cache.imageCol && data.image) { fields.push(cache.imageCol); values.push(data.image); }
      if (cache.stockCol && data.stock !== undefined) { fields.push(cache.stockCol); values.push(data.stock); }
      if (cache.categoryCol && data.category !== undefined) { fields.push(cache.categoryCol); values.push(data.category); }
      if (!fields.length) return cb(new Error('No writable product columns matched.'));
      const placeholders = fields.map(() => '?').join(',');
      const sql = `INSERT INTO products (${fields.join(',')}) VALUES (${placeholders})`;
      db.query(sql, values, cb);
    });
  },

  updateProduct(id, data, cb) {
    buildColumnCache((err, cache) => {
      if (err) return cb(err);
      const sets = [];
      const values = [];
      if (cache.nameCol && data.name) { sets.push(`${cache.nameCol}=?`); values.push(data.name); }
      if (cache.priceCol && data.price !== undefined) { sets.push(`${cache.priceCol}=?`); values.push(data.price); }
      if (cache.descCol && data.description !== undefined) { sets.push(`${cache.descCol}=?`); values.push(data.description); }
      if (cache.imageCol && data.image) { sets.push(`${cache.imageCol}=?`); values.push(data.image); }
      if (cache.stockCol && data.stock !== undefined) { sets.push(`${cache.stockCol}=?`); values.push(data.stock); }
      if (cache.categoryCol && data.category !== undefined) { sets.push(`${cache.categoryCol}=?`); values.push(data.category); }
      if (!sets.length) return cb(null, { affectedRows: 0 });
      values.push(id);
      const sql = `UPDATE products SET ${sets.join(', ')} WHERE id=?`;
      db.query(sql, values, cb);
    });
  },

  deleteProduct(id, cb) {
    db.query('DELETE FROM products WHERE id=?', [id], cb);
  },

  /**
   * Decrease stock/quantity for each cart item. Fails fast if any item would drop below zero.
   * Expects cart items shaped like { id, quantity|qty, name }.
   */
  adjustStockForCart(cartItems, cb) {
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
  },

  searchProductsByName(term, cb) {
    buildColumnCache((err, cache) => {
      if (err) return cb(err);
      if (!cache.nameCol) return cb(null, []); // cannot search without a name column
      const like = `%${term}%`;
      const sql = cache.selectAll.replace('ORDER BY id DESC', `WHERE ${cache.nameCol} LIKE ? ORDER BY id DESC`);
      db.query(sql, [like], (e, rows) => cb(e, rows));
    });
  }
};
