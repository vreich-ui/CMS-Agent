/**
 * Operator password hashing/verification via scrypt.
 *
 * Hash format: scrypt$N$r$p$salt_b64$hash_b64
 *   N = CPU/memory cost, r = block size, p = parallelization
 * The plaintext password is never stored anywhere — only this hash line,
 * pasted into OPERATOR_PASSWORD_HASH.
 *
 * Run `npm run hash -- <password>` to generate a line for .env.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions
) => Promise<Buffer>;

const SCRYPT_N = 16384; // 2^14
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

interface ParsedHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseHash(stored: string): ParsedHash {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    throw new Error("OPERATOR_PASSWORD_HASH is malformed: expected scrypt$N$r$p$salt_b64$hash_b64");
  }
  const n = Number.parseInt(parts[1]!, 10);
  const r = Number.parseInt(parts[2]!, 10);
  const p = Number.parseInt(parts[3]!, 10);
  const salt = Buffer.from(parts[4]!, "base64url");
  const hash = Buffer.from(parts[5]!, "base64url");
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || salt.length === 0 || hash.length === 0) {
    throw new Error("OPERATOR_PASSWORD_HASH is malformed: could not parse scrypt parameters");
  }
  return { n, r, p, salt, hash };
}

/** Hashes a plaintext password into the scrypt$N$r$p$salt_b64$hash_b64 format. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = (await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  })) as Buffer;
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

/**
 * Verifies a plaintext password against a stored hash line, constant-time.
 * Returns false (never throws) for a malformed stored hash — a broken
 * config must fail closed on login, not crash the request handler.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  let parsed: ParsedHash;
  try {
    parsed = parseHash(stored);
  } catch {
    return false;
  }
  const derived = (await scrypt(password, parsed.salt, parsed.hash.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
    maxmem: 128 * parsed.n * parsed.r * 2,
  })) as Buffer;
  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
}

// --- CLI entry: `npm run hash -- <password>` -------------------------------

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${entry}`;
}

if (isMainModule()) {
  const password = process.argv[2];
  if (!password) {
    console.error("Usage: npm run hash -- <password>");
    process.exit(1);
  }
  hashPassword(password)
    .then((line) => {
      console.log("Paste this into OPERATOR_PASSWORD_HASH in your .env:\n");
      console.log(line);
    })
    .catch((err) => {
      console.error("Failed to hash password:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
