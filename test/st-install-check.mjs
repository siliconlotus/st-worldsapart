// st-install-check.mjs — locating the ST install and resolving paths inside it, over synthetic roots pointed at with
// WA_ST_ROOT. The `dataRoot:` reading is the part a count of directories cannot do. Self-checking.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stInstall } from '../eval/lib/st-install.mjs';
import { eq } from '../eval/lib/metrics.mjs';

const roots = [];
/** A synthetic install: a directory with the given config.yaml body, or none at all. */
const install = (config = null) => {
    const root = mkdtempSync(join(tmpdir(), 'wa-st-'));
    roots.push(root);
    if (config !== null) writeFileSync(join(root, 'config.yaml'), config);
    return root;
};
const at = (root, ...args) => { process.env.WA_ST_ROOT = root; try { return stInstall(...args); } finally { delete process.env.WA_ST_ROOT; } };

// --- dataRoot decides where a data/ path lands
const plain = install('dataRoot: ./data\n');
eq(at(plain).resolve('data/default-user/worlds'), `${plain}/data/default-user/worlds`, 'the default dataRoot sits under the root');
eq(at(plain).root, plain, 'and root is the install itself');
eq(at(plain).dataRoot, `${plain}/data`, 'dataRoot is absolute, so a caller never re-joins it against the root');

const moved = install('dataRoot: ./custom-data\n');
eq(at(moved).resolve('data/default-user/worlds'), `${moved}/custom-data/default-user/worlds`,
    'a relocated dataRoot moves every data/ path — the bug a hardcoded ../../data/ path cannot see');

const elsewhere = install('dataRoot: /srv/st-data\n');
eq(at(elsewhere).resolve('data/default-user/worlds'), '/srv/st-data/default-user/worlds', 'an absolute dataRoot is taken as given');
eq(at(install("dataRoot: '/srv/quoted'\n")).resolve('data/x'), '/srv/quoted/x', 'quotes around the value are stripped');
eq(at(install('port: 8000\n')).resolve('data/x'), `${roots.at(-1)}/data/x`, 'no dataRoot line falls back to ./data');
eq(at(install()).resolve('data/x'), `${roots.at(-1)}/data/x`, 'and so does a root with no config.yaml at all');

// --- only data/ is special; everything else hangs off the root
const r = install('dataRoot: /srv/st-data\n');
eq(at(r).resolve('plugins/worlds-apart'), `${r}/plugins/worlds-apart`, 'a non-data path resolves against the root, not dataRoot');
eq(at(r).resolve('config.yaml'), `${r}/config.yaml`, '...including config.yaml itself');
eq(at(r).resolve('/already/absolute'), '/already/absolute', 'an absolute path passes through untouched');
// `database/` must not be caught by a loose prefix test on 'data'.
eq(at(r).resolve('database/x'), `${r}/database/x`, "a path merely starting with 'data' is not a data/ path");

// --- WA_ST_ROOT overrides the walk, which is what lets a worktree or a moved checkout run the evals
eq(at(plain).root, plain, 'WA_ST_ROOT wins over walking up for config.yaml');
const live = stInstall();
eq(live !== null && live.root !== plain, true, 'and without it the walk finds the real install this checkout sits in');

for (const d of roots) rmSync(d, { recursive: true, force: true });
