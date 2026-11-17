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
  // v1.3: connected apps (Gmail / Outlook, Calendar, Forms, Sheets, Slack) and Qline itself
  'gmail.search': { risk: 'L0', templates: AGENT_TEMPLATES, decision: 'allow', requires: 'contacts.read' },
  'gmail.read': { risk: 'L0', templates: AGENT_TEMPLATES, decision: 'allow', requires: 'contacts.read' },
  'calendar.list': { risk: 'L0', templates: AGENT_TEMPLATES, decision: 'allow', requires: 'tasks.read' },
  'leads.list': { risk: 'L0', templates: AGENT_TEMPLATES, decision: 'allow', requires: 'contacts.read' },
  'approvals.list': { risk: 'L0', templates: AGENT_TEMPLATES, decision: 'allow', requires: 'tasks.read' },
  'workflows.list': { risk: 'L0', templates: AGENT_TEMPLATES, decision: 'allow', requires: 'workflows.read' },
  'forms.responses': { risk: 'L0', templates: AGENT_TEMPLATES, decision: 'allow', requires: 'contacts.read' },
  'calendar.create': { risk: 'L1', templates: NON_RESEARCH, decision: 'allow', requires: 'tasks.write' },
  'forms.create': { risk: 'L1', templates: AGENT_TEMPLATES, decision: 'allow', requires: 'documents.write' },
  'sheets.create': { risk: 'L1', templates: AGENT_TEMPLATES, decision: 'allow', requires: 'documents.write' },
  'notify.me': { risk: 'L1', templates: AGENT_TEMPLATES, decision: 'allow', requires: 'agents.use' },
  'contacts.create': { risk: 'L1', templates: T('ceo', 'sales', 'marketing', 'operations'), decision: 'require_approval', requires: 'contacts.write', relaxable: true },
  'workflows.run': { risk: 'L2', templates: T('ceo', 'operations'), decision: 'require_approval', requires: 'workflows.manage' },
  'slack.post': { risk: 'L3', templates: T('ceo', 'sales', 'marketing', 'operations'), decision: 'require_approval', requires: 'contacts.write' },
  'email.send': { risk: 'L3', templates: T('ceo', 'sales', 'marketing', 'operations'), decision: 'require_approval', requires: 'contacts.write' },
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
  /** v1.5: workspace emergency stop. When on, every agent and workflow tool is denied. */
  stopped?: boolean;
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
  if (input.stopped) return { decision: 'deny', risk: p.risk, reason: 'Emergency stop is on for this workspace.' };
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

// ---------------------------------------------------------------------------
// v1.5 AI CEO missions (docs/13). Pure functions: effective permissions, plan
// validation and task output validation. The API calls these; tests cover them alone.
// ---------------------------------------------------------------------------

export const MISSION_AGENTS = ['sales', 'marketing', 'finance', 'operations', 'research'] as const;
export type MissionAgent = (typeof MISSION_AGENTS)[number];

/** Keys the engine owns; a plan or a task output may never set them (forged approvals). */
export const RESERVED_KEYS = ['approved', 'approved_steps', 'trigger', 'approval'] as const;

/**
 * Tools a mission task may run without a human. v1.5.0 keeps missions supervised and replay-safe:
 * read-only tools (L0) plus internal L1 tools whose effect stays inside Qline and is idempotent per key.
 * Anything that needs an approval, or reaches an external app with a write, is not given to mission tasks.
 */
export const MISSION_INTERNAL_WRITES = new Set(['notes.create', 'memory.propose', 'drafts.email.create', 'notify.me']);

export const MAX_DELEGATION_DEPTH = 3;

export interface EffectiveInput {
  /** Role of the human the mission acts for. */
  role: Role;
  /** Allowlist of the parent (the mission owner's grant, or the parent task's tools). */
  parentTools: readonly string[];
  /** Allowlist of the agent that will act (its version's tool_allowlist). */
  agentTools: readonly string[];
  /** Optional narrower list requested by the plan for this task. */
  requestedTools?: readonly string[];
  /** Org overrides (same shape as decideTool). */
  relaxed?: readonly string[];
  tightened?: readonly string[];
  /** Delegation depth of the child (root mission = 0). */
  depth: number;
  /** Workspace emergency stop. */
  stopped?: boolean;
}

export interface EffectiveResult {
  ok: boolean;
  tools: string[];
  permissions: Permission[];
  reason?: string;
}

/**
 * The child's grant is the intersection of the parent's, the agent's and the role's permissions,
 * filtered to tools a mission may run without a human. A child is always a subset of its parent.
 */
export function effectivePermissions(input: EffectiveInput): EffectiveResult {
  if (input.stopped) return { ok: false, tools: [], permissions: [], reason: 'Emergency stop is on for this workspace.' };
  if (!Number.isInteger(input.depth) || input.depth < 0 || input.depth > MAX_DELEGATION_DEPTH) {
    return { ok: false, tools: [], permissions: [], reason: `Delegation is limited to ${MAX_DELEGATION_DEPTH} levels.` };
  }
  const parent = new Set(input.parentTools);
  const agent = new Set(input.agentTools);
  const requested = input.requestedTools ? new Set(input.requestedTools) : null;
  const tools: string[] = [];
  for (const tool of Object.keys(TOOL_POLICIES)) {
    if (!parent.has(tool) || !agent.has(tool)) continue;
    if (requested && !requested.has(tool)) continue;
    const p = TOOL_POLICIES[tool]!;
    if (!(p.risk === 'L0' || (p.risk === 'L1' && MISSION_INTERNAL_WRITES.has(tool)))) continue;
    const d = decideTool({ tool, allowlist: [...agent], userRole: input.role, relaxed: input.relaxed, tightened: input.tightened });
    if (d.decision !== 'allow') continue;
    tools.push(tool);
  }
  const permissions = PERMISSIONS.filter((perm) => can(input.role, perm) && tools.some((t) => TOOL_POLICIES[t]!.requires === perm));
  return { ok: true, tools, permissions };
}

// ---- Output schemas: a small, safe JSON-Schema subset -----------------------------

export type OutputSchema =
  | { type: 'string'; maxLength?: number; enum?: string[] }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number }
  | { type: 'boolean' }
  | { type: 'array'; items: OutputSchema; maxItems?: number }
  | { type: 'object'; properties: Record<string, OutputSchema>; required?: string[] };

const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);
const PROP_KEY = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

/** Checks that an output schema is well formed. Returns errors (empty when valid). */
export function checkOutputSchema(s: unknown, path = '$', depth = 0): string[] {
  if (depth > 5) return [`${path}: schema is nested too deeply (max 5)`];
  if (!s || typeof s !== 'object' || Array.isArray(s)) return [`${path}: schema must be an object`];
  const o = s as Record<string, unknown>;
  if (typeof o.type !== 'string' || !SCHEMA_TYPES.has(o.type)) return [`${path}: unknown type`];
  const errs: string[] = [];
  if (o.type === 'array') errs.push(...checkOutputSchema(o.items, `${path}[]`, depth + 1));
  if (o.type === 'object') {
    const props = o.properties;
    if (!props || typeof props !== 'object' || Array.isArray(props)) return [`${path}: object needs properties`];
    const keys = Object.keys(props);
    if (keys.length === 0 || keys.length > 30) errs.push(`${path}: object needs 1–30 properties`);
    for (const k of keys) {
      if (!PROP_KEY.test(k)) errs.push(`${path}.${k}: invalid property name`);
      if ((RESERVED_KEYS as readonly string[]).includes(k)) errs.push(`${path}.${k}: reserved key`);
      errs.push(...checkOutputSchema((props as any)[k], `${path}.${k}`, depth + 1));
    }
    if (o.required !== undefined && (!Array.isArray(o.required) || o.required.some((r) => typeof r !== 'string' || !keys.includes(r)))) {
      errs.push(`${path}: required lists unknown properties`);
    }
  }
  return errs;
}

/** Validates a value against an output schema. Returns errors (empty when valid). */
export function validateOutput(schema: OutputSchema, v: unknown, path = '$'): string[] {
  switch (schema.type) {
    case 'string':
      if (typeof v !== 'string') return [`${path}: expected a string`];
      if (v.length > (schema.maxLength ?? 20_000)) return [`${path}: too long`];
      if (schema.enum && !schema.enum.includes(v)) return [`${path}: must be one of ${schema.enum.join(', ')}`];
      return [];
    case 'number':
    case 'integer':
      if (typeof v !== 'number' || !Number.isFinite(v)) return [`${path}: expected a number`];
      if (schema.type === 'integer' && !Number.isInteger(v)) return [`${path}: expected an integer`];
      if (schema.minimum !== undefined && v < schema.minimum) return [`${path}: below ${schema.minimum}`];
      if (schema.maximum !== undefined && v > schema.maximum) return [`${path}: above ${schema.maximum}`];
      return [];
    case 'boolean':
      return typeof v === 'boolean' ? [] : [`${path}: expected true or false`];
    case 'array': {
      if (!Array.isArray(v)) return [`${path}: expected a list`];
      if (v.length > (schema.maxItems ?? 100)) return [`${path}: too many items`];
      return v.flatMap((x, i) => validateOutput(schema.items, x, `${path}[${i}]`));
    }
    case 'object': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return [`${path}: expected an object`];
      const o = v as Record<string, unknown>;
      const errs: string[] = [];
      for (const k of Object.keys(o)) {
        if ((RESERVED_KEYS as readonly string[]).includes(k)) errs.push(`${path}.${k}: reserved key`);
        else if (!schema.properties[k]) errs.push(`${path}.${k}: not in the schema`);
      }
      for (const r of schema.required ?? []) if (o[r] === undefined) errs.push(`${path}.${r}: required`);
      for (const [k, sub] of Object.entries(schema.properties)) if (o[k] !== undefined) errs.push(...validateOutput(sub, o[k], `${path}.${k}`));
      return errs;
    }
  }
}

// ---- Plans -------------------------------------------------------------------------

export const PLAN_KEY = /^[a-z][a-z0-9_]{1,40}$/;
export const MAX_PLAN_TASKS = 20;
export const MAX_PLAN_DEPTH = 6;
export const MAX_DEPENDS_ON = 8;
export type ReviewMode = 'schema' | 'human';

export interface PlanTask {
  key: string;
  agent: MissionAgent;
  title: string;
  instructions: string;
  dependsOn: string[];
  /** Values for the task. `{ "$from": "<key>" }` or `{ "$from": "<key>.<field>" }` pulls an earlier task's output. */
  inputs: Record<string, unknown>;
  outputSchema: OutputSchema;
  review: ReviewMode;
  tools?: string[];
}
export interface Plan {
  summary: string;
  tasks: PlanTask[];
}

function findReserved(v: unknown, path: string, depth = 0): string[] {
  if (depth > 8 || !v || typeof v !== 'object') return [];
  if (Array.isArray(v)) return v.flatMap((x, i) => findReserved(x, `${path}[${i}]`, depth + 1));
  return Object.entries(v).flatMap(([k, x]) => [...((RESERVED_KEYS as readonly string[]).includes(k) ? [`${path}.${k}: reserved key`] : []), ...findReserved(x, `${path}.${k}`, depth + 1)]);
}

function fromRefs(v: unknown, depth = 0): string[] {
  if (depth > 8 || !v || typeof v !== 'object') return [];
  if (Array.isArray(v)) return v.flatMap((x) => fromRefs(x, depth + 1));
  const o = v as Record<string, unknown>;
  if (typeof o.$from === 'string') return [o.$from];
  return Object.values(o).flatMap((x) => fromRefs(x, depth + 1));
}

/**
 * Validates a CEO plan. Rules: 1–20 tasks; unique keys; known agents; dependsOn and $from only name
 * earlier tasks (this alone rules out cycles; Kahn's algorithm double-checks); $from must also be a
 * dependency; dependency depth ≤ 6; no reserved keys anywhere; well-formed output schemas.
 */
export function validatePlan(raw: unknown): { ok: true; plan: Plan; order: string[]; depth: number } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['Plan must be an object.'] };
  const p = raw as Record<string, unknown>;
  if (typeof p.summary !== 'string' || !p.summary.trim() || p.summary.length > 2000) errors.push('summary: required, up to 2000 characters');
  if (!Array.isArray(p.tasks) || p.tasks.length < 1 || p.tasks.length > MAX_PLAN_TASKS) {
    return { ok: false, errors: [...errors, `tasks: need 1–${MAX_PLAN_TASKS} tasks`] };
  }
  const seen: string[] = [];
  const tasks: PlanTask[] = [];
  p.tasks.forEach((t: any, i: number) => {
    const at = `tasks[${i}]`;
    if (!t || typeof t !== 'object') return void errors.push(`${at}: must be an object`);
    if (typeof t.key !== 'string' || !PLAN_KEY.test(t.key)) errors.push(`${at}.key: must match ${PLAN_KEY}`);
    else if ((RESERVED_KEYS as readonly string[]).includes(t.key)) errors.push(`${at}.key: reserved key`);
    else if (seen.includes(t.key)) errors.push(`${at}.key: duplicate "${t.key}"`);
    if (!(MISSION_AGENTS as readonly string[]).includes(t.agent)) errors.push(`${at}.agent: must be one of ${MISSION_AGENTS.join(', ')}`);
    if (typeof t.title !== 'string' || !t.title.trim() || t.title.length > 200) errors.push(`${at}.title: required, up to 200 characters`);
    if (typeof t.instructions !== 'string' || !t.instructions.trim() || t.instructions.length > 4000) errors.push(`${at}.instructions: required, up to 4000 characters`);
    const deps = t.dependsOn ?? [];
    if (!Array.isArray(deps) || deps.length > MAX_DEPENDS_ON || deps.some((d: unknown) => typeof d !== 'string')) errors.push(`${at}.dependsOn: up to ${MAX_DEPENDS_ON} task keys`);
    else for (const d of deps) if (!seen.includes(d)) errors.push(`${at}.dependsOn: "${d}" is not an earlier task`);
    const inputs = t.inputs ?? {};
    if (typeof inputs !== 'object' || Array.isArray(inputs)) errors.push(`${at}.inputs: must be an object`);
    else {
      errors.push(...findReserved(inputs, `${at}.inputs`));
      for (const ref of fromRefs(inputs)) {
        const key = ref.split('.')[0]!;
        if (!seen.includes(key)) errors.push(`${at}.inputs: $from "${ref}" is not an earlier task`);
        else if (!Array.isArray(deps) || !deps.includes(key)) errors.push(`${at}.inputs: $from "${ref}" must also be in dependsOn`);
      }
    }
    errors.push(...checkOutputSchema(t.outputSchema, `${at}.outputSchema`));
    if (t.outputSchema?.type !== 'object') errors.push(`${at}.outputSchema: top level must be an object`);
    const review = t.review ?? 'schema';
    if (review !== 'schema' && review !== 'human') errors.push(`${at}.review: schema or human`);
    if (t.tools !== undefined && (!Array.isArray(t.tools) || t.tools.some((x: unknown) => typeof x !== 'string' || !TOOL_POLICIES[x as string]))) errors.push(`${at}.tools: unknown tool`);
    if (typeof t.key === 'string') seen.push(t.key);
    tasks.push({ key: t.key, agent: t.agent, title: t.title, instructions: t.instructions, dependsOn: Array.isArray(deps) ? deps : [], inputs, outputSchema: t.outputSchema, review, tools: t.tools });
  });
  if (errors.length) return { ok: false, errors };
  // Kahn's algorithm: topological order and longest dependency chain.
  const indeg = new Map(tasks.map((t) => [t.key, t.dependsOn.length]));
  const level = new Map<string, number>();
  const queue = tasks.filter((t) => t.dependsOn.length === 0).map((t) => t.key);
  const order: string[] = [];
  while (queue.length) {
    const k = queue.shift()!;
    order.push(k);
    const lv = Math.max(0, ...tasks.find((t) => t.key === k)!.dependsOn.map((d) => level.get(d)! + 1));
    level.set(k, lv);
    for (const t of tasks) {
      if (!t.dependsOn.includes(k)) continue;
      indeg.set(t.key, indeg.get(t.key)! - 1);
      if (indeg.get(t.key) === 0) queue.push(t.key);
    }
  }
  if (order.length !== tasks.length) return { ok: false, errors: ['Plan has a dependency cycle.'] };
  const depth = Math.max(...level.values()) + 1;
  if (depth > MAX_PLAN_DEPTH) return { ok: false, errors: [`Plan is ${depth} levels deep; the limit is ${MAX_PLAN_DEPTH}.`] };
  return { ok: true, plan: { summary: (p.summary as string).trim(), tasks }, order, depth };
}

/** Resolves `{ "$from": "key" }` / `{ "$from": "key.field" }` against finished outputs. */
export function resolveInputs(inputs: unknown, outputs: Record<string, unknown>, depth = 0): unknown {
  if (depth > 8 || !inputs || typeof inputs !== 'object') return inputs;
  if (Array.isArray(inputs)) return inputs.map((x) => resolveInputs(x, outputs, depth + 1));
  const o = inputs as Record<string, unknown>;
  if (typeof o.$from === 'string') {
    const [key, ...path] = o.$from.split('.');
    let v: any = outputs[key!];
    for (const seg of path) v = v && typeof v === 'object' ? v[seg] : undefined;
    return v ?? null;
  }
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolveInputs(x, outputs, depth + 1)]));
}
