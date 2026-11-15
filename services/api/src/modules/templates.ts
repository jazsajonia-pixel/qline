import { defaultAllowlist, type AgentTemplate } from '@qline/policy';

export const AGENT_DEFAULTS: Record<AgentTemplate, { name: string; instructions: string }> = {
  ceo: {
    name: 'AI CEO',
    instructions:
      'You are the AI CEO of this business. You see the whole picture: priorities, overdue work, pipeline and risks. Give short, concrete answers. Prefer action: propose tasks with clear titles and due dates. Always say which records you used.',
  },
  sales: {
    name: 'Sales',
    instructions: 'You help with leads, follow-ups and client relationships. Draft emails but never claim one was sent.',
  },
  marketing: {
    name: 'Marketing',
    instructions: 'You help plan campaigns and content. Draft content; publishing always needs a human.',
  },
  finance: {
    name: 'Finance',
    instructions: 'You summarise financial records the business has imported. You never move money and never give tax or legal advice as fact.',
  },
  operations: {
    name: 'Operations',
    instructions: 'You keep work moving: break goals into tasks, spot blockers and overdue items, and keep processes consistent.',
  },
  research: {
    name: 'Research',
    instructions: 'You find and summarise information from the business library. You cannot change records.',
  },
};

export const TEMPLATES: AgentTemplate[] = ['ceo', 'sales', 'marketing', 'finance', 'operations', 'research'];

export function agentSeed(template: AgentTemplate) {
  return { ...AGENT_DEFAULTS[template], allowlist: defaultAllowlist(template) };
}

export const DEFAULT_CONFIG = {
  terminology: { client: 'Client', project: 'Project', task: 'Task' },
  taskStatuses: ['todo', 'in_progress', 'blocked', 'done'],
  pipelineStages: ['lead', 'qualified', 'proposal', 'won', 'lost'],
  modules: ['home', 'work', 'library', 'agents', 'workflows'],
  knowledgeFolders: ['Policies', 'Playbooks', 'Clients'],
  agentPolicy: { relaxed: [] as string[], tightened: [] as string[] },
};

export const NEW_CLIENT_WORKFLOW = {
  name: 'New client onboarding',
  description: 'When a client contact is added, prepare onboarding tasks, ask for approval, then create them and notify the owner.',
  definition: {
    trigger: { type: 'event', event: 'contact.created' },
    steps: [
      { type: 'approval', title: 'Create onboarding tasks for {{trigger.name}}?' },
      { type: 'action', tool: 'tasks.create', args: { title: 'Kick-off call with {{trigger.name}}', priority: 'high', dueInDays: 2 } },
      { type: 'action', tool: 'tasks.create', args: { title: 'Send welcome pack to {{trigger.name}}', dueInDays: 3 } },
      { type: 'notify', title: 'Onboarding tasks created for {{trigger.name}}' },
    ],
  },
};
