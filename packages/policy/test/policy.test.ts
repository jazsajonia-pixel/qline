import { describe, expect, it } from 'vitest';
import {
  can,
  canAssignRole,
  canDecideApproval,
  decideTool,
  defaultAllowlist,
  ROLES,
  routeAgent,
  TOOL_POLICIES,
} from '@qline/policy';

describe('roles', () => {
  it('owner holds every permission and viewer cannot write', () => {
    expect(can('owner', 'org.manage')).toBe(true);
    expect(can('viewer', 'tasks.write')).toBe(false);
    expect(can('viewer', 'tasks.read')).toBe(true);
  });
  it('only owner manages the org', () => {
    for (const r of ROLES) expect(can(r, 'org.manage')).toBe(r === 'owner');
  });
  it('nobody can assign owner, and admins cannot create admins', () => {
    expect(canAssignRole('owner', 'owner')).toBe(false);
    expect(canAssignRole('owner', 'admin')).toBe(true);
    expect(canAssignRole('admin', 'admin')).toBe(false);
    expect(canAssignRole('admin', 'manager')).toBe(true);
    expect(canAssignRole('manager', 'member')).toBe(false);
  });
});

describe('tool policy matrix (docs/07 §3)', () => {
  const ceo = defaultAllowlist('ceo');

  it('reads are allowed for every template', () => {
    for (const tool of ['records.search', 'tasks.search', 'documents.search', 'memory.read']) {
      expect(decideTool({ tool, allowlist: defaultAllowlist('research'), userRole: 'member' }).decision).toBe('allow');
    }
  });

  it('task creation needs approval by default and can be relaxed by the org', () => {
    expect(decideTool({ tool: 'tasks.create', allowlist: ceo, userRole: 'owner' }).decision).toBe('require_approval');
    expect(decideTool({ tool: 'tasks.create', allowlist: ceo, userRole: 'owner', relaxed: ['tasks.create'] }).decision).toBe('allow');
  });

  it('research agent cannot create tasks', () => {
    expect(decideTool({ tool: 'tasks.create', allowlist: defaultAllowlist('research'), userRole: 'owner' }).decision).toBe('deny');
  });

  it('L3 external actions always need approval even if the org tries to relax them', () => {
    const sales = defaultAllowlist('sales');
    const r = decideTool({ tool: 'email.send', allowlist: sales, userRole: 'owner', relaxed: ['email.send'] });
    expect(r.decision).toBe('require_approval');
    expect(r.risk).toBe('L3');
  });

  it('money and policy changes are hard-denied', () => {
    for (const tool of ['payments.create', 'transfers.send', 'agents.grant_permission', 'policy.update', 'org.delete']) {
      expect(decideTool({ tool, allowlist: [tool], userRole: 'owner' }).decision).toBe('deny');
    }
  });

  it('unknown tools are denied', () => {
    expect(decideTool({ tool: 'shell.exec', allowlist: ['shell.exec'], userRole: 'owner' }).decision).toBe('deny');
  });

  it('agent cannot exceed the human it acts for', () => {
    expect(decideTool({ tool: 'tasks.create', allowlist: ceo, userRole: 'viewer' }).decision).toBe('deny');
  });

  it('tightening turns an allow into an approval', () => {
    expect(decideTool({ tool: 'notes.create', allowlist: ceo, userRole: 'member', tightened: ['notes.create'] }).decision).toBe('require_approval');
  });

  it('every policy names a real template', () => {
    for (const p of Object.values(TOOL_POLICIES)) expect(p.templates.length).toBeGreaterThan(0);
  });
});

describe('approval authority', () => {
  it('members decide low risk only; high risk needs admin', () => {
    expect(canDecideApproval('member', 'L1')).toBe(true);
    expect(canDecideApproval('member', 'L2')).toBe(false);
    expect(canDecideApproval('manager', 'L2')).toBe(true);
    expect(canDecideApproval('manager', 'L3')).toBe(false);
    expect(canDecideApproval('admin', 'L3')).toBe(true);
    expect(canDecideApproval('owner', 'L4')).toBe(false);
    expect(canDecideApproval('viewer', 'L1')).toBe(false);
  });
});

describe('v1.6 autonomy levels', () => {
  const ceo = defaultAllowlist('ceo');
  const d = (tool: string, autonomy?: 'supervised' | 'autopilot' | 'full', extra: Record<string, unknown> = {}) => decideTool({ tool, allowlist: ceo, userRole: 'owner', autonomy, ...extra }).decision;

  it('supervised keeps the defaults', () => {
    expect(d('tasks.create', 'supervised')).toBe('require_approval');
    expect(d('slack.post', 'supervised')).toBe('require_approval');
    expect(d('tasks.search', 'supervised')).toBe('allow');
  });
  it('autopilot allows internal writes but still asks for deletes, config and external actions', () => {
    expect(d('tasks.create', 'autopilot')).toBe('allow');
    expect(d('contacts.update', 'autopilot')).toBe('allow');
    expect(d('companies.update', 'autopilot')).toBe('allow');
    expect(d('tasks.bulk_update', 'autopilot')).toBe('allow');
    expect(d('records.delete', 'autopilot')).toBe('require_approval');
    expect(d('config.propose', 'autopilot')).toBe('require_approval');
    expect(d('slack.post', 'autopilot')).toBe('require_approval');
    expect(d('slack.channel.create', 'autopilot')).toBe('require_approval');
  });
  it('full autopilot also acts in connected apps until the daily cap', () => {
    expect(d('slack.post', 'full')).toBe('allow');
    expect(d('slack.channel.create', 'full')).toBe('allow');
    expect(d('email.send', 'full')).toBe('allow');
    expect(d('records.delete', 'full')).toBe('allow');
    expect(d('slack.post', 'full', { externalCapReached: true })).toBe('require_approval');
    expect(d('config.propose', 'full')).toBe('require_approval');
  });
  it('never overrides the hard limits', () => {
    expect(d('payments.send', 'full')).toBe('deny');
    expect(d('policy.update', 'full')).toBe('deny');
    expect(d('slack.post', 'full', { stopped: true })).toBe('deny');
    expect(decideTool({ tool: 'slack.post', allowlist: defaultAllowlist('research'), userRole: 'owner', autonomy: 'full' }).decision).toBe('deny');
    expect(decideTool({ tool: 'tasks.create', allowlist: ceo, userRole: 'viewer', autonomy: 'full' }).decision).toBe('deny');
  });
  it('only the CEO can hand work to other agents', () => {
    expect(defaultAllowlist('ceo')).toContain('agents.delegate');
    expect(defaultAllowlist('sales')).not.toContain('agents.delegate');
  });
});

describe('v1.6 automatic agent switching', () => {
  it('routes clear requests to the matching specialist', () => {
    expect(routeAgent('How much revenue did we make and what are our expenses?')).toBe('finance');
    expect(routeAgent('Follow up with the new leads from yesterday')).toBe('sales');
    expect(routeAgent('Plan an Instagram campaign for the launch')).toBe('marketing');
    expect(routeAgent('Create tasks for the project deadline next week')).toBe('operations');
    expect(routeAgent('Research our competitors in Davao')).toBe('research');
  });
  it('keeps the CEO for general or mixed requests and for paused agents', () => {
    expect(routeAgent('Good morning, what should I focus on today?')).toBe('ceo');
    expect(routeAgent('Check the invoice for that lead')).toBe('ceo');
    expect(routeAgent('Research our competitors', ['ceo', 'sales'])).toBe('ceo');
  });
});

describe('v1.6 file and chart tools', () => {
  const ceo = defaultAllowlist('ceo');
  const research = defaultAllowlist('research');
  it('reading files and showing charts or images never needs approval', () => {
    for (const tool of ['files.read', 'chart.business', 'chart.create', 'image.show', 'files.save_to_library']) {
      expect(decideTool({ tool, allowlist: research, userRole: 'member' }).decision).toBe('allow');
    }
  });
  it('importing rows from a file asks first unless autopilot, and needs the imports permission', () => {
    expect(research).not.toContain('files.import_records');
    expect(decideTool({ tool: 'files.import_records', allowlist: ceo, userRole: 'owner' }).decision).toBe('require_approval');
    expect(decideTool({ tool: 'files.import_records', allowlist: ceo, userRole: 'owner', autonomy: 'autopilot' }).decision).toBe('allow');
    expect(decideTool({ tool: 'files.import_records', allowlist: ceo, userRole: 'member', autonomy: 'full' }).decision).toBe('deny');
    expect(decideTool({ tool: 'files.import_records', allowlist: ceo, userRole: 'owner', autonomy: 'full', stopped: true }).decision).toBe('deny');
  });
});

describe('M1: EXTERNAL_WRITE_TOOLS', () => {
  it('lists every L3 tool, so no connected-app action can skip the reservation and unknown-outcome path', async () => {
    const { EXTERNAL_WRITE_TOOLS } = await import('../src/index');
    const l3 = Object.entries(TOOL_POLICIES).filter(([, p]) => p.risk === 'L3').map(([k]) => k);
    expect(l3.length).toBeGreaterThan(0);
    for (const t of l3) expect(EXTERNAL_WRITE_TOOLS.has(t)).toBe(true);
    for (const t of EXTERNAL_WRITE_TOOLS) expect(TOOL_POLICIES[t]).toBeTruthy();
  });
});

describe('M2: REUSE_POLICY', () => {
  it('only lists read-only (L0) tools, with expiries of 30 minutes or less, and never live-status tools', async () => {
    const { REUSE_POLICY } = await import('../src/index');
    for (const [tool, p] of Object.entries(REUSE_POLICY)) {
      expect(TOOL_POLICIES[tool]?.risk, tool).toBe('L0');
      expect(p.ttlSec).toBeGreaterThan(0);
      expect(p.ttlSec).toBeLessThanOrEqual(1800);
      expect(p.tables.length).toBeGreaterThan(0);
    }
    for (const live of ['time.now', 'approvals.list', 'agents.status', 'leads.list', 'business.snapshot', 'chart.create', 'chart.business', 'image.show']) expect(REUSE_POLICY[live]).toBeUndefined();
  });
  it('wantsFresh spots requests for current data', async () => {
    const { wantsFresh } = await import('../src/index');
    for (const s of ['Refresh my tasks', 'check again please', 'any new emails?', 'what is the latest on Acme', 'show it again', 'up-to-date numbers', 'Check mo ulit yung tasks', 'May bago ba sa inbox?']) expect(wantsFresh(s), s).toBe(true);
    for (const s of ['What tasks are open?', 'Summarise the Acme deal', 'Draft a reply to Dana']) expect(wantsFresh(s), s).toBe(false);
  });
});

describe('v1.10: GitHub code, pull requests and CI (docs/24)', () => {
  const reads = ['github.repo', 'github.tree', 'github.file', 'github.code_search', 'github.branches', 'github.commits', 'github.commit', 'github.compare', 'github.pulls', 'github.pull', 'github.runs', 'github.run', 'github.checks'];
  const writes = ['github.branch.create', 'github.files.commit', 'github.pr.create', 'github.pr.update', 'github.pr.review', 'github.issue.create', 'github.issue.comment'];

  it('reads are L0 for every built-in profile and need only tasks.read', () => {
    for (const t of reads) {
      expect(TOOL_POLICIES[t]?.risk, t).toBe('L0');
      expect(TOOL_POLICIES[t]?.requires, t).toBe('tasks.read');
      expect(decideTool({ tool: t, allowlist: defaultAllowlist('research'), userRole: 'viewer' }).decision, t).toBe('allow');
    }
  });

  it('every write is L3, only for CEO and Operations, and asks a person at every autonomy level', async () => {
    const { ALWAYS_ASK, EXTERNAL_WRITE_TOOLS, GITHUB_WRITE_TOOLS } = await import('../src/index');
    expect([...GITHUB_WRITE_TOOLS].sort()).toEqual([...writes].sort());
    for (const t of writes) {
      expect(TOOL_POLICIES[t]?.risk, t).toBe('L3');
      expect(TOOL_POLICIES[t]?.templates, t).toEqual(['ceo', 'operations']);
      expect(ALWAYS_ASK.has(t), t).toBe(true);
      expect(EXTERNAL_WRITE_TOOLS.has(t), t).toBe(true);
      for (const autonomy of ['supervised', 'autopilot', 'full'] as const) {
        expect(decideTool({ tool: t, allowlist: defaultAllowlist('ceo'), userRole: 'owner', autonomy, relaxed: [t] }).decision, `${t} ${autonomy}`).toBe('require_approval');
      }
      expect(decideTool({ tool: t, allowlist: defaultAllowlist('ceo'), userRole: 'viewer' }).decision, t).toBe('deny');
      expect(defaultAllowlist('research')).not.toContain(t);
    }
  });

  it('has no merge, force-push, delete, workflow or secrets tool', () => {
    for (const t of Object.keys(TOOL_POLICIES).filter((k) => k.startsWith('github.'))) expect(t).not.toMatch(/merge|force|delete|secret|workflow_dispatch|rerun|dispatch|variable/);
  });
});
