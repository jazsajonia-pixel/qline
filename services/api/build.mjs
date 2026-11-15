// Bundles the API into a single ESM file for Neon Functions (docs: neon.com/docs/compute/functions/deploy).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const out = resolve(here, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const banner =
  "import{createRequire as ___cr}from'module';import{fileURLToPath as ___f}from'url';import{dirname as ___d}from'path';const require=___cr(import.meta.url);const __filename=___f(import.meta.url);const __dirname=___d(__filename);";

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  banner: { js: banner },
  alias: {
    '@qline/policy': resolve(root, 'packages/policy/src/index.ts'),
    '@qline/ai': resolve(root, 'packages/ai/src/index.ts'),
  },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
  // pg-native is optional and never used.
  external: ['pg-native'],
};

await build({ ...common, entryPoints: [resolve(here, 'src/index.ts')], outfile: resolve(out, 'index.mjs') });
await build({ ...common, entryPoints: [resolve(here, 'src/server.ts')], outfile: resolve(out, 'server.mjs') });
execFileSync('zip', ['-j', '-q', '-9', resolve(out, 'function.zip'), resolve(out, 'index.mjs')]);
console.log(`index.mjs ${(statSync(resolve(out, 'index.mjs')).size / 1e6).toFixed(2)} MB, function.zip ${(statSync(resolve(out, 'function.zip')).size / 1e6).toFixed(2)} MB`);
