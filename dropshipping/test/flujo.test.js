import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getSettings } from '../src/db.js';
import {
  DAY, balances, prepareSaleOrder, confirmPayment, failPayment, markShipped, markDelivered,
  autoDeliver, refundOrder, requestWithdrawal, processWithdrawal, orderLedgerTotal,
} from '../src/services.js';

const T0 = Date.UTC(2026, 10, 2, 12);
let db, s, supplier, seller, listingId, productId;

function addUser(role, extra = {}) {
  const r = db.prepare(
    `INSERT INTO users (email, pass_hash, name, country, role, kyc_status, payout_method, created_at)
     VALUES (?, 'x', ?, ?, ?, ?, ?, ?)`
  ).run(`${role}${Math.random()}@test.py`, role, extra.country ?? 'PY', role,
    extra.kyc ?? 'verificado', extra.payout ?? 'Banco Itaú 123', T0);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid));
}

const buyer = {
  name: 'Ana Comprador', email: 'ana@test.py', phone: '0981000000',
  document: '1234567', address: 'Asunción', country: 'PY',
};

beforeEach(() => {
  db = openDb(':memory:');
  s = getSettings(db);
  supplier = addUser('proveedor');
  seller = addUser('vendedor', { country: 'AR' });
  productId = Number(db.prepare(
    `INSERT INTO products (supplier_id, title, wholesale_pyg, shipping_pyg, stock, ships_to, created_at)
     VALUES (?, 'Auriculares', 100000, 20000, 10, 'PY,AR', ?)`
  ).run(supplier.id, T0).lastInsertRowid);
  listingId = Number(db.prepare(
    'INSERT INTO listings (seller_id, product_id, retail_pyg, created_at) VALUES (?, ?, 200000, ?)'
  ).run(seller.id, productId, T0).lastInsertRowid);
});

function paidOrder(qty = 1, now = T0) {
  const o = prepareSaleOrder(db, s, { listingId, qty, buyer, gateway: 'simulado' }, now);
  confirmPayment(db, s, o.id, o.total_pyg, now);
  return o;
}

test('flujo completo: pedido -> pago -> retención -> liberación -> retiro', () => {
  // 1. Pedido: el reparto se calcula en guaraníes enteros.
  const o = prepareSaleOrder(db, s, { listingId, qty: 2, buyer, gateway: 'simulado' }, T0);
  assert.equal(o.status, 'pendiente_pago');
  assert.equal(o.total_pyg, 400000);
  assert.equal(o.supplier_pyg, 240000);       // (100.000 + 20.000) × 2
  assert.equal(o.platform_fee_pyg, 40000);    // 10% plan Gratis
  assert.equal(o.gateway_fee_pyg, 20000);     // 5%
  assert.equal(o.seller_pyg, 100000);
  for (const k of ['total_pyg', 'supplier_pyg', 'platform_fee_pyg', 'gateway_fee_pyg', 'seller_pyg']) {
    assert.ok(Number.isInteger(o[k]), `${k} debe ser entero`);
  }

  // 2. Pago: el dinero queda retenido, nada disponible todavía.
  const { changed } = confirmPayment(db, s, o.id, 400000, T0 + 1000);
  assert.equal(changed, true);
  assert.deepEqual(balances(db, supplier.id, T0 + 1000), { disponible: 0, retenido: 240000 });
  assert.deepEqual(balances(db, seller.id, T0 + 1000), { disponible: 0, retenido: 100000 });
  assert.equal(db.prepare('SELECT stock FROM products WHERE id = ?').get(productId).stock, 8);
  // El libro cuadra con lo que pagó el comprador.
  assert.equal(orderLedgerTotal(db, o.id) + o.gateway_fee_pyg, o.total_pyg);

  // Un pago duplicado (webhook repetido) no duplica asientos.
  assert.equal(confirmPayment(db, s, o.id, 400000, T0 + 2000).changed, false);
  assert.deepEqual(balances(db, seller.id, T0 + 2000), { disponible: 0, retenido: 100000 });

  // 3. Envío y entrega: sigue retenido durante la garantía.
  markShipped(db, supplier.id, o.id, 'PY123', T0 + DAY);
  const tDeliver = T0 + 3 * DAY;
  assert.equal(markDelivered(db, s, o.id, tDeliver), true);
  assert.deepEqual(balances(db, seller.id, tDeliver + DAY), { disponible: 0, retenido: 100000 });

  // 4. Liberación: pasado el plazo de garantía el saldo queda disponible.
  const tFree = tDeliver + s.hold_days * DAY;
  assert.deepEqual(balances(db, seller.id, tFree), { disponible: 100000, retenido: 0 });
  assert.deepEqual(balances(db, supplier.id, tFree), { disponible: 240000, retenido: 0 });

  // 5. Retiro del proveedor en guaraníes.
  const w = requestWithdrawal(db, s, supplier, { amount: 240000, currency: 'PYG' }, tFree);
  assert.equal(w.fee, 15000);
  assert.equal(w.amountOutMinor, 225000);
  assert.deepEqual(balances(db, supplier.id, tFree), { disponible: 0, retenido: 0 });
  processWithdrawal(db, w.id, 'pagado', 'transferido', tFree + 1000);
  const wr = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(w.id);
  assert.equal(wr.status, 'pagado');
  assert.equal(wr.amount_out_minor, 225000);

  // La plataforma ganó la comisión de venta y la del retiro.
  const platform = db.prepare('SELECT SUM(amount_pyg) AS t FROM ledger WHERE user_id IS NULL').get().t;
  assert.equal(platform, 40000 + 15000);
});

test('no se puede retirar dinero retenido', () => {
  // Con precio 400.000 el vendedor gana 220.000, pero todavía está retenido.
  db.prepare('UPDATE listings SET retail_pyg = 400000 WHERE id = ?').run(listingId);
  paidOrder();
  assert.deepEqual(balances(db, seller.id, T0), { disponible: 0, retenido: 220000 });
  assert.throws(() => requestWithdrawal(db, s, seller, { amount: 150000, currency: 'PYG' }, T0),
    /Saldo disponible insuficiente/);
});

test('retiro en USD: centavos enteros y ganancia por spread', () => {
  db.prepare('UPDATE listings SET retail_pyg = 1000000 WHERE id = ?').run(listingId);
  const o = paidOrder();
  markShipped(db, supplier.id, o.id, 'X', T0);
  markDelivered(db, s, o.id, T0);
  const t = T0 + s.hold_days * DAY;
  const { disponible } = balances(db, seller.id, t);
  assert.equal(disponible, 1000000 - 120000 - 100000 - 50000);

  const w = requestWithdrawal(db, s, seller, { amount: 700000, currency: 'USD' }, t);
  // neto 625.000 / (7300 × 1,025) = 83,528… USD, redondeado hacia abajo a 83,52
  assert.equal(w.net, 625000);
  assert.equal(w.amountOutMinor, 8352);
  assert.ok(Number.isInteger(w.spreadGain) && w.spreadGain > 0);
  processWithdrawal(db, w.id, 'pagado', '', t);
  const spread = db.prepare(`SELECT amount_pyg FROM ledger WHERE type = 'spread_cambio'`).get();
  assert.equal(spread.amount_pyg, w.spreadGain);
});

test('retiro rechazado devuelve el saldo', () => {
  const o = paidOrder();
  markShipped(db, supplier.id, o.id, 'X', T0);
  markDelivered(db, s, o.id, T0);
  const t = T0 + s.hold_days * DAY;
  const w = requestWithdrawal(db, s, supplier, { amount: 120000, currency: 'PYG' }, t);
  assert.equal(balances(db, supplier.id, t).disponible, 0);
  processWithdrawal(db, w.id, 'rechazado', 'cuenta inválida', t);
  assert.equal(balances(db, supplier.id, t).disponible, 120000);
  assert.throws(() => processWithdrawal(db, w.id, 'pagado', '', t), /ya fue procesado/);
});

test('validaciones de retiro', () => {
  const noKyc = addUser('vendedor', { kyc: 'sin_enviar' });
  assert.throws(() => requestWithdrawal(db, s, noKyc, { amount: 200000, currency: 'PYG' }, T0), /verificar tu identidad/);
  assert.throws(() => requestWithdrawal(db, s, seller, { amount: 1500.5, currency: 'PYG' }, T0), /entero/);
  assert.throws(() => requestWithdrawal(db, s, seller, { amount: 200000, currency: 'EUR' }, T0), /Moneda/);
  assert.throws(() => requestWithdrawal(db, s, seller, { amount: 50000, currency: 'PYG' }, T0), /mínimo/);
  assert.throws(() => processWithdrawal(db, 1, 'cualquiera', '', T0), /inválido/);
});

test('pago con monto distinto se rechaza y no toca el libro', () => {
  const o = prepareSaleOrder(db, s, { listingId, qty: 1, buyer, gateway: 'simulado' }, T0);
  assert.throws(() => confirmPayment(db, s, o.id, 199999, T0), /no coincide/);
  assert.equal(orderLedgerTotal(db, o.id), 0);
  failPayment(db, o.id);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(o.id).status, 'rechazado');
});

test('entrega automática si el comprador no confirma', () => {
  const o = paidOrder();
  markShipped(db, supplier.id, o.id, 'X', T0);
  assert.equal(autoDeliver(db, s, T0 + (s.auto_deliver_days - 1) * DAY), 0);
  assert.equal(autoDeliver(db, s, T0 + s.auto_deliver_days * DAY), 1);
  const t = T0 + (s.auto_deliver_days + s.hold_days) * DAY;
  assert.equal(balances(db, supplier.id, t).disponible, 120000);
});

test('reembolso antes de la entrega anula lo retenido', () => {
  const o = paidOrder();
  refundOrder(db, o.id, T0 + 1000);
  assert.deepEqual(balances(db, seller.id, T0 + 1000), { disponible: 0, retenido: 0 });
  assert.deepEqual(balances(db, supplier.id, T0 + 1000), { disponible: 0, retenido: 0 });
  assert.equal(orderLedgerTotal(db, o.id), 0);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id = ?').get(productId).stock, 10);
  // Un pedido reembolsado no se puede entregar ni liberar.
  assert.equal(markDelivered(db, s, o.id, T0 + DAY), false);
});

test('no se envía a países fuera de la lista del proveedor', () => {
  assert.throws(
    () => prepareSaleOrder(db, s, { listingId, qty: 1, buyer: { ...buyer, country: 'US' }, gateway: 'simulado' }, T0),
    /no se envía/
  );
});
