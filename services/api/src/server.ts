import { serve } from '@hono/node-server';
import app from './index';

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (i) => console.log(`Qline API on http://localhost:${i.port}`));
