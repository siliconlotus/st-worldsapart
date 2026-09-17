// slice-bundles.mjs — cuts graded bundles down to a shortlist of rows ({bundle, book, uid}; other fields ignored) as one disposable review pack for /wa-super-eval; each element carries its source basename in `file`, which apply-review's round trip resolves. Books are cut to the kept rows, grades copied whole.
// Usage (any cwd):
//   node eval/synthetic-data/slice-bundles.mjs contested45.json [--data eval/eval-data] [--out <file>]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve as resolvePath, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDurable } from '../../extension/grading.mjs';
import { arg } from '../lib/metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

const CLI = import.meta.url === `file://${process.argv[1]}`;
const LIST = argv.find(a => !a.startsWith('--') && !['--data', '--out'].includes(argv[argv.indexOf(a) - 1]));
if (CLI && !LIST) {
    console.error('usage: node eval/synthetic-data/slice-bundles.mjs <shortlist.json> [--data <dir>] [--out <file>]');
    process.exit(2);
}
const DATA = resolvePath(arg(argv, '--data', resolvePath(HERE, '..', 'eval-data')));
const OUT = resolvePath(arg(argv, '--out', resolvePath(DATA, 'review-pack.json')));

/** Unit Separator, the same key and separator as rowKey in grading.mjs; without it W+11 and W1+1 collide. */
const US = String.fromCharCode(31);

/** One bundle cut to `keys` (a Set of book+US+uid strings); `dyn` is the keys that survived as gradeable rows, `lost` those that did not. */
export function sliceBundle(m, keys) {
    if (!Array.isArray(m?.scenes)) throw new Error('sliceBundle expects a graded-scene document — no `scenes`');
    const key = c => `${c.book ?? ''}${US}${c.uid}`;
    const cut = cell => (cell.candidates ?? []).filter(c => keys.has(key(c)));
    const sliced = { ...m, arms: (m.arms ?? []).map(a => ({
        ...a,
        scenes: Object.fromEntries(Object.entries(a.scenes ?? {}).map(([id, cell]) => [id, { ...cell, candidates: cut(cell) }])),
    })) };
    const kept = (sliced.arms ?? []).flatMap(a => Object.values(a.scenes ?? {}));
    // The reviewer grades the dynamic block only and refuses a section with none, so durable rows are reported as lost.
    const dyn = new Set(kept.flatMap(a => (a.candidates ?? []).filter(c => !isDurable(c)).map(key)));
    // Match on the entry's own uid, not the book map's key.
    const need = new Map();
    for (const a of kept) for (const c of (a.candidates ?? [])) {
        if (!need.has(c.book)) need.set(c.book, new Set());
        need.get(c.book).add(Number(c.uid));
    }
    sliced.books = Object.fromEntries(Object.entries(m.books ?? {}).map(([w, bk]) => [
        w, Object.fromEntries(Object.entries(bk).filter(([, e]) => need.get(w)?.has(Number(e?.uid)))),
    ]));
    // bookHashes no longer describe a subset; dropped rather than recomputed.
    delete sliced.bookHashes;
    return { sliced, dyn, lost: [...keys].filter(k => !dyn.has(k)) };
}

// argv is read at module scope, but nothing acts on it until here: the check imports sliceBundle.
if (CLI) {
    const rows = JSON.parse(readFileSync(resolvePath(LIST), 'utf8'));
    const want = new Map();
    for (const r of rows) {
        const b = basename(r.bundle ?? r.file ?? '');
        if (!b) continue;
        if (!want.has(b)) want.set(b, new Set());
        want.get(b).add(`${r.book ?? ''}${US}${r.uid}`);
    }

    const pack = [];
    let kept = 0, dropped = 0;
    for (const [file, keys] of want) {
        const path = `${DATA}/${file}`;
        if (!existsSync(path)) { console.log(`  MISSING ${file}`); continue; }
        const { sliced, dyn, lost } = sliceBundle(JSON.parse(readFileSync(path, 'utf8')), keys);
        kept += dyn.size; dropped += lost.length;
        if (!dyn.size) { console.log(`  SKIP ${file} — none of its ${keys.size} rows are dynamic`); continue; }
        pack.push({ file, ...sliced });
        console.log(`${String(dyn.size).padStart(3)} rows  ${file}${lost.length ? `  (${lost.length} not gradeable)` : ''}`);
    }
    writeFileSync(OUT, JSON.stringify(pack, null, 1));
    console.log(`\n${pack.length} bundles -> ${OUT}  ${kept} rows${dropped ? `, ${dropped} dropped as non-dynamic` : ''}`);
    console.log('Open it in /wa-super-eval, then: node eval/synthetic-data/apply-review.mjs --write');
}
