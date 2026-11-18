import { ApiError } from './errors';

/**
 * Upload guards (M1). The request body is read as a stream and counted, so a client that lies about
 * (or omits) Content-Length cannot make the server buffer more than `limit` bytes before we refuse.
 */
export async function readLimitedForm(req: Request, limit: number, message: string): Promise<FormData | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > limit) throw new ApiError(413, 'FILE_TOO_LARGE', 'File too large', message);
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new ApiError(413, 'FILE_TOO_LARGE', 'File too large', message);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.byteLength;
  }
  const copy = new Request('http://local/upload', { method: 'POST', headers: { 'content-type': req.headers.get('content-type') ?? '' }, body });
  return copy.formData().catch(() => null);
}

/** Limits for Office (zip) files, checked from the central directory before any parser inflates them. */
export const ZIP_MAX_ENTRIES = 2_000;
export const ZIP_MAX_UNCOMPRESSED = 100 * 1024 * 1024;

/**
 * Reads the zip central directory and refuses archives that would inflate past the limits (zip bombs),
 * have too many entries, or use Zip64 (not needed for 10 MB Office files). Returns the totals.
 */
export function checkZipBounds(bytes: Uint8Array, maxEntries = ZIP_MAX_ENTRIES, maxUncompressed = ZIP_MAX_UNCOMPRESSED) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bad = (why: string) => new ApiError(400, 'FILE_REJECTED', 'This file could not be read safely', why);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad('The archive has no directory.');
  const entries = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (entries === 0xffff || cdOffset === 0xffffffff) throw bad('Zip64 archives are not accepted.');
  if (entries > maxEntries) throw bad(`The file has too many parts (${entries}).`);
  let p = cdOffset;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw bad('The archive directory is damaged.');
    const size = dv.getUint32(p + 24, true);
    if (size === 0xffffffff) throw bad('Zip64 archives are not accepted.');
    total += size;
    if (total > maxUncompressed) throw bad('The file expands to more than 100 MB.');
    p += 46 + dv.getUint16(p + 28, true) + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return { entries, uncompressed: total };
}

/** Bounds a parser's wall time. CPU-bound synchronous work cannot be interrupted, but the request is answered. */
export async function withDeadline<T>(ms: number, work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ApiError(422, 'PARSE_TIMEOUT', `${what} took too long to read`, 'Try a smaller or simpler file.')), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
