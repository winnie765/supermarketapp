'use strict';
const fs = require('fs');
const path = require('path');
const Supermarket = require('../models/Supermarket');
const CartModel = require('../models/cart');
const PaymentMethods = require('../models/paymentMethods');
const UserController = require('./Usercontroller');

// In-memory, user-scoped order history so it survives logout/login (per server run)
const orderHistoryStore = new Map(); // key => [orders]
const globalOrderFeed = []; // latest orders across all users
const feedFile = path.join(__dirname, '..', 'orders-feed.json');

function loadFeedFromDisk() {
  try {
    if (fs.existsSync(feedFile)) {
      const raw = fs.readFileSync(feedFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        globalOrderFeed.splice(0, globalOrderFeed.length, ...parsed.slice(0, 50));
      }
    }
  } catch (err) {
    console.warn('Could not load orders feed:', err.message);
  }
}

function persistFeed() {
  try {
    fs.writeFile(feedFile, JSON.stringify(globalOrderFeed.slice(0, 50), null, 2), () => {});
  } catch (err) {
    console.warn('Could not save orders feed:', err.message);
  }
}

// warm the feed on startup
loadFeedFromDisk();

function userHistoryKey(user) {
  if (!user) return null;
  return user.id ? `id:${user.id}` : (user.email ? `email:${user.email}` : null);
}

function recordOrderForUser(user, order) {
  const key = userHistoryKey(user);
  if (!key || !order) return;
  const existing = orderHistoryStore.get(key) || [];
  existing.unshift(order);
  orderHistoryStore.set(key, existing.slice(0, 20));
}

function recordGlobalOrder(order) {
  if (!order) return;
  globalOrderFeed.unshift(order);
  if (globalOrderFeed.length > 50) globalOrderFeed.length = 50;
  persistFeed();
}

function getHistoryForUser(user, fallbackSessionHistory) {
  const key = userHistoryKey(user);
  if (!key) return fallbackSessionHistory || [];
  return orderHistoryStore.get(key) || fallbackSessionHistory || [];
}

function getRecentOrders(limit = 5) {
  const safeLimit = Number.isFinite(Number(limit)) ? Number(limit) : 5;
  const combined = [...globalOrderFeed];

  // include any per-user histories to avoid missing orders if the global feed was empty when they were recorded
  orderHistoryStore.forEach((orders) => {
    if (Array.isArray(orders)) combined.push(...orders);
  });

  // de-duplicate by invoice/order number
  const seen = new Set();
  const unique = combined.filter((order) => {
    const key = order && (order.invoiceNumber || order.orderNumber || order.id);
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => {
    const timeA = new Date(a.placedAt || a.createdAt || 0).getTime();
    const timeB = new Date(b.placedAt || b.createdAt || 0).getTime();
    return timeB - timeA;
  });

  return unique.slice(0, safeLimit);
}

function setOrderStatus(orderKey, status) {
  if (!orderKey) return false;
  const target = String(orderKey).toLowerCase();
  const applyStatus = (order) => {
    const idMatch = (order.id && String(order.id).toLowerCase() === target);
    const invMatch = (order.invoiceNumber && String(order.invoiceNumber).toLowerCase() === target);
    const numMatch = (order.orderNumber && String(order.orderNumber).toLowerCase() === target);
    if (idMatch || invMatch || numMatch) {
      order.status = status;
      return true;
    }
    return false;
  };

  let updated = false;
  globalOrderFeed.forEach((order) => {
    if (applyStatus(order)) updated = true;
  });
  orderHistoryStore.forEach((orders, key) => {
    if (Array.isArray(orders)) {
      orders.forEach((order) => {
        if (applyStatus(order)) updated = true;
      });
      orderHistoryStore.set(key, orders);
    }
  });
  if (updated) persistFeed();
  return updated;
}

function getCartItems(req) {
  const sessionCart = req.session.cart;
  const rawItems = Array.isArray(sessionCart)
    ? sessionCart
    : (Array.isArray(sessionCart && sessionCart.items) ? sessionCart.items : []);

  req.session.cart = rawItems; // normalize shape for future requests

  const cartItems = rawItems.map((item, index) => {
    const qty = Number.parseInt(item.quantity ?? item.qty, 10);
    const quantity = Number.isFinite(qty) && qty > 0 ? qty : 1;

    const priceCandidates = [
      typeof item.price === 'number' ? item.price : Number.parseFloat(item.price),
      item.product && typeof item.product.price === 'number' ? item.product.price : Number.parseFloat(item.product && item.product.price)
    ];
    const price = priceCandidates.find(val => Number.isFinite(val)) || 0;

    const name =
      item.name ||
      item.productName ||
      (item.product && (item.product.name || item.product.title)) ||
      (item.id ? `Item ${item.id}` : `Item ${index + 1}`);

    return {
      id: item.id,
      name,
      quantity,
      price,
      subtotal: price * quantity
    };
  });

  return cartItems;
}

function calculateTotals(cartItems) {
  const subtotal = cartItems.reduce((sum, item) => sum + (Number(item.subtotal) || 0), 0);
  const gst = Number((subtotal * 0.09).toFixed(2)); // 9% GST rounded to cents
  const shipping = subtotal >= 59 ? 0 : 7;
  const total = subtotal + gst + shipping;
  return { subtotal, gst, shipping, total };
}

function buildPayNowPayload({ invoiceNumber, total, customer }) {
  const amount = Number.isFinite(total) ? total : 0;
  const formattedAmount = amount.toFixed(2);

  const parts = [
    'PAYNOW',
    `INV:${invoiceNumber}`,
    `AMT:${formattedAmount}`,
    customer.fullName ? `NAME:${customer.fullName}` : null,
    customer.email ? `EMAIL:${customer.email}` : null
  ].filter(Boolean);

  return {
    reference: invoiceNumber,
    amount: formattedAmount,
    payload: parts.join('|')
  };
}

function renderCheckout(req, res) {
  const cartItems = getCartItems(req);
  if (!cartItems.length) {
    req.flash('error', 'Your cart is empty. Add items before checking out.');
    return res.redirect('/cart');
  }

  const totals = calculateTotals(cartItems);
  const userId = req.session.user && req.session.user.id;
  if (userId && PaymentMethods && typeof PaymentMethods.listByUser === 'function') {
    return PaymentMethods.listByUser(userId, (err, methods) => {
      if (err) console.error('Payment methods load failed:', err);
      const dbCards = Array.isArray(methods) ? methods : [];
      const cached = Array.isArray(req.session.savedCardsCache) ? req.session.savedCardsCache : [];
      const combined = [...dbCards];
      cached.forEach((c) => {
        const already = dbCards.some((d) => d.id && c.id && String(d.id) === String(c.id));
        if (!already) combined.push(c);
      });
      return UserController.renderCheckoutWithProfile(req, res, {
        cartItems,
        savedCards: combined,
        ...totals
      });
    });
  }

  return UserController.renderCheckoutWithProfile(req, res, {
    cartItems,
    savedCards: Array.isArray(req.session.savedCardsCache) ? req.session.savedCardsCache : [],
    ...totals
  });
}

function processCheckout(req, res) {
  const cartItems = getCartItems(req);
  if (!cartItems.length) {
    req.flash('error', 'Your cart is empty. Add items before checking out.');
    return res.redirect('/checkout');
  }

  const requiredFields = ['fullName', 'email', 'address', 'paymentMethod'];
  const missing = requiredFields.filter(field => !(req.body[field] || '').trim());

  if (missing.length) {
    req.flash('error', 'Please complete all checkout fields before placing your order.');
    return res.redirect('/checkout');
  }

  let selectedSavedCard = null;
  let cardToSave = null;
  if (req.body.paymentMethod === 'card') {
    const savedId = req.body.savedPaymentMethod;
    if (savedId) {
      const userId = req.session.user && req.session.user.id;
      return PaymentMethods.getForUser(savedId, userId, (pmErr, pm) => {
        if (pmErr || !pm) {
          req.flash('error', 'Saved card not found. Please re-enter card details.');
          return res.redirect('/checkout');
        }
        selectedSavedCard = pm;
        continueCheckout();
      });
    } else {
      const cardNumber = (req.body.cardNumber || '').replace(/\s+/g, '');
      const cardCvv = (req.body.cardCvv || '').trim();
      const cardExpiry = (req.body.cardExpiry || '').trim();
      const cardMissing = [];
      if (!cardNumber) cardMissing.push('card number');
      if (!cardExpiry) cardMissing.push('expiry');
      if (!cardCvv) cardMissing.push('CVV');
      if (cardMissing.length) {
        req.flash('error', `Please enter your ${cardMissing.join(', ')} to pay by card.`);
        return res.redirect('/checkout');
      }
      // prepare new card payload for optional saving
      const expParts = cardExpiry.replace(/\s+/g, '').split(/[\/-]/);
      const expMonth = expParts[0] || null;
      const expYear = expParts[1] || null;
      if (req.session.user && req.session.user.id && req.body.saveCard) {
        cardToSave = {
          userId: req.session.user.id,
          brand: 'Card',
          label: req.body.cardName || 'Card',
          cardholderName: req.body.cardName || req.body.fullName,
          last4: cardNumber.slice(-4),
          expMonth,
          expYear,
          expiry: cardExpiry,
          cvv: req.body.cardCvv || null,
          cardToken: cardNumber
        };
      }
      continueCheckout();
    }
  } else {
    continueCheckout();
  }

  function continueCheckout() {
    if (req.body.paymentMethod === 'card' && selectedSavedCard) {
      req.body.cardNumber = selectedSavedCard.cardToken || `**** **** **** ${selectedSavedCard.last4}`;
      req.body.cardExpiry = `${selectedSavedCard.expMonth || 'MM'} / ${selectedSavedCard.expYear || 'YY'}`;
      req.body.cardCvv = '***';
    }

    // main checkout flow continues here
    const totals = calculateTotals(cartItems);
    const invoiceNumber = `INV-${Date.now().toString().slice(-8)}`;
    const isPayNow = req.body.paymentMethod === 'paynow';
    const cardNumber = (req.body.cardNumber || '').replace(/\s+/g, '');
    const cardLast4 = req.body.paymentMethod === 'card' && cardNumber.length >= 4
      ? cardNumber.slice(-4)
      : null;
    const customer = {
      fullName: req.body.fullName,
      email: req.body.email,
      address: req.body.address,
      paymentMethod: req.body.paymentMethod,
      cardLast4
    };

    const finalizeOrder = () => {
      const orderRecord = {
        invoiceNumber,
        customer,
        paynow: isPayNow ? buildPayNowPayload({ invoiceNumber, total: totals.total, customer }) : null,
        cartItems,
        ...totals,
        placedAt: new Date().toISOString()
      };

      req.session.lastOrder = orderRecord;
      const history = Array.isArray(req.session.orderHistory) ? req.session.orderHistory : [];
      history.unshift(orderRecord);
      // keep recent 20 orders max to avoid unbounded session growth
      req.session.orderHistory = history.slice(0, 20);
      // also keep a per-user record that survives logout/login for the same account
      recordOrderForUser(req.session.user, orderRecord);
      // keep a global feed for admins
      recordGlobalOrder(orderRecord);
      if (req.session.user && req.session.user.id) {
        CartModel.clearUserCart(req.session.user.id, (err) => {
          if (err) console.error('Failed to clear DB cart after checkout:', err);
        });
      }
      req.session.cart = [];
      req.flash('success', `Order placed! An invoice has been generated for ${req.body.email}.`);

      return req.session.save(() => {
        if (isPayNow) {
          req.session.pendingPayNow = true;
          return res.redirect('/paynow');
        }
        return res.redirect('/invoice');
      });
    };

    Supermarket.adjustStockForCart(cartItems, (stockErr, result) => {
      if (stockErr) {
        if (stockErr.code === 'INSUFFICIENT_STOCK') {
          const name = stockErr.productName || `Product ${stockErr.productId}`;
          req.flash('error', `Not enough stock for ${name}. Available: ${stockErr.available}, requested: ${stockErr.requested}.`);
        } else {
          console.error('Stock update failed:', stockErr);
          req.flash('error', 'Unable to update stock. Please try again.');
        }
        return res.redirect('/cart');
      }

      if (result && result.skipped) {
        console.warn('Stock update skipped:', result.reason || 'No stock column available on products table');
      }

      return saveCardIfNeeded(cardToSave, req, finalizeOrder);
    });
  }
}

function saveCardIfNeeded(cardPayload, req, next) {
  if (!cardPayload) return next();
  if (!PaymentMethods || typeof PaymentMethods.add !== 'function') return next();
  return PaymentMethods.add(cardPayload, (err, result) => {
    if (err) {
      console.error('Failed to save card', err);
      // still cache locally so user sees it in this session
      const cache = Array.isArray(req.session.savedCardsCache) ? req.session.savedCardsCache : [];
      const tempId = `temp-${Date.now()}`;
      cache.unshift({ ...cardPayload, id: tempId });
      req.session.savedCardsCache = cache.slice(0, 5);
      return next();
    }
    // cache for the session so it appears on the next checkout even if DB load is delayed
    const cache = Array.isArray(req.session.savedCardsCache) ? req.session.savedCardsCache : [];
    const toStore = { ...cardPayload };
    if (result && result.insertId) toStore.id = result.insertId;
    cache.unshift(toStore);
    req.session.savedCardsCache = cache.slice(0, 5); // keep it small
    next();
  });
}

function renderPayNow(req, res) {
  const order = req.session.lastOrder;
  if (!order || !order.cartItems || !order.cartItems.length) {
    req.flash('error', 'No PayNow order found. Please checkout again.');
    return res.redirect('/checkout');
  }
  if (order.customer.paymentMethod !== 'paynow') {
    return res.redirect('/invoice');
  }
  // avoid direct navigation without a recent checkout
  if (!req.session.pendingPayNow) {
    return res.redirect('/invoice');
  }
  req.session.pendingPayNow = false;
  if (order.customer.paymentMethod === 'paynow' && !order.paynow) {
    order.paynow = buildPayNowPayload({ invoiceNumber: order.invoiceNumber, total: order.total, customer: order.customer });
  }
  const totals = calculateTotals(order.cartItems);
  res.render('paynow', {
    order,
    ...totals
  });
}

function renderInvoice(req, res) {
  const order = req.session.lastOrder;
  if (!order || !order.cartItems || !order.cartItems.length) {
    req.flash('error', 'No recent order found. Complete a checkout first.');
    return res.redirect('/cart');
  }
  if (order.customer.paymentMethod === 'paynow' && !order.paynow) {
    order.paynow = buildPayNowPayload({ invoiceNumber: order.invoiceNumber, total: order.total, customer: order.customer });
  }

  const fallbackTotals = calculateTotals(order.cartItems);
  const totals = {
    subtotal: Number(order.subtotal) || fallbackTotals.subtotal,
    gst: Number.isFinite(Number(order.gst)) ? Number(order.gst) : fallbackTotals.gst,
    shipping: Number(order.shipping) || 0,
    total: Number(order.total) || fallbackTotals.total
  };
  res.render('invoice', {
    order,
    ...totals
  });
}

function mergeOrdersForUser(user, sessionHistory = []) {
  const base = getHistoryForUser(user, sessionHistory) || [];
  const userEmail = user && user.email;
  const userId = user && user.id;
  const merged = [...base];

  globalOrderFeed.forEach((order) => {
    const emailMatches = userEmail && order.customer && order.customer.email && String(order.customer.email).toLowerCase() === String(userEmail).toLowerCase();
    const idMatches = userId && order.customer && order.customer.id && String(order.customer.id) === String(userId);
    if (emailMatches || idMatches) {
      const key = order.invoiceNumber || order.orderNumber || order.id;
      const exists = merged.some((o) => (o.invoiceNumber || o.orderNumber || o.id) === key);
      if (!exists) merged.push(order);
    }
  });

  merged.sort((a, b) => {
    const timeA = new Date(a.placedAt || a.createdAt || 0).getTime();
    const timeB = new Date(b.placedAt || b.createdAt || 0).getTime();
    return timeB - timeA;
  });
  return merged;
}

function renderOrderHistory(req, res) {
  const orders = mergeOrdersForUser(req.session.user, req.session.orderHistory);
  res.render('orderHistory', {
    orders,
    messages: req.flash()
  });
}

function viewOrderFromHistory(req, res) {
  const orders = mergeOrdersForUser(req.session.user, req.session.orderHistory);
  const order = orders.find((o) => String(o.invoiceNumber) === String(req.params.invoice));
  if (!order) {
    req.flash('error', 'Order not found in your history.');
    return res.redirect('/orders');
  }
  req.session.lastOrder = order;
  req.session.pendingPayNow = false;
  return res.redirect('/invoice');
}

module.exports = {
  renderCheckout,
  processCheckout,
  renderPayNow,
  renderInvoice,
  renderOrderHistory,
  viewOrderFromHistory,
  getRecentOrders,
  setOrderStatus
};
