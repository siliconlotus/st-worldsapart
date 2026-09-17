// gitversion.mjs — the resolved version of a git checkout, which a bundle's `stVersion` records for ST.
import { execFileSync } from 'node:child_process';

/** `<branch>@<git describe --tags --always --dirty>` of a checkout, '' when not a repo. `+dirty`, not `-dirty`: SemVer build metadata. */
export const gitVersion = (dir) => {
    const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    try {
        return `${git('rev-parse', '--abbrev-ref', 'HEAD')}@${git('describe', '--tags', '--always', '--dirty=+dirty')}`;
    } catch { return ''; }
};
