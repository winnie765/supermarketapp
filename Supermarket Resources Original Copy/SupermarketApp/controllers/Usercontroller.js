const User = require('../models/User');

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
        req.session.cart = req.session.cart || [];
        res.redirect('/home');
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

module.exports = {
  renderRegister,
  registerUser: register,
  renderLogin,
  loginUser: login,
  logout,
  requireAuth
};
