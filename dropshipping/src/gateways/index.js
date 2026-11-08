import { pagopar } from './pagopar.js';
import { bancard } from './bancard.js';

// Simulador: solo para desarrollo y pruebas. Nunca habilitarlo en producción.
function simulado() {
  return {
    id: 'simulado',
    name: 'Simulador de pagos (solo pruebas)',
    async create(order, { publicUrl }) {
      return { ref: 'SIM-' + order.public_code, redirect: `${publicUrl}/#/simulador/${order.public_code}` };
    },
  };
}

export function buildGateways(cfg) {
  const g = {};
  if (cfg.pagopar?.publicKey && cfg.pagopar?.privateKey) g.pagopar = pagopar(cfg.pagopar);
  if (cfg.bancard?.publicKey && cfg.bancard?.privateKey) g.bancard = bancard(cfg.bancard);
  if (cfg.simulator) g.simulado = simulado();
  return g;
}
