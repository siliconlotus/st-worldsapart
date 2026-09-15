// bump-staging-version.mjs — rewrites manifest.json's version to the next build counter and prints it.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { nextBuildVersion } from '../../eval/version.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const path = resolve(ROOT, 'manifest.json');
const text = readFileSync(path, 'utf8');
const next = nextBuildVersion(JSON.parse(text).version ?? '');

// Textual replacement, not JSON.stringify: the manifest is hand-edited and its formatting is not ours to normalise.
const out = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${next}$2`);
if (out === text) throw new Error(`could not rewrite the version field in ${path}`);
writeFileSync(path, out);
console.log(next);
