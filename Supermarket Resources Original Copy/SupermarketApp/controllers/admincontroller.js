'use strict';

const Admin = require('../models/admin');
const User = require('../models/User');
const Supermarket = require('../models/Supermarket');
const CheckoutController = require('./checkoutcontroller');

function renderAdmin(req, res) {
  Admin.getStats((err, stats) => {
    if (err) {
      console.error('Admin stats error:', err);
      req.flash('error', 'Failed to load stats');
      stats = { products: 0, users: 0 };
    }
    // Compute stock totals
    Supermarket.getAllProducts((prodErr, products) => {
      if (prodErr) console.error('Admin products error:', prodErr);
      const totalStock = Array.isArray(products)
        ? products.reduce((sum, p) => {
            const stockNum = Number(p.stock ?? p.quantity);
            return Number.isFinite(stockNum) ? sum + stockNum : sum;
          }, 0)
        : 0;
      const lowStock = Array.isArray(products)
        ? products.filter(p => {
            const stockNum = Number(p.stock ?? p.quantity);
            return Number.isFinite(stockNum) && stockNum > 0 && stockNum <= 5;
          }).length
        : 0;

      Admin.getRecentProducts(6, (e2, recent) => {
        if (e2) {
          console.error('Admin recent products error:', e2);
          recent = [];
        }
        const recentOrders = typeof CheckoutController.getRecentOrders === 'function'
          ? CheckoutController.getRecentOrders(6)
          : [];
        const salesOverview = (() => {
          const orders = Array.isArray(recentOrders) ? recentOrders : [];
          const totalOrders = orders.length;
          const revenue = orders.reduce((sum, order) => sum + (Number(order.total) || 0), 0);
          const avgOrder = totalOrders ? revenue / totalOrders : 0;
          const lastOrder = orders[0];
          const lastOrderAt = lastOrder && (lastOrder.placedAt || lastOrder.createdAt);
          return {
            totalOrders,
            revenue,
            avgOrder,
            lastOrderAt
          };
        })();
        const dashboardStats = {
          products: stats.products,
          users: stats.users,
          totalStock,
          lowStock,
          totalSales: salesOverview ? salesOverview.revenue : 0,
          totalOrders: salesOverview ? salesOverview.totalOrders : 0,
          deliveredCompleted: salesOverview ? salesOverview.totalOrders : 0
        };

        res.render('admin', {
          user: req.session.user,
          messages: req.flash(),
          stats,
          recent,
          recentOrders,
          salesOverview,
          dashboardStats
        });
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

function renderEditUser(req, res) {
  const { id } = req.params;
  User.findById(id, (err, user) => {
    if (err || !user) {
      req.flash('error', 'User not found');
      return res.redirect('/admin/users');
    }
    res.render('adminEditUser', {
      user: req.session.user,
      editUser: user,
      messages: req.flash()
    });
  });
}

function updateUser(req, res) {
  const { id } = req.params;
  const payload = {
    username: req.body.username,
    email: req.body.email,
    contact: req.body.contact,
    address: req.body.address,
    role: req.body.role
  };
  User.update(id, payload, (err) => {
    if (err) {
      console.error('Admin update user error:', err);
      req.flash('error', 'Failed to update user.');
      return res.redirect(`/admin/users/${id}/edit`);
    }
    req.flash('success', 'User updated.');
    res.redirect('/admin/users');
  });
}

module.exports = { renderAdmin, renderUsers, deleteUser, renderEditUser, updateUser };
