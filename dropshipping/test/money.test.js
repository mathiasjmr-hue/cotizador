import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saleSplit, minRetail, payoutQuote } from '../src/money.js';
import { DEFAULT_SETTINGS as s } from '../src/db.js';

test('saleSplit reparte todo el total en enteros', () => {
  const r = saleSplit({ retail: 123457, wholesale: 50000, shipping: 9999, qty: 3, feePct: 10, gatewayPct: 5 });
  assert.equal(r.total, r.supplier + r.platformFee + r.gatewayFee + r.seller);
  for (const v of Object.values(r)) assert.ok(Number.isInteger(v));
});

test('minRetail nunca deja al vendedor en negativo', () => {
  const args = { wholesale: 99999, shipping: 12345, feePct: 10, gatewayPct: 5 };
  const p = minRetail(args);
  assert.ok(saleSplit({ ...args, retail: p, qty: 1 }).seller >= 0);
  assert.ok(saleSplit({ ...args, retail: p - 1, qty: 1 }).seller < 0);
});

test('payoutQuote solo acepta montos enteros y monedas conocidas', () => {
  assert.throws(() => payoutQuote({ amount: 100.5, currency: 'PYG', s }), /entero/);
  assert.throws(() => payoutQuote({ amount: 100000, currency: 'BRL', s }), /Moneda/);
  const q = payoutQuote({ amount: 1000000, currency: 'USD', s });
  assert.ok(Number.isInteger(q.amountOutMinor) && Number.isInteger(q.spreadGain));
});
