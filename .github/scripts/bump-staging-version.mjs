// bump-staging-version.mjs — rewrites manifest.json's version to the next build counter and prints it; holds a counterless one
// until WA_RELEASE_VERSION (release's manifest version) carries it.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isCounterless, nextBuildVersion } from '../../eval/lib/version.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const path = resolve(ROOT, 'manifest.json');
const text = readFileSync(path, 'utf8');
const current = JSON.parse(text).version ?? '';

// A counterless version is a release cut parked on staging: held while the cut is pending, restarted once release carries it.
// Unset WA_RELEASE_VERSION reads as pending, so a run without the fetch can only hold.
if (isCounterless(current) && current !== process.env.WA_RELEASE_VERSION) {
    console.log(`${current} — held, not bumped`);
} else {
    const next = nextBuildVersion(current);

    // Textual replacement, not JSON.stringify: the manifest is hand-edited and its formatting is not ours to normalise.
    const out = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${next}$2`);
    if (out === text) throw new Error(`could not rewrite the version field in ${path}`);
    writeFileSync(path, out);
    console.log(next);
}
