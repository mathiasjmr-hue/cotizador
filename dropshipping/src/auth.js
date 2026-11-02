import crypto from 'node:crypto';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = Buffer.from(keyHex, 'hex');
  const test = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), key.length);
  return crypto.timingSafeEqual(key, test);
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomCode = (bytes = 12) => crypto.randomBytes(bytes).toString('base64url');

const SESSION_MS = 30 * 24 * 3600 * 1000;

export function createSession(db, userId, now) {
  const token = randomCode(32);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, now + SESSION_MS);
  return token;
}

export function userFromToken(db, token, now) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`
  ).get(sha256(token), now);
  return row ?? null;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

// Limita intentos de inicio de sesión por IP (en memoria).
const attempts = new Map();
export function loginAllowed(ip, now) {
  const a = attempts.get(ip);
  if (!a || a.reset < now) {
    attempts.set(ip, { n: 1, reset: now + 15 * 60 * 1000 });
    return true;
  }
  a.n++;
  return a.n <= 10;
}
