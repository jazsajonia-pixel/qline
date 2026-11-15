import pg from 'pg';
import { env } from './env';

let pool: pg.Pool | null = null;
export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: env.databaseUrl, max: 5, idleTimeoutMillis: 20_000, connectionTimeoutMillis: 15_000 });
    pool.on('error', () => {});
  }
  return pool;
}
export async function closePool() {
  if (pool) await pool.end();
  pool = null;
}

export interface Q {
  many<T = any>(text: string, params?: unknown[]): Promise<T[]>;
  one<T = any>(text: string, params?: unknown[]): Promise<T | null>;
  exec(text: string, params?: unknown[]): Promise<number>;
}

function wrap(client: pg.PoolClient): Q {
  return {
    async many(text, params) {
      return (await client.query(text, params as any[])).rows;
    },
    async one(text, params) {
      return (await client.query(text, params as any[])).rows[0] ?? null;
    },
    async exec(text, params) {
      return (await client.query(text, params as any[])).rowCount ?? 0;
    },
  };
}

export interface DbCtx {
  orgId: string | null;
  userId: string;
}

/**
 * Every tenant query runs inside this: one transaction with the RLS context
 * set locally (docs/05 §4). The pooled connection never keeps the setting.
 */
export async function withTenant<T>(ctx: DbCtx, fn: (q: Q) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query("select set_config('qline.org_id', $1, true), set_config('qline.user_id', $2, true)", [ctx.orgId ?? '', ctx.userId]);
    const result = await fn(wrap(client));
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
