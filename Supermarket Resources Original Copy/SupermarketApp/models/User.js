const db = require('../db');
const crypto = require('crypto');

function hashPassword(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

function hashSha1(pw) {
  return crypto.createHash('sha1').update(String(pw)).digest('hex');
}

module.exports = {
  hashPassword,
  
  create(user, cb) {
    const { username, email, password, address, contact, role } = user;
    const hashed = hashPassword(password);
    const sql = 'INSERT INTO users (username, email, password, address, contact, role) VALUES (?,?,?,?,?,?)';
    db.query(sql, [username, email, hashed, address || '', contact || '', role || 'user'], cb);
  },

  findByEmail(email, cb) {
    db.query('SELECT * FROM users WHERE email = ?', [email], (err, rows) => {
      if (err) return cb(err);
      cb(null, rows[0]);
    });
  },

  findById(id, cb) {
    db.query('SELECT * FROM users WHERE id = ?', [id], (err, rows) => {
      if (err) return cb(err);
      cb(null, rows[0]);
    });
  },

  findAll(cb) {
    const sql = 'SELECT id, username, email, role, contact, address FROM users ORDER BY id ASC';
    db.query(sql, (err, rows) => {
      if (err) return cb(err);
      cb(null, rows || []);
    });
  },

  upgradePassword(id, plain, cb) {
    const newHash = hashPassword(plain);
    db.query('UPDATE users SET password=? WHERE id=?', [newHash, id], (err) => cb(err, newHash));
  },

  verify(plain, user, cb) {
    if (!user) return cb(null, false);
    
    const sha256 = hashPassword(plain);
    if (user.password === sha256) return cb(null, true);
    
    // Legacy SHA1 support
    if (user.password.length === 40 && user.password === hashSha1(plain)) {
      this.upgradePassword(user.id, plain, () => cb(null, true));
      return;
    }
    
    // Legacy plain text support
    if (user.password === plain) {
      this.upgradePassword(user.id, plain, () => cb(null, true));
      return;
    }
    
    cb(null, false);
  },

  update(id, data, cb) {
    const fields = [];
    const values = [];
    if (typeof data.username === 'string') { fields.push('username=?'); values.push(data.username); }
    if (typeof data.email === 'string') { fields.push('email=?'); values.push(data.email); }
    if (data.password) { fields.push('password=?'); values.push(hashPassword(data.password)); }
    if (typeof data.address === 'string') { fields.push('address=?'); values.push(data.address); }
    if (typeof data.contact === 'string') { fields.push('contact=?'); values.push(data.contact); }
    // Intentionally skip payment_method to avoid errors on schemas without that column
    if (typeof data.role === 'string') { fields.push('role=?'); values.push(data.role); }
    if (!fields.length) return cb(null, { affectedRows: 0 });
    values.push(id);
    db.query(`UPDATE users SET ${fields.join(', ')} WHERE id=?`, values, cb);
  },

  delete(id, cb) {
    db.query('DELETE FROM users WHERE id=?', [id], cb);
  }
};
