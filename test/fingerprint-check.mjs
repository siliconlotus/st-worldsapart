// fingerprint-check.mjs — the drift check's two sides hash the same manifest: every pair resolves to a real file, no
// name is hashed twice, and one changed file is one changed fingerprint. A live deploy cannot be assumed (CI), so the
// round-trip runs over the source texts standing in for the deployed copies.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_FILES, pluginFingerprint } from '../plugin/fingerprint.mjs';
import { eq } from '../eval/lib/metrics.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

eq(PLUGIN_FILES.every(([from]) => existsSync(join(ROOT, 'plugin', from))), true, 'every source file the manifest names exists');
eq(new Set(PLUGIN_FILES.map(([from]) => from)).size, PLUGIN_FILES.length, 'no source file is hashed twice');
eq(new Set(PLUGIN_FILES.map(([, to]) => to)).size, PLUGIN_FILES.length, 'no deployed name is written twice');
eq(PLUGIN_FILES.some(([from]) => from.startsWith('../extension/')), true, 'the matcher modules deploy flat, by manifest');

// The extension hashes `plugin/<from>`, the deployed plugin its copies — identical contents, one fingerprint.
const texts = PLUGIN_FILES.map(([from]) => readFileSync(join(ROOT, 'plugin', from), 'utf8'));
const fp = pluginFingerprint(...texts);
eq(pluginFingerprint(...texts), fp, 'the fingerprint is stable over unchanged files');

// Sensitivity: any one file changing — the stale-deploy case the settings panel flags — moves it.
for (let i = 0; i < texts.length; i++) {
    const drifted = [...texts];
    drifted[i] = `${drifted[i]}\n// drift`;
    eq(pluginFingerprint(...drifted) !== fp, true, `changing ${PLUGIN_FILES[i][1]} changes the fingerprint`);
}

if (process.exitCode !== 1) console.log('fingerprint-check: ok');
