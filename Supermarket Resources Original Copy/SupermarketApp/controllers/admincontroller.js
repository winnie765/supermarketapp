'use strict';

const Admin = require('../models/admin');
const User = require('../models/User');

function renderAdmin(req, res) {
  Admin.getStats((err, stats) => {
    if (err) {
      console.error('Admin stats error:', err);
      req.flash('error', 'Failed to load stats');
      stats = { products: 0, users: 0 };
    }
    Admin.getRecentProducts(6, (e2, recent) => {
      if (e2) {
        console.error('Admin recent products error:', e2);
        recent = [];
      }
      res.render('admin', {
        user: req.session.user,
        messages: req.flash(),
        stats,
        recent
      });
    });
  });
}

function renderUsers(req, res) {
  User.findAll((err, users) => {
    if (err) {
      console.error('Admin users error:', err);
      req.flash('error', 'Failed to load users');
      return res.render('users', {
        user: req.session.user,
        messages: req.flash(),
        users: []
      });
    }
    res.render('users', {
      user: req.session.user,
      messages: req.flash(),
      users: users || []
    });
  });
}

function deleteUser(req, res) {
  const { id } = req.params;
  // Avoid allowing an admin to delete themselves
  if (req.session.user && String(req.session.user.id) === String(id)) {
    req.flash('error', 'You cannot delete your own account while logged in.');
    return res.redirect('/admin/users');
  }
  User.delete(id, (err, result) => {
    if (err || !result || result.affectedRows === 0) {
      req.flash('error', 'Failed to delete user');
      return res.redirect('/admin/users');
    }
    req.flash('success', 'User deleted');
    res.redirect('/admin/users');
  });
}

module.exports = { renderAdmin, renderUsers, deleteUser };
