import { describe, expect, it } from 'vitest';
import {
  can,
  canAssignRole,
  canDecideApproval,
  decideTool,
  defaultAllowlist,
  ROLES,
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
