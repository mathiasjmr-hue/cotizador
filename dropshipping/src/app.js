// API HTTP de la plataforma. createApp devuelve un manejador (req, res) para node:http.
import { getSettings, DEFAULT_SETTINGS } from './db.js';
import { minRetail, feePctFor } from './money.js';
import {
  hashPassword, verifyPassword, createSession, userFromToken, destroySession, loginAllowed,
} from './auth.js';
import {
  HttpError, bad, createRouter, readBody, sendJson, parseCookies, serveStatic,
  str, int, email, country,
} from './http.js';
import {
  balances, prepareSaleOrder, prepareSubscriptionOrder, getOrderById, setGatewayRef,
  confirmPayment, failPayment, markShipped, markDelivered, refundOrder,
  requestWithdrawal, processWithdrawal, WITHDRAW_CURRENCIES,
} from './services.js';

const COOKIE = 'sid';
const ROLES_PUBLICOS = ['proveedor', 'vendedor'];
const KYC_DOCS = ['CI', 'RUC', 'PASAPORTE', 'DNI', 'OTRO'];

export function slugify(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tienda';
}

export function createUser(db, { email: mail, password, name, country: pais, role, storeName }, now) {
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(mail)) throw new HttpError(409, 'Ese email ya está registrado');
  let slug = null;
  if (role === 'vendedor') {
    const base = slugify(storeName);
    slug = base;
    for (let i = 2; db.prepare('SELECT 1 FROM users WHERE store_slug = ?').get(slug); i++) slug = `${base}-${i}`;
  }
  const r = db.prepare(
    `INSERT INTO users (email, pass_hash, name, country, role, store_name, store_slug, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(mail, hashPassword(password), name, pais, role, role === 'vendedor' ? storeName : null, slug, now);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid));
}

// Datos del usuario que se pueden mostrar (nunca el hash de la contraseña).
function publicUser(u, s, now) {
  return {
    id: u.id, email: u.email, name: u.name, country: u.country, role: u.role,
    store_name: u.store_name, store_slug: u.store_slug,
    plan: u.plan === 'pro' && (u.plan_until ?? 0) > now ? 'pro' : 'gratis', plan_until: u.plan_until,
    fee_pct: u.role === 'vendedor' ? feePctFor(u, s, now) : null,
    kyc_status: u.kyc_status, kyc_note: u.kyc_note, payout_method: u.payout_method,
  };
}

// Lo que ve el comprador de su pedido: sin el reparto interno del dinero.
function buyerView(o) {
  return {
    code: o.public_code, item_title: o.item_title, qty: o.qty, total_pyg: o.total_pyg,
    status: o.status, tracking: o.tracking, gateway: o.gateway,
    created_at: o.created_at, paid_at: o.paid_at, shipped_at: o.shipped_at, delivered_at: o.delivered_at,
  };
}

function buyerFrom(b) {
  const x = b ?? {};
  return {
    name: str(x.name, 'Nombre', { min: 2, max: 120 }),
    email: email(x.email),
    phone: str(x.phone, 'Teléfono', { min: 6, max: 30 }),
    document: str(x.document, 'Documento', { min: 3, max: 30 }),
    address: str(x.address, 'Dirección', { min: 5, max: 300 }),
    country: country(x.country),
  };
}

/**
 * cfg: {
 *   gateways: objeto de buildGateways(),
 *   publicUrl: URL pública del sitio (para las redirecciones de las pasarelas),
 *   publicDir: carpeta con el frontend (opcional),
 *   secureCookies: true en producción (HTTPS),
 *   now: () => ms (opcional, para pruebas),
 *   log: función de registro (opcional),
 * }
 */
export function createApp(db, cfg) {
  const gateways = cfg.gateways ?? {};
  const clock = cfg.now ?? (() => Date.now());
  const log = cfg.log ?? ((...a) => console.error(...a));
  const r = createRouter();

  const need = (ctx, ...roles) => {
    if (!ctx.user) throw new HttpError(401, 'Iniciá sesión');
    if (roles.length && !roles.includes(ctx.user.role)) throw new HttpError(403, 'No tenés permiso para esto');
    return ctx.user;
  };
  const gatewayOf = (id) => {
    const g = gateways[id];
    if (!g) throw bad('Medio de pago no disponible');
    return g;
  };
  const cookie = (token, maxAge) =>
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cfg.secureCookies ? '; Secure' : ''}`;

  async function startPayment(ctx, order, gatewayId) {
    const g = gatewayOf(gatewayId);
    let pay;
    try {
      pay = await g.create(order, { publicUrl: cfg.publicUrl, now: ctx.now });
    } catch (e) {
      log('Error al iniciar el pago', gatewayId, order.public_code, e.message);
      failPayment(db, order.id);
      throw new HttpError(502, 'No se pudo iniciar el pago. Probá de nuevo en unos minutos.');
    }
    setGatewayRef(db, order.id, pay.ref);
    return { code: order.public_code, redirect: pay.redirect, total_pyg: order.total_pyg };
  }

  // ---------- Cuentas ----------

  r.add('POST', '/api/registro', ({ body, now }) => {
    const role = body.role;
    if (!ROLES_PUBLICOS.includes(role)) throw bad('Rol: proveedor o vendedor');
    const u = createUser(db, {
      email: email(body.email),
      password: str(body.password, 'Contraseña', { min: 8, max: 200 }),
      name: str(body.name, 'Nombre', { min: 2, max: 120 }),
      country: country(body.country),
      role,
      storeName: role === 'vendedor' ? str(body.store_name, 'Nombre de la tienda', { min: 2, max: 80 }) : null,
    }, now);
    const token = createSession(db, u.id, now);
    return { status: 201, data: { user: publicUser(u, getSettings(db), now) }, headers: { 'set-cookie': cookie(token, 30 * 86400) } };
  });

  r.add('POST', '/api/login', ({ body, now, ip }) => {
    if (!loginAllowed(ip, now)) throw new HttpError(429, 'Demasiados intentos. Esperá 15 minutos.');
    const u = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(String(body.email ?? '').trim().toLowerCase());
    if (!u || !verifyPassword(String(body.password ?? ''), u.pass_hash)) throw new HttpError(401, 'Email o contraseña incorrectos');
    const token = createSession(db, u.id, now);
    return { data: { user: publicUser(u, getSettings(db), now) }, headers: { 'set-cookie': cookie(token, 30 * 86400) } };
  });

  r.add('POST', '/api/logout', ({ token }) => {
    destroySession(db, token);
    return { data: { ok: true }, headers: { 'set-cookie': cookie('', 0) } };
  });

  // Sin sesión responde user: null (no es un error: la página lo consulta al abrir).
  r.add('GET', '/api/yo', (ctx) => ({ data: { user: ctx.user ? publicUser(ctx.user, getSettings(db), ctx.now) : null } }));

  r.add('PUT', '/api/cuenta/cobro', (ctx) => {
    const u = need(ctx, 'proveedor', 'vendedor');
    const m = str(ctx.body.payout_method, 'Método de cobro', { min: 5, max: 300 });
    db.prepare('UPDATE users SET payout_method = ? WHERE id = ?').run(m, u.id);
    return { data: { ok: true } };
  });

  r.add('POST', '/api/cuenta/kyc', (ctx) => {
    const u = need(ctx, 'proveedor', 'vendedor');
    if (u.kyc_status === 'verificado') throw bad('Tu identidad ya está verificada');
    const docType = String(ctx.body.doc_type ?? '').toUpperCase();
    if (!KYC_DOCS.includes(docType)) throw bad(`Tipo de documento: ${KYC_DOCS.join(', ')}`);
    db.prepare(
      `UPDATE users SET kyc_status = 'pendiente', kyc_legal_name = ?, kyc_doc_type = ?, kyc_doc_number = ?, kyc_note = NULL WHERE id = ?`
    ).run(str(ctx.body.legal_name, 'Nombre legal', { min: 3, max: 160 }), docType,
      str(ctx.body.doc_number, 'Número de documento', { min: 3, max: 40 }), u.id);
    return { data: { kyc_status: 'pendiente' } };
  });

  // ---------- Saldos y retiros ----------

  r.add('GET', '/api/saldo', (ctx) => {
    const u = need(ctx, 'proveedor', 'vendedor');
    const movimientos = db.prepare(
      `SELECT id, order_id, withdrawal_id, amount_pyg, type, available_at, created_at
       FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 100`
    ).all(u.id);
    return { data: { ...balances(db, u.id, ctx.now), movimientos } };
  });

  r.add('POST', '/api/retiros', (ctx) => {
    const u = need(ctx, 'proveedor', 'vendedor');
    const currency = String(ctx.body.currency ?? 'PYG').toUpperCase();
    if (!WITHDRAW_CURRENCIES.includes(currency)) throw bad('Moneda no soportada (PYG o USD)');
    const w = requestWithdrawal(db, getSettings(db), u, { amount: int(ctx.body.amount, 'Monto', { min: 1 }), currency }, ctx.now);
    return { status: 201, data: w };
  });

  r.add('GET', '/api/retiros', (ctx) => {
    const u = need(ctx, 'proveedor', 'vendedor');
    return { data: db.prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC').all(u.id) };
  });

  // ---------- Proveedor: productos y envíos ----------

  const productFields = (b) => ({
    title: str(b.title, 'Título', { min: 3, max: 140 }),
    description: typeof b.description === 'string' ? b.description.slice(0, 5000) : '',
    image_url: (() => {
      const u = typeof b.image_url === 'string' ? b.image_url.trim() : '';
      if (u && !/^https:\/\/\S+$/.test(u)) throw bad('La imagen debe ser un enlace https');
      return u.slice(0, 500);
    })(),
    wholesale_pyg: int(b.wholesale_pyg, 'Precio mayorista', { min: 1000 }),
    shipping_pyg: int(b.shipping_pyg ?? 0, 'Costo de envío', { min: 0 }),
    stock: int(b.stock ?? 0, 'Stock', { min: 0, max: 1e6 }),
    ships_to: (() => {
      const list = String(b.ships_to ?? 'PY').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
      if (!list.length || !list.every((c) => c === '*' || /^[A-Z]{2}$/.test(c))) throw bad('Envía a: códigos de país separados por coma, o *');
      return list.join(',');
    })(),
  });

  r.add('POST', '/api/productos', (ctx) => {
    const u = need(ctx, 'proveedor');
    const p = productFields(ctx.body);
    const res = db.prepare(
      `INSERT INTO products (supplier_id, title, description, image_url, wholesale_pyg, shipping_pyg, stock, ships_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(u.id, p.title, p.description, p.image_url, p.wholesale_pyg, p.shipping_pyg, p.stock, p.ships_to, ctx.now);
    return { status: 201, data: db.prepare('SELECT * FROM products WHERE id = ?').get(Number(res.lastInsertRowid)) };
  });

  r.add('PUT', '/api/productos/:id', (ctx) => {
    const u = need(ctx, 'proveedor');
    const p = productFields(ctx.body);
    const active = ctx.body.active === undefined ? 1 : ctx.body.active ? 1 : 0;
    const res = db.prepare(
      `UPDATE products SET title = ?, description = ?, image_url = ?, wholesale_pyg = ?, shipping_pyg = ?, stock = ?, ships_to = ?, active = ?
       WHERE id = ? AND supplier_id = ?`
    ).run(p.title, p.description, p.image_url, p.wholesale_pyg, p.shipping_pyg, p.stock, p.ships_to, active, Number(ctx.params.id), u.id);
    if (!res.changes) throw new HttpError(404, 'Producto inexistente');
    return { data: db.prepare('SELECT * FROM products WHERE id = ?').get(Number(ctx.params.id)) };
  });

  r.add('GET', '/api/mis-productos', (ctx) => {
    const u = need(ctx, 'proveedor');
    return { data: db.prepare('SELECT * FROM products WHERE supplier_id = ? ORDER BY id DESC').all(u.id) };
  });

  r.add('GET', '/api/proveedor/pedidos', (ctx) => {
    const u = need(ctx, 'proveedor');
    return {
      data: db.prepare(
        `SELECT id, public_code, item_title, qty, buyer_name, buyer_phone, buyer_document, buyer_address, buyer_country,
                supplier_pyg, status, tracking, paid_at, shipped_at, delivered_at, created_at
         FROM orders WHERE supplier_id = ? AND kind = 'venta' AND status != 'pendiente_pago' AND status != 'rechazado'
         ORDER BY id DESC`
      ).all(u.id),
    };
  });

  r.add('POST', '/api/proveedor/pedidos/:id/envio', (ctx) => {
    const u = need(ctx, 'proveedor');
    markShipped(db, u.id, Number(ctx.params.id), str(ctx.body.tracking, 'Código de seguimiento', { min: 2, max: 120 }), ctx.now);
    return { data: { ok: true } };
  });

  // ---------- Vendedor: catálogo, publicaciones, ventas y plan ----------

  r.add('GET', '/api/catalogo', (ctx) => {
    const u = need(ctx, 'vendedor');
    const s = getSettings(db);
    const feePct = feePctFor(u, s, ctx.now);
    const rows = db.prepare(
      `SELECT p.id, p.title, p.description, p.image_url, p.wholesale_pyg, p.shipping_pyg, p.stock, p.ships_to,
              sup.name AS supplier_name, sup.country AS supplier_country
       FROM products p JOIN users sup ON sup.id = p.supplier_id
       WHERE p.active = 1 AND sup.active = 1 AND p.stock > 0 ORDER BY p.id DESC LIMIT 500`
    ).all();
    for (const p of rows) {
      p.min_retail_pyg = minRetail({ wholesale: p.wholesale_pyg, shipping: p.shipping_pyg, feePct, gatewayPct: s.gateway_fee_pct });
    }
    return { data: rows };
  });

  const checkRetail = (u, productId, retail, now) => {
    const s = getSettings(db);
    const p = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
    if (!p) throw new HttpError(404, 'Producto inexistente');
    const min = minRetail({ wholesale: p.wholesale_pyg, shipping: p.shipping_pyg, feePct: feePctFor(u, s, now), gatewayPct: s.gateway_fee_pct });
    if (retail < min) throw bad(`El precio mínimo para no perder dinero es Gs. ${min.toLocaleString('es-PY')}`);
    return s;
  };

  r.add('POST', '/api/publicaciones', (ctx) => {
    const u = need(ctx, 'vendedor');
    const productId = int(ctx.body.product_id, 'Producto', { min: 1 });
    const retail = int(ctx.body.retail_pyg, 'Precio de venta', { min: 1 });
    const s = checkRetail(u, productId, retail, ctx.now);
    if (feePctFor(u, s, ctx.now) !== s.fee_pct_pro) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM listings WHERE seller_id = ? AND active = 1').get(u.id).n;
      if (n >= s.max_listings_gratis) throw new HttpError(402, `El plan Gratis permite ${s.max_listings_gratis} productos. Pasate a Pro para publicar más.`);
    }
    if (db.prepare('SELECT 1 FROM listings WHERE seller_id = ? AND product_id = ?').get(u.id, productId)) {
      throw new HttpError(409, 'Ya publicaste este producto');
    }
    const res = db.prepare('INSERT INTO listings (seller_id, product_id, retail_pyg, created_at) VALUES (?, ?, ?, ?)')
      .run(u.id, productId, retail, ctx.now);
    return { status: 201, data: db.prepare('SELECT * FROM listings WHERE id = ?').get(Number(res.lastInsertRowid)) };
  });

  r.add('PUT', '/api/publicaciones/:id', (ctx) => {
    const u = need(ctx, 'vendedor');
    const l = db.prepare('SELECT * FROM listings WHERE id = ? AND seller_id = ?').get(Number(ctx.params.id), u.id);
    if (!l) throw new HttpError(404, 'Publicación inexistente');
    const retail = int(ctx.body.retail_pyg ?? l.retail_pyg, 'Precio de venta', { min: 1 });
    checkRetail(u, l.product_id, retail, ctx.now);
    const active = ctx.body.active === undefined ? l.active : ctx.body.active ? 1 : 0;
    db.prepare('UPDATE listings SET retail_pyg = ?, active = ? WHERE id = ?').run(retail, active, l.id);
    return { data: db.prepare('SELECT * FROM listings WHERE id = ?').get(l.id) };
  });

  r.add('GET', '/api/mis-publicaciones', (ctx) => {
    const u = need(ctx, 'vendedor');
    return {
      data: db.prepare(
        `SELECT l.*, p.title, p.image_url, p.stock, p.wholesale_pyg, p.shipping_pyg, p.active AS product_active
         FROM listings l JOIN products p ON p.id = l.product_id WHERE l.seller_id = ? ORDER BY l.id DESC`
      ).all(u.id),
    };
  });

  r.add('GET', '/api/vendedor/pedidos', (ctx) => {
    const u = need(ctx, 'vendedor');
    return {
      data: db.prepare(
        `SELECT id, public_code, item_title, qty, buyer_name, buyer_country, total_pyg, seller_pyg, platform_fee_pyg,
                status, tracking, paid_at, shipped_at, delivered_at, created_at
         FROM orders WHERE seller_id = ? AND kind = 'venta' ORDER BY id DESC`
      ).all(u.id),
    };
  });

  r.add('POST', '/api/plan-pro', async (ctx) => {
    const u = need(ctx, 'vendedor');
    gatewayOf(ctx.body.gateway);
    const order = prepareSubscriptionOrder(db, getSettings(db), u, ctx.body.gateway, ctx.now);
    return { status: 201, data: await startPayment(ctx, order, ctx.body.gateway) };
  });

  // ---------- Tienda pública y checkout ----------

  r.add('GET', '/api/pasarelas', () => ({
    data: Object.values(gateways).map((g) => ({ id: g.id, name: g.name, checkoutScript: g.checkoutScript ?? null })),
  }));

  r.add('GET', '/api/tienda/:slug', ({ params }) => {
    const seller = db.prepare(`SELECT id, store_name, store_slug, country FROM users WHERE store_slug = ? AND active = 1 AND role = 'vendedor'`).get(params.slug);
    if (!seller) throw new HttpError(404, 'Tienda inexistente');
    const items = db.prepare(
      `SELECT l.id AS listing_id, l.retail_pyg, p.title, p.description, p.image_url, p.ships_to, p.stock > 0 AS in_stock
       FROM listings l JOIN products p ON p.id = l.product_id JOIN users sup ON sup.id = p.supplier_id
       WHERE l.seller_id = ? AND l.active = 1 AND p.active = 1 AND sup.active = 1 ORDER BY l.id DESC`
    ).all(seller.id);
    return { data: { store_name: seller.store_name, store_slug: seller.store_slug, country: seller.country, items } };
  });

  r.add('POST', '/api/checkout', async (ctx) => {
    const b = ctx.body;
    gatewayOf(b.gateway);
    const order = prepareSaleOrder(db, getSettings(db), {
      listingId: int(b.listing_id, 'Producto', { min: 1 }),
      qty: int(b.qty ?? 1, 'Cantidad', { min: 1, max: 100 }),
      buyer: buyerFrom(b.buyer),
      gateway: b.gateway,
    }, ctx.now);
    return { status: 201, data: await startPayment(ctx, order, b.gateway) };
  });

  const orderByCode = (code) => {
    const o = db.prepare('SELECT * FROM orders WHERE public_code = ?').get(code);
    if (!o) throw new HttpError(404, 'Pedido inexistente');
    return o;
  };

  r.add('GET', '/api/pedido/:code', ({ params }) => ({ data: buyerView(orderByCode(params.code)) }));

  // El comprador confirma que recibió el producto: empieza a correr el plazo de garantía.
  r.add('POST', '/api/pedido/:code/recibido', ({ params, now }) => {
    const o = orderByCode(params.code);
    if (!markDelivered(db, getSettings(db), o.id, now)) throw bad('El pedido todavía no fue enviado');
    return { data: buyerView(getOrderById(db, o.id)) };
  });

  // ---------- Avisos de pago de las pasarelas ----------

  function settle(gatewayId, ref, paid, failed, amount, now) {
    const o = db.prepare('SELECT * FROM orders WHERE gateway = ? AND gateway_ref = ?').get(gatewayId, ref);
    if (!o) throw new HttpError(404, 'Pedido inexistente');
    if (paid) confirmPayment(db, getSettings(db), o.id, amount, now);
    else if (failed) failPayment(db, o.id);
    return o;
  }

  r.add('POST', '/api/webhooks/:gateway', ({ params, body, now }) => {
    const g = gateways[params.gateway];
    if (!g?.parseWebhook) throw new HttpError(404, 'Pasarela desconocida');
    let n;
    try {
      n = g.parseWebhook(body);
    } catch (e) {
      log('Aviso de pago rechazado', params.gateway, e.message);
      throw new HttpError(401, 'Aviso de pago inválido');
    }
    settle(g.id, n.ref, n.paid, n.failed, n.amount, now);
    return { data: n.reply ?? { ok: true } };
  }, { webhook: true });

  // Simulador de pagos: solo existe si la pasarela "simulado" está habilitada (desarrollo).
  r.add('POST', '/api/simulador/:code', ({ params, body, now }) => {
    if (!gateways.simulado) throw new HttpError(404, 'No encontrado');
    const o = orderByCode(params.code);
    if (o.gateway !== 'simulado') throw bad('Este pedido no usa el simulador');
    const ok = body.ok !== false;
    settle('simulado', o.gateway_ref, ok, !ok, o.total_pyg, now);
    return { data: buyerView(getOrderById(db, o.id)) };
  });

  // ---------- Administración ----------

  r.add('GET', '/api/admin/resumen', (ctx) => {
    need(ctx, 'admin');
    const ingresos = db.prepare(
      'SELECT type, SUM(amount_pyg) AS total_pyg, COUNT(*) AS n FROM ledger WHERE user_id IS NULL GROUP BY type'
    ).all();
    const retenido = db.prepare(
      'SELECT COALESCE(SUM(amount_pyg), 0) AS t FROM ledger WHERE user_id IS NOT NULL AND (available_at IS NULL OR available_at > ?)'
    ).get(ctx.now).t;
    const disponible = db.prepare(
      'SELECT COALESCE(SUM(amount_pyg), 0) AS t FROM ledger WHERE user_id IS NOT NULL AND available_at <= ?'
    ).get(ctx.now).t;
    const pedidos = db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all();
    return { data: { ingresos, saldo_usuarios: { retenido, disponible }, pedidos } };
  });

  r.add('GET', '/api/admin/ajustes', (ctx) => {
    need(ctx, 'admin');
    return { data: getSettings(db) };
  });

  r.add('PUT', '/api/admin/ajustes', (ctx) => {
    need(ctx, 'admin');
    const upd = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(ctx.body)) {
      if (!(k in DEFAULT_SETTINGS)) throw bad(`Ajuste desconocido: ${k}`);
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw bad(`${k}: número mayor o igual a 0`);
      if (k.endsWith('_pyg') && !Number.isInteger(n)) throw bad(`${k}: debe ser un entero en guaraníes`);
    }
    for (const [k, v] of Object.entries(ctx.body)) upd.run(k, String(Number(v)));
    return { data: getSettings(db) };
  });

  r.add('GET', '/api/admin/kyc', (ctx) => {
    need(ctx, 'admin');
    return {
      data: db.prepare(
        `SELECT id, email, name, country, role, kyc_status, kyc_legal_name, kyc_doc_type, kyc_doc_number
         FROM users WHERE kyc_status = 'pendiente' ORDER BY id`
      ).all(),
    };
  });

  r.add('POST', '/api/admin/kyc/:id', (ctx) => {
    need(ctx, 'admin');
    const status = ctx.body.status;
    if (!['verificado', 'rechazado'].includes(status)) throw bad('Estado: verificado o rechazado');
    const res = db.prepare(`UPDATE users SET kyc_status = ?, kyc_note = ? WHERE id = ? AND kyc_status = 'pendiente'`)
      .run(status, typeof ctx.body.note === 'string' ? ctx.body.note.slice(0, 300) : null, Number(ctx.params.id));
    if (!res.changes) throw bad('No hay una verificación pendiente para ese usuario');
    return { data: { ok: true } };
  });

  r.add('GET', '/api/admin/retiros', (ctx) => {
    need(ctx, 'admin');
    return {
      data: db.prepare(
        `SELECT w.*, u.email, u.name, u.kyc_legal_name FROM withdrawals w JOIN users u ON u.id = w.user_id
         ORDER BY w.status = 'solicitado' DESC, w.id DESC LIMIT 200`
      ).all(),
    };
  });

  r.add('POST', '/api/admin/retiros/:id', (ctx) => {
    need(ctx, 'admin');
    const note = typeof ctx.body.note === 'string' ? ctx.body.note.slice(0, 300) : '';
    processWithdrawal(db, Number(ctx.params.id), ctx.body.status, note, ctx.now);
    return { data: db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(Number(ctx.params.id)) };
  });

  r.add('GET', '/api/admin/pedidos', (ctx) => {
    need(ctx, 'admin');
    return {
      data: db.prepare(
        `SELECT o.id, o.kind, o.public_code, o.item_title, o.qty, o.total_pyg, o.platform_fee_pyg, o.status, o.gateway,
                o.tracking, o.created_at, o.paid_at, o.shipped_at, o.delivered_at, o.buyer_name, o.buyer_country,
                sel.store_name AS seller_store, sup.name AS supplier_name
         FROM orders o LEFT JOIN users sel ON sel.id = o.seller_id LEFT JOIN users sup ON sup.id = o.supplier_id
         WHERE o.status != 'pendiente_pago' ORDER BY o.id DESC LIMIT 300`
      ).all(),
    };
  });

  r.add('GET', '/api/admin/usuarios', (ctx) => {
    need(ctx, 'admin');
    return {
      data: db.prepare(
        `SELECT id, email, name, country, role, store_name, plan, plan_until, kyc_status, active, created_at
         FROM users ORDER BY id DESC LIMIT 500`
      ).all(),
    };
  });

  r.add('POST', '/api/admin/pedidos/:id/reembolso', (ctx) => {
    need(ctx, 'admin');
    refundOrder(db, Number(ctx.params.id), ctx.now);
    return { data: getOrderById(db, Number(ctx.params.id)) };
  });

  r.add('POST', '/api/admin/pedidos/:id/entregado', (ctx) => {
    need(ctx, 'admin');
    if (!markDelivered(db, getSettings(db), Number(ctx.params.id), ctx.now)) throw bad('El pedido no está enviado');
    return { data: getOrderById(db, Number(ctx.params.id)) };
  });

  r.add('POST', '/api/admin/usuarios/:id/activo', (ctx) => {
    const admin = need(ctx, 'admin');
    if (Number(ctx.params.id) === admin.id) throw bad('No podés desactivar tu propia cuenta');
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(ctx.body.active ? 1 : 0, Number(ctx.params.id));
    if (!ctx.body.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(Number(ctx.params.id));
    return { data: { ok: true } };
  });

  // ---------- Manejador ----------

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (cfg.publicDir && req.method === 'GET') return serveStatic(res, cfg.publicDir, url.pathname);
        throw new HttpError(404, 'No encontrado');
      }
      const m = r.match(req.method, url.pathname);
      if (!m) throw new HttpError(404, 'No encontrado');
      const now = clock();
      let body = {};
      if (req.method !== 'GET') {
        // Fuera de los avisos de las pasarelas solo se acepta JSON: un formulario de otro sitio no puede enviarlo.
        if (!m.route.opts.webhook && !String(req.headers['content-type'] ?? '').includes('application/json')) {
          throw new HttpError(415, 'Enviá los datos como JSON');
        }
        body = await readBody(req);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw bad('Cuerpo inválido');
      }
      const token = parseCookies(req.headers.cookie)[COOKIE] || null;
      const ctx = {
        req, body, now, token, params: m.params, query: url.searchParams,
        ip: req.socket?.remoteAddress ?? '',
        user: m.route.opts.webhook ? null : userFromToken(db, token, now),
      };
      const out = await m.route.handler(ctx);
      return sendJson(res, out.status ?? 200, out.data, out.headers);
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      log('Error interno', req.method, url.pathname, e);
      return sendJson(res, 500, { error: 'Error interno' });
    }
  };
}
