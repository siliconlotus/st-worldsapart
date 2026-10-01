// fingerprint-check.mjs — the drift check's two sides hash the same list: every file resolves, none is hashed twice, and one
// changed file is one changed fingerprint. The server hashes the files it loaded, the browser the same files as it serves them.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOADER_VERSION, PLUGIN_FILES, pluginFingerprint } from '../plugin/fingerprint.mjs';
import { eq } from '../eval/lib/metrics.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

eq(PLUGIN_FILES.every(src => existsSync(join(ROOT, 'plugin', src))), true, 'every file the list names exists');
eq(new Set(PLUGIN_FILES).size, PLUGIN_FILES.length, 'no file is hashed twice');
eq(PLUGIN_FILES.includes('server.js') && PLUGIN_FILES.includes('../extension/matcher.mjs'), true, 'the server and the matcher it loads are both hashed');
eq(PLUGIN_FILES.includes('loader.js'), false, 'the loader is not: it is the deployed copy, and LOADER_VERSION tracks it instead');

// The loader cannot import fingerprint.mjs (it is deployed alone), so the two constants are kept equal by hand and checked here.
const loaderVersion = Number(readFileSync(join(ROOT, 'plugin', 'loader.js'), 'utf8').match(/const LOADER_VERSION = (\d+);/)?.[1]);
eq(loaderVersion, LOADER_VERSION, 'loader.js and fingerprint.mjs declare the same LOADER_VERSION');

const texts = PLUGIN_FILES.map(src => readFileSync(join(ROOT, 'plugin', src), 'utf8'));
const fp = pluginFingerprint(...texts);
eq(pluginFingerprint(...texts), fp, 'the fingerprint is stable over unchanged files');

// Sensitivity: any one file changing — an update the running server has not loaded yet — moves it.
for (let i = 0; i < texts.length; i++) {
    const drifted = [...texts];
    drifted[i] = `${drifted[i]}\n// drift`;
    eq(pluginFingerprint(...drifted) !== fp, true, `changing ${PLUGIN_FILES[i]} changes the fingerprint`);
}

if (process.exitCode !== 1) console.log('fingerprint-check: ok');
