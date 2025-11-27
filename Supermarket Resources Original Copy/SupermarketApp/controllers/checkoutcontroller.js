'use strict';
const Supermarket = require('../models/Supermarket');

// In-memory, user-scoped order history so it survives logout/login (per server run)
const orderHistoryStore = new Map(); // key => [orders]

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

function getHistoryForUser(user, fallbackSessionHistory) {
  const key = userHistoryKey(user);
  if (!key) return fallbackSessionHistory || [];
  return orderHistoryStore.get(key) || fallbackSessionHistory || [];
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
  const subtotal = cartItems.reduce((sum, item) => sum + item.subtotal, 0);
  const shipping = 0;
  const total = subtotal + shipping;
  return { subtotal, shipping, total };
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

  res.render('checkout', {
    cartItems,
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

  if (req.body.paymentMethod === 'card') {
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
  }

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

    return finalizeOrder();
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
    shipping: Number(order.shipping) || 0,
    total: Number(order.total) || fallbackTotals.total
  };
  res.render('invoice', {
    order,
    ...totals
  });
}

function renderOrderHistory(req, res) {
  const orders = getHistoryForUser(req.session.user, req.session.orderHistory);
  res.render('orderHistory', {
    orders
  });
}

function viewOrderFromHistory(req, res) {
  const orders = Array.isArray(req.session.orderHistory) ? req.session.orderHistory : [];
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
  viewOrderFromHistory
};
