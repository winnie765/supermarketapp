const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const multer = require('multer');
require('dotenv').config();

const app = express();

// Controllers
const SupermarketController = require('./controllers/supermarketcontroller');
const UserController = require('./controllers/Usercontroller');
const AdminController = require('./controllers/admincontroller');
const CartController = require('./controllers/cartcontroller');
const CheckoutController = require('./controllers/checkoutcontroller');

// Body parsers
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// View engine
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Session / flash
app.use(session({
  secret: process.env.SESSION_SECRET || 'devsecret',
  resave: false,
  saveUninitialized: false
}));
app.use(flash());

// Static
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Make session user and flash messages available to all views
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  // expose messages in a predictable shape used by EJS templates
  res.locals.messages = {
    error: req.flash('error') || [],
    success: req.flash('success') || []
  };
  res.locals.searchQuery = req.query.q || '';
  res.locals.searchFilter = req.query.filter || 'all';
  // normalize cart shape so every request sees an array
  if (!Array.isArray(req.session.cart)) {
    if (req.session.cart && Array.isArray(req.session.cart.items)) {
      req.session.cart = req.session.cart.items;
    } else {
      req.session.cart = [];
    }
  }
  next();
});

// Auth middleware (define BEFORE routes)
function checkAuthenticated(req, res, next) {
  if (!req.session.user) {
    req.flash('error', 'Please log in');
    return res.redirect('/login');
  }
  next();
}
function checkAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    req.flash('error', 'Admin access required');
    return res.redirect('/');
  }
  next();
}

// Prevent admin accounts from accessing shopping/cart features
function blockAdminShopping(req, res, next) {
  if (req.session.user && req.session.user.role === 'admin') {
    const blocked = [/^\/shopping$/, /^\/add-to-cart\//, /^\/cart(\/.*)?$/, /^\/checkout$/];
    if (blocked.some(r => r.test(req.path))) {
      req.flash('error', 'Admin account cannot shop. Use a customer account.');
      return res.redirect('/inventory');
    }
  }
  next();
}

// Debug (keep briefly)
console.log({
  addToCart: typeof CartController.addToCart,
  renderCart: typeof CartController.renderCart,
  renderCheckout: typeof CheckoutController.renderCheckout,
  processCheckout: typeof CheckoutController.processCheckout,
  renderShopping: typeof SupermarketController.renderShopping,
  renderInventory: typeof SupermarketController.renderInventory,
  renderAdmin: typeof AdminController.renderAdmin,
  checkAuthenticated: typeof checkAuthenticated,
  checkAdmin: typeof checkAdmin,
  registerUser: typeof UserController.registerUser,
  loginUser: typeof UserController.loginUser
});

// Fallback wrapper to avoid passing undefined/non-functions to Express
function ensureFn(fn, label) {
  if (typeof fn !== 'function') {
    console.error(`Missing handler: ${label}`);
    return (req, res) => res.status(500).send(`${label} not implemented`);
  }
  return fn;
}

// File upload configuration
const uploadDir = path.join(__dirname, 'public', 'images');
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const safeName = file.originalname.replace(/\s+/g, '-');
    cb(null, `${unique}-${safeName}`);
  }
});
const upload = multer({ storage });

// Routes (NO parentheses after handler names)
app.use(blockAdminShopping);
app.get('/', SupermarketController.renderLanding);
app.get('/home', SupermarketController.renderHomePage);
app.get('/shopping', SupermarketController.renderShopping);

app.get('/register', UserController.renderRegister);
app.post('/register', ensureFn(UserController.registerUser, 'UserController.registerUser'));

app.get('/login', UserController.renderLogin);
app.post('/login', ensureFn(UserController.loginUser, 'UserController.loginUser'));
app.get('/logout', SupermarketController.logout);


// Inventory / product admin
app.get('/inventory', checkAuthenticated, checkAdmin, SupermarketController.renderInventory);
app.get('/addProduct', checkAuthenticated, checkAdmin, SupermarketController.renderAddProductForm);
app.post('/addProduct', checkAuthenticated, checkAdmin, upload.single('image'), ensureFn(SupermarketController.createProduct, 'SupermarketController.createProduct'));
app.get('/updateProduct/:id', checkAuthenticated, checkAdmin, SupermarketController.renderUpdateProductForm);
app.post('/updateProduct/:id', checkAuthenticated, checkAdmin, upload.single('image'), ensureFn(SupermarketController.updateProduct, 'SupermarketController.updateProduct'));
app.get('/inventory/edit/:id', checkAuthenticated, checkAdmin, SupermarketController.renderUpdateProductForm); // new edit route

// Cart
app.post('/add-to-cart/:id', checkAuthenticated, ensureFn(CartController.addToCart, 'CartController.addToCart'));
app.get('/cart', checkAuthenticated, CartController.renderCart);
app.get('/cart/remove/:id', checkAuthenticated, ensureFn(CartController.removeItem, 'CartController.removeItem'));
app.get('/cart/clear', checkAuthenticated, ensureFn(CartController.clearCart, 'CartController.clearCart'));
app.get('/checkout', checkAuthenticated, ensureFn(CheckoutController.renderCheckout, 'CheckoutController.renderCheckout'));
app.post('/checkout', checkAuthenticated, ensureFn(CheckoutController.processCheckout, 'CheckoutController.processCheckout'));
app.get('/paynow', checkAuthenticated, ensureFn(CheckoutController.renderPayNow, 'CheckoutController.renderPayNow'));
app.get('/invoice', checkAuthenticated, ensureFn(CheckoutController.renderInvoice, 'CheckoutController.renderInvoice'));
app.get('/orders', checkAuthenticated, ensureFn(CheckoutController.renderOrderHistory, 'CheckoutController.renderOrderHistory'));
app.get('/orders/:invoice', checkAuthenticated, ensureFn(CheckoutController.viewOrderFromHistory, 'CheckoutController.viewOrderFromHistory'));

// Admin dashboard
app.get('/admin', checkAuthenticated, checkAdmin, AdminController.renderAdmin);
app.get('/admin/users', checkAuthenticated, checkAdmin, AdminController.renderUsers);
app.get('/admin/users/:id/delete', checkAuthenticated, checkAdmin, ensureFn(AdminController.deleteUser, 'AdminController.deleteUser')); // convenience GET
app.post('/admin/users/:id/delete', checkAuthenticated, checkAdmin, ensureFn(AdminController.deleteUser, 'AdminController.deleteUser'));

// 404
app.use((req, res) => res.status(404).send('Not Found'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server http://localhost:${PORT}`));
