// version-check.mjs — the staging counter, the version predicates, and the bump script's hold on a counterless version.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextBuildVersion, isReleaseVersion, hasBuildCounter, isCounterless } from '../eval/lib/version.mjs';

let failed = 0;
const eq = (got, want, msg) => {
    if (got !== want) { failed++; process.exitCode = 1; console.log(`FAIL ${msg}: got ${got}, want ${want}`); }
};
const throws = (fn, msg) => {
    try { fn(); failed++; process.exitCode = 1; console.log(`FAIL ${msg}: did not throw`); } catch { /* expected */ }
};

eq(nextBuildVersion('1.20.0+build.14'), '1.20.0+build.15', 'counter increments');
eq(nextBuildVersion('1.20.0+build.9'), '1.20.0+build.10', 'no lexical rollover at 9');
eq(nextBuildVersion('1.20.0'), '1.20.0+build.1', 'a bare release version starts the counter');
eq(nextBuildVersion('1.0.0-alpha.1'), '1.0.0-alpha.1+build.1', 'a prerelease base keeps its prerelease');
eq(nextBuildVersion('1.0.0-alpha.1+build.3'), '1.0.0-alpha.1+build.4', 'prerelease base increments too');
throws(() => nextBuildVersion('1.20'), 'refuses a two-part version');
throws(() => nextBuildVersion('1.20.0+sha.abc123'), 'refuses build metadata that is not the counter');
throws(() => nextBuildVersion('1.20.0+build.x'), 'refuses a non-numeric counter');
throws(() => nextBuildVersion(''), 'refuses empty');

eq(isReleaseVersion('1.20.0'), true, 'plain X.Y.Z is a release version');
eq(isReleaseVersion('1.20.0+build.1'), false, 'a counter disqualifies a release version');
eq(isReleaseVersion('1.0.0-alpha.1'), false, 'a prerelease is not a release version');

eq(hasBuildCounter('1.20.0+build.1'), true, 'a bare base plus the counter');
eq(hasBuildCounter('1.0.0-alpha.1+build.1'), true, 'a prerelease base plus the counter');
eq(hasBuildCounter('1.20.0'), false, 'a bare release version has no counter');

eq(isCounterless('1.20.0'), true, 'a bare release version is counterless');
eq(isCounterless('1.0.0-alpha.1'), true, 'a prerelease base without a counter is counterless');
eq(isCounterless('1.20.0+build.1'), false, 'the counter disqualifies counterless');
eq(isCounterless('1.20'), false, 'a two-part version is not a version at all');
eq(isCounterless(''), false, 'empty is not counterless');

// The bump script is shipped code, so it is driven as a copy of itself over a fixture manifest, not re-derived here.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const drive = manifestVersion => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-bump-'));
    mkdirSync(join(dir, '.github/scripts'), { recursive: true });
    mkdirSync(join(dir, 'eval/lib'), { recursive: true });
    copyFileSync(join(REPO, '.github/scripts/bump-staging-version.mjs'), join(dir, '.github/scripts/bump-staging-version.mjs'));
    copyFileSync(join(REPO, 'eval/lib/version.mjs'), join(dir, 'eval/lib/version.mjs'));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: manifestVersion }));
    const r = spawnSync('node', [join(dir, '.github/scripts/bump-staging-version.mjs')], { encoding: 'utf8' });
    const version = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).version;
    rmSync(dir, { recursive: true, force: true });
    return { status: r.status, version };
};

eq(drive('1.20.0+build.14').version, '1.20.0+build.15', 'the script bumps a countered version');
eq(drive('1.20.0+build.14').status, 0, 'the script exits clean after a bump');
const held = drive('1.20.0');
eq(held.version, '1.20.0', 'the script holds a counterless version');
eq(held.status, 0, 'holding is not a failure');
eq(drive('garbage').status !== 0, true, 'the script refuses a version it cannot parse');

if (!failed) console.log('version-check: ok');
