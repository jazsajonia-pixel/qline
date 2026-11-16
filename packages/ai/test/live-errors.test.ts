import { describe, expect, it } from 'vitest';
import { listModels, PROVIDER_IDS } from '../src/index';

// Hits the real provider endpoints with fake keys (no secrets needed). Opt-in: QLINE_LIVE=1.
const d = process.env.QLINE_LIVE ? describe : describe.skip;
d('real providers reject fake keys as auth failures', () => {
  for (const id of PROVIDER_IDS) {
    it(id, async () => {
      await expect(listModels(id, id === 'google' ? 'AIzaSyFAKE-not-a-real-key-000000000' : 'sk-fake1234567890abcdef')).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
    });
  }
});
