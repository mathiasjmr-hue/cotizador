// Uso: node scripts/crear-admin.js email@dominio.com "contraseña larga" "Nombre"
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { createUser } from '../src/app.js';

const [mail, password, name = 'Administrador'] = process.argv.slice(2);
if (!mail || !password || password.length < 12) {
  console.error('Uso: node scripts/crear-admin.js email contraseña(12+ caracteres) [nombre]');
  process.exit(1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const db = openDb(process.env.DB_FILE ?? path.join(here, '..', 'data', 'dropshipping.db'));
const u = createUser(db, { email: mail.trim().toLowerCase(), password, name, country: 'PY', role: 'admin' }, Date.now());
db.prepare(`UPDATE users SET kyc_status = 'verificado' WHERE id = ?`).run(u.id);
console.log(`Administrador creado: ${u.email} (id ${u.id})`);
