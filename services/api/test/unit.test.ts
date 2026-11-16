import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { detectFormat, parseFile, suggestMapping } from '../src/modules/imports';
import { analyseWithRules, buildProposal } from '../src/modules/onboarding';
import { DEFAULT_CONFIG } from '../src/modules/templates';
import { classifyByRules, rulesSchema } from '../src/integrations/leads';
import { envelope } from '../src/modules/voice';

const enc = (s: string) => new TextEncoder().encode(s);

describe('file validation', () => {
  it('accepts known types and checks magic bytes', () => {
    expect(detectFormat('clients.csv', enc('name,email\n'))).toBe('csv');
    expect(() => detectFormat('book.xlsm', enc('PK\u0003\u0004'))).toThrow(/Macro/);
    expect(() => detectFormat('fake.xlsx', enc('name,email'))).toThrow(/does not match/);
    expect(() => detectFormat('fake.pdf', enc('hello'))).toThrow(/does not match/);
    expect(() => detectFormat('run.exe', enc('MZ'))).toThrow(/Unsupported/);
    expect(() => detectFormat('x.csv', new Uint8Array([0x50, 0x4b, 3, 4, 0]))).toThrow(/text file/);
  });
});

describe('parsing and mapping', () => {
  it('parses CSV with BOM and suggests a contacts mapping', async () => {
    const p = await parseFile('csv', enc('\uFEFFFull Name,E-mail,Company,Phone\nAna Cruz,ana@x.test,Acme,123\n,,,\n'));
    expect(p.columns).toEqual(['Full Name', 'E-mail', 'Company', 'Phone']);
    expect(p.rows).toHaveLength(1);
    const m = suggestMapping(p.columns);
    expect(m.target).toBe('contacts');
    expect(m.fields).toMatchObject({ name: 'Full Name', email: 'E-mail', company: 'Company', phone: 'Phone' });
  });
  it('detects tasks from headers', () => {
    expect(suggestMapping(['Task', 'Status', 'Due date']).target).toBe('tasks');
  });
  it('parses JSON arrays and {items}', async () => {
    const p = await parseFile('json', enc(JSON.stringify({ items: [{ name: 'A', email: 'a@x.test' }, { name: 'B' }] })));
    expect(p.rows).toHaveLength(2);
    expect(p.columns).toEqual(['name', 'email']);
    await expect(parseFile('json', enc('{"a":1}'))).rejects.toThrow(/array/);
  });
  it('reads XLSX values only and never evaluates formulas', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Clients');
    ws.addRow(['Name', 'Email', 'Total']);
    ws.addRow(['Ana', 'ana@x.test', { formula: 'SUM(1,2)', result: 3 }]);
    ws.addRow(['Ben', 'ben@x.test', { formula: 'WEBSERVICE("http://evil")' }]);
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
    const p = await parseFile('xlsx', bytes);
    expect(p.rows[0]).toEqual({ Name: 'Ana', Email: 'ana@x.test', Total: '3' });
    expect(p.rows[1].Total).toBe('');
  });
  it('treats text as a document', async () => {
    const p = await parseFile('md', enc('# Pricing\nWe charge monthly.'));
    expect(p.kind).toBe('document');
    expect(p.text).toContain('Pricing');
  });
});

describe('onboarding rules', () => {
  it('builds a model from answers and marks unknowns as defaults', () => {
    const m = analyseWithRules({
      clients: { value: 'Consumers (B2C)', at: '' },
      taskStages: { value: 'To do -> In progress -> Check', at: '' },
      pains: { value: 'cash flow and late invoices', at: '' },
      aiComfort: { value: 'Small internal tasks are fine', at: '' },
      salesStages: { value: 'x', unknown: true, at: '' },
    });
    expect(m.clientWord.value).toBe('Customer');
    expect(m.taskStatuses.value).toEqual(['to_do', 'in_progress', 'check']);
    expect(m.pipelineStages.source).toBe('default');
    expect(m.recommendedAgents.value).toContain('finance');
    expect(m.aiAutonomy.value).toBe('internal_ok');
  });
  it('proposal diff lists changes and always ends statuses with done; workflows disabled', () => {
    const m = analyseWithRules({ taskStages: { value: 'Backlog, Doing', at: '' }, tools: { value: 'Gmail, Notion', at: '' } });
    const { snapshot, diff } = buildProposal(m, DEFAULT_CONFIG);
    expect(snapshot.taskStatuses).toEqual(['backlog', 'doing', 'done']);
    expect(snapshot.workflows).toEqual([{ template: 'new_client_onboarding', enabled: false }]);
    expect(snapshot.integrationsSuggested).toEqual(['google_gmail', 'notion']);
    expect(diff.find((d) => d.path === 'taskStatuses')).toBeTruthy();
  });
});

describe('API key encryption', () => {
  it('round-trips, binds to org+provider, and refuses without a data key', async () => {
    const { seal, open } = await import('../src/core/secrets');
    const prev = process.env.QLINE_DATA_KEY;
    process.env.QLINE_DATA_KEY = 'x'.repeat(48);
    try {
      const s = seal('sk-secret-value-1234', 'org1:openai');
      expect(s).not.toContain('secret');
      expect(open(s, 'org1:openai')).toBe('sk-secret-value-1234');
      expect(() => open(s, 'org2:openai')).toThrow();
      delete process.env.QLINE_DATA_KEY;
      expect(() => seal('a', 'b')).toThrow(/QLINE_DATA_KEY/);
    } finally {
      if (prev) process.env.QLINE_DATA_KEY = prev;
      else delete process.env.QLINE_DATA_KEY;
    }
  });
});

describe('lead rules (v1.2)', () => {
  const r = rulesSchema.parse({ vipDomains: ['vip.test'], ignoreDomains: ['spam.test'] });
  it('finds leads and urgency from keywords', () => {
    expect(classifyByRules({ fromEmail: 'a@b.test', fromName: 'A', subject: 'Quote request', text: 'Need it ASAP' }, r)).toMatchObject({ isLead: true, urgency: 'urgent' });
    expect(classifyByRules({ fromEmail: 'a@b.test', fromName: 'A', subject: 'Hello', text: 'How are you' }, r)).toMatchObject({ isLead: false });
  });
  it('VIP domains are at least high; ignore list and newsletters are never leads', () => {
    expect(classifyByRules({ fromEmail: 'boss@sub.vip.test', fromName: null, subject: 'Hi', text: '' }, r)).toMatchObject({ isLead: true, urgency: 'high' });
    expect(classifyByRules({ fromEmail: 'x@spam.test', fromName: null, subject: 'Pricing', text: 'urgent quote' }, r).isLead).toBe(false);
    expect(classifyByRules({ fromEmail: 'x@news.test', fromName: null, subject: 'Pricing', text: 'quote', bulk: true }, r).isLead).toBe(false);
  });
});

describe('voice envelope (v1.2)', () => {
  it('normalises loudness per window', () => {
    const rate = 1000;
    const pcm = Buffer.alloc(rate * 2 * 0.2); // 200 ms
    for (let i = 100; i < 200; i++) pcm.writeInt16LE(i % 2 ? 12000 : -12000, i * 2); // loud second half
    const e = envelope(pcm, rate, 50);
    expect(e.length).toBe(4);
    expect(e[0]).toBe(0);
    expect(Math.max(...e)).toBe(1);
  });
});
