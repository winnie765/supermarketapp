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

function clearCart(req, res) {
  req.session.cart = [];
  req.flash('success', 'Cart cleared');
  res.redirect('/cart');
}


module.exports = { addToCart, renderCart, removeItem, clearCart };
