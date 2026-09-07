// Self-check for the plugin's embedding routes against SillyTavern's own source list.
//
// plugin/server.js `embed()` mirrors ST's `getVector`, which is module-private — src/endpoints/vectors.js
// exports only `router`, and no route returns a raw vector, so WA cannot call it and a copy is the only
// way to support more than the handful of sources whose settings it happens to know.
//
// A copy of a private function drifts silently: a source ST adds or renames arrives here as "that provider
// quietly gets no cosine", and stage 3 falls back to the noCosine fit, so nothing downstream looks broken.
// The check reads ST's SOURCES array from its own file and asserts the switch still covers every entry —
// ST maintains that array deliberately, which is what makes it sound to read.
//
// Skips without an ST install rather than guessing, the same contract stInstall() has everywhere else.
import { readFileSync, existsSync } from 'node:fs';
import { stInstall } from './scene.mjs';
import { eq } from './metrics.mjs';

const st = stInstall();
const vectorsFile = st && `${st.root}/src/endpoints/vectors.js`;
if (!st || !existsSync(vectorsFile)) {
    console.log('ok  (no SillyTavern install reachable — nothing to compare the source list against)');
    process.exit(0);
}

const stSource = readFileSync(vectorsFile, 'utf8');
const listed = [...(stSource.match(/const SOURCES = \[([\s\S]*?)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]);
eq(listed.length > 0, true, "ST's SOURCES array is still parseable");

const pluginSource = readFileSync(new URL('../plugin/server.js', import.meta.url).pathname, 'utf8');
const routed = new Set([...pluginSource.matchAll(/case '([^']+)':/g)].map(m => m[1]));

const missing = listed.filter(s => !routed.has(s));
eq(missing.join(', '), '', `every source ST lists has a route in plugin/server.js (missing: ${missing.join(', ') || 'none'})`);

// The other direction: a route for something ST dropped is dead code, not a fault, so it is reported
// rather than failed — ST removing a source does not break anything here.
const extra = [...routed].filter(s => !listed.includes(s));
if (extra.length) console.log(`note: routes with no matching ST source (harmless, now dead): ${extra.join(', ')}`);

console.log(`ok  ${listed.length} sources, all routed`);
