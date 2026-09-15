// st-boundary-check.mjs — which modules import SillyTavern. Everything under extension/ and plugin/ must be ST-free and
// node-importable, so the evals exercise the shipped code; these are the declared exceptions. Self-checking.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from '../eval/lib/metrics.mjs';
import { ST_HALF, ST_SERVER } from './st-half.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');


const walk = dir => readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : walk(full);
    return /\.(mjs|js)$/.test(name) ? [full] : [];
});

const files = ['extension', 'plugin'].flatMap(d => walk(join(ROOT, d))).concat(join(ROOT, 'worldsapart.js'));

// A relative specifier that resolves outside the repo is an ST import; a bare one would be a node_modules dependency.
const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"](\.[^'"]*)['"]/g;
const escapes = [];
for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const outside = [...src.matchAll(IMPORT)].map(m => m[1])
        .filter(spec => relative(ROOT, resolve(dirname(file), spec)).startsWith('..'));
    if (outside.length) escapes.push([relative(ROOT, file), outside]);
}

const found = escapes.map(([f]) => f).sort();
const DECLARED = [...ST_HALF, ...ST_SERVER].sort();
eq(found.join('\n'), DECLARED.join('\n'),
    'exactly the declared ST-coupled files import SillyTavern; a pure module that gains an ST import stops being '
    + 'node-importable, and fails at import time naming an unrelated ST file rather than the boundary');

// The pure modules are the point: an eval or check importing one must not drag ST in behind it.
const pure = files.map(f => relative(ROOT, f)).filter(f => !DECLARED.includes(f));
eq(pure.some(f => found.includes(f)), false, 'no module outside the ST half reaches past the repo root');
eq(pure.length > 20, true, 'and the sweep is reading the tree, not an empty list');
