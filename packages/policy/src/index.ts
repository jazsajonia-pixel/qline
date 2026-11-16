/**
 * Qline permission + agent tool policy (docs/07 §3, docs/05 §3).
 * Pure TypeScript, no I/O. Every decision the API makes about "may this
 * actor do this?" goes through these functions so they can be tested alone.
 */

export const ROLES = ['owner', 'admin', 'manager', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'org.manage',
  'members.manage',
  'config.apply',
  'imports.run',
  'tasks.read',
  'tasks.write',
  'contacts.read',
  'contacts.write',
  'documents.read',
  'documents.write',
  'memory.read',
  'memory.write',
  'agents.use',
  'agents.manage',
  'workflows.read',
  'workflows.manage',
  'approvals.decide:low',
  'approvals.decide:medium',
  'approvals.decide:high',
  'audit.read',
  'export.run',
  'integrations.manage',
  'ai.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);
const READS: Permission[] = ['tasks.read', 'contacts.read', 'documents.read', 'memory.read', 'workflows.read'];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: ALL,
  admin: new Set([...PERMISSIONS].filter((p) => p !== 'org.manage')),
  manager: new Set<Permission>([
    ...READS,
    'imports.run',
    'tasks.write',
    'contacts.write',
    'documents.write',
    'memory.write',
    'agents.use',
    'workflows.manage',
    'approvals.decide:low',
    'approvals.decide:medium',
    'audit.read',
  ]),
  member: new Set<Permission>([
    ...READS,
    'tasks.write',
    'contacts.write',
    'documents.write',
    'memory.write',
    'agents.use',
    'approvals.decide:low',
  ]),
  viewer: new Set<Permission>(READS),
};

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

export function can(role: Role, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(perm) ?? false;
}

/** A role may only assign roles strictly below its own (owner may assign admin and below). */
export function canAssignRole(actor: Role, target: Role): boolean {
  if (!can(actor, 'members.manage')) return false;
  const rank = (r: Role) => ROLES.indexOf(r);
  if (target === 'owner') return false;
  return rank(target) > rank(actor) || (actor === 'owner' && target === 'admin');
}

// ---------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------

export type Risk = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
export type Decision = 'allow' | 'require_approval' | 'deny';
export type AgentTemplate = 'ceo' | 'sales' | 'marketing' | 'finance' | 'operations' | 'research';

export const AGENT_TEMPLATES: AgentTemplate[] = ['ceo', 'sales', 'marketing', 'finance', 'operations', 'research'];

export interface ToolPolicy {
  risk: Risk;
  /** Templates that carry this tool in their default allowlist. */
  templates: AgentTemplate[];
  /** Default decision when the agent is allowed to use the tool. */
  decision: Decision;
  /** Permission the initiating human must hold for the action to happen at all. */
  requires: Permission;
  /** Orgs may relax `require_approval` to `allow` only for tools that set this. */
  relaxable?: boolean;
}

const T = (...t: AgentTemplate[]) => t;
const NON_RESEARCH = T('ceo', 'sales', 'marketing', 'finance', 'operations');

export const TOOL_POLICIES: Record<string, ToolPolicy> = {
  'records.search': { risk: 'L0', templates: AGENT_TEMPLATES, decision: 'allow', requires: 'contacts.read' },
  'tasks.search': { risk: 'L0', templates: AGENT_TEMPLATES, decision: 'allow', requires: 'tasks.read' },
  'documents.search': { risk: 'L0', templates: AGENT_TEMPLATES, decision: 'allow', requires: 'documents.read' },
  'memory.read': { risk: 'L0', templates: AGENT_TEMPLATES, decision: 'allow', requires: 'memory.read' },
  'tasks.create': { risk: 'L1', templates: NON_RESEARCH, decision: 'require_approval', requires: 'tasks.write', relaxable: true },
  'tasks.update': { risk: 'L1', templates: NON_RESEARCH, decision: 'require_approval', requires: 'tasks.write', relaxable: true },
  'notes.create': { risk: 'L1', templates: AGENT_TEMPLATES, decision: 'allow', requires: 'documents.write' },
  'memory.propose': { risk: 'L1', templates: AGENT_TEMPLATES, decision: 'allow', requires: 'memory.write' },
  'contacts.update': { risk: 'L1', templates: T('ceo', 'sales', 'operations'), decision: 'require_approval', requires: 'contacts.write' },
  'drafts.email.create': { risk: 'L1', templates: T('ceo', 'sales', 'marketing', 'operations'), decision: 'allow', requires: 'documents.write' },
  'tasks.bulk_update': { risk: 'L2', templates: T('ceo', 'operations'), decision: 'require_approval', requires: 'tasks.write' },
  'records.delete': { risk: 'L2', templates: T('ceo', 'operations'), decision: 'require_approval', requires: 'contacts.write' },
  'config.propose': { risk: 'L2', templates: T('ceo', 'operations'), decision: 'require_approval', requires: 'config.apply' },
  'email.send': { risk: 'L3', templates: T('sales', 'marketing', 'operations'), decision: 'require_approval', requires: 'contacts.write' },
  'calendar.invite.send': { risk: 'L3', templates: T('sales', 'marketing', 'operations'), decision: 'require_approval', requires: 'contacts.write' },
  'social.publish': { risk: 'L3', templates: T('sales', 'marketing', 'operations'), decision: 'require_approval', requires: 'contacts.write' },
};

/** Actions that are never available to agents or workflows, whatever the configuration. */
export const HARD_DENY_PREFIXES = ['payments.', 'transfers.'];
export const AGENT_DENY = new Set(['records.purge', 'org.delete', 'share.external', 'agents.grant_permission', 'policy.update']);

export const RISK_APPROVAL_PERMISSION: Record<Risk, Permission | null> = {
  L0: 'approvals.decide:low',
  L1: 'approvals.decide:low',
  L2: 'approvals.decide:medium',
  L3: 'approvals.decide:high',
  L4: null, // nobody approves L4 for an agent
};

export function riskLabel(r: Risk): 'low' | 'medium' | 'high' {
  return r === 'L0' || r === 'L1' ? 'low' : r === 'L2' ? 'medium' : 'high';
}

export interface DecideInput {
  tool: string;
  /** The agent's effective allowlist (from its version). */
  allowlist: readonly string[];
  /** Role of the human the agent is acting for. */
  userRole: Role;
  /** Org overrides: tools relaxed from approval to allow (only honoured when relaxable). */
  relaxed?: readonly string[];
  /** Org overrides: tools tightened from allow to approval. */
  tightened?: readonly string[];
}

export interface DecideResult {
  decision: Decision;
  risk: Risk;
  reason: string;
}

export function decideTool(input: DecideInput): DecideResult {
  const { tool } = input;
  if (HARD_DENY_PREFIXES.some((p) => tool.startsWith(p))) {
    return { decision: 'deny', risk: 'L4', reason: 'Money movement is not implemented and is always denied.' };
  }
  if (AGENT_DENY.has(tool)) {
    return { decision: 'deny', risk: 'L4', reason: 'Agents can never perform this action.' };
  }
  const p = TOOL_POLICIES[tool];
  if (!p) return { decision: 'deny', risk: 'L4', reason: `Unknown tool "${tool}".` };
  if (!input.allowlist.includes(tool)) {
    return { decision: 'deny', risk: p.risk, reason: 'This agent is not allowed to use this tool.' };
  }
  if (!can(input.userRole, p.requires)) {
    return { decision: 'deny', risk: p.risk, reason: `You need the ${p.requires} permission for this.` };
  }
  let decision = p.decision;
  if (decision === 'allow' && input.tightened?.includes(tool)) decision = 'require_approval';
  if (decision === 'require_approval' && p.relaxable && p.risk !== 'L3' && input.relaxed?.includes(tool)) decision = 'allow';
  // Floor: L3 always needs approval, whatever the org says.
  if (p.risk === 'L3') decision = 'require_approval';
  return { decision, risk: p.risk, reason: decision === 'allow' ? 'Allowed by policy.' : 'Needs a human decision.' };
}

export function defaultAllowlist(template: AgentTemplate): string[] {
  return Object.entries(TOOL_POLICIES)
    .filter(([, p]) => p.templates.includes(template))
    .map(([name]) => name);
}

/** May this human decide an approval of this risk? */
export function canDecideApproval(role: Role, risk: Risk): boolean {
  const perm = RISK_APPROVAL_PERMISSION[risk];
  return perm !== null && can(role, perm);
}
