// prepush-check.mjs — the push gate, driven the way git drives it: one line per ref on stdin.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { hasBuildCounter, isReleaseVersion } from './version.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = resolve(ROOT, 'hooks/pre-push');
const HEAD = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const ZERO = '0'.repeat(40);

let failed = 0;
/** Feeds git's `<local ref> <local sha> <remote ref> <remote sha>` line and returns the exit code. */
const run = (remoteRef, localSha = HEAD) => {
    try {
        execFileSync(HOOK, [], { cwd: ROOT, input: `refs/heads/x ${localSha} ${remoteRef} ${ZERO}\n`, stdio: ['pipe', 'ignore', 'ignore'] });
        return 0;
    } catch (e) { return e.status ?? 1; }
};
const eq = (got, want, msg) => {
    if (got !== want) { failed++; process.exitCode = 1; console.log(`FAIL ${msg}: exit ${got}, want ${want}`); }
};

eq(run('refs/heads/some-feature'), 0, 'a feature branch pushes untouched');
eq(run('refs/heads/release', ZERO), 0, 'deleting release is not a release');
eq(run('refs/heads/staging', ZERO), 0, 'deleting staging is not a push');

// Derived from what HEAD actually carries, so the check is correct on any branch.
const version = JSON.parse(execFileSync('git', ['-C', ROOT, 'show', 'HEAD:manifest.json'], { encoding: 'utf8' })).version;
const tagged = (() => {
    try { return execFileSync('git', ['-C', ROOT, 'rev-list', '-n', '1', version], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === HEAD; }
    catch { return false; }
})();
eq(run('refs/heads/staging'), hasBuildCounter(version) ? 0 : 1, `staging gate agrees with hasBuildCounter for ${version}`);
eq(run('refs/heads/release'), isReleaseVersion(version) && tagged ? 0 : 1, `release gate agrees with isReleaseVersion+tag for ${version}`);

if (!failed) console.log('prepush-check: ok');
