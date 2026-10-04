// ST's SOURCES against the embed routes a real deploy of the plugin exports, imported as ST loads it. Skips without an ST install.
import { readFileSync, existsSync } from 'node:fs';
import { stInstall } from '../eval/lib/st-install.mjs';
import { eq } from '../eval/lib/metrics.mjs';
import { deploySandbox } from './plugin-sandbox.mjs';

const st = stInstall();
const vectorsFile = st && `${st.root}/src/endpoints/vectors.js`;
if (!st || !existsSync(vectorsFile)) {
    console.log('ok  (no SillyTavern install reachable — nothing to compare the source list against)');
    process.exit(0);
}

// SOURCES is module-private in ST, so it is read off ST's file; the plugin's side is imported.
const listed = [...(readFileSync(vectorsFile, 'utf8').match(/const SOURCES = \[([\s\S]*?)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]);
eq(listed.length > 0, true, "ST's SOURCES array is still parseable");

const box = deploySandbox({ st });
try {
    eq(box.run.status, 0, `the deploy ran (${box.run.stderr.trim() || 'no stderr'})`);
    const plugin = await box.load();
    eq(typeof plugin.default?.init, 'function', 'the deployed index.js loads and exports init, as ST expects');
    const routed = new Set(plugin.EMBED_SOURCES);

    const missing = listed.filter(s => !routed.has(s));
    eq(missing.join(', '), '', `every source ST lists has an embed route (missing: ${missing.join(', ') || 'none'})`);

    // A route ST dropped is dead code, not a fault: reported, not failed.
    const extra = [...routed].filter(s => !listed.includes(s));
    if (extra.length) console.log(`note: routes with no matching ST source (harmless, now dead): ${extra.join(', ')}`);
    console.log(`ok  ${listed.length} sources, all routed`);
} finally {
    box.cleanup();
}
