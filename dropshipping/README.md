# Dropshipping PY

Plataforma de dropshipping que cobra con pasarelas de Paraguay (Pagopar, Bancard) y admite proveedores y vendedores de cualquier país.

Requiere Node 22.5 o superior (usa `node:sqlite`, sin dependencias externas).

```
npm test                      # pruebas
npm run dev                   # servidor local con el simulador de pagos, en http://localhost:3000
npm run crear-admin -- admin@tudominio.com "clave de 12+ caracteres"
```

## Configuración (variables de entorno)

| Variable | Para qué |
|---|---|
| `PORT` | Puerto (por defecto 3000) |
| `PUBLIC_URL` | URL pública del sitio, para las redirecciones de las pasarelas |
| `DB_FILE` | Archivo SQLite (por defecto `data/dropshipping.db`) |
| `NODE_ENV=production` | Cookies solo por HTTPS; prohíbe el simulador |
| `PAGOPAR_PUBLIC_KEY`, `PAGOPAR_PRIVATE_KEY` | Habilitan Pagopar |
| `BANCARD_PUBLIC_KEY`, `BANCARD_PRIVATE_KEY`, `BANCARD_API_URL` | Habilitan Bancard (staging por defecto) |
| `GATEWAY_SIMULATOR=1` | Simulador de pagos, solo para desarrollo |

Las claves nunca van en el repositorio.

## API

Todas las rutas aceptan y devuelven JSON. La sesión va en una cookie `HttpOnly`.

- **Cuentas:** `POST /api/registro`, `POST /api/login`, `POST /api/logout`, `GET /api/yo`, `PUT /api/cuenta/cobro`, `POST /api/cuenta/kyc`
- **Proveedor:** `POST /api/productos`, `PUT /api/productos/:id`, `GET /api/mis-productos`, `GET /api/proveedor/pedidos`, `POST /api/proveedor/pedidos/:id/envio`
- **Vendedor:** `GET /api/catalogo` (con precio mínimo sugerido), `POST /api/publicaciones`, `PUT /api/publicaciones/:id`, `GET /api/mis-publicaciones`, `GET /api/vendedor/pedidos`, `POST /api/plan-pro`
- **Saldos:** `GET /api/saldo`, `POST /api/retiros`, `GET /api/retiros`
- **Tienda pública:** `GET /api/pasarelas`, `GET /api/tienda/:slug`, `POST /api/checkout`, `GET /api/pedido/:codigo`, `POST /api/pedido/:codigo/recibido`
- **Pasarelas:** `POST /api/webhooks/pagopar`, `POST /api/webhooks/bancard` (URL que se configura en cada pasarela), `POST /api/simulador/:codigo` (solo desarrollo)
- **Admin:** `GET /api/admin/resumen`, `GET|PUT /api/admin/ajustes`, `GET /api/admin/kyc`, `POST /api/admin/kyc/:id`, `GET /api/admin/retiros`, `POST /api/admin/retiros/:id`, `POST /api/admin/pedidos/:id/reembolso`, `POST /api/admin/pedidos/:id/entregado`, `POST /api/admin/usuarios/:id/activo`

## Flujo del dinero

Todos los montos son guaraníes enteros (`src/money.js`). Los retiros en USD se guardan en centavos enteros.

1. **Pedido** (`prepareSaleOrder`): se calcula el reparto del precio en proveedor, comisión de la plataforma, costo de la pasarela y margen del vendedor.
2. **Pago** (`confirmPayment`, idempotente): se anotan en el libro contable (`ledger`) la parte del proveedor y la del vendedor como **retenidas** (`available_at` nulo). La comisión de la plataforma queda disponible.
3. **Envío y entrega** (`markShipped`, `markDelivered`, `autoDeliver`): al entregarse, el dinero se libera después de `hold_days` días de garantía.
4. **Retiro** (`requestWithdrawal`, `processWithdrawal`): solo con identidad verificada y saldo disponible. Si el retiro se rechaza, el saldo vuelve al usuario. La plataforma gana la comisión de retiro y, en USD, el margen cambiario.
5. **Reembolso** (`refundOrder`): agrega asientos inversos; nunca se borran ni modifican montos del libro.

El saldo de cada usuario es la suma de sus filas del libro (`balances`).
