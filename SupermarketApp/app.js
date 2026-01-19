const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const multer = require('multer');
const MySQLStore = require('express-mysql-session')(session);
const crypto = require('crypto');
const util = require('util');
const axios = require('axios');
require('dotenv').config();

// Silence deprecated util.isArray by redirecting to Array.isArray (Node >= 16)
if (typeof util.isArray === 'function') {
  util.isArray = Array.isArray;
}

const app = express();

// Controllers
const SupermarketController = require('./controllers/supermarketcontroller');
const UserController = require('./controllers/Usercontroller');
const AdminController = require('./controllers/admincontroller');
const CartController = require('./controllers/cartcontroller');
const CheckoutController = require('./controllers/checkoutcontroller');
const netsQr = require('./services/nets');

// Body parsers
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// View engine
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Session / flash
const sessionStore = new MySQLStore({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'c372_supermarketdb',
  clearExpired: true,
  checkExpirationInterval: 15 * 60 * 1000, // 15 minutes
  expiration: 24 * 60 * 60 * 1000 // 1 day
});
// Clear any persisted sessions on server start so users must log in after a restart
sessionStore.clear((err) => {
  if (err) console.error('Failed to clear session store on startup:', err);
});

app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  store: sessionStore
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
app.get('/', SupermarketController.renderLanding);
app.get('/home', SupermarketController.renderHomePage);
app.get('/shopping', SupermarketController.renderShopping);

app.get('/register', UserController.renderRegister);
app.post('/register', ensureFn(UserController.registerUser, 'UserController.registerUser'));

app.get('/login', UserController.renderLogin);
app.post('/login', ensureFn(UserController.loginUser, 'UserController.loginUser'));
app.get('/profile', checkAuthenticated, ensureFn(UserController.renderProfile, 'UserController.renderProfile'));
app.post('/profile', checkAuthenticated, ensureFn(UserController.updateProfile, 'UserController.updateProfile'));
app.get('/logout', SupermarketController.logout);

app.get("/", (req, res) => { res.render("shopping") })
app.get("/nets-qr/success", (req, res) => {
    res.render('netsTxnSuccessStatus', { message: 'Transaction Successful!' });
});
app.get("/nets-qr/fail", (req, res) => {
    res.render('netsTxnFailStatus', { message: 'Transaction Failed. Please try again.' });
})

app.get('/generateNETSQR', checkAuthenticated, (req, res) => {
  res.render('netsQrStart', { title: 'NETS QR Payment' });
});
app.post('/generateNETSQR', checkAuthenticated, netsQr.generateQrCode);


//errors
app.get('/401', (req, res) => {
    res.render('401', { errors: req.flash('error') });
});

//Endpoint in your backend which is a Server-Sent Events (SSE) endpoint that allows your frontend (browser) 
//to receive real-time updates about the payment status of a NETS QR transaction.
app.get('/sse/payment-status/:txnRetrievalRef', async (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    const txnRetrievalRef = req.params.txnRetrievalRef;
    let pollCount = 0;
    const maxPolls = 60; // 5 minutes if polling every 5s
    let frontendTimeoutStatus = 0;

    const interval = setInterval(async () => {
        pollCount++;

        try {
            // Call the NETS query API
            const response = await axios.post(
                'https://sandbox.nets.openapipaas.com/api/v1/common/payments/nets-qr/query',
                { txn_retrieval_ref: txnRetrievalRef, frontend_timeout_status: frontendTimeoutStatus },
                {
                    headers: {
                        'api-key': process.env.API_KEY,
                        'project-id': process.env.PROJECT_ID,
                        'Content-Type': 'application/json'
                    }
                }
            );

            console.log("Polling response:", response.data);
            // Send the full response to the frontend
            res.write(`data: ${JSON.stringify(response.data)}\n\n`);
        
          const resData = response.data.result.data;

            // Decide when to end polling and close the connection
            //Check if payment is successful
            if (resData.response_code == "00" && resData.txn_status === 1) {
                // Payment success: send a success message
                res.write(`data: ${JSON.stringify({ success: true })}\n\n`);
                clearInterval(interval);
                res.end();
            } else if (frontendTimeoutStatus == 1 && resData && (resData.response_code !== "00" || resData.txn_status === 2)) {
                // Payment failure: send a fail message
                res.write(`data: ${JSON.stringify({ fail: true, ...resData })}\n\n`);
                clearInterval(interval);
                res.end();
            }

        } catch (err) {
            clearInterval(interval);
            res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
            res.end();
        }


        // Timeout
        if (pollCount >= maxPolls) {
            clearInterval(interval);
            frontendTimeoutStatus = 1;
            res.write(`data: ${JSON.stringify({ fail: true, error: "Timeout" })}\n\n`);
            res.end();
        }
    }, 5000);

    req.on('close', () => {
        clearInterval(interval);
    });
});
// Inventory / product admin
app.get('/inventory', checkAuthenticated, checkAdmin, SupermarketController.renderInventory);
app.get('/addProduct', checkAuthenticated, checkAdmin, SupermarketController.renderAddProductForm);
app.post('/addProduct', checkAuthenticated, checkAdmin, upload.single('image'), ensureFn(SupermarketController.createProduct, 'SupermarketController.createProduct'));
app.get('/updateProduct/:id', checkAuthenticated, checkAdmin, SupermarketController.renderUpdateProductForm);
app.post('/updateProduct/:id', checkAuthenticated, checkAdmin, upload.single('image'), ensureFn(SupermarketController.updateProduct, 'SupermarketController.updateProduct'));
app.get('/inventory/edit/:id', checkAuthenticated, checkAdmin, SupermarketController.renderUpdateProductForm); // new edit route
app.get('/inventory/delete/:id', checkAuthenticated, checkAdmin, ensureFn(SupermarketController.deleteProduct, 'SupermarketController.deleteProduct'));
app.post('/inventory/delete/:id', checkAuthenticated, checkAdmin, ensureFn(SupermarketController.deleteProduct, 'SupermarketController.deleteProduct'));

// Cart
app.post('/add-to-cart/:id', checkAuthenticated, ensureFn(CartController.addToCart, 'CartController.addToCart'));
app.get('/cart', checkAuthenticated, CartController.renderCart);
app.get('/cart/remove/:id', checkAuthenticated, ensureFn(CartController.removeItem, 'CartController.removeItem'));
app.post('/cart/update/:id', checkAuthenticated, ensureFn(CartController.updateQuantity, 'CartController.updateQuantity'));
app.get('/cart/clear', checkAuthenticated, ensureFn(CartController.clearCart, 'CartController.clearCart'));
app.get('/checkout', checkAuthenticated, ensureFn(CheckoutController.renderCheckout, 'CheckoutController.renderCheckout'));
app.post('/checkout', checkAuthenticated, ensureFn(CheckoutController.processCheckout, 'CheckoutController.processCheckout'));
app.post('/checkout/paypal/order', checkAuthenticated, ensureFn(CheckoutController.createPayPalOrder, 'CheckoutController.createPayPalOrder'));
app.post('/checkout/paypal/capture', checkAuthenticated, ensureFn(CheckoutController.capturePayPalOrder, 'CheckoutController.capturePayPalOrder'));
app.get('/paynow', checkAuthenticated, ensureFn(CheckoutController.renderPayNow, 'CheckoutController.renderPayNow'));
app.get('/invoice', checkAuthenticated, ensureFn(CheckoutController.renderInvoice, 'CheckoutController.renderInvoice'));
app.get('/orders', checkAuthenticated, ensureFn(CheckoutController.renderOrderHistory, 'CheckoutController.renderOrderHistory'));
app.get('/orders/:invoice', checkAuthenticated, ensureFn(CheckoutController.viewOrderFromHistory, 'CheckoutController.viewOrderFromHistory'));

// Admin dashboard
app.get('/admin', checkAuthenticated, checkAdmin, AdminController.renderAdmin);
app.get('/admin/users', checkAuthenticated, checkAdmin, AdminController.renderUsers);
app.get('/admin/users/:id/delete', checkAuthenticated, checkAdmin, ensureFn(AdminController.deleteUser, 'AdminController.deleteUser')); // convenience GET
app.post('/admin/users/:id/delete', checkAuthenticated, checkAdmin, ensureFn(AdminController.deleteUser, 'AdminController.deleteUser'));
app.get('/admin/users/:id/edit', checkAuthenticated, checkAdmin, ensureFn(AdminController.renderEditUser, 'AdminController.renderEditUser'));
app.post('/admin/users/:id/edit', checkAuthenticated, checkAdmin, ensureFn(AdminController.updateUser, 'AdminController.updateUser'));
app.post('/admin/orders/:orderId/status', checkAuthenticated, checkAdmin, ensureFn(AdminController.updateOrderStatus, 'AdminController.updateOrderStatus'));

// 404
app.use((req, res) => res.status(404).send('Not Found'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server http://localhost:${PORT}`));
