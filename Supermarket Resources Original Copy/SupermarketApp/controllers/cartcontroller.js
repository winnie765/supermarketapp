'use strict';
const Supermarket = require('../models/Supermarket');

function addToCart(req, res) {
  const id = req.params.id;
  const parsedQty = Number.parseInt(req.body.quantity ?? req.body.qty ?? 1, 10);
  const requestedQty = Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : 1;
  const cart = Array.isArray(req.session.cart) ? req.session.cart : [];
  Supermarket.getProductById(id, (err, product) => {
    if (err || !product) {
      req.flash('error', 'Product not found');
      return res.redirect('/shopping');
    }
    const productId = String(product.id);
    const item = cart.find(i => String(i.id) === productId);
    const productStockRaw = Number(product.stock);
    const quantityFallback = Number(product.quantity);
    const productStock = Number.isFinite(productStockRaw)
      ? productStockRaw
      : (Number.isFinite(quantityFallback) ? quantityFallback : 0);
    const currentQty = item ? Number(item.qty) || 0 : 0;

    const remaining = productStock - currentQty;
    if (remaining <= 0) {
      req.flash('error', `Out of stock. ${product.name} has no remaining units.`);
      return res.redirect('/shopping');
    }

    if (requestedQty > remaining) {
      req.flash('error', `Amount exceeds the max quantity. Only ${remaining} left for ${product.name}.`);
      return res.redirect('/shopping');
    }

    if (item) item.qty = currentQty + requestedQty;
    else cart.push({
      id: productId,
      name: product.name,
      price: product.price,
      image: product.image,
      qty: requestedQty
    });
    req.flash('success', 'Added to cart');
    req.session.cart = cart;
    return req.session.save(() => {
      res.redirect('/cart');
    });
  });
}

function calculateCartTotal(cart) {
  if (!cart) return 0;
  return cart.reduce((sum, item) => sum + Number(item.price) * Number(item.qty), 0);
}

function renderCart(req, res) {
  const cart = Array.isArray(req.session.cart)
    ? req.session.cart
    : (Array.isArray(req.session.cart && req.session.cart.items) ? req.session.cart.items : []);
  req.session.cart = cart;
  const total = calculateCartTotal(cart);

  res.render('cart', {
    user: req.session.user,
    cart,
    total,
    messages: req.flash()
  });
}

function removeItem(req, res) {
  const id = req.params.id;

  if (!req.session.cart) req.session.cart = [];
  if (!Array.isArray(req.session.cart) && Array.isArray(req.session.cart.items)) {
    req.session.cart = req.session.cart.items;
  }

  req.session.cart = req.session.cart.filter(item => String(item.id) !== String(id));

  req.flash('success', 'Item removed from cart');
  res.redirect('/cart');
}

function updateQuantity(req, res) {
  const id = req.params.id;
  const cart = Array.isArray(req.session.cart)
    ? req.session.cart
    : (Array.isArray(req.session.cart && req.session.cart.items) ? req.session.cart.items : []);
  const item = cart.find(i => String(i.id) === String(id));
  if (!item) {
    req.flash('error', 'Item not found in cart');
    return res.redirect('/cart');
  }

  const action = (req.body.action || req.query.action || '').toLowerCase();
  const bodyQty = Number.parseInt(req.body.quantity ?? req.query.quantity, 10);
  const requestedQty = Number.isFinite(bodyQty) && bodyQty > 0 ? bodyQty : null;

  Supermarket.getProductById(id, (err, product) => {
    if (err || !product) {
      req.flash('error', 'Product not found');
      return res.redirect('/cart');
    }

    const productStockRaw = Number(product.stock);
    const quantityFallback = Number(product.quantity);
    const productStock = Number.isFinite(productStockRaw)
      ? productStockRaw
      : (Number.isFinite(quantityFallback) ? quantityFallback : null);

    const currentQty = Number(item.qty) || 1;
    let newQty = currentQty;
    if (action === 'inc' || action === 'increase' || action === '+') {
      newQty = currentQty + 1;
    } else if (action === 'dec' || action === 'decrease' || action === '-') {
      newQty = currentQty - 1;
    } else if (requestedQty !== null) {
      newQty = requestedQty;
    }

    if (newQty < 1) {
      // Treat as remove
      req.session.cart = cart.filter(i => String(i.id) !== String(id));
      req.flash('success', 'Item removed from cart');
      return req.session.save(() => res.redirect('/cart'));
    }

    let hasError = false;
    if (productStock !== null) {
      if (productStock <= 0) {
        req.flash('error', `${product.name} is out of stock`);
        hasError = true;
        return res.redirect('/cart');
      }
      if (newQty > productStock) {
        newQty = productStock;
        req.flash('error', `Only ${productStock} unit(s) of ${product.name} available.`);
        hasError = true;
      }
    }

    item.qty = newQty;
    req.session.cart = cart;
    return req.session.save(() => {
      if (!hasError) {
        req.flash('success', 'Quantity updated');
      }
      res.redirect('/cart');
    });
  });
}

function clearCart(req, res) {
  req.session.cart = [];
  req.flash('success', 'Cart cleared');
  res.redirect('/cart');
}


module.exports = { addToCart, renderCart, removeItem, clearCart, updateQuantity };
