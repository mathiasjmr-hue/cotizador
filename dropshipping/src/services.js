import { tx } from './db.js';
import { saleSplit, feePctFor, payoutQuote } from './money.js';
import { HttpError, bad } from './http.js';
import { randomCode } from './auth.js';

export const DAY = 24 * 3600 * 1000;

// ---------- Saldos ----------

export function balances(db, userId, now) {
  const r = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN available_at IS NOT NULL AND available_at <= ? THEN amount_pyg END), 0) AS disponible,
       COALESCE(SUM(CASE WHEN available_at IS NULL OR available_at > ? THEN amount_pyg END), 0) AS retenido
     FROM ledger WHERE user_id = ?`
  ).get(now, now, userId);
  return { disponible: r.disponible, retenido: r.retenido };
}

function entry(db, { userId = null, orderId = null, withdrawalId = null, amount, type, availableAt = null, now }) {
  db.prepare(
    `INSERT INTO ledger (user_id, order_id, withdrawal_id, amount_pyg, type, available_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, orderId, withdrawalId, amount, type, availableAt, now);
}

// ---------- Checkout ----------

export function prepareSaleOrder(db, s, { listingId, qty, buyer, gateway }, now) {
  const row = db.prepare(
    `SELECT l.id AS listing_id, l.retail_pyg, l.active AS l_active,
            p.id AS product_id, p.title, p.image_url, p.wholesale_pyg, p.shipping_pyg, p.stock, p.ships_to, p.active AS p_active,
            p.supplier_id, sel.id AS seller_id, sel.plan, sel.plan_until, sel.active AS seller_active, sup.active AS supplier_active
     FROM listings l
     JOIN products p ON p.id = l.product_id
     JOIN users sel ON sel.id = l.seller_id
     JOIN users sup ON sup.id = p.supplier_id
     WHERE l.id = ?`
  ).get(listingId);
  if (!row || !row.l_active || !row.p_active || !row.seller_active || !row.supplier_active) {
    throw new HttpError(404, 'Producto no disponible');
  }
  if (row.stock < qty) throw bad('No hay stock suficiente');
  const shipsTo = row.ships_to.split(',').map((c) => c.trim());
  if (!shipsTo.includes('*') && !shipsTo.includes(buyer.country)) throw bad('Este producto no se envía a tu país');

  const feePct = feePctFor(row, s, now);
  const split = saleSplit({
    retail: row.retail_pyg, wholesale: row.wholesale_pyg, shipping: row.shipping_pyg,
    qty, feePct, gatewayPct: s.gateway_fee_pct,
  });
  if (split.seller < 0) throw new HttpError(409, 'Producto no disponible momentáneamente (precio en revisión)');

  const code = randomCode(12);
  const r = db.prepare(
    `INSERT INTO orders (kind, public_code, seller_id, supplier_id, listing_id, product_id, item_title, qty,
       buyer_name, buyer_email, buyer_phone, buyer_document, buyer_address, buyer_country,
       total_pyg, supplier_pyg, platform_fee_pyg, gateway_fee_pyg, seller_pyg, fee_pct, gateway, created_at)
     VALUES ('venta', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(code, row.seller_id, row.supplier_id, row.listing_id, row.product_id, row.title, qty,
    buyer.name, buyer.email, buyer.phone, buyer.document, buyer.address, buyer.country,
    split.total, split.supplier, split.platformFee, split.gatewayFee, split.seller, feePct, gateway, now);
  const order = getOrderById(db, Number(r.lastInsertRowid));
  order.image_url = row.image_url;
  return order;
}

export function prepareSubscriptionOrder(db, s, user, gateway, now) {
  const code = randomCode(12);
  const r = db.prepare(
    `INSERT INTO orders (kind, public_code, seller_id, item_title, qty, buyer_name, buyer_email, buyer_phone,
       buyer_document, buyer_address, buyer_country, total_pyg, platform_fee_pyg, gateway, created_at)
     VALUES ('suscripcion', ?, ?, ?, 1, ?, ?, '', '', '', ?, ?, ?, ?, ?)`
  ).run(code, user.id, `Plan Pro ${s.pro_days} días`, user.name, user.email, user.country, s.pro_price_pyg, s.pro_price_pyg, gateway, now);
  return getOrderById(db, Number(r.lastInsertRowid));
}

export function getOrderById(db, id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

export function setGatewayRef(db, orderId, ref) {
  db.prepare('UPDATE orders SET gateway_ref = ? WHERE id = ?').run(ref, orderId);
}

// ---------- Confirmación de pago (idempotente) ----------

export function confirmPayment(db, s, orderId, amount, now) {
  return tx(db, () => {
    const o = getOrderById(db, orderId);
    if (!o) throw new HttpError(404, 'Pedido inexistente');
    if (o.status !== 'pendiente_pago') return { order: o, changed: false };
    if (amount !== o.total_pyg) throw bad(`Monto pagado (${amount}) no coincide con el pedido (${o.total_pyg})`);

    db.prepare(`UPDATE orders SET status = 'pagado', paid_at = ? WHERE id = ?`).run(now, o.id);

    if (o.kind === 'venta') {
      // El dinero del proveedor y del vendedor queda RETENIDO hasta la entrega (protección al comprador).
      entry(db, { userId: o.supplier_id, orderId: o.id, amount: o.supplier_pyg, type: 'venta_proveedor', now });
      if (o.seller_pyg > 0) entry(db, { userId: o.seller_id, orderId: o.id, amount: o.seller_pyg, type: 'venta_vendedor', now });
      entry(db, { orderId: o.id, amount: o.platform_fee_pyg, type: 'comision_venta', availableAt: now, now });
      db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?').run(o.qty, o.product_id);
    } else {
      const u = db.prepare('SELECT plan_until FROM users WHERE id = ?').get(o.seller_id);
      const from = Math.max(now, u?.plan_until ?? 0);
      db.prepare(`UPDATE users SET plan = 'pro', plan_until = ? WHERE id = ?`).run(from + s.pro_days * DAY, o.seller_id);
      entry(db, { orderId: o.id, amount: o.total_pyg, type: 'suscripcion', availableAt: now, now });
    }
    return { order: getOrderById(db, o.id), changed: true };
  });
}

export function failPayment(db, orderId) {
  db.prepare(`UPDATE orders SET status = 'rechazado' WHERE id = ? AND status = 'pendiente_pago'`).run(orderId);
}

// ---------- Envío y entrega ----------

export function markShipped(db, supplierId, orderId, tracking, now) {
  const r = db.prepare(
    `UPDATE orders SET status = 'enviado', tracking = ?, shipped_at = ?
     WHERE id = ? AND supplier_id = ? AND status = 'pagado'`
  ).run(tracking, now, orderId, supplierId);
  if (!r.changes) throw bad('El pedido no está pendiente de envío');
}

export function markDelivered(db, s, orderId, now) {
  return tx(db, () => {
    const r = db.prepare(
      `UPDATE orders SET status = 'entregado', delivered_at = ? WHERE id = ? AND status = 'enviado'`
    ).run(now, orderId);
    if (!r.changes) return false;
    // Libera el dinero retenido después del plazo de garantía.
    db.prepare('UPDATE ledger SET available_at = ? WHERE order_id = ? AND available_at IS NULL')
      .run(now + s.hold_days * DAY, orderId);
    return true;
  });
}

export function autoDeliver(db, s, now) {
  const due = db.prepare(`SELECT id FROM orders WHERE status = 'enviado' AND shipped_at <= ?`)
    .all(now - s.auto_deliver_days * DAY);
  for (const { id } of due) markDelivered(db, s, id, now);
  return due.length;
}

// ---------- Reembolsos (admin) ----------

export function refundOrder(db, orderId, now) {
  return tx(db, () => {
    const o = getOrderById(db, orderId);
    if (!o || o.kind !== 'venta' || !['pagado', 'enviado', 'entregado'].includes(o.status)) {
      throw bad('Solo se reembolsan ventas pagadas');
    }
    // Asientos inversos: los retenidos se anulan como retenidos, los disponibles se descuentan del saldo.
    const entries = db.prepare(`SELECT * FROM ledger WHERE order_id = ? AND type IN ('venta_proveedor','venta_vendedor','comision_venta')`).all(o.id);
    for (const e of entries) {
      entry(db, { userId: e.user_id, orderId: o.id, amount: -e.amount_pyg, type: 'reembolso', availableAt: e.available_at, now });
    }
    db.prepare(`UPDATE orders SET status = 'reembolsado' WHERE id = ?`).run(o.id);
    db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(o.qty, o.product_id);
  });
}

// ---------- Retiros ----------

export const WITHDRAW_CURRENCIES = ['PYG', 'USD'];

export function requestWithdrawal(db, s, user, { amount, currency }, now) {
  if (!Number.isInteger(amount) || amount <= 0) throw bad('El monto debe ser un entero positivo en guaraníes');
  if (!WITHDRAW_CURRENCIES.includes(currency)) throw bad('Moneda no soportada (PYG o USD)');
  if (user.kyc_status !== 'verificado') throw new HttpError(403, 'Tenés que verificar tu identidad antes de retirar');
  if (!user.payout_method) throw bad('Configurá tu método de cobro en "Cuenta"');
  if (amount < s.withdraw_min_pyg) throw bad(`El retiro mínimo es Gs. ${s.withdraw_min_pyg.toLocaleString('es-PY')}`);
  const q = payoutQuote({ amount, currency, s });
  if (q.net <= 0) throw bad('El monto no cubre la comisión de retiro');
  return tx(db, () => {
    const { disponible } = balances(db, user.id, now);
    if (amount > disponible) throw bad('Saldo disponible insuficiente');
    const r = db.prepare(
      `INSERT INTO withdrawals (user_id, amount_pyg, fee_pyg, currency, amount_out_minor, fx_rate, spread_gain_pyg, method, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(user.id, amount, q.fee, currency, q.amountOutMinor, q.fxRate, q.spreadGain, user.payout_method, now);
    const wid = Number(r.lastInsertRowid);
    entry(db, { userId: user.id, withdrawalId: wid, amount: -amount, type: 'retiro', availableAt: now, now });
    return { id: wid, ...q };
  });
}

export function processWithdrawal(db, id, status, note, now) {
  if (!['pagado', 'rechazado'].includes(status)) throw bad('Estado de retiro inválido');
  return tx(db, () => {
    const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
    if (!w || w.status !== 'solicitado') throw bad('El retiro ya fue procesado');
    db.prepare('UPDATE withdrawals SET status = ?, admin_note = ?, processed_at = ? WHERE id = ?').run(status, note, now, id);
    if (status === 'pagado') {
      entry(db, { withdrawalId: id, amount: w.fee_pyg, type: 'comision_retiro', availableAt: now, now });
      if (w.spread_gain_pyg) entry(db, { withdrawalId: id, amount: w.spread_gain_pyg, type: 'spread_cambio', availableAt: now, now });
    } else {
      entry(db, { userId: w.user_id, withdrawalId: id, amount: w.amount_pyg, type: 'retiro_rechazado', availableAt: now, now });
    }
  });
}

// ---------- Control contable ----------

// Verifica que el dinero de un pedido pagado cuadre: lo que se repartió en el libro
// más el costo de la pasarela tiene que ser exactamente lo que pagó el comprador.
export function orderLedgerTotal(db, orderId) {
  return db.prepare('SELECT COALESCE(SUM(amount_pyg), 0) AS t FROM ledger WHERE order_id = ?').get(orderId).t;
}
