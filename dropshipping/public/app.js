// Frontend de Dropshipping PY: una sola página, sin dependencias, con rutas por #hash.
// Todo el texto se inserta con textContent (nunca innerHTML) para evitar inyección de código.

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const toastEl = document.getElementById('toast');

let me = null;          // usuario con sesión, o null
let gatewaysCache = null;

// ---------- Utilidades ----------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const gs = (n) => 'Gs. ' + Number(n ?? 0).toLocaleString('es-PY');
const usd = (cents) => 'US$ ' + (cents / 100).toLocaleString('es-PY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fdate = (ms) => (ms ? new Date(ms).toLocaleDateString('es-PY', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

function toast(msg, bad = false) {
  toastEl.textContent = msg;
  toastEl.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (toastEl.className = ''), 3500);
}

// Ejecuta una acción con el botón deshabilitado y muestra el error si falla.
async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function formData(form) {
  const out = {};
  for (const [k, v] of new FormData(form)) out[k] = typeof v === 'string' ? v.trim() : v;
  return out;
}

const field = (label, input, hint) => h('label', null, label, hint ? h('span', { class: 'hint' }, hint) : null, input);
const input = (name, attrs = {}) => h('input', { name, ...attrs });

const COUNTRIES = [
  ['PY', 'Paraguay'], ['AR', 'Argentina'], ['BR', 'Brasil'], ['UY', 'Uruguay'], ['BO', 'Bolivia'],
  ['CL', 'Chile'], ['PE', 'Perú'], ['CO', 'Colombia'], ['EC', 'Ecuador'], ['VE', 'Venezuela'],
  ['MX', 'México'], ['US', 'Estados Unidos'], ['ES', 'España'], ['IT', 'Italia'], ['DE', 'Alemania'],
];
const countryName = (c) => COUNTRIES.find(([k]) => k === c)?.[1] ?? c;
function countrySelect(name = 'country', value = 'PY') {
  return h('select', { name, required: true },
    COUNTRIES.map(([k, n]) => h('option', { value: k, selected: k === value }, `${n} (${k})`)));
}

const ORDER_STATUS = {
  pendiente_pago: ['Esperando pago', 'warn'],
  pagado: ['Pagado · por enviar', 'info'],
  enviado: ['Enviado', 'info'],
  entregado: ['Entregado', 'ok'],
  rechazado: ['Pago rechazado', 'bad'],
  reembolsado: ['Reembolsado', 'bad'],
};
const statusBadge = (s) => {
  const [t, c] = ORDER_STATUS[s] ?? [s, ''];
  return h('span', { class: `badge ${c}` }, t);
};
const KYC = {
  sin_enviar: ['Sin verificar', 'warn'],
  pendiente: ['En revisión', 'info'],
  verificado: ['Verificada', 'ok'],
  rechazado: ['Rechazada', 'bad'],
};
const kycBadge = (s) => h('span', { class: `badge ${KYC[s]?.[1] ?? ''}` }, KYC[s]?.[0] ?? s);
const WITHDRAW_STATUS = { solicitado: ['Solicitado', 'warn'], pagado: ['Pagado', 'ok'], rechazado: ['Rechazado', 'bad'] };
const LEDGER = {
  venta_proveedor: 'Venta (tu parte como proveedor)',
  venta_vendedor: 'Venta (tu ganancia)',
  reembolso: 'Reembolso al comprador',
  retiro: 'Retiro',
  retiro_rechazado: 'Retiro rechazado (devuelto)',
  comision_venta: 'Comisión por venta',
  comision_retiro: 'Comisión por retiro',
  spread_cambio: 'Margen cambiario',
  suscripcion: 'Plan Pro',
};

function table(headers, rows, empty = 'Todavía no hay nada acá.') {
  if (!rows.length) return h('p', { class: 'muted' }, empty);
  return h('div', { class: 'table-wrap' },
    h('table', null,
      h('thead', null, h('tr', null, headers.map((x) => {
        const [t, num] = Array.isArray(x) ? x : [x, false];
        return h('th', { class: num ? 'num' : null }, t);
      }))),
      h('tbody', null, rows.map((cells) => h('tr', null, cells.map((c, i) => {
        const num = Array.isArray(headers[i]) && headers[i][1];
        return h('td', { class: num ? 'num' : null }, c);
      }))))));
}

function productImage(url, alt) {
  return h('div', { class: 'img' }, url && /^https:\/\//.test(url)
    ? h('img', { src: url, alt, loading: 'lazy', referrerpolicy: 'no-referrer' })
    : '📦');
}

// ---------- Rutas ----------

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { parts: path.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(qs ?? '') };
}
const go = (path) => { location.hash = '#' + path; };

function homeFor(u) {
  if (!u) return '/';
  return { proveedor: '/panel/productos', vendedor: '/panel/catalogo', admin: '/admin/resumen' }[u.role] ?? '/';
}

function renderNav(active) {
  nav.replaceChildren();
  const link = (href, text) => h('a', { href: '#' + href, 'aria-current': active.startsWith(href) ? 'page' : null }, text);
  if (!me) {
    nav.append(link('/entrar', 'Entrar'), h('a', { href: '#/registro', class: 'btn small' }, 'Crear cuenta'));
  } else {
    nav.append(link(homeFor(me).split('/').slice(0, 2).join('/') || '/', me.role === 'admin' ? 'Administración' : 'Mi panel'));
    if (me.role === 'vendedor' && me.store_slug) nav.append(link(`/t/${me.store_slug}`, 'Ver mi tienda'));
    nav.append(h('button', {
      onclick: async () => { await api('POST', '/api/logout', {}).catch(() => {}); me = null; go('/'); },
    }, 'Salir'));
  }
}

async function render() {
  const { parts, query } = parseHash();
  const path = '/' + parts.join('/');
  renderNav(path);
  app.replaceChildren(h('p', { class: 'muted' }, 'Cargando…'));
  try {
    const [a, b, c] = parts;
    let view;
    if (!a) view = await viewHome();
    else if (a === 'entrar') view = viewLogin();
    else if (a === 'registro') view = viewRegister(query.get('rol'));
    else if (a === 't' && b) view = await viewStore(b);
    else if (a === 'comprar' && b) view = await viewCheckout(b, Number(c));
    else if (a === 'pedido' && b) view = await viewOrder(b);
    else if (a === 'simulador' && b) view = await viewSimulator(b);
    else if (a === 'pago' && b === 'bancard' && c) view = await viewBancard(c, query.get('pid'));
    else if (a === 'panel') view = await viewPanel(b);
    else if (a === 'admin') view = await viewAdmin(b);
    else view = h('div', { class: 'card narrow' }, h('h1', null, 'Página no encontrada'), h('a', { href: '#/' }, 'Volver al inicio'));
    app.replaceChildren(view);
  } catch (e) {
    if (e.status === 401) { me = null; go('/entrar'); return; }
    app.replaceChildren(h('div', { class: 'card narrow' }, h('h2', null, 'No se pudo cargar'), h('p', { class: 'error' }, e.message),
      h('button', { class: 'btn secondary', onclick: render }, 'Reintentar')));
  }
  app.focus({ preventScroll: true });
}

async function refreshMe() {
  try { me = (await api('GET', '/api/yo')).user; } catch { me = null; }
}

// ---------- Inicio y cuentas ----------

async function viewHome() {
  if (me) { go(homeFor(me)); return h('p', { class: 'muted' }, 'Entrando…'); }
  return h('div', null,
    h('section', { class: 'hero' },
      h('h1', null, 'Vendé sin stock. Cobrá en Paraguay.'),
      h('p', null, 'Proveedores de Paraguay publican sus productos. Vendedores de cualquier país arman su tienda, ponen su precio y ganan la diferencia. Los compradores pagan con Pagopar o Bancard, y el dinero queda protegido hasta la entrega.'),
      h('div', { class: 'row' },
        h('a', { class: 'btn', href: '#/registro?rol=vendedor' }, 'Quiero vender'),
        h('a', { class: 'btn secondary', href: '#/registro?rol=proveedor' }, 'Soy proveedor'))),
    h('h2', null, 'Cómo funciona'),
    h('ol', { class: 'steps' },
      h('li', null, h('h3', null, 'El proveedor publica'), h('p', { class: 'muted small' }, 'Carga productos con su precio mayorista, costo de envío y países a los que envía.')),
      h('li', null, h('h3', null, 'El vendedor arma su tienda'), h('p', { class: 'muted small' }, 'Elige productos del catálogo y pone su precio. El sistema le muestra el mínimo para no perder.')),
      h('li', null, h('h3', null, 'El comprador paga'), h('p', { class: 'muted small' }, 'Con tarjeta, billetera o bocas de cobranza. El dinero queda retenido hasta que recibe el producto.')),
      h('li', null, h('h3', null, 'Todos cobran'), h('p', { class: 'muted small' }, 'Tras la entrega y el plazo de garantía, proveedor y vendedor retiran su saldo en guaraníes o dólares.'))));
}

function viewLogin() {
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      busy(form.querySelector('button'), async () => {
        me = (await api('POST', '/api/login', formData(form))).user;
        go(homeFor(me));
      });
    },
  },
  field('Email', input('email', { type: 'email', required: true, autocomplete: 'email' })),
  field('Contraseña', input('password', { type: 'password', required: true, autocomplete: 'current-password' })),
  h('button', { class: 'btn' }, 'Entrar'));
  return h('div', { class: 'card narrow stack' }, h('h1', null, 'Entrar'), form,
    h('p', { class: 'muted small' }, '¿No tenés cuenta? ', h('a', { href: '#/registro' }, 'Creá una gratis')));
}

function viewRegister(rol) {
  const storeField = field('Nombre de tu tienda', input('store_name', { maxlength: 80 }), 'Va a aparecer en el enlace de tu tienda');
  const roleSel = h('select', { name: 'role', onchange: () => sync() },
    h('option', { value: 'vendedor', selected: rol !== 'proveedor' }, 'Vendedor: armo mi tienda y vendo'),
    h('option', { value: 'proveedor', selected: rol === 'proveedor' }, 'Proveedor: tengo productos en Paraguay'));
  const sync = () => {
    const v = roleSel.value === 'vendedor';
    storeField.hidden = !v;
    storeField.querySelector('input').required = v;
  };
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      busy(form.querySelector('button'), async () => {
        const d = formData(form);
        if (d.role !== 'vendedor') delete d.store_name;
        me = (await api('POST', '/api/registro', d)).user;
        toast('¡Cuenta creada!');
        go(homeFor(me));
      });
    },
  },
  field('Quiero ser', roleSel),
  field('Nombre y apellido', input('name', { required: true, autocomplete: 'name', maxlength: 120 })),
  storeField,
  field('País', countrySelect()),
  field('Email', input('email', { type: 'email', required: true, autocomplete: 'email' })),
  field('Contraseña', input('password', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' }), 'Mínimo 8 caracteres'),
  h('button', { class: 'btn' }, 'Crear cuenta'));
  sync();
  return h('div', { class: 'card narrow stack' }, h('h1', null, 'Crear cuenta'), form,
    h('p', { class: 'muted small' }, '¿Ya tenés cuenta? ', h('a', { href: '#/entrar' }, 'Entrá')));
}

// ---------- Tienda pública y compra ----------

async function getGateways() {
  if (!gatewaysCache) gatewaysCache = await api('GET', '/api/pasarelas');
  return gatewaysCache;
}

async function viewStore(slug) {
  const s = await api('GET', `/api/tienda/${encodeURIComponent(slug)}`);
  return h('div', { class: 'stack' },
    h('div', null, h('h1', null, s.store_name), h('p', { class: 'muted' }, `Tienda de ${countryName(s.country)}`)),
    s.items.length
      ? h('div', { class: 'grid' }, s.items.map((it) => h('article', { class: 'card product' },
        productImage(it.image_url, it.title),
        h('div', { class: 'body' },
          h('h3', null, it.title),
          it.description ? h('p', { class: 'muted small' }, it.description.slice(0, 160)) : null,
          h('div', { class: 'price' }, gs(it.retail_pyg)),
          h('p', { class: 'muted small' }, 'Envía a: ', it.ships_to === '*' ? 'todo el mundo' : it.ships_to.split(',').map(countryName).join(', ')),
          it.in_stock
            ? h('a', { class: 'btn', href: `#/comprar/${encodeURIComponent(slug)}/${it.listing_id}` }, 'Comprar')
            : h('span', { class: 'badge bad' }, 'Sin stock')))))
      : h('p', { class: 'muted' }, 'Esta tienda todavía no tiene productos.'));
}

async function viewCheckout(slug, listingId) {
  const [s, gws] = await Promise.all([api('GET', `/api/tienda/${encodeURIComponent(slug)}`), getGateways()]);
  const it = s.items.find((x) => x.listing_id === listingId);
  if (!it) throw new Error('Este producto ya no está disponible');
  if (!gws.length) throw new Error('La tienda no tiene medios de pago habilitados en este momento');
  const qty = input('qty', { type: 'number', min: 1, max: 100, value: 1, required: true });
  const total = h('strong', null, gs(it.retail_pyg));
  qty.addEventListener('input', () => { total.textContent = gs(it.retail_pyg * Math.max(1, Number(qty.value) || 1)); });
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      busy(form.querySelector('button[type=submit]'), async () => {
        const d = formData(form);
        const r = await api('POST', '/api/checkout', {
          listing_id: listingId, qty: Number(d.qty), gateway: d.gateway,
          buyer: { name: d.name, email: d.email, phone: d.phone, document: d.document, address: d.address, country: d.country },
        });
        try { localStorage.setItem('ultimo-pedido', r.code); } catch { /* sin almacenamiento */ }
        // La pasarela puede ser otro sitio (Pagopar) o una página de esta misma tienda (simulador, Bancard).
        location.href = r.redirect;
      });
    },
  },
  h('div', { class: 'two' }, field('Cantidad', qty), h('div', { class: 'row', style: 'align-self:end;min-height:44px' }, 'Total: ', total)),
  h('h3', null, 'Tus datos para el envío'),
  field('Nombre y apellido', input('name', { required: true, autocomplete: 'name' })),
  h('div', { class: 'two' },
    field('Email', input('email', { type: 'email', required: true, autocomplete: 'email' }), 'Te avisamos ahí del pedido'),
    field('Teléfono', input('phone', { type: 'tel', required: true, autocomplete: 'tel' }))),
  h('div', { class: 'two' },
    field('Documento (CI, DNI o pasaporte)', input('document', { required: true })),
    field('País', countrySelect('country', 'PY'))),
  field('Dirección completa', h('textarea', { name: 'address', required: true, autocomplete: 'street-address', placeholder: 'Calle, número, barrio, ciudad y referencias' })),
  h('h3', null, 'Medio de pago'),
  h('div', { class: 'stack' }, gws.map((g, i) => h('label', { class: 'row', style: 'font-weight:500' },
    h('input', { type: 'radio', name: 'gateway', value: g.id, checked: i === 0, style: 'width:auto;min-height:0' }), g.name))),
  h('p', { class: 'notice info small' }, 'Tu pago queda protegido: el vendedor y el proveedor recién cobran después de que recibís el producto.'),
  h('button', { class: 'btn', type: 'submit' }, 'Ir a pagar'));
  return h('div', { class: 'card narrow stack', style: 'max-width:620px' },
    h('a', { href: `#/t/${encodeURIComponent(slug)}`, class: 'small' }, '← Volver a la tienda'),
    h('div', { class: 'row' }, h('h1', { style: 'margin:0' }, it.title)),
    h('p', { class: 'price' }, gs(it.retail_pyg), h('span', { class: 'muted small' }, ' por unidad')),
    form);
}

async function viewOrder(code) {
  const o = await api('GET', `/api/pedido/${encodeURIComponent(code)}`);
  const steps = [
    ['Pedido creado', true],
    ['Pago confirmado', !!o.paid_at],
    [o.tracking ? `Enviado · seguimiento ${o.tracking}` : 'Enviado', !!o.shipped_at],
    ['Recibido', !!o.delivered_at],
  ];
  const confirm = o.status === 'enviado' ? h('button', {
    class: 'btn',
    onclick: (e) => busy(e.currentTarget, async () => {
      await api('POST', `/api/pedido/${encodeURIComponent(code)}/recibido`, {});
      toast('¡Gracias! Confirmaste la entrega.');
      render();
    }),
  }, 'Ya recibí mi pedido') : null;
  return h('div', { class: 'card narrow stack' },
    h('p', { class: 'muted small' }, `Pedido ${o.code}`),
    h('h1', null, o.item_title),
    h('div', { class: 'row' }, statusBadge(o.status), h('span', null, `${o.qty} ${o.qty === 1 ? 'unidad' : 'unidades'} · Total ${gs(o.total_pyg)}`)),
    ['rechazado', 'reembolsado'].includes(o.status)
      ? h('p', { class: 'notice' }, o.status === 'rechazado' ? 'El pago no se completó. Podés volver a la tienda e intentarlo de nuevo.' : 'Este pedido fue reembolsado.')
      : h('ol', { class: 'timeline' }, steps.map(([t, done]) => h('li', { class: done ? 'done' : null }, t))),
    confirm,
    h('p', { class: 'muted small' }, 'Guardá esta página para seguir tu pedido.'));
}

async function viewSimulator(code) {
  const o = await api('GET', `/api/pedido/${encodeURIComponent(code)}`);
  const pay = (ok) => (e) => busy(e.currentTarget, async () => {
    await api('POST', `/api/simulador/${encodeURIComponent(code)}`, { ok });
    go(`/pedido/${encodeURIComponent(code)}`);
  });
  return h('div', { class: 'card narrow stack' },
    h('p', { class: 'notice' }, 'Simulador de pagos: solo para pruebas. No se cobra dinero real.'),
    h('h1', null, `Pagar ${gs(o.total_pyg)}`),
    h('p', { class: 'muted' }, o.item_title),
    o.status !== 'pendiente_pago'
      ? h('p', null, 'Este pedido ya fue procesado. ', h('a', { href: `#/pedido/${encodeURIComponent(code)}` }, 'Ver pedido'))
      : h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: pay(true) }, 'Aprobar pago'),
        h('button', { class: 'btn secondary', onclick: pay(false) }, 'Rechazar pago')));
}

// Bancard muestra su formulario de tarjeta dentro de un iframe propio (vPOS 2.0).
async function viewBancard(code, processId) {
  const [o, gws] = await Promise.all([api('GET', `/api/pedido/${encodeURIComponent(code)}`), getGateways()]);
  const g = gws.find((x) => x.id === 'bancard');
  const box = h('div', { id: 'bancard-iframe', style: 'min-height:420px' });
  const view = h('div', { class: 'card narrow stack' }, h('h1', null, `Pagar ${gs(o.total_pyg)}`), h('p', { class: 'muted' }, o.item_title), box,
    h('a', { class: 'small', href: `#/pedido/${encodeURIComponent(code)}` }, 'Ver el estado del pedido'));
  if (!g?.checkoutScript || !processId) {
    box.replaceChildren(h('p', { class: 'error' }, 'No se pudo abrir el pago con tarjeta.'));
    return view;
  }
  const mount = () => {
    try { window.Bancard.Checkout.createForm('bancard-iframe', processId, {}); } catch { box.textContent = 'No se pudo abrir el pago con tarjeta.'; }
  };
  if (window.Bancard) setTimeout(mount);
  else document.head.append(h('script', { src: g.checkoutScript, onload: mount }));
  return view;
}

// ---------- Paneles de proveedor y vendedor ----------

function tabs(base, items, active) {
  return h('nav', { class: 'tabs', 'aria-label': 'Secciones' },
    items.map(([id, text]) => h('a', { href: `#${base}/${id}`, 'aria-current': id === active ? 'page' : null }, text)));
}

async function viewPanel(tab) {
  if (!me) await refreshMe();
  if (!me) { go('/entrar'); return h('p'); }
  if (me.role === 'admin') { go('/admin/resumen'); return h('p'); }
  const items = me.role === 'proveedor'
    ? [['productos', 'Productos'], ['pedidos', 'Pedidos'], ['saldo', 'Saldo y retiros'], ['cuenta', 'Cuenta']]
    : [['catalogo', 'Catálogo'], ['publicaciones', 'Mi tienda'], ['ventas', 'Ventas'], ['saldo', 'Saldo y retiros'], ['cuenta', 'Cuenta y plan']];
  const t = items.some(([id]) => id === tab) ? tab : items[0][0];
  const views = {
    productos: supplierProducts, pedidos: supplierOrders, catalogo: sellerCatalog,
    publicaciones: sellerListings, ventas: sellerSales, saldo: balanceView, cuenta: accountView,
  };
  return h('div', null,
    h('div', { class: 'row spread' },
      h('h1', null, me.role === 'proveedor' ? `Hola, ${me.name}` : me.store_name),
      me.role === 'vendedor' ? h('span', { class: `badge ${me.plan === 'pro' ? 'ok' : ''}` }, me.plan === 'pro' ? 'Plan Pro' : 'Plan Gratis') : null),
    me.kyc_status !== 'verificado'
      ? h('p', { class: 'notice small' }, 'Para poder retirar tu dinero tenés que verificar tu identidad. ', h('a', { href: '#/panel/cuenta' }, 'Hacerlo ahora'))
      : null,
    tabs('/panel', items, t),
    await views[t]());
}

function productForm(p, onDone) {
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      busy(form.querySelector('button[type=submit]'), async () => {
        const d = formData(form);
        const body = {
          title: d.title, description: d.description, image_url: d.image_url,
          wholesale_pyg: Number(d.wholesale_pyg), shipping_pyg: Number(d.shipping_pyg || 0),
          stock: Number(d.stock || 0), ships_to: d.ships_to, active: p ? form.active.checked : true,
        };
        if (p) await api('PUT', `/api/productos/${p.id}`, body);
        else await api('POST', '/api/productos', body);
        toast(p ? 'Producto actualizado' : 'Producto publicado');
        onDone();
      });
    },
  },
  field('Título', input('title', { required: true, maxlength: 140, value: p?.title ?? '' })),
  field('Descripción', h('textarea', { name: 'description', maxlength: 5000 }, p?.description ?? '')),
  field('Imagen', input('image_url', { type: 'url', placeholder: 'https://…', value: p?.image_url ?? '' }), 'Enlace https a una foto del producto'),
  h('div', { class: 'two' },
    field('Precio mayorista (Gs.)', input('wholesale_pyg', { type: 'number', min: 1000, step: 1, required: true, value: p?.wholesale_pyg ?? '' }), 'Lo que cobrás vos por unidad'),
    field('Costo de envío (Gs.)', input('shipping_pyg', { type: 'number', min: 0, step: 1, value: p?.shipping_pyg ?? 0 }), 'Por unidad')),
  h('div', { class: 'two' },
    field('Stock', input('stock', { type: 'number', min: 0, step: 1, value: p?.stock ?? 0 })),
    field('Envía a', input('ships_to', { value: p?.ships_to ?? 'PY', required: true }), 'Códigos de país separados por coma, o * para todo el mundo')),
  p ? h('label', { class: 'row', style: 'font-weight:500' }, h('input', { type: 'checkbox', name: 'active', checked: !!p.active, style: 'width:auto;min-height:0' }), 'Producto activo') : null,
  h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, p ? 'Guardar' : 'Publicar producto'),
    h('button', { class: 'btn secondary', type: 'button', onclick: onDone }, 'Cancelar')));
  return form;
}

function openDialog(title, content) {
  const d = h('dialog', null, h('h2', null, title), content);
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

async function supplierProducts() {
  const list = await api('GET', '/api/mis-productos');
  const edit = (p) => {
    const d = openDialog(p ? 'Editar producto' : 'Nuevo producto', productForm(p, () => { d.close(); render(); }));
  };
  return h('div', { class: 'stack' },
    h('div', { class: 'row spread' }, h('p', { class: 'muted', style: 'margin:0' }, 'Los vendedores ven estos productos en su catálogo y los revenden con su propio precio.'),
      h('button', { class: 'btn', onclick: () => edit(null) }, '+ Nuevo producto')),
    table(['Producto', ['Mayorista', true], ['Envío', true], ['Stock', true], 'Envía a', 'Estado', ''],
      list.map((p) => [p.title, gs(p.wholesale_pyg), gs(p.shipping_pyg), p.stock, p.ships_to,
        p.active ? h('span', { class: 'badge ok' }, 'Activo') : h('span', { class: 'badge' }, 'Pausado'),
        h('button', { class: 'btn secondary small', onclick: () => edit(p) }, 'Editar')]),
      'Todavía no cargaste productos.'));
}

async function supplierOrders() {
  const list = await api('GET', '/api/proveedor/pedidos');
  const ship = (o) => {
    const form = h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        busy(form.querySelector('button'), async () => {
          await api('POST', `/api/proveedor/pedidos/${o.id}/envio`, { tracking: form.tracking.value.trim() });
          d.close(); toast('Pedido marcado como enviado'); render();
        });
      },
    },
    h('p', null, h('strong', null, `${o.qty} × ${o.item_title}`)),
    h('p', { class: 'small' }, o.buyer_name, h('br'), o.buyer_address, h('br'), `${countryName(o.buyer_country)} · Tel. ${o.buyer_phone} · Doc. ${o.buyer_document}`),
    field('Código de seguimiento', input('tracking', { required: true, maxlength: 120 }), 'De la empresa de envíos (AEX, Correo Paraguayo, etc.)'),
    h('button', { class: 'btn' }, 'Marcar como enviado'));
    const d = openDialog('Enviar pedido', form);
  };
  return h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Cuando un comprador paga, el pedido aparece acá. Envialo y cargá el código de seguimiento.'),
    table(['Fecha', 'Producto', 'Comprador', ['Tu parte', true], 'Estado', ''],
      list.map((o) => [fdate(o.paid_at ?? o.created_at), `${o.qty} × ${o.item_title}`, `${o.buyer_name} (${o.buyer_country})`, gs(o.supplier_pyg),
        statusBadge(o.status),
        o.status === 'pagado' ? h('button', { class: 'btn small', onclick: () => ship(o) }, 'Enviar') : (o.tracking ?? '')]),
      'Todavía no tenés pedidos.'));
}

async function sellerCatalog() {
  const list = await api('GET', '/api/catalogo');
  const mine = new Set((await api('GET', '/api/mis-publicaciones')).map((l) => l.product_id));
  const publish = (p) => {
    const price = input('retail_pyg', { type: 'number', min: p.min_retail_pyg, step: 1, required: true, value: Math.ceil(p.min_retail_pyg * 1.3 / 1000) * 1000 });
    const form = h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        busy(form.querySelector('button'), async () => {
          await api('POST', '/api/publicaciones', { product_id: p.id, retail_pyg: Number(price.value) });
          d.close(); toast('Producto agregado a tu tienda'); render();
        });
      },
    },
    h('p', null, h('strong', null, p.title)),
    h('p', { class: 'small muted' }, `Costo del proveedor con envío: ${gs(p.wholesale_pyg + p.shipping_pyg)} · Precio mínimo para no perder: ${gs(p.min_retail_pyg)}`),
    field('Tu precio de venta (Gs.)', price),
    h('button', { class: 'btn' }, 'Agregar a mi tienda'));
    const d = openDialog('Vender este producto', form);
  };
  if (!list.length) return h('p', { class: 'muted' }, 'Todavía no hay productos de proveedores. Volvé pronto.');
  return h('div', { class: 'stack' },
    h('p', { class: 'muted' }, `Elegí productos y ponele tu precio. Tu comisión actual es ${me.fee_pct}% por venta.`),
    h('div', { class: 'grid' }, list.map((p) => h('article', { class: 'card product' },
      productImage(p.image_url, p.title),
      h('div', { class: 'body' },
        h('h3', null, p.title),
        h('p', { class: 'small muted' }, `${p.supplier_name} · ${countryName(p.supplier_country)} · stock ${p.stock}`),
        h('p', { class: 'small' }, 'Costo: ', h('strong', null, gs(p.wholesale_pyg + p.shipping_pyg)), h('br'), 'Vendé desde ', h('strong', null, gs(p.min_retail_pyg))),
        mine.has(p.id) ? h('span', { class: 'badge ok' }, 'Ya está en tu tienda') : h('button', { class: 'btn', onclick: () => publish(p) }, 'Vender'))))));
}

async function sellerListings() {
  const list = await api('GET', '/api/mis-publicaciones');
  const storeUrl = `${location.origin}${location.pathname}#/t/${me.store_slug}`;
  const edit = (l) => {
    const price = input('retail_pyg', { type: 'number', min: 1, step: 1, required: true, value: l.retail_pyg });
    const active = h('input', { type: 'checkbox', checked: !!l.active, style: 'width:auto;min-height:0' });
    const form = h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        busy(form.querySelector('button'), async () => {
          await api('PUT', `/api/publicaciones/${l.id}`, { retail_pyg: Number(price.value), active: active.checked });
          d.close(); toast('Guardado'); render();
        });
      },
    }, field('Precio de venta (Gs.)', price), h('label', { class: 'row', style: 'font-weight:500' }, active, 'Visible en mi tienda'), h('button', { class: 'btn' }, 'Guardar'));
    const d = openDialog(l.title, form);
  };
  return h('div', { class: 'stack' },
    h('div', { class: 'card row spread' },
      h('div', null, h('strong', null, 'Enlace de tu tienda'), h('br'), h('a', { href: storeUrl }, storeUrl)),
      h('button', {
        class: 'btn secondary small',
        onclick: () => navigator.clipboard?.writeText(storeUrl).then(() => toast('Enlace copiado'), () => toast('No se pudo copiar', true)),
      }, 'Copiar enlace')),
    table(['Producto', ['Tu precio', true], ['Costo', true], 'Estado', ''],
      list.map((l) => [l.title, gs(l.retail_pyg), gs(l.wholesale_pyg + l.shipping_pyg),
        l.active && l.product_active ? h('span', { class: 'badge ok' }, 'Visible') : h('span', { class: 'badge' }, l.product_active ? 'Oculto' : 'Pausado por el proveedor'),
        h('button', { class: 'btn secondary small', onclick: () => edit(l) }, 'Editar')]),
      'Tu tienda está vacía. Agregá productos desde el catálogo.'));
}

async function sellerSales() {
  const list = await api('GET', '/api/vendedor/pedidos');
  return table(['Fecha', 'Producto', 'Comprador', ['Total', true], ['Tu ganancia', true], 'Estado'],
    list.map((o) => [fdate(o.created_at), `${o.qty} × ${o.item_title}`, `${o.buyer_name} (${o.buyer_country})`, gs(o.total_pyg), gs(o.seller_pyg), statusBadge(o.status)]),
    'Todavía no vendiste. Compartí el enlace de tu tienda para empezar.');
}

async function balanceView() {
  const [b, ws] = await Promise.all([api('GET', '/api/saldo'), api('GET', '/api/retiros')]);
  const amount = input('amount', { type: 'number', min: 1, step: 1, required: true, max: b.disponible, value: b.disponible || '' });
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      busy(form.querySelector('button'), async () => {
        const d = formData(form);
        const r = await api('POST', '/api/retiros', { amount: Number(d.amount), currency: d.currency });
        toast(`Retiro solicitado: recibirás ${d.currency === 'USD' ? usd(r.amountOutMinor) : gs(r.amountOutMinor)}`);
        render();
      });
    },
  },
  h('div', { class: 'two' },
    field('Monto a retirar (Gs.)', amount),
    field('Recibir en', h('select', { name: 'currency' },
      h('option', { value: 'PYG' }, 'Guaraníes (cuenta en Paraguay)'),
      h('option', { value: 'USD' }, 'Dólares (transferencia internacional)')))),
  h('button', { class: 'btn', disabled: b.disponible <= 0 || me.kyc_status !== 'verificado' || !me.payout_method }, 'Solicitar retiro'),
  !me.payout_method ? h('p', { class: 'small muted' }, 'Primero cargá tu cuenta de cobro en ', h('a', { href: '#/panel/cuenta' }, 'Cuenta'), '.') : null);
  return h('div', { class: 'stack' },
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Disponible para retirar'), h('div', { class: 'value' }, gs(b.disponible))),
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Retenido (por entregar o en garantía)'), h('div', { class: 'value' }, gs(b.retenido)))),
    h('p', { class: 'muted small' }, 'El dinero de cada venta se libera unos días después de que el comprador recibe el producto, para cubrir posibles reclamos.'),
    h('div', { class: 'card' }, h('h2', null, 'Retirar'), form),
    h('h2', null, 'Tus retiros'),
    table(['Fecha', ['Monto', true], ['Comisión', true], ['Recibís', true], 'Estado'],
      ws.map((w) => [fdate(w.created_at), gs(w.amount_pyg), gs(w.fee_pyg), w.currency === 'USD' ? usd(w.amount_out_minor) : gs(w.amount_out_minor),
        h('span', { class: `badge ${WITHDRAW_STATUS[w.status]?.[1] ?? ''}` }, WITHDRAW_STATUS[w.status]?.[0] ?? w.status)]),
      'Todavía no hiciste retiros.'),
    h('h2', null, 'Movimientos'),
    table(['Fecha', 'Concepto', ['Monto', true], 'Disponible desde'],
      b.movimientos.map((m) => [fdate(m.created_at), LEDGER[m.type] ?? m.type, gs(m.amount_pyg), m.available_at ? fdate(m.available_at) : 'Al entregarse']),
      'Sin movimientos.'));
}

async function accountView() {
  const cobro = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      busy(cobro.querySelector('button'), async () => {
        await api('PUT', '/api/cuenta/cobro', formData(cobro));
        await refreshMe(); toast('Cuenta de cobro guardada'); render();
      });
    },
  },
  field('Cuenta donde querés cobrar', h('textarea', { name: 'payout_method', required: true, minlength: 5, maxlength: 300, placeholder: 'Banco, titular, número de cuenta o IBAN/SWIFT si es del exterior' }, me.payout_method ?? '')),
  h('button', { class: 'btn' }, 'Guardar'));

  const kyc = me.kyc_status === 'verificado' || me.kyc_status === 'pendiente'
    ? h('p', null, kycBadge(me.kyc_status), me.kyc_status === 'pendiente' ? ' Estamos revisando tus datos.' : ' Ya podés retirar tu dinero.')
    : h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        const f = e.currentTarget;
        busy(f.querySelector('button'), async () => {
          await api('POST', '/api/cuenta/kyc', formData(f));
          await refreshMe(); toast('Datos enviados para revisión'); render();
        });
      },
    },
    me.kyc_status === 'rechazado' ? h('p', { class: 'notice small' }, 'Tu verificación fue rechazada', me.kyc_note ? `: ${me.kyc_note}` : '', '. Revisá los datos y volvé a enviarlos.') : null,
    field('Nombre legal completo', input('legal_name', { required: true, maxlength: 160 })),
    h('div', { class: 'two' },
      field('Tipo de documento', h('select', { name: 'doc_type' }, ['CI', 'RUC', 'DNI', 'PASAPORTE', 'OTRO'].map((x) => h('option', { value: x }, x)))),
      field('Número', input('doc_number', { required: true, maxlength: 40 }))),
    h('button', { class: 'btn' }, 'Enviar para verificación'));

  let plan = null;
  if (me.role === 'vendedor') {
    const gws = await getGateways();
    plan = h('div', { class: 'card stack' }, h('h2', null, 'Plan'),
      me.plan === 'pro'
        ? h('p', null, `Tenés el plan Pro hasta el ${fdate(me.plan_until)}. Comisión por venta: ${me.fee_pct}%.`)
        : h('p', null, `Estás en el plan Gratis: comisión de ${me.fee_pct}% por venta y un límite de productos en tu tienda. El plan Pro baja la comisión y no tiene límite.`),
      gws.length ? h('div', { class: 'row' }, gws.map((g) => h('button', {
        class: 'btn secondary',
        onclick: (e) => busy(e.currentTarget, async () => {
          const r = await api('POST', '/api/plan-pro', { gateway: g.id });
          location.href = r.redirect;
        }),
      }, `${me.plan === 'pro' ? 'Renovar' : 'Pasar a Pro'} con ${g.name.split(' ')[0]}`))) : null);
  }

  return h('div', { class: 'stack' },
    h('div', { class: 'card stack' }, h('h2', null, 'Verificación de identidad'), h('p', { class: 'muted small' }, 'La pedimos por ley y para proteger a todos antes de enviar dinero.'), kyc),
    h('div', { class: 'card stack' }, h('h2', null, 'Cuenta de cobro'), cobro),
    plan,
    h('p', { class: 'muted small' }, `Cuenta: ${me.email} · ${countryName(me.country)}`));
}

// ---------- Administración ----------

async function viewAdmin(tab) {
  if (!me) await refreshMe();
  if (!me || me.role !== 'admin') { go(me ? homeFor(me) : '/entrar'); return h('p'); }
  const items = [['resumen', 'Resumen'], ['pedidos', 'Pedidos'], ['kyc', 'Identidades'], ['retiros', 'Retiros'], ['usuarios', 'Usuarios'], ['ajustes', 'Ajustes']];
  const t = items.some(([id]) => id === tab) ? tab : 'resumen';
  const views = { resumen: adminSummary, pedidos: adminOrders, kyc: adminKyc, retiros: adminWithdrawals, usuarios: adminUsers, ajustes: adminSettings };
  return h('div', null, h('h1', null, 'Administración'), tabs('/admin', items, t), await views[t]());
}

async function adminSummary() {
  const r = await api('GET', '/api/admin/resumen');
  const total = r.ingresos.reduce((a, i) => a + i.total_pyg, 0);
  const count = (s) => r.pedidos.find((p) => p.status === s)?.n ?? 0;
  return h('div', { class: 'stack' },
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Ingresos de la plataforma'), h('div', { class: 'value' }, gs(total))),
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Dinero de usuarios retenido'), h('div', { class: 'value' }, gs(r.saldo_usuarios.retenido))),
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Disponible para retiros'), h('div', { class: 'value' }, gs(r.saldo_usuarios.disponible))),
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Pedidos por enviar'), h('div', { class: 'value' }, count('pagado')))),
    h('h2', null, 'Ingresos por concepto'),
    table(['Concepto', ['Cantidad', true], ['Total', true]], r.ingresos.map((i) => [LEDGER[i.type] ?? i.type, i.n, gs(i.total_pyg)]), 'Todavía no hay ingresos.'),
    h('h2', null, 'Pedidos por estado'),
    table(['Estado', ['Cantidad', true]], r.pedidos.map((p) => [statusBadge(p.status), p.n]), 'Sin pedidos.'));
}

async function adminOrders() {
  const list = await api('GET', '/api/admin/pedidos');
  const act = (url, msg, confirmText) => (e) => {
    if (confirmText && !confirm(confirmText)) return;
    busy(e.currentTarget, async () => { await api('POST', url, {}); toast(msg); render(); });
  };
  return table(['Fecha', 'Tipo', 'Detalle', ['Total', true], ['Comisión', true], 'Pasarela', 'Estado', ''],
    list.map((o) => [fdate(o.created_at), o.kind === 'venta' ? 'Venta' : 'Plan Pro',
      h('span', null, `${o.qty} × ${o.item_title}`, h('br'), h('span', { class: 'muted small' }, o.kind === 'venta' ? `${o.seller_store ?? ''} · ${o.supplier_name ?? ''} · ${o.buyer_name} (${o.buyer_country})` : o.buyer_name)),
      gs(o.total_pyg), gs(o.platform_fee_pyg), o.gateway, statusBadge(o.status),
      h('div', { class: 'row' },
        o.status === 'enviado' ? h('button', { class: 'btn secondary small', onclick: act(`/api/admin/pedidos/${o.id}/entregado`, 'Marcado como entregado') }, 'Entregado') : null,
        o.kind === 'venta' && ['pagado', 'enviado', 'entregado'].includes(o.status)
          ? h('button', { class: 'btn danger small', onclick: act(`/api/admin/pedidos/${o.id}/reembolso`, 'Pedido reembolsado', '¿Reembolsar este pedido? Se descuenta el dinero al proveedor y al vendedor. La devolución al comprador se hace desde la pasarela.') }, 'Reembolsar')
          : null)]),
    'Todavía no hay pedidos pagados.');
}

async function adminKyc() {
  const list = await api('GET', '/api/admin/kyc');
  const decide = (u, status) => (e) => {
    const note = status === 'rechazado' ? prompt('Motivo del rechazo (lo ve el usuario):') : null;
    if (status === 'rechazado' && note === null) return;
    busy(e.currentTarget, async () => { await api('POST', `/api/admin/kyc/${u.id}`, { status, note }); toast('Listo'); render(); });
  };
  return table(['Usuario', 'Rol', 'Nombre legal', 'Documento', ''],
    list.map((u) => [h('span', null, u.name, h('br'), h('span', { class: 'muted small' }, `${u.email} · ${u.country}`)), u.role, u.kyc_legal_name, `${u.kyc_doc_type} ${u.kyc_doc_number}`,
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: decide(u, 'verificado') }, 'Aprobar'),
        h('button', { class: 'btn secondary small', onclick: decide(u, 'rechazado') }, 'Rechazar'))]),
    'No hay verificaciones pendientes.');
}

async function adminWithdrawals() {
  const list = await api('GET', '/api/admin/retiros');
  const decide = (w, status) => (e) => {
    const note = prompt(status === 'pagado' ? 'Referencia de la transferencia (opcional):' : 'Motivo del rechazo:');
    if (note === null) return;
    busy(e.currentTarget, async () => { await api('POST', `/api/admin/retiros/${w.id}`, { status, note }); toast('Listo'); render(); });
  };
  return h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, 'Hacé la transferencia desde el banco y después marcá el retiro como pagado. Si lo rechazás, el saldo vuelve al usuario.'),
    table(['Fecha', 'Usuario', 'Cuenta de cobro', ['Enviar', true], 'Estado', ''],
      list.map((w) => [fdate(w.created_at), h('span', null, w.kyc_legal_name ?? w.name, h('br'), h('span', { class: 'muted small' }, w.email)), w.method,
        w.currency === 'USD' ? usd(w.amount_out_minor) : gs(w.amount_out_minor),
        h('span', { class: `badge ${WITHDRAW_STATUS[w.status]?.[1] ?? ''}` }, WITHDRAW_STATUS[w.status]?.[0] ?? w.status),
        w.status === 'solicitado' ? h('div', { class: 'row' },
          h('button', { class: 'btn small', onclick: decide(w, 'pagado') }, 'Pagado'),
          h('button', { class: 'btn secondary small', onclick: decide(w, 'rechazado') }, 'Rechazar')) : (w.admin_note ?? '')]),
      'No hay retiros.'));
}

async function adminUsers() {
  const list = await api('GET', '/api/admin/usuarios');
  const toggle = (u) => (e) => {
    if (u.active && !confirm(`¿Bloquear a ${u.email}? No podrá entrar ni vender.`)) return;
    busy(e.currentTarget, async () => { await api('POST', `/api/admin/usuarios/${u.id}/activo`, { active: !u.active }); render(); });
  };
  return table(['Alta', 'Usuario', 'Rol', 'Identidad', 'Estado', ''],
    list.map((u) => [fdate(u.created_at), h('span', null, u.name, u.store_name ? ` · ${u.store_name}` : '', h('br'), h('span', { class: 'muted small' }, `${u.email} · ${u.country}`)),
      u.role, kycBadge(u.kyc_status), u.active ? h('span', { class: 'badge ok' }, 'Activo') : h('span', { class: 'badge bad' }, 'Bloqueado'),
      u.role === 'admin' ? '' : h('button', { class: 'btn secondary small', onclick: toggle(u) }, u.active ? 'Bloquear' : 'Activar')]));
}

const SETTINGS = [
  ['fee_pct_gratis', 'Comisión por venta, plan Gratis (%)'],
  ['fee_pct_pro', 'Comisión por venta, plan Pro (%)'],
  ['pro_price_pyg', 'Precio del plan Pro (Gs.)'],
  ['pro_days', 'Duración del plan Pro (días)'],
  ['max_listings_gratis', 'Productos máximos en plan Gratis'],
  ['gateway_fee_pct', 'Costo estimado de la pasarela (%)'],
  ['hold_days', 'Días de garantía antes de liberar el dinero'],
  ['auto_deliver_days', 'Días tras el envío para dar por entregado'],
  ['withdraw_min_pyg', 'Retiro mínimo (Gs.)'],
  ['withdraw_fee_pyg', 'Comisión de retiro en Paraguay (Gs.)'],
  ['withdraw_fee_intl_pyg', 'Comisión de retiro internacional (Gs.)'],
  ['usd_rate', 'Cotización del dólar (Gs.)'],
  ['fx_spread_pct', 'Margen cambiario en retiros en USD (%)'],
];

async function adminSettings() {
  const s = await api('GET', '/api/admin/ajustes');
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      busy(form.querySelector('button'), async () => {
        const d = formData(form);
        const body = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Number(v)]));
        await api('PUT', '/api/admin/ajustes', body);
        toast('Ajustes guardados');
      });
    },
  },
  h('div', { class: 'two' }, SETTINGS.map(([k, label]) => field(label, input(k, { type: 'number', min: 0, step: k.endsWith('_pyg') ? 1 : 'any', required: true, value: s[k] })))),
  h('button', { class: 'btn' }, 'Guardar ajustes'));
  return h('div', { class: 'card stack' }, h('p', { class: 'muted small' }, 'Los cambios se aplican a los pedidos nuevos. Los pedidos ya creados mantienen sus montos.'), form);
}

// ---------- Arranque ----------

window.addEventListener('hashchange', render);
refreshMe().then(render);
