// Cálculos de dinero. Todo se maneja en guaraníes enteros (PYG no tiene decimales).

export function saleSplit({ retail, wholesale, shipping, qty, feePct, gatewayPct }) {
  const total = retail * qty;
  const supplier = (wholesale + shipping) * qty;
  const platformFee = Math.round((total * feePct) / 100);
  const gatewayFee = Math.round((total * gatewayPct) / 100);
  const seller = total - supplier - platformFee - gatewayFee;
  return { total, supplier, platformFee, gatewayFee, seller };
}

// Precio mínimo de venta para que el vendedor no pierda dinero.
export function minRetail({ wholesale, shipping, feePct, gatewayPct }) {
  const k = 1 - (feePct + gatewayPct) / 100;
  if (k <= 0) throw new Error('Las comisiones suman 100% o más');
  let p = Math.ceil((wholesale + shipping) / k);
  const sellerAt = (retail) => saleSplit({ retail, wholesale, shipping, qty: 1, feePct, gatewayPct }).seller;
  // El redondeo de las comisiones puede mover el mínimo uno o dos guaraníes: se ajusta exacto.
  while (sellerAt(p) < 0) p++;
  while (p > 0 && sellerAt(p - 1) >= 0) p--;
  return p;
}

export function feePctFor(user, s, now) {
  return user.plan === 'pro' && (user.plan_until ?? 0) > now ? s.fee_pct_pro : s.fee_pct_gratis;
}

// Cotiza un retiro. En USD la plataforma gana el margen cambiario (spread).
// amountOutMinor va en la unidad mínima de la moneda: guaraníes para PYG, centavos para USD.
export function payoutQuote({ amount, currency, s }) {
  if (!Number.isInteger(amount)) throw new Error('El monto debe ser un entero en guaraníes');
  if (currency === 'PYG') {
    const fee = s.withdraw_fee_pyg;
    return { fee, net: amount - fee, amountOutMinor: amount - fee, fxRate: 1, spreadGain: 0 };
  }
  if (currency === 'USD') {
    const fee = s.withdraw_fee_intl_pyg;
    const net = amount - fee;
    // Tasa con margen, en enteros: usd_rate * (1 + spread) con el spread en puntos básicos.
    const spreadBp = Math.round(s.fx_spread_pct * 100);
    const fxRate = (s.usd_rate * (10000 + spreadBp)) / 10000;
    const cents = net > 0
      ? Number((BigInt(net) * 100n * 10000n) / (BigInt(s.usd_rate) * BigInt(10000 + spreadBp)))
      : 0;
    const spreadGain = net - Math.round((cents * s.usd_rate) / 100);
    return { fee, net, amountOutMinor: cents, fxRate, spreadGain };
  }
  throw new Error('Moneda no soportada');
}
