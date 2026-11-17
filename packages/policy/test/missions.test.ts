import { describe, expect, it } from 'vitest';
import { checkOutputSchema, decideTool, defaultAllowlist, effectivePermissions, resolveInputs, validateOutput, validatePlan, type OutputSchema } from '@qline/policy';

const out: OutputSchema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
const task = (key: string, extra: Record<string, unknown> = {}) => ({ key, agent: 'research', title: `Do ${key}`, instructions: 'Find things', dependsOn: [], inputs: {}, outputSchema: out, review: 'schema', ...extra });

describe('effectivePermissions (docs/13 §4)', () => {
  const research = defaultAllowlist('research');
  const ceo = defaultAllowlist('ceo');
  it('child is a subset of parent and agent; only no-approval internal tools', () => {
    const r = effectivePermissions({ role: 'owner', parentTools: ceo, agentTools: defaultAllowlist('sales'), depth: 1 });
    expect(r.ok).toBe(true);
    for (const t of r.tools) {
      expect(ceo).toContain(t);
      expect(defaultAllowlist('sales')).toContain(t);
    }
    expect(r.tools).toContain('records.search');
    expect(r.tools).toContain('drafts.email.create');
    for (const t of ['email.send', 'slack.post', 'tasks.create', 'contacts.update', 'calendar.create', 'workflows.run', 'records.delete']) expect(r.tools).not.toContain(t);
  });
  it('never grows past the parent', () => {
    const r = effectivePermissions({ role: 'owner', parentTools: ['records.search'], agentTools: research, depth: 1 });
    expect(r.tools).toEqual(['records.search']);
  });
  it('respects the human role (viewer cannot write notes)', () => {
    const r = effectivePermissions({ role: 'viewer', parentTools: ceo, agentTools: research, depth: 1 });
    expect(r.tools).not.toContain('notes.create');
    expect(r.tools).toContain('tasks.search');
    expect(r.permissions).not.toContain('documents.write');
  });
  it('tightened tools drop out; depth limit and emergency stop deny all', () => {
    expect(effectivePermissions({ role: 'owner', parentTools: ceo, agentTools: research, depth: 1, tightened: ['notes.create'] }).tools).not.toContain('notes.create');
    expect(effectivePermissions({ role: 'owner', parentTools: ceo, agentTools: research, depth: 4 }).ok).toBe(false);
    expect(effectivePermissions({ role: 'owner', parentTools: ceo, agentTools: research, depth: 1, stopped: true })).toMatchObject({ ok: false, tools: [] });
  });
  it('requested tools narrow further', () => {
    expect(effectivePermissions({ role: 'owner', parentTools: ceo, agentTools: research, depth: 1, requestedTools: ['tasks.search', 'email.send'] }).tools).toEqual(['tasks.search']);
  });
});

describe('decideTool emergency stop', () => {
  it('denies even L0 tools when stopped', () => {
    expect(decideTool({ tool: 'tasks.search', allowlist: ['tasks.search'], userRole: 'owner', stopped: true }).decision).toBe('deny');
    expect(decideTool({ tool: 'tasks.search', allowlist: ['tasks.search'], userRole: 'owner' }).decision).toBe('allow');
  });
});

describe('validatePlan (docs/13 §5)', () => {
  it('accepts a valid plan and returns order + depth', () => {
    const r = validatePlan({ summary: 'Plan', tasks: [task('find_leads'), task('draft_emails', { agent: 'sales', dependsOn: ['find_leads'], inputs: { leads: { $from: 'find_leads.summary' } } })] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.order).toEqual(['find_leads', 'draft_emails']);
      expect(r.depth).toBe(2);
    }
  });
  it('rejects forward references and cycles', () => {
    expect(validatePlan({ summary: 'x', tasks: [task('aa', { dependsOn: ['bb'] }), task('bb', { dependsOn: ['aa'] })] }).ok).toBe(false);
    expect(validatePlan({ summary: 'x', tasks: [task('aa', { dependsOn: ['aa'] })] }).ok).toBe(false);
  });
  it('rejects $from not in dependsOn, unknown agents, bad keys, duplicates', () => {
    const bad = (tasks: unknown[]) => validatePlan({ summary: 'x', tasks });
    expect(bad([task('aa'), task('bb', { inputs: { v: { $from: 'aa' } } })]).ok).toBe(false);
    expect(bad([task('aa', { agent: 'ceo' })]).ok).toBe(false);
    expect(bad([task('Bad-Key')]).ok).toBe(false);
    expect(bad([task('aa'), task('aa')]).ok).toBe(false);
  });
  it('rejects reserved keys anywhere', () => {
    expect(validatePlan({ summary: 'x', tasks: [task('approved')] }).ok).toBe(false);
    expect(validatePlan({ summary: 'x', tasks: [task('aa', { inputs: { nested: { approved_steps: [1] } } })] }).ok).toBe(false);
    expect(validatePlan({ summary: 'x', tasks: [task('aa', { outputSchema: { type: 'object', properties: { trigger: { type: 'string' } } } })] }).ok).toBe(false);
  });
  it('limits size and depth', () => {
    expect(validatePlan({ summary: 'x', tasks: [] }).ok).toBe(false);
    expect(validatePlan({ summary: 'x', tasks: Array.from({ length: 21 }, (_, i) => task(`t${i}`)) }).ok).toBe(false);
    const chain = Array.from({ length: 7 }, (_, i) => task(`t${i}`, { dependsOn: i ? [`t${i - 1}`] : [] }));
    expect(validatePlan({ summary: 'x', tasks: chain }).ok).toBe(false);
    expect(validatePlan({ summary: 'x', tasks: chain.slice(0, 6) }).ok).toBe(true);
  });
  it('rejects unknown tools and review modes', () => {
    expect(validatePlan({ summary: 'x', tasks: [task('aa', { tools: ['nope.tool'] })] }).ok).toBe(false);
    expect(validatePlan({ summary: 'x', tasks: [task('aa', { review: 'ceo' })] }).ok).toBe(false);
  });
});

describe('output schemas', () => {
  it('checks schemas and values', () => {
    expect(checkOutputSchema(out)).toEqual([]);
    expect(checkOutputSchema({ type: 'object', properties: {} }).length).toBeGreaterThan(0);
    expect(validateOutput(out, { summary: 'ok' })).toEqual([]);
    expect(validateOutput(out, {}).length).toBe(1);
    expect(validateOutput(out, { summary: 'ok', extra: 1 }).length).toBe(1);
    expect(validateOutput(out, { summary: 'ok', approved: true }).length).toBe(1);
    const list: OutputSchema = { type: 'object', properties: { n: { type: 'integer', minimum: 0 }, xs: { type: 'array', items: { type: 'string' }, maxItems: 2 } } };
    expect(validateOutput(list, { n: 1.5 }).length).toBe(1);
    expect(validateOutput(list, { xs: ['a', 'b', 'c'] }).length).toBe(1);
  });
  it('resolves $from inputs', () => {
    expect(resolveInputs({ a: { $from: 'x.summary' }, b: [{ $from: 'x' }], c: 1 }, { x: { summary: 'S' } })).toEqual({ a: 'S', b: [{ summary: 'S' }], c: 1 });
  });
});
