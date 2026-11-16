import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from './env';
import { ApiError } from './errors';

/** AES-256-GCM with a key derived from QLINE_DATA_KEY. Format: v1.<iv>.<tag>.<ciphertext> (base64url). */
function key() {
  const k = env.dataKey;
  if (!k || k.length < 32) throw new ApiError(503, 'DATA_KEY_MISSING', 'This server cannot store API keys yet', 'QLINE_DATA_KEY is not configured.');
  return createHash('sha256').update(k).digest();
}

export function seal(plain: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function open(sealed: string, aad: string): string {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unknown secret format');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
