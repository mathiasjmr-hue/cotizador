// Servidor de la plataforma. Configuración por variables de entorno (ver README).
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getSettings } from './src/db.js';
import { buildGateways } from './src/gateways/index.js';
import { createApp } from './src/app.js';
import { autoDeliver } from './src/services.js';

const env = process.env;
const here = path.dirname(fileURLToPath(import.meta.url));
const production = env.NODE_ENV === 'production';

if (production && env.GATEWAY_SIMULATOR === '1') {
  console.error('GATEWAY_SIMULATOR no se puede usar en producción.');
  process.exit(1);
}

const db = openDb(env.DB_FILE ?? path.join(here, 'data', 'dropshipping.db'));
const gateways = buildGateways({
  pagopar: { publicKey: env.PAGOPAR_PUBLIC_KEY, privateKey: env.PAGOPAR_PRIVATE_KEY },
  bancard: { publicKey: env.BANCARD_PUBLIC_KEY, privateKey: env.BANCARD_PRIVATE_KEY, apiUrl: env.BANCARD_API_URL },
  simulator: env.GATEWAY_SIMULATOR === '1',
});
if (!Object.keys(gateways).length) console.warn('Atención: no hay ninguna pasarela de pago configurada.');

const port = Number(env.PORT ?? 3000);
const handler = createApp(db, {
  gateways,
  publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
  publicDir: path.join(here, 'public'),
  secureCookies: production,
});

// Da por entregados los pedidos enviados hace mucho y sin confirmación del comprador.
const tick = () => {
  try {
    const n = autoDeliver(db, getSettings(db), Date.now());
    if (n) console.log(`Entrega automática: ${n} pedido(s)`);
  } catch (e) {
    console.error('Error en la entrega automática', e);
  }
};
setInterval(tick, 60 * 60 * 1000).unref();
tick();

http.createServer(handler).listen(port, () => {
  console.log(`Dropshipping PY en http://localhost:${port} · pasarelas: ${Object.keys(gateways).join(', ') || 'ninguna'}`);
});
