// version-check.mjs — the staging counter and the two version predicates the pre-push gate reads.
import { nextBuildVersion, isReleaseVersion, hasBuildCounter } from '../eval/version.mjs';

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

if (!failed) console.log('version-check: ok');
