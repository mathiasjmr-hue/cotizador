import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { openDb, getSettings } from '../src/db.js';
import { buildGateways } from '../src/gateways/index.js';
import { pagopar } from '../src/gateways/pagopar.js';
import { createApp, createUser } from '../src/app.js';
import { DAY } from '../src/services.js';

const PRIV = 'clave-privada-de-prueba';
let db, server, base, clock;

// Cliente con su propia cookie de sesión.
function client() {
  let cookie = '';
  return async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}

before(async () => {
  db = openDb(':memory:');
  clock = Date.UTC(2026, 10, 5, 12);
  // Pagopar real para validar firmas de los avisos, sin llamar a su API al crear el pago.
  const pp = pagopar({ publicKey: 'pub', privateKey: PRIV });
  pp.create = async (order) => ({ ref: 'HASH-' + order.public_code, redirect: 'https://www.pagopar.com/pagos/x' });
  const gateways = { ...buildGateways({ simulator: true }), pagopar: pp };
  const handler = createApp(db, { gateways, publicUrl: 'http://tienda.test', now: () => clock, log: () => {} });
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('flujo completo por la API: registro, producto, venta, pago, envío, entrega, liberación y retiro', async () => {
  const prov = client();
  const vend = client();
  const comprador = client();
  const admin = client();

  // Registro
  let r = await prov('POST', '/api/registro', {
    email: 'prov@test.py', password: 'secreta123', name: 'Proveedor SA', country: 'PY', role: 'proveedor',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.pass_hash, undefined);
  r = await vend('POST', '/api/registro', {
    email: 'vend@test.ar', password: 'secreta123', name: 'Vendedora', country: 'AR', role: 'vendedor', store_name: 'Tienda Única',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.store_slug, 'tienda-unica');
  r = await vend('POST', '/api/registro', {
    email: 'otro@test.py', password: 'secreta123', name: 'X', country: 'PY', role: 'admin',
  });
  assert.equal(r.status, 400, 'nadie se registra como admin');

  // Producto del proveedor
  r = await prov('POST', '/api/productos', {
    title: 'Auriculares', wholesale_pyg: 100000, shipping_pyg: 20000, stock: 5, ships_to: 'PY,AR',
  });
  assert.equal(r.status, 201);
  const productId = r.body.id;
  assert.equal((await vend('POST', '/api/productos', { title: 'x', wholesale_pyg: 1000 })).status, 403);

  // El vendedor lo ve en el catálogo con el precio mínimo y lo publica
  r = await vend('GET', '/api/catalogo');
  const item = r.body.find((p) => p.id === productId);
  assert.ok(item.min_retail_pyg > 120000);
  assert.equal((await vend('POST', '/api/publicaciones', { product_id: productId, retail_pyg: 120000 })).status, 400);
  r = await vend('POST', '/api/publicaciones', { product_id: productId, retail_pyg: 200000 });
  assert.equal(r.status, 201);
  const listingId = r.body.id;

  // Tienda pública: no muestra costos internos
  r = await comprador('GET', '/api/tienda/tienda-unica');
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.items[0].wholesale_pyg, undefined);

  // Checkout con el simulador
  const buyer = { name: 'Ana', email: 'ana@test.py', phone: '0981000000', document: '1234567', address: 'Asunción centro', country: 'PY' };
  r = await comprador('POST', '/api/checkout', { listing_id: listingId, qty: 2, buyer, gateway: 'simulado' });
  assert.equal(r.status, 201);
  assert.equal(r.body.total_pyg, 400000);
  const code = r.body.code;
  assert.match(r.body.redirect, /simulador/);
  r = await comprador('POST', `/api/simulador/${code}`, { ok: true });
  assert.equal(r.body.status, 'pagado');
  assert.equal(r.body.supplier_pyg, undefined, 'el comprador no ve el reparto');

  // Saldos retenidos
  assert.deepEqual(pick(await prov('GET', '/api/saldo')), { disponible: 0, retenido: 240000 });
  assert.deepEqual(pick(await vend('GET', '/api/saldo')), { disponible: 0, retenido: 100000 });

  // Envío por el proveedor y confirmación del comprador
  r = await prov('GET', '/api/proveedor/pedidos');
  const orderId = r.body[0].id;
  assert.equal(r.body[0].buyer_address, 'Asunción centro');
  assert.equal((await comprador('POST', `/api/pedido/${code}/recibido`, {})).status, 400, 'no se confirma antes del envío');
  assert.equal((await prov('POST', `/api/proveedor/pedidos/${orderId}/envio`, { tracking: 'AEX-123' })).status, 200);
  r = await comprador('POST', `/api/pedido/${code}/recibido`, {});
  assert.equal(r.body.status, 'entregado');

  // Liberación después de la garantía
  clock += getSettings(db).hold_days * DAY;
  assert.deepEqual(pick(await vend('GET', '/api/saldo')), { disponible: 100000, retenido: 0 });

  // Retiro: primero exige identidad verificada y método de cobro
  r = await vend('POST', '/api/retiros', { amount: 100000, currency: 'PYG' });
  assert.equal(r.status, 403);
  await vend('PUT', '/api/cuenta/cobro', { payout_method: 'Banco Galicia CBU 0070000000' });
  await vend('POST', '/api/cuenta/kyc', { legal_name: 'Vendedora Pérez', doc_type: 'DNI', doc_number: '30111222' });

  const a = createUser(db, { email: 'admin@test.py', password: 'administrador-seguro', name: 'Admin', country: 'PY', role: 'admin' }, clock);
  assert.equal(a.role, 'admin');
  await admin('POST', '/api/login', { email: 'admin@test.py', password: 'administrador-seguro' });
  r = await admin('GET', '/api/admin/kyc');
  const vendId = r.body.find((u) => u.email === 'vend@test.ar').id;
  assert.equal((await vend('POST', `/api/admin/kyc/${vendId}`, { status: 'verificado' })).status, 403);
  assert.equal((await admin('POST', `/api/admin/kyc/${vendId}`, { status: 'verificado' })).status, 200);

  r = await vend('POST', '/api/retiros', { amount: 100000, currency: 'PYG' });
  assert.equal(r.status, 201);
  assert.equal(r.body.amountOutMinor, 85000);
  assert.deepEqual(pick(await vend('GET', '/api/saldo')), { disponible: 0, retenido: 0 });

  r = await admin('POST', `/api/admin/retiros/${r.body.id}`, { status: 'pagado', note: 'transferido' });
  assert.equal(r.body.status, 'pagado');

  r = await admin('GET', '/api/admin/resumen');
  const ingresos = Object.fromEntries(r.body.ingresos.map((i) => [i.type, i.total_pyg]));
  assert.deepEqual(ingresos, { comision_venta: 40000, comision_retiro: 15000 });
});

test('aviso de pago de Pagopar: valida la firma y es idempotente', async () => {
  const vend = client();
  const prov = client();
  await prov('POST', '/api/registro', { email: 'p2@test.py', password: 'secreta123', name: 'Prov 2', country: 'PY', role: 'proveedor' });
  const p = await prov('POST', '/api/productos', { title: 'Mate', wholesale_pyg: 50000, stock: 3 });
  await vend('POST', '/api/registro', { email: 'v2@test.py', password: 'secreta123', name: 'Vend 2', country: 'PY', role: 'vendedor', store_name: 'Mates' });
  const l = await vend('POST', '/api/publicaciones', { product_id: p.body.id, retail_pyg: 90000 });
  const buyer = { name: 'Juan', email: 'juan@test.py', phone: '0991000000', document: '7654321', address: 'Luque centro', country: 'PY' };
  const c = await client()('POST', '/api/checkout', { listing_id: l.body.id, buyer, gateway: 'pagopar' });
  assert.equal(c.status, 201);
  const hash = 'HASH-' + c.body.code;

  const aviso = (token, monto = 90000) => ({
    respuesta: true,
    resultado: [{ pagado: true, cancelado: false, hash_pedido: hash, monto: String(monto), token }],
  });
  const good = crypto.createHash('sha1').update(PRIV + hash).digest('hex');
  const hook = client();

  let r = await hook('POST', '/api/webhooks/pagopar', aviso('0'.repeat(40)));
  assert.equal(r.status, 401, 'firma falsa');
  r = await hook('POST', '/api/webhooks/pagopar', aviso(good, 1000));
  assert.equal(r.status, 400, 'monto distinto');
  assert.equal((await hook('GET', `/api/pedido/${c.body.code}`)).body.status, 'pendiente_pago');

  r = await hook('POST', '/api/webhooks/pagopar', aviso(good));
  assert.equal(r.status, 200);
  assert.equal(r.body[0].hash_pedido, hash, 'responde lo que espera Pagopar');
  r = await hook('POST', '/api/webhooks/pagopar', aviso(good));
  assert.equal(r.status, 200);
  const n = db.prepare(`SELECT COUNT(*) AS n FROM ledger l JOIN orders o ON o.id = l.order_id WHERE o.public_code = ?`).get(c.body.code).n;
  assert.equal(n, 3, 'el aviso repetido no duplica asientos');
});

test('seguridad básica de la API', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/api/saldo')).status, 401);
  assert.deepEqual((await anon('GET', '/api/yo')).body, { user: null });
  assert.equal((await anon('GET', '/api/admin/resumen')).status, 401);
  // Sin JSON no se aceptan cambios (protección contra formularios de otros sitios).
  const res = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b',
  });
  assert.equal(res.status, 415);
  const r = await anon('POST', '/api/login', { email: 'prov@test.py', password: 'incorrecta' });
  assert.equal(r.status, 401);
  assert.equal((await anon('GET', '/api/no-existe')).status, 404);
});

function pick(r) {
  return { disponible: r.body.disponible, retenido: r.body.retenido };
}
