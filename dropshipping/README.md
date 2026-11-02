# Dropshipping PY

Plataforma de dropshipping que cobra con pasarelas de Paraguay (Pagopar, Bancard) y admite proveedores y vendedores de cualquier país.

Requiere Node 22.5 o superior (usa `node:sqlite`, sin dependencias externas).

```
npm test
```

## Flujo del dinero

Todos los montos son guaraníes enteros (`src/money.js`). Los retiros en USD se guardan en centavos enteros.

1. **Pedido** (`prepareSaleOrder`): se calcula el reparto del precio en proveedor, comisión de la plataforma, costo de la pasarela y margen del vendedor.
2. **Pago** (`confirmPayment`, idempotente): se anotan en el libro contable (`ledger`) la parte del proveedor y la del vendedor como **retenidas** (`available_at` nulo). La comisión de la plataforma queda disponible.
3. **Envío y entrega** (`markShipped`, `markDelivered`, `autoDeliver`): al entregarse, el dinero se libera después de `hold_days` días de garantía.
4. **Retiro** (`requestWithdrawal`, `processWithdrawal`): solo con identidad verificada y saldo disponible. Si el retiro se rechaza, el saldo vuelve al usuario. La plataforma gana la comisión de retiro y, en USD, el margen cambiario.
5. **Reembolso** (`refundOrder`): agrega asientos inversos; nunca se borran ni modifican montos del libro.

El saldo de cada usuario es la suma de sus filas del libro (`balances`).
