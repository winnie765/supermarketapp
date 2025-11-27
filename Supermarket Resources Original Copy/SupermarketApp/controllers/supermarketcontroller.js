'use strict';

const crypto = require('crypto');
const Supermarket = require('../models/Supermarket');

// ----- VIEW/SESSION CONTROLLERS -----

// Inventory page (admin)
function renderInventory(req, res) {
  const q = (req.query.q || '').trim();
  const cb = (err, products) => {
    if (err) {
      console.error('Inventory error:', err);
      return res.render('inventory', { 
        user: req.session.user, 
        products: [], 
        q,
        messages: req.flash() 
      });
    }
    res.render('inventory', { 
      user: req.session.user, 
      products: products || [], 
      q,
      messages: req.flash() 
    });
  };
  
  if (q) {
    Supermarket.searchProductsByName(q, cb);
  } else {
    Supermarket.getAllProducts(cb);
  }
}

// Register page + submit
function renderRegister(req, res) {
  const errors = req.flash('error');
  const success = req.flash('success');
  const formData = req.flash('formData')[0] || {};
  const messages = [...errors, ...success];

  res.render('register', {
    user: req.session.user || null,
    messages,
    formData
  });
}

function registerUser(req, res) {
  const userData = req.body || {};
  if (!userData.password) {
    req.flash('error', 'Password required');
    req.flash('formData', req.body);
    return res.redirect('/register');
  }
  // Hash before saving
  userData.password = hashPassword(userData.password);
  Supermarket.addUser(userData, (err) => {
    if (err) {
      req.flash('error', 'Failed to register user');
      req.flash('formData', req.body);
      return res.redirect('/register');
    }
    req.flash('success', 'Registration successful. Please log in.');
    res.redirect('/login');
  });
}

// Login page + submit
function renderLogin(req, res) {
  const errors = req.flash('error');
  const messages = req.flash('success');
  const formData = req.flash('formData')[0] || {};
  res.render('login', {
    user: req.session.user || null,
    errors,
    messages,
    formData
  });
}

function loginUser(req, res) {
  const { email, password } = req.body;
  Supermarket.authenticate(email, password, (err, user) => {
    if (err || !user) {
      req.flash('error', 'Invalid email or password');
      return res.redirect('/login');
    }
    req.session.user = user;
    return res.redirect('/home');
  });
}

function logout(req, res) {
  req.session.destroy(() => res.redirect('/login'));
}

// Shopping page (category filter)
const DEFAULT_CATEGORIES = ['dairy','fruits','vegetables','bakery','beverages','snacks','meat','seafood','frozen','pantry'];

function normalizeFilter(filter) {
  return (filter || 'all').toString().trim().toLowerCase().replace(/\s+/g, '');
}

function getProductCategory(product) {
  const raw =
    product.category ??
    product.Category ??
    product.type ??
    product.productCategory ??
    product.categoryName ??
    product.CategoryName;
  if (raw === undefined || raw === null) return 'uncategorized';
  const str = String(raw).trim();
  return str || 'uncategorized';
}

function buildCategoryList(products) {
  const categories = new Set(['all', ...DEFAULT_CATEGORIES]);
  (products || []).forEach((p) => {
    const category = getProductCategory(p).toLowerCase();
    if (category && category !== 'uncategorized') {
      categories.add(category);
    }
  });
  return Array.from(categories);
}

function applyCategoryFilter(products, filter) {
  const normalized = normalizeFilter(filter);
  if (!products || normalized === 'all') return products || [];
  const hasCategorized = (products || []).some((p) => {
    const cat = getProductCategory(p).toLowerCase();
    return cat && cat !== 'uncategorized';
  });
  return (products || []).filter((product) => {
    const category = getProductCategory(product).toLowerCase();
    if (category === normalized) return true;
    // Fallbacks:
    // 1) if category is missing/uncategorized, allow name match
    // 2) if none of the products are categorized at all, treat filter as name substring
    const name = (product.name || product.productName || '').toString().toLowerCase();
    if (category === 'uncategorized' && name.includes(normalized)) return true;
    if (!hasCategorized && name.includes(normalized)) return true;
    return false;
  });
}

function renderShopping(req, res) {
  const q = (req.query.q || '').trim();
  const filter = normalizeFilter(req.query.filter);
  const finish = (err, products) => {
    if (err) {
      console.error('Shopping error:', err);
      return res.render('shopping', {
        user: req.session.user,
        products: [],
        q,
        filter,
        categories: DEFAULT_CATEGORIES,
        messages: req.flash()
      });
    }
    const categories = buildCategoryList(products);
    const filteredProducts = applyCategoryFilter(products, filter);
    res.render('shopping', {
      user: req.session.user,
      products: filteredProducts,
      q,
      filter,
      categories,
      messages: req.flash()
    });
  };
  if (q) Supermarket.searchProductsByName(q, finish);
  else Supermarket.getAllProducts(finish);
}

function renderProductDetails(req, res) {
  Supermarket.getProductById(req.params.id, (err, product) => {
    if (err || !product) {
      req.flash('error', 'Product not found');
      return res.redirect('/shopping');
    }
    res.render('product', { user: req.session.user, product, messages: req.flash() });
  });
}

// Add/Update Forms
function renderAddProductForm(req, res) {
  res.render('addProduct', {
    user: req.user || null,
    messages: req.flash(),
    product: {} // keeps addProduct.ejs happy
  });
}

function renderUpdateProductForm(req, res) {
  const { id } = req.params;
  Supermarket.getProductById(id, (err, product) => {
    if (err || !product) {
      req.flash('error', 'Product not found');
      return res.redirect('/inventory');
    }
    res.render('updateProduct', { 
      user: req.session.user, 
      product, 
      messages: req.flash() 
    });
  });
}

// Create/Update/Delete product (form posts)
// Uses same model methods but handles file upload + redirects

function parseQuantity(raw) {
  const qty = Number.parseInt(raw, 10);
  return Number.isFinite(qty) && qty >= 0 ? qty : null;
}

function createProduct(req, res) {
  const productData = { ...req.body };
  const quantity = parseQuantity(req.body.quantity ?? req.body.stock ?? req.body.qty);
  if (quantity === null) {
    req.flash('error', 'Quantity must be zero or greater');
    return res.redirect('/addProduct');
  }
  productData.quantity = quantity;
  productData.stock = quantity; // normalize for model/db
  if (productData.price !== undefined) {
    productData.price = Number(productData.price);
  }
  if (req.file && req.file.filename) {
    productData.image = req.file.filename;
  } else {
    // DB requires an image; fall back to an existing asset if none uploaded
    productData.image = productData.image || 'ShoppingCart.png';
  }
  Supermarket.addProduct(productData, (err) => {
    if (err) { req.flash('error','Failed to add'); return res.redirect('/addProduct'); }
    req.flash('success','Product added'); res.redirect('/inventory');
  });
}
function updateProduct(req, res) {
  const { id } = req.params;
  const productData = { ...req.body };
  const quantity = parseQuantity(req.body.quantity ?? req.body.stock ?? req.body.qty);
  if (quantity === null) {
    req.flash('error', 'Quantity must be zero or greater');
    return res.redirect(`/updateProduct/${id}`);
  }
  productData.quantity = quantity;
  productData.stock = quantity; // normalize for model/db
  if (productData.price !== undefined) {
    productData.price = Number(productData.price);
  }
  if (req.file) productData.image = req.file.filename;
  Supermarket.updateProduct(id, productData, (err, r) => {
    if (err || !r || r.affectedRows===0) { req.flash('error','Failed'); return res.redirect(`/updateProduct/${id}`); }
    req.flash('success','Updated'); res.redirect('/inventory');
  });
}

function deleteProduct(req, res) {
  const { id } = req.params;
  Supermarket.deleteProduct(id, (err, result) => {
    if (err || !result || result.affectedRows === 0) {
      req.flash('error', 'Failed to delete product');
      return res.redirect('/inventory');
    }
    req.flash('success', 'Product deleted successfully');
    res.redirect('/inventory');
  });
}

// ----- JSON API CONTROLLERS (existing) -----

function listProducts(req, res) {
  Supermarket.getAllProducts((err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch products', details: err });
    res.json(rows || []);
  });
}

function getProductById(req, res) {
  const { id } = req.params;
  Supermarket.getProductById(id, (err, row) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch product', details: err });
    if (!row) return res.status(404).json({ error: 'Product not found' });
    res.json(row);
  });
}

// Keep an API add for completeness (not used by form POST)
function addProduct(req, res) {
  const productData = req.body || {};
  Supermarket.addProduct(productData, (err, saved) => {
    if (err) return res.status(500).json({ error: 'Failed to add product', details: err });
    res.status(201).json(saved);
  });
}

// User JSON endpoints
function listUsers(req, res) {
  Supermarket.getAllUsers((err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch users', details: err });
    res.json(rows || []);
  });
}

function getUserById(req, res) {
  const { id } = req.params;
  Supermarket.getUserById(id, (err, row) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch user', details: err });
    if (!row) return res.status(404).json({ error: 'User not found' });
    res.json(row);
  });
}

function getUserByEmail(req, res) {
  const { email } = req.params;
  Supermarket.getUserByEmail(email, (err, row) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch user by email', details: err });
    if (!row) return res.status(404).json({ error: 'User not found' });
    res.json(row);
  });
}

function addUser(req, res) {
  const userData = req.body || {};
  Supermarket.addUser(userData, (err, saved) => {
    if (err) return res.status(500).json({ error: 'Failed to add user', details: err });
    res.status(201).json(saved);
  });
}

function updateUser(req, res) {
  const { id } = req.params;
  const userData = req.body || {};
  Supermarket.updateUser(id, userData, (err, result) => {
    if (err) return res.status(500).json({ error: 'Failed to update user', details: err });
    if (!result || result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
    Supermarket.getUserById(id, (e, row) => {
      if (e) return res.status(500).json({ error: 'Updated but failed to fetch user', details: e });
      res.json(row || { id, ...userData });
    });
  });
}

function deleteUserApi(req, res) {
  const { id } = req.params;
  Supermarket.deleteUser(id, (err, result) => {
    if (err) return res.status(500).json({ error: 'Failed to delete user', details: err });
    if (!result || result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
    res.status(204).end();
  });
}

function hashPassword(plain) {
  return crypto.createHash('sha256').update(String(plain)).digest('hex');
}

// Example register handler (adjust to match your variable names):
async function register(req, res) {
  try {
    const { username, password, email } = req.body;
    if (!username || !password) {
      return res.status(400).send('Missing fields');
    }
    const hashed = hashPassword(password);
    // Replace with your model save logic:
    await User.create({ username, email, password: hashed });
    res.redirect('/login');
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
}

// If you have a login comparison:
async function login(req, res) {
  const { username, password } = req.body;
  const hashed = hashPassword(password);
  const user = await User.findOne({ username, password: hashed });
  if (!user) return res.status(401).send('Invalid');
  // proceed with session
  res.redirect('/');
}

function addToCart(req, res) {
  const id = req.params.id;
  Supermarket.getProductById(id, (err, product) => {
    if (err || !product) {
      req.flash('error', 'Product not found');
      return res.redirect('/shopping');
    }
    if (!req.session.cart) req.session.cart = [];
    const existing = req.session.cart.find(i => i.id === product.id);
    if (existing) existing.qty += 1;
    else req.session.cart.push({
      id: product.id,
      name: product.name,
      price: product.price,
      image: product.image,
      qty: 1
    });
    req.flash('success', 'Added to cart');
    res.redirect('/cart');
  });
}

function renderLanding(req, res) {
  res.render('landing', {
    user: req.session.user || null,
    messages: req.flash()
  });
}

function renderHomePage(req, res) {
  // Keep admins on their own dashboard; customers see the home hero
  if (req.session.user && req.session.user.role === 'admin') {
    return res.redirect('/admin');
  }
  res.render('index', {
    user: req.session.user || null,
    messages: req.flash()
  });
}

module.exports = {
  // Views/session
  renderInventory,
  renderRegister,
  registerUser,
  renderLogin,
  loginUser,
  logout,
  renderShopping,
  renderProductDetails,
  addToCart,
  renderAddProductForm,
  renderUpdateProductForm,
  createProduct,
  updateProduct,
  deleteProduct,

  // JSON API
  listProducts,
  getProductById,
  addProduct,
  listUsers,
  getUserById,
  getUserByEmail,
  addUser,
  updateUser,
  deleteUser: deleteUserApi,

  // Landing and Home
  renderLanding,
  renderHomePage
};
