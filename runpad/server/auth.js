import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Pad locks. A lock stores a scrypt hash of its password. Entering the password gives
 * the browser a signed token for that lock; tokens name the lock's path and version, so
 * changing or removing the lock invalidates every token issued for it.
 */

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const TOKEN_DAYS = 30;

/** Reads the server's signing secret from the data dir, creating it on first start. */
export function loadSecret(dataDir) {
  const file = path.join(dataDir, 'secret.key');
  try {
    const existing = fs.readFileSync(file);
    if (existing.length >= 32) return existing;
  } catch {
    /* first start */
  }
  const secret = crypto.randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

/** @returns {Promise<{ salt: string, hash: string }>} */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 32, SCRYPT, (err, key) =>
      err ? reject(err) : resolve({ salt: salt.toString('base64'), hash: key.toString('base64') }),
    );
  });
}

/** @returns {Promise<boolean>} */
export function verifyPassword(password, lock) {
  if (!lock?.salt || !lock?.hash) return Promise.resolve(false);
  const expected = Buffer.from(lock.hash, 'base64');
  return new Promise((resolve) => {
    crypto.scrypt(String(password), Buffer.from(lock.salt, 'base64'), expected.length, SCRYPT, (err, key) =>
      resolve(!err && key.length === expected.length && crypto.timingSafeEqual(key, expected)),
    );
  });
}

export class TokenSigner {
  constructor(secret) {
    this.secret = secret;
  }

  #mac(payload) {
    return crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  /** Token granting access to everything under the lock at `lockPath`. */
  sign(lockPath, version, now = Date.now()) {
    const payload = Buffer.from(JSON.stringify({ p: lockPath, v: version, e: now + TOKEN_DAYS * 864e5 })).toString('base64url');
    return `${payload}.${this.#mac(payload)}`;
  }

  /** @returns {{ path: string, version: number } | null} */
  verify(token, now = Date.now()) {
    if (typeof token !== 'string' || token.length > 2048) return null;
    const dot = token.indexOf('.');
    if (dot < 1) return null;
    const payload = token.slice(0, dot);
    const mac = Buffer.from(token.slice(dot + 1));
    const expected = Buffer.from(this.#mac(payload));
    if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (typeof data.p !== 'string' || typeof data.v !== 'number' || !(data.e > now)) return null;
      return { path: data.p, version: data.v };
    } catch {
      return null;
    }
  }

  /** HMAC of a value, for names that must not be guessable (workspace directories). */
  digest(value) {
    return crypto.createHmac('sha256', this.secret).update(`ws:${value}`).digest('hex').slice(0, 40);
  }
}

/** Splits a comma-separated token list from a header or query string. */
export function parseTokens(raw) {
  if (Array.isArray(raw)) return raw.filter((t) => typeof t === 'string').slice(0, 16);
  if (typeof raw !== 'string' || !raw) return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 16);
}

/**
 * Decides who may read and write a pad. The locks on a pad's path (its own and its
 * ancestors') form its lock chain:
 * - write needs a valid token for any lock in the chain (or no lock at all);
 * - read is open unless a lock in the chain is private, then it needs such a token too.
 */
export class Access {
  /** @param {{ lockChain(path: string): Array<{ path: string, mode: string, version: number }> }} store */
  constructor(store, signer) {
    this.store = store;
    this.signer = signer;
  }

  /**
   * @param {string} padPath
   * @param {string[]} tokens
   */
  check(padPath, tokens) {
    const chain = this.store.lockChain(padPath);
    const valid = tokens.map((t) => this.signer.verify(t)).filter(Boolean);
    const holds = chain.some((lock) => valid.some((v) => v.path === lock.path && v.version === lock.version));
    const isPrivate = chain.some((lock) => lock.mode === 'private');
    const nearest = chain.at(-1);
    return {
      canRead: !isPrivate || holds,
      canWrite: chain.length === 0 || holds,
      lock: nearest ? { path: nearest.path, mode: isPrivate ? 'private' : nearest.mode } : null,
      holds,
    };
  }
}
