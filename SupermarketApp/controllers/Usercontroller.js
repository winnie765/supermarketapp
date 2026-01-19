const User = require('../models/User');
const CartModel = require('../models/cart');
const PaymentMethods = require('../models/paymentMethods');
const UserController = {}; // forward reference for checkout helper

function renderRegister(req, res) {
  res.render('register', { 
    messages: req.flash('error'),
    success: req.flash('success'),
    formData: req.flash('formData')[0] || {} 
  });
}

function register(req, res) {
  const data = req.body || {};
  
  if (!data.username || !data.email || !data.password) {
    req.flash('error', 'All fields are required');
    req.flash('formData', data);
    return res.redirect('/register');
  }

  if (data.password.length < 6) {
    req.flash('error', 'Password must be at least 6 characters');
    req.flash('formData', data);
    return res.redirect('/register');
  }

  User.create(data, (err) => {
    if (err) {
      console.error('Register error:', err);
      req.flash('error', err.code === 'ER_DUP_ENTRY' ? 'Email already registered' : 'Registration failed');
      req.flash('formData', data);
      return res.redirect('/register');
    }
    req.flash('success', 'Registration successful! Please log in.');
    res.redirect('/login');
  });
}

function renderLogin(req, res) {
  res.render('login', { 
    errors: req.flash('error'),
    messages: req.flash('success'),
    formData: req.flash('formData')[0] || {} 
  });
}

function login(req, res) {
  const { email, password } = req.body || {};
  
  if (!email || !password) {
    req.flash('error', 'Email and password are required');
    req.flash('formData', { email });
    return res.redirect('/login');
  }

  User.findByEmail(email, (err, user) => {
    if (err || !user) {
      req.flash('error', 'Invalid email or password');
      req.flash('formData', { email });
      return res.redirect('/login');
    }

    User.verify(password, user, (verr, ok) => {
      if (verr || !ok) {
        req.flash('error', 'Invalid email or password');
        req.flash('formData', { email });
        return res.redirect('/login');
      }

      User.findByEmail(email, (_, fresh) => {
        req.session.user = fresh || user;
        if (req.session.user && req.session.user.id) {
          CartModel.getUserCart(req.session.user.id, (err, items) => {
            if (err) console.error('Load cart on login failed:', err);
            req.session.cart = Array.isArray(items) ? items : [];
            return req.session.save(() => res.redirect('/home'));
          });
        } else {
          req.session.cart = req.session.cart || [];
          res.redirect('/home');
        }
      });
    });
  });
}

function logout(req, res) {
  req.session.destroy(() => res.redirect('/login'));
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function renderProfile(req, res) {
  if (!req.session.user) return res.redirect('/login');
  const userId = req.session.user.id;
  User.findById(userId, (err, user) => {
    if (err) console.error('Profile fetch error:', err);
    const viewUser = user || req.session.user;
    PaymentMethods.listByUser(userId, (pmErr, methods) => {
      if (pmErr) console.error('Payment methods fetch error:', pmErr);
      res.render('profile', {
        user: viewUser,
        paymentMethods: Array.isArray(methods) ? methods : [],
        messages: res.locals.messages || { error: [], success: [] }
      });
    });
  });
}

function updateProfile(req, res) {
  if (!req.session.user) return res.redirect('/login');
  const userId = req.session.user.id;
  const { username, email, contact, address } = req.body || {};
  const rawPayment = (req.body && req.body.paymentMethod) ? String(req.body.paymentMethod) : '';
  const paymentDigits = rawPayment.replace(/\D/g, '').slice(-16); // keep last 16 digits only
  const paymentMethod = paymentDigits || '';

  if (!username || !email) {
    req.flash('error', 'Name and email are required.');
    return res.redirect('/profile');
  }

  User.update(userId, { username, email, contact, address }, (err) => {
    if (err) {
      console.error('Profile update error:', err);
      req.flash('error', 'Could not update profile.');
      return res.redirect('/profile');
    }
    const persistPayment = (next) => {
      if (!paymentMethod) return next();
      const last4 = paymentMethod.slice(-4);
      const brand = paymentMethod.startsWith('3') ? 'AMEX'
        : paymentMethod.startsWith('5') ? 'MasterCard'
        : paymentMethod.startsWith('4') ? 'VISA'
        : 'Card';
      const rawExpiry = (req.body && req.body.cardExpiry) ? String(req.body.cardExpiry) : '';
      const expDigits = rawExpiry.replace(/\D/g, '');
      const expMonth = expDigits.slice(0, 2) || null;
      const expYear = expDigits.slice(2, 4) || null;
      const cardholderName = (req.body && req.body.cardName) ? String(req.body.cardName) : null;
      PaymentMethods.add({ userId, brand, last4, expMonth, expYear, cardholderName, cardToken: paymentMethod }, (pmErr) => {
        if (pmErr) console.error('Payment method save error:', pmErr);
        next();
      });
    };

    persistPayment(() => {
      User.findById(userId, (freshErr, freshUser) => {
        if (freshErr) console.error('Profile reload error:', freshErr);
        const updatedSessionUser = freshUser || { ...req.session.user, username, email, contact, address };
        req.session.user = updatedSessionUser;
        req.flash('success', 'Changes saved.');
        req.session.save(() => res.redirect('/profile'));
      });
    });
  });
}

UserController.renderRegister = renderRegister;
UserController.registerUser = register;
UserController.renderLogin = renderLogin;
UserController.loginUser = login;
UserController.logout = logout;
UserController.requireAuth = requireAuth;
UserController.renderProfile = renderProfile;
UserController.updateProfile = updateProfile;
UserController.renderCheckoutWithProfile = function renderCheckoutWithProfile(req, res, locals) {
  const user = req.session.user || {};
  const prefill = {
    fullName: user.username || '',
    email: user.email || '',
    address: user.address || '',
    paymentMethod: user.payment_method || user.paymentMethod || ''
  };
  const paypalClientId = (locals && locals.paypalClientId) ? locals.paypalClientId : '';
  res.render('checkout', {
    prefill,
    paypalClientId,
    ...locals
  });
};

module.exports = UserController;
