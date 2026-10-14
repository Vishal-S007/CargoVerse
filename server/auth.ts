// Password hashing (scrypt) and signed session tokens. Node built-ins only.
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

const N = 16384, R = 8, P = 1, KEYLEN = 32;

export function hashPassword(password: string, salt = randomBytes(16)): string {
  const key = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function validatePassword(pw: string): string | null {
  if (pw.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and numbers';
  return null;
}

export function newSessionId(): string {
  return randomBytes(24).toString('hex');
}

export function signToken(sessionId: string, secret: string): string {
  const mac = createHmac('sha256', secret).update(sessionId).digest('base64url');
  return `${sessionId}.${mac}`;
}

/** Returns the session id when the token's signature is valid. */
export function readToken(token: string | null | undefined, secret: string): string | null {
  if (!token) return null;
  const i = token.indexOf('.');
  if (i <= 0) return null;
  const sid = token.slice(0, i);
  const mac = Buffer.from(token.slice(i + 1));
  const expected = Buffer.from(createHmac('sha256', secret).update(sid).digest('base64url'));
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  return sid;
}
