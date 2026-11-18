// Dependency audit gate. Fails on any moderate+ advisory, except the narrow, dated exceptions below.
// Each exception must name one advisory, say why it does not reach production, and expire.
import { execSync } from 'node:child_process';

const EXCEPTIONS = {
  // picomatch ReDoS (npm audit lists every published version; no patched release yet). Reached only via vite/vitest test tooling,
  // which matches our own fixed glob patterns — never user input. `npm audit --omit=dev` is clean.
  'GHSA-fc5q-39xc-vjpf': { expires: '2027-01-31', reason: 'dev/test tooling only; no fix published' },
};
const LEVELS = ['info', 'low', 'moderate', 'high', 'critical'];
const min = LEVELS.indexOf('moderate');
const today = new Date().toISOString().slice(0, 10);

let raw;
try { raw = execSync('npm audit --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }); }
catch (e) { raw = e.stdout; }
const report = JSON.parse(raw);
const blocking = new Set();
const excused = new Set();
for (const v of Object.values(report.vulnerabilities ?? {})) {
  for (const via of v.via) {
    if (typeof via !== 'object' || LEVELS.indexOf(via.severity) < min) continue;
    const id = String(via.url ?? '').split('/').pop();
    const ex = EXCEPTIONS[id];
    if (ex && ex.expires >= today) excused.add(`${id} (${via.name}, until ${ex.expires}: ${ex.reason})`);
    else blocking.add(`${id} ${via.severity} ${via.name}: ${via.title}${ex ? ' — exception expired' : ''}`);
  }
}
for (const e of excused) console.log(`excepted: ${e}`);
if (blocking.size) {
  for (const b of blocking) console.error(`BLOCKING: ${b}`);
  process.exit(1);
}
console.log(`audit ok: no unexcepted moderate+ advisories (${excused.size} dated exception(s))`);
