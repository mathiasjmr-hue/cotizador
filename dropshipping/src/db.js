import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('proveedor','vendedor','admin')),
  store_name TEXT,
  store_slug TEXT UNIQUE,
  plan TEXT NOT NULL DEFAULT 'gratis',
  plan_until INTEGER,
  kyc_status TEXT NOT NULL DEFAULT 'sin_enviar',
  kyc_legal_name TEXT,
  kyc_doc_type TEXT,
  kyc_doc_number TEXT,
  kyc_note TEXT,
  payout_method TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  wholesale_pyg INTEGER NOT NULL,
  shipping_pyg INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  ships_to TEXT NOT NULL DEFAULT 'PY',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY,
  seller_id INTEGER NOT NULL REFERENCES users(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  retail_pyg INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (seller_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('venta','suscripcion')),
  public_code TEXT UNIQUE NOT NULL,
  seller_id INTEGER REFERENCES users(id),
  supplier_id INTEGER REFERENCES users(id),
  listing_id INTEGER REFERENCES listings(id),
  product_id INTEGER REFERENCES products(id),
  item_title TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  buyer_name TEXT, buyer_email TEXT, buyer_phone TEXT, buyer_document TEXT,
  buyer_address TEXT, buyer_country TEXT,
  total_pyg INTEGER NOT NULL,
  supplier_pyg INTEGER NOT NULL DEFAULT 0,
  platform_fee_pyg INTEGER NOT NULL DEFAULT 0,
  gateway_fee_pyg INTEGER NOT NULL DEFAULT 0,
  seller_pyg INTEGER NOT NULL DEFAULT 0,
  fee_pct REAL NOT NULL DEFAULT 0,
  gateway TEXT NOT NULL,
  gateway_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pendiente_pago',
  tracking TEXT,
  paid_at INTEGER, shipped_at INTEGER, delivered_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_gateway_ref ON orders(gateway, gateway_ref);

-- Libro contable: cada movimiento de dinero es una fila inmutable.
-- user_id NULL = cuenta de la plataforma (ingresos).
-- available_at NULL = retenido hasta la entrega; > ahora = retenido por plazo de garantía.
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  order_id INTEGER REFERENCES orders(id),
  withdrawal_id INTEGER,
  amount_pyg INTEGER NOT NULL,
  type TEXT NOT NULL,
  available_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id);
CREATE INDEX IF NOT EXISTS ledger_order ON ledger(order_id);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_pyg INTEGER NOT NULL,
  fee_pyg INTEGER NOT NULL,
  currency TEXT NOT NULL,
  amount_out_minor INTEGER NOT NULL, -- guaraníes (PYG) o centavos (USD)
  fx_rate REAL NOT NULL,
  spread_gain_pyg INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'solicitado',
  admin_note TEXT,
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Valores por defecto del modelo de negocio. Todos se editan desde el panel de administración.
export const DEFAULT_SETTINGS = {
  fee_pct_gratis: 10,          // % de comisión por venta, plan Gratis
  fee_pct_pro: 5,              // % de comisión por venta, plan Pro
  pro_price_pyg: 150000,       // precio mensual del plan Pro
  pro_days: 30,
  max_listings_gratis: 25,     // productos máximos en la tienda con plan Gratis
  gateway_fee_pct: 5,          // costo estimado de la pasarela, descontado del margen del vendedor
  hold_days: 7,                // días de garantía tras la entrega antes de liberar el dinero
  auto_deliver_days: 21,       // si el comprador no confirma, se da por entregado tras N días del envío
  withdraw_min_pyg: 100000,
  withdraw_fee_pyg: 15000,     // retiro a cuenta bancaria en Paraguay
  withdraw_fee_intl_pyg: 75000, // retiro internacional (USD)
  usd_rate: 7300,              // guaraníes por dólar (referencia)
  fx_spread_pct: 2.5,          // margen cambiario en retiros en USD
};

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, String(v));
  return db;
}

export function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    if (key in DEFAULT_SETTINGS) out[key] = Number(value);
  }
  return out;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
