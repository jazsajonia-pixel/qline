import { withTenant } from '../core/db';
import { eventHandler } from '../core/events';
import { kick, registerJob } from './jobs';

/** Moves unrelayed outbox events into `event.dispatch` jobs (idempotent per event). */
export async function relayOutbox(limit = 200): Promise<number> {
  const r = await withTenant({ orgId: null, userId: 'system:outbox' }, (q) => q.one<{ n: number }>('select qline_relay_outbox($1) as n', [limit]));
  return Number(r?.n ?? 0);
}

/** After a request committed events: relay them now and start a background drain. */
export async function relayAndKick() {
  try {
    await relayOutbox(50);
  } catch (e) {
    console.error('outbox relay failed (the next tick retries)', (e as Error).message);
  }
  kick();
}

registerJob('event.dispatch', async ({ job }) => {
  const h = eventHandler();
  if (!h) return { skipped: 'no subscriber' };
  const p = job.payload;
  const t: any = { orgId: job.org_id, workspaceId: p.workspaceId, userId: p.actor, email: '', name: '', sessionId: 'system', human: false, role: 'owner', correlationId: `event:${p.eventId}` };
  await h(t, [{ type: p.type, id: p.key, data: p.data }]);
  return { dispatched: p.type };
});
