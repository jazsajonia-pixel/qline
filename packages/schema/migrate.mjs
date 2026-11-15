// Applies SQL migrations in order as the owner role.
// Env: DATABASE_URL_OWNER (unpooled owner connection), APP_DB_PASSWORD.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const url = process.env.DATABASE_URL_OWNER;
const appPassword = process.env.APP_DB_PASSWORD;
if (!url || !appPassword) {
  console.error('DATABASE_URL_OWNER and APP_DB_PASSWORD are required');
  process.exit(1);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
for (const f of files) {
  const always = f.includes('app_role'); // re-run grants every time so new tables are covered
  if (done.has(f) && !always) continue;
  let sqlText = fs.readFileSync(path.join(dir, f), 'utf8');
  sqlText = sqlText.replaceAll('__APP_PASSWORD__', appPassword.replaceAll("'", "''"));
  await client.query('begin');
  try {
    await client.query(sqlText);
    await client.query('insert into schema_migrations(name) values ($1) on conflict do nothing', [f]);
    await client.query('commit');
    console.log('applied', f);
  } catch (e) {
    await client.query('rollback');
    console.error('failed', f, e.message);
    process.exit(1);
  }
}
await client.end();
