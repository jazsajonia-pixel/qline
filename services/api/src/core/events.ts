import type { TenantCtx } from './context';

export interface DomainEvent {
  type: 'contact.created' | 'task.created' | 'import.completed' | 'lead.created' | 'lead.urgent';
  id: string;
  data: Record<string, any>;
}
type Handler = (t: TenantCtx, events: DomainEvent[]) => Promise<void>;
let handler: Handler | null = null;
export function onEvents(h: Handler) {
  handler = h;
}
/** Called after the creating transaction commits, so workflows see committed rows. */
export async function dispatch(t: TenantCtx, events: DomainEvent[]) {
  if (!handler || !events.length) return;
  try {
    await handler(t, events);
  } catch (e) {
    console.error('event dispatch failed', (e as Error).message);
  }
}
