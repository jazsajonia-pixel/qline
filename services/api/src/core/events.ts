import type { TenantCtx } from './context';
import { withTenant, type Q } from './db';
import { relayAndKick } from '../runtime/outbox';

export interface DomainEvent {
  type: 'contact.created' | 'task.created' | 'import.completed' | 'lead.created' | 'lead.urgent' | 'email.important';
  /** Stable id (e.g. `task:<uuid>`). The outbox deduplicates on it, so re-emitting is safe. */
  id: string;
  data: Record<string, any>;
}
type Handler = (t: TenantCtx, events: DomainEvent[]) => Promise<void>;
let handler: Handler | null = null;
/** Consumers subscribe here; the runtime calls them from `event.dispatch` jobs (durable, retried). */
export function onEvents(h: Handler) {
  handler = h;
}
export function eventHandler() {
  return handler;
}

type Emitter = Pick<TenantCtx, 'orgId' | 'workspaceId' | 'userId'>;

/**
 * Transactional outbox (docs/12 §7): call inside the business transaction so the event
 * exists if and only if the change committed.
 */
export async function publish(q: Q, t: Emitter, events: DomainEvent[]) {
  for (const ev of events) {
    await q.exec(
      `insert into outbox_events (org_id, workspace_id, type, event_key, data, actor) values ($1,$2,$3,$4,$5,$6) on conflict (org_id, event_key) do nothing`,
      [t.orgId, t.workspaceId, ev.type, ev.id, JSON.stringify(ev.data ?? {}), t.userId],
    );
  }
}

/**
 * For callers that already committed: writes the events to the outbox in a new transaction.
 * Durable from here on; the gap between the business commit and this write is the only
 * place an event can still be lost, so prefer `publish` inside the transaction.
 */
export async function dispatch(t: Emitter, events: DomainEvent[]) {
  if (!events.length) return;
  await withTenant({ orgId: t.orgId, userId: t.userId }, (q) => publish(q, t, events));
  await relayAndKick();
}
