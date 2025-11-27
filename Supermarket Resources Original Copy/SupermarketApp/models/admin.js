const db = require('../db');

function getStats(cb) {
  const stats = { products: 0, users: 0 };
  db.query('SELECT COUNT(*) AS cnt FROM products', (err, productRows) => {
    if (!err && productRows && productRows[0]) stats.products = productRows[0].cnt;
    db.query('SELECT COUNT(*) AS cnt FROM users', (err2, userRows) => {
      if (!err2 && userRows && userRows[0]) stats.users = userRows[0].cnt;
      cb(err || err2 || null, stats);
    });
  });
}

function getRecentProducts(limit, cb) {
  const safeLimit = Number.isFinite(Number(limit)) ? Number(limit) : 5;
  const sql = `
    SELECT id, productName AS name, price, image
    FROM products
    ORDER BY id DESC
    LIMIT ?
  `;
  db.query(sql, [safeLimit], (err, rows) => {
    if (err) return cb(err);
    cb(null, rows || []);
  });
}

module.exports = { getStats, getRecentProducts };
