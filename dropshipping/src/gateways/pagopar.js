// Pagopar (https://www.pagopar.com) — tarjetas, billeteras (Tigo Money, Personal, Zimple),
// transferencias y bocas de cobranza (Aquí Pago, Pago Express, etc.).
// Verificar los campos contra la documentación vigente de Pagopar antes de pasar a producción.
import crypto from 'node:crypto';

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function pyDate(ms) {
  // Pagopar espera "YYYY-MM-DD HH:mm:ss" en hora de Paraguay (UTC-3).
  const d = new Date(ms - 3 * 3600 * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

export function pagopar({ publicKey, privateKey, apiUrl = 'https://api.pagopar.com', checkoutUrl = 'https://www.pagopar.com' }) {
  return {
    id: 'pagopar',
    name: 'Pagopar — tarjetas, billeteras y bocas de cobranza',

    async create(order, { now }) {
      const monto = order.total_pyg;
      const idPedido = order.public_code;
      const body = {
        token: sha1(privateKey + idPedido + String(monto)),
        public_key: publicKey,
        monto_total: monto,
        tipo_pedido: 'VENTA-COMERCIO',
        compras_items: [{
          ciudad: '1',
          nombre: order.item_title.slice(0, 100),
          cantidad: order.qty,
          categoria: '909',
          public_key: publicKey,
          url_imagen: order.image_url || '',
          descripcion: order.item_title.slice(0, 100),
          id_producto: order.product_id ?? 0,
          precio_total: monto,
          vendedor_telefono: '',
          vendedor_direccion: '',
          vendedor_direccion_referencia: '',
          vendedor_direccion_coordenadas: '',
        }],
        fecha_maxima_pago: pyDate(now + 48 * 3600 * 1000),
        id_pedido: idPedido,
        descripcion_resumen: order.item_title.slice(0, 100),
        comprador: {
          ruc: '',
          email: order.buyer_email,
          ciudad: null,
          nombre: order.buyer_name,
          telefono: order.buyer_phone,
          direccion: order.buyer_address,
          documento: order.buyer_document,
          coordenadas: '',
          razon_social: order.buyer_name,
          tipo_documento: 'CI',
          direccion_referencia: '',
        },
      };
      const r = await fetch(`${apiUrl}/api/comercios/2.0/iniciar-transaccion`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!j.respuesta || !j.resultado?.[0]?.data) {
        throw new Error('Pagopar rechazó la transacción: ' + JSON.stringify(j.resultado ?? j));
      }
      const hash = j.resultado[0].data;
      return { ref: hash, redirect: `${checkoutUrl}/pagos/${hash}` };
    },

    // Pagopar notifica con { respuesta, resultado: [{ pagado, hash_pedido, token, monto, cancelado, ... }] }
    // y espera que se le devuelva el mismo "resultado".
    parseWebhook(body) {
      const r = body?.resultado?.[0];
      if (!r || typeof r.hash_pedido !== 'string') throw new Error('Notificación Pagopar inválida');
      const expected = sha1(privateKey + r.hash_pedido);
      if (typeof r.token !== 'string' || r.token.length !== expected.length ||
          !crypto.timingSafeEqual(Buffer.from(r.token), Buffer.from(expected))) {
        throw new Error('Token de Pagopar inválido');
      }
      const cancelled = r.cancelado === true || r.cancelado === 'true';
      const paid = (r.pagado === true || r.pagado === 'true') && !cancelled;
      return { ref: r.hash_pedido, paid, failed: cancelled, amount: Math.round(Number(r.monto)), reply: body.resultado };
    },
  };
}
