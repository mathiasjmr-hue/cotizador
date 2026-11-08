// Bancard vPOS 2.0 (tarjetas de crédito/débito locales e internacionales: Visa, Mastercard, etc.).
// Staging: https://vpos.infonet.com.py:8888  ·  Producción: https://vpos.infonet.com.py
// Verificar los campos contra la documentación vigente de Bancard antes de pasar a producción.
import crypto from 'node:crypto';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

export function bancard({ publicKey, privateKey, apiUrl = 'https://vpos.infonet.com.py:8888' }) {
  return {
    id: 'bancard',
    name: 'Bancard — tarjetas de crédito y débito',
    checkoutScript: `${apiUrl}/checkout/javascript/dist/bancard-checkout-4.0.0.js`,

    async create(order, { publicUrl }) {
      const amount = order.total_pyg.toFixed(2);
      const shopProcessId = order.id; // Bancard exige un entero único por comercio
      const body = {
        public_key: publicKey,
        operation: {
          token: md5(privateKey + shopProcessId + amount + 'PYG'),
          shop_process_id: shopProcessId,
          currency: 'PYG',
          amount,
          additional_data: '',
          description: order.item_title.slice(0, 20),
          return_url: `${publicUrl}/#/pedido/${order.public_code}`,
          cancel_url: `${publicUrl}/#/pedido/${order.public_code}`,
        },
      };
      const r = await fetch(`${apiUrl}/vpos/api/0.3/single_buy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (j.status !== 'success' || !j.process_id) {
        throw new Error('Bancard rechazó la transacción: ' + JSON.stringify(j.messages ?? j));
      }
      return {
        ref: String(shopProcessId),
        redirect: `${publicUrl}/#/pago/bancard/${order.public_code}?pid=${encodeURIComponent(j.process_id)}`,
      };
    },

    // Bancard confirma con { operation: { token, shop_process_id, response, response_code, amount, currency, ... } }
    parseWebhook(body) {
      const op = body?.operation;
      if (!op || op.shop_process_id == null) throw new Error('Confirmación Bancard inválida');
      const expected = md5(privateKey + op.shop_process_id + 'confirm' + op.amount + op.currency);
      if (typeof op.token !== 'string' || op.token.length !== expected.length ||
          !crypto.timingSafeEqual(Buffer.from(op.token), Buffer.from(expected))) {
        throw new Error('Token de Bancard inválido');
      }
      const paid = op.response === 'S' && op.response_code === '00';
      return { ref: String(op.shop_process_id), paid, failed: !paid, amount: Math.round(parseFloat(op.amount)), reply: { status: 'success' } };
    },
  };
}
