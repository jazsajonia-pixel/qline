import type { Context } from 'hono';
import { z } from 'zod';
import { badRequest } from './errors';

export async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    raw = {};
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[i.path.join('.') || '_'] = i.message;
    throw badRequest('Some fields are invalid.', fields);
  }
  return r.data;
}

export function query<T extends z.ZodTypeAny>(c: Context, schema: T): z.infer<T> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw badRequest('Invalid query parameters.');
  return r.data;
}

export const uuid = z.string().uuid();
export const limitParam = z.coerce.number().int().min(1).max(100).default(50);
