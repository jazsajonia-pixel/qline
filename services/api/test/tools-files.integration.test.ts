/**
 * v1.6 run 2: files sent to the AI, charts and images in chat — against a real Postgres as the app role (RLS on).
 * Storage uses the test-only in-memory store. Needs QLINE_TEST_ENV; skipped otherwise.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const envFile = process.env.QLINE_TEST_ENV;
if (envFile) process.loadEnvFile(envFile);
process.env.NODE_ENV = 'test';
process.env.QLINE_RUNTIME_KICK = '0';

const d = envFile ? describe : describe.skip;

type Who = { token: string; org?: string; userId?: string; ws?: string };
let app: { fetch: (r: Request) => Promise<Response> };
let db: typeof import('../src/core/db');
let tools: typeof import('../src/agent/tools');
let ai: typeof import('@qline/ai');

const headers = (who: Who) => ({ authorization: `Bearer ${who.token}`, ...(who.org ? { 'x-qline-org': who.org } : {}) });

async function call(who: Who | null, method: string, path: string, body?: unknown) {
  const h: Record<string, string> = who ? headers(who) : {};
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await app.fetch(new Request(`http://localhost/v1${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }));
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, res };
}

async function attach(who: Who, name: string, bytes: Uint8Array | string, type = 'application/octet-stream') {
  const form = new FormData();
  form.append('file', new Blob([(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes) as BlobPart], { type }), name);
  const res = await app.fetch(new Request('http://localhost/v1/agents/attachments', { method: 'POST', headers: headers(who), body: form }));
  return { status: res.status, json: await res.json() as any };
}

async function setup(name: string): Promise<Who> {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@test.qline.dev`;
  const r = await call(null, 'POST', '/auth/sign-up/email', { email, password: 'correct-horse-battery', name });
  const w: Who = { token: r.json.token };
  w.org = (await call(w, 'POST', '/orgs', { name: `${name} Co` })).json.id;
  w.userId = (await call(w, 'GET', '/me')).json.user.id;
  w.ws = (await db.withTenant({ orgId: w.org!, userId: w.userId! }, (q) => q.one('select id from workspaces where org_id=$1', [w.org])))!.id;
  return w;
}

const run = (w: Who, name: string, args: unknown) =>
  db.withTenant({ orgId: w.org!, userId: w.userId! }, (q) => {
    const t = tools.getTool(name)!;
    return t.execute(q, { orgId: w.org!, workspaceId: w.ws!, actor: { kind: 'agent', id: 'test-agent' }, userId: w.userId! }, t.schema.parse(args));
  });

// 1×1 transparent PNG
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
const CSV = 'Name,Email,Company,Stage\nAna Cruz,ana@example.com,Acme,lead\nBen Lim,ben@example.com,Acme,customer\nAna Again,ANA@example.com,Acme,lead\n';

d('v1.6 files, charts and images (integration)', () => {
  let A: Who;
  let B: Who;
  beforeAll(async () => {
    app = (await import('../src/index')).default as any;
    db = await import('../src/core/db');
    tools = await import('../src/agent/tools');
    ai = await import('@qline/ai');
    A = await setup('Mara');
    B = await setup('Tess');
  });
  afterAll(async () => {
    await db.closePool();
  });

  it('every agent gets the file and chart tools; import is for agents that edit records', async () => {
    const agents = (await call(A, 'GET', '/agents')).json.items;
    const allow = async (template: string) => (await call(A, 'GET', `/agents/${agents.find((x: any) => x.template === template).id}`)).json.tool_allowlist as string[];
    for (const t of ['ceo', 'research', 'finance']) expect(await allow(t)).toEqual(expect.arrayContaining(['files.read', 'files.save_to_library', 'chart.business', 'chart.create', 'image.show']));
    expect(await allow('ceo')).toContain('files.import_records');
    expect(await allow('research')).not.toContain('files.import_records');
  });

  it('attachments: parsed on upload, type checked by content, and private to the workspace', async () => {
    const csv = await attach(A, 'leads.csv', CSV, 'text/csv');
    expect(csv.status).toBe(201);
    expect(csv.json).toMatchObject({ kind: 'records', name: 'leads.csv' });
    expect(csv.json.summary).toContain('3 rows');
    const img = await attach(A, 'receipt.png', PNG, 'image/png');
    expect(img.status).toBe(201);
    expect(img.json).toMatchObject({ kind: 'image', mime: 'image/png' });
    // A text file named .png, and unsupported types, are refused.
    expect((await attach(A, 'fake.png', 'hello', 'image/png')).status).toBe(400);
    expect((await attach(A, 'tool.exe', 'MZ...')).status).toBe(400);
    // Image bytes are served with a fixed type and nosniff; non-images are not served; other orgs see nothing.
    const content = await app.fetch(new Request(`http://localhost/v1/files/${img.json.id}/content`, { headers: headers(A) }));
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/png');
    expect(content.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await content.arrayBuffer()).length).toBe(PNG.length);
    expect((await call(A, 'GET', `/files/${csv.json.id}/content`)).status).toBe(415);
    expect((await call(B, 'GET', `/files/${img.json.id}/content`)).status).toBe(404);
    const audit = await db.withTenant({ orgId: A.org!, userId: A.userId! }, (q) => q.one(`select count(*)::int as n from audit_events where action='file.attached'`));
    expect(audit.n).toBe(2);
  });

  it('a message can carry attachments (only your own), and the runner gives them to the model with images', async () => {
    const csv = (await attach(A, 'team.csv', CSV, 'text/csv')).json;
    const img = (await attach(A, 'photo.png', PNG, 'image/png')).json;
    const foreign = (await attach(B, 'b.csv', CSV, 'text/csv')).json;
    const conv = (await call(A, 'POST', '/conversations', {})).json;
    expect((await call(A, 'POST', `/conversations/${conv.id}/messages`, { content: 'x', attachments: [foreign.id] })).status).toBe(404);
    expect((await call(A, 'POST', `/conversations/${conv.id}/messages`, { content: '' })).status).toBe(400);

    // Connect a provider so the run can resolve a model; the mock stands in for it.
    const { seal } = await import('../src/core/secrets');
    const { aad } = await import('../src/agent/models');
    await db.withTenant({ orgId: A.org!, userId: A.userId! }, (q) =>
      q.exec(`insert into ai_provider_keys (org_id, provider, key_ciphertext, key_hint, models, created_by) values ($1,'anthropic',$2,'TEST',$3,'test')`, [
        A.org,
        seal('sk-ant-test-key', aad(A.org!, 'anthropic')),
        JSON.stringify([{ id: 'claude-test', name: 'Claude Test' }]),
      ]),
    );
    expect((await call(A, 'PUT', '/ai/default', { provider: 'anthropic', model: 'claude-test' })).status).toBe(200);

    const mock = new ai.MockProvider((req) => {
      const lastTool = [...req.messages].reverse().find((m) => m.role === 'tool');
      if (!lastTool) return [{ type: 'tool_call', call: { id: 'c1', type: 'function', function: { name: 'chart__business', arguments: JSON.stringify({ metric: 'contacts_by_stage' }) } } }, { type: 'done' }];
      return [{ type: 'token', text: 'Here is your pipeline. <qline-meta>{"speech":"Chart is on screen.","suggestions":["Import these contacts"]}</qline-meta>' }, { type: 'done' }];
    });
    ai.setTestProvider(mock);
    try {
      const m = await call(A, 'POST', `/conversations/${conv.id}/messages`, { content: '', attachments: [csv.id, img.id] });
      expect(m.status).toBe(202);
      const st = await app.fetch(new Request(`http://localhost/v1/runs/${m.json.runId}/stream`, { headers: headers(A) }));
      const sse = await st.text();
      expect(sse).toContain('event: artifact');
      expect(sse).toContain('"computed":true');
      const user = mock.calls[0].messages.find((x) => x.role === 'user') as any;
      expect(user.content).toContain('Attached files:');
      expect(user.content).toContain('trust="untrusted"');
      expect(user.content).toContain(csv.id);
      expect(user.content).toContain('ana@example.com');
      expect(user.images).toHaveLength(1);
      expect(user.images[0].mime).toBe('image/png');
      const g = (await call(A, 'GET', `/conversations/${conv.id}`)).json;
      const u = g.messages.find((x: any) => x.role === 'user');
      expect(u.content).toBe('Please look at the attached file.');
      expect(u.meta.attachments.map((a: any) => a.kind).sort()).toEqual(['image', 'records']);
      const reply = g.messages.find((x: any) => x.role === 'assistant');
      expect(reply.content).toContain('Here is your pipeline.');
      expect(reply.content).not.toContain('qline-meta');
      expect(reply.meta.speech).toBe('Chart is on screen.');
      expect(reply.meta.artifacts[0]).toMatchObject({ type: 'chart', chart: 'pie', computed: true, source: 'Qline data' });
    } finally {
      ai.setTestProvider(null);
    }
  });

  it('files.read pages through text and rows; save_to_library makes a searchable document', async () => {
    const long = 'Policy. '.repeat(1500); // 12,000 chars
    const doc = (await attach(A, 'policy.txt', long, 'text/plain')).json;
    const p1 = await run(A, 'files.read', { fileId: doc.id });
    expect((p1.data as any).text.length).toBe(8000);
    expect((p1.data as any).nextOffset).toBe(8000);
    const p2 = await run(A, 'files.read', { fileId: doc.id, offset: 8000 });
    expect((p2.data as any).nextOffset).toBeNull();
    const csv = (await attach(A, 'list.csv', CSV, 'text/csv')).json;
    expect(((await run(A, 'files.read', { fileId: csv.id })).data as any).rows).toHaveLength(3);
    const saved = await run(A, 'files.save_to_library', { fileId: doc.id, title: 'Refund policy' });
    expect(saved.ok).toBe(true);
    const found = await call(A, 'GET', '/documents');
    expect(found.json.items.some((x: any) => x.title === 'Refund policy')).toBe(true);
    // Other workspaces cannot read the file.
    expect((await run(B, 'files.read', { fileId: doc.id })).ok).toBe(false);
  });

  it('files.import_records imports with duplicate skipping, is recorded as an import, and can be rolled back', async () => {
    const csv = (await attach(A, 'crm.csv', CSV, 'text/csv')).json;
    const r = await run(A, 'files.import_records', { fileId: csv.id, target: 'contacts' });
    expect(r.ok).toBe(true);
    expect((r.data as any).imported).toBe(2);
    expect((r.data as any).skipped).toBe(1); // same email, different case
    const job = r.refs[0]!.id;
    const imp = await call(A, 'GET', `/imports/${job}`);
    expect(imp.json).toMatchObject({ status: 'completed', rows_ok: 2, target_entity: 'contacts' });
    expect((await call(A, 'GET', '/contacts?q=ana%40example.com')).json.items.length).toBe(1);
    // Wrong kind of file, and a mapping without the required column, fail clearly.
    const img = (await attach(A, 'x.png', PNG, 'image/png')).json;
    expect((await run(A, 'files.import_records', { fileId: img.id, target: 'contacts' })).ok).toBe(false);
    expect((await run(A, 'files.import_records', { fileId: csv.id, target: 'tasks' })).summary).toContain('No column for title');
    expect((await call(A, 'POST', `/imports/${job}/rollback`)).status).toBe(200);
    expect((await call(A, 'GET', '/contacts?q=ben%40example.com')).json.items.length).toBe(0);
  });

  it('chart.business computes from this workspace only; chart.create validates its data; image.show only shows images', async () => {
    for (const title of ['One', 'Two', 'Three']) expect((await call(A, 'POST', '/tasks', { title, priority: 'high' })).status).toBe(201);
    await call(B, 'POST', '/tasks', { title: 'Other org', priority: 'high' });
    const c = await run(A, 'chart.business', { metric: 'tasks_by_priority' });
    const chart = c.artifacts![0] as any;
    expect(chart).toMatchObject({ type: 'chart', chart: 'bar', computed: true });
    expect(chart.series[0].values[chart.labels.indexOf('high')]).toBe(3);
    const perDay = (await run(A, 'chart.business', { metric: 'leads_per_day', days: 14 })).artifacts![0] as any;
    expect(perDay.labels).toHaveLength(14);
    expect(perDay.series[0].values.every((v: number) => v === 0)).toBe(true);

    const t = tools.getTool('chart.create')!;
    expect(t.schema.safeParse({ chart: 'bar', title: 'X', labels: ['a', 'b'], series: [{ name: 's', values: [1] }], source: 'Sheet: X' }).success).toBe(false);
    expect(t.schema.safeParse({ chart: 'pie', title: 'X', labels: ['a'], series: [{ name: 's', values: [-1] }], source: 'Sheet: X' }).success).toBe(false);
    expect(t.schema.safeParse({ chart: 'line', title: 'X', labels: ['a'], series: [{ name: 's', values: [1] }] }).success).toBe(false); // source required
    const ok = await run(A, 'chart.create', { chart: 'line', title: 'Sales', labels: ['Jan', 'Feb'], series: [{ name: 'PHP', values: [10, 12] }], source: 'Sheet: Sales' });
    expect(ok.artifacts![0]).toMatchObject({ computed: false, source: 'Sheet: Sales' });

    const csv = (await attach(A, 'n.csv', CSV, 'text/csv')).json;
    expect((await run(A, 'image.show', { fileId: csv.id })).ok).toBe(false);
    const img = (await attach(A, 'logo.png', PNG, 'image/png')).json;
    expect((await run(A, 'image.show', { fileId: img.id, caption: 'Your logo' })).artifacts![0]).toMatchObject({ type: 'image', fileId: img.id });
    expect((await run(B, 'image.show', { fileId: img.id })).ok).toBe(false);
  });
});
