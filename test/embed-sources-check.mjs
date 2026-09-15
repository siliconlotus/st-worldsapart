// plugin/server.js embed() copies ST's module-private getVector; this reads ST's SOURCES array and asserts the switch still covers every entry. Skips without an ST install.
import { readFileSync, existsSync } from 'node:fs';
import { stInstall } from '../eval/scene.mjs';
import { eq } from '../eval/metrics.mjs';
import { fileURLToPath } from 'node:url';

const st = stInstall();
const vectorsFile = st && `${st.root}/src/endpoints/vectors.js`;
if (!st || !existsSync(vectorsFile)) {
    console.log('ok  (no SillyTavern install reachable — nothing to compare the source list against)');
    process.exit(0);
}

const stSource = readFileSync(vectorsFile, 'utf8');
const listed = [...(stSource.match(/const SOURCES = \[([\s\S]*?)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]);
eq(listed.length > 0, true, "ST's SOURCES array is still parseable");

const pluginSource = readFileSync(fileURLToPath(new URL('../plugin/server.js', import.meta.url)), 'utf8');
const routed = new Set([...pluginSource.matchAll(/case '([^']+)':/g)].map(m => m[1]));

const missing = listed.filter(s => !routed.has(s));
eq(missing.join(', '), '', `every source ST lists has a route in plugin/server.js (missing: ${missing.join(', ') || 'none'})`);

// A route ST dropped is dead code, not a fault: reported, not failed.
const extra = [...routed].filter(s => !listed.includes(s));
if (extra.length) console.log(`note: routes with no matching ST source (harmless, now dead): ${extra.join(', ')}`);

console.log(`ok  ${listed.length} sources, all routed`);
