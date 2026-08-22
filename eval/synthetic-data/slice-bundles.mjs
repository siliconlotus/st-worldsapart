// slice-bundles.mjs — cuts graded bundles down to a SHORTLIST of rows, so /wa-super-eval renders those
// rows and nothing else.
//
// The reviewer draws its rows from `arms[].candidates`, and a sommers scene carries ~177 of them. Opening
// 15 of those to adjudicate 45 rows is 1985 rows of hunting with no marker on the ones that matter, which
// is what a shortlist exists to avoid. Dropping the other candidates is the whole mechanism.
//
// ONE PACK FILE, not one file per scene: the reviewer reads a top-level ARRAY as one section per element,
// so a shortlist spanning eleven scenes is one pick and one save rather than eleven.
//
// EACH ELEMENT CARRIES ITS SOURCE BASENAME in `file`, which is what makes the round trip work: the review
// records that name, and apply-review.mjs resolves it against eval-data and writes to the REAL bundle. The
// pack is a disposable input to the picker, never a thing to keep.
//
// `books` are cut to the entries the kept rows name — they are all of the weight (2MB a scene against
// 10KB of rows), and a section only ever renders text for its own rows. `grades` are copied whole, so the
// reviewer still pre-fills with what the judges said.
//
// The shortlist is a JSON array of {bundle, book, uid}; anything else on the row (grader scores, notes)
// is ignored, so a contested-rows dump can be passed as-is.
//
// Usage (any cwd):
//   node eval/synthetic-data/slice-bundles.mjs contested45.json [--data eval/eval-data] [--out <file>]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve as resolvePath, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const CLI = import.meta.url === `file://${process.argv[1]}`;
const LIST = argv.find(a => !a.startsWith('--') && !['--data', '--out'].includes(argv[argv.indexOf(a) - 1]));
if (CLI && !LIST) {
    console.error('usage: node eval/synthetic-data/slice-bundles.mjs <shortlist.json> [--data <dir>] [--out <file>]');
    process.exit(2);
}
const DATA = resolvePath(arg('--data', resolvePath(HERE, '..', 'eval-data')));
const OUT = resolvePath(arg('--out', resolvePath(DATA, 'review-pack.json')));

/**
 * One bundle cut to `keys` (a Set of `world` + `uid` strings).
 *
 * @returns {{sliced: object, dyn: Set<string>, lost: string[]}} the cut bundle, the keys that survived as
 *   gradeable rows, and the keys that did not.
 */
/** Unit Separator — see CLAUDE.md. This key used to join book and uid with NOTHING, so `W`+`11` and
 *  `W1`+`1` were the same shortlist entry; the collision needs two books whose names differ by a numeric
 *  suffix, which is why nothing has hit it yet. `rowKey` in grading.mjs is the same key with the same
 *  separator, and this is deliberately not a second copy of the rule so much as the same one. */
const US = String.fromCharCode(31);

export function sliceBundle(m, keys) {
    if (!Array.isArray(m?.scenes)) throw new Error('sliceBundle expects a graded-scene document — no `scenes`');
    const key = c => `${c.book ?? ''}${US}${c.uid}`;
    const cut = cell => (cell.candidates ?? []).filter(c => keys.has(key(c)));
    // ARMS ARE AT DOCUMENT LEVEL and hold one CELL per scene they captured, so the cut walks the cells.
    const sliced = { ...m, arms: (m.arms ?? []).map(a => ({
        ...a,
        scenes: Object.fromEntries(Object.entries(a.scenes ?? {}).map(([id, cell]) => [id, { ...cell, candidates: cut(cell) }])),
    })) };
    const kept = (sliced.arms ?? []).flatMap(a => Object.values(a.scenes ?? {}));
    // The reviewer grades the dynamic block only, and refuses a section with none — a constant row is in
    // the prompt whatever it scores, so a shortlist naming one yields a section that cannot be opened.
    const dyn = new Set(kept.flatMap(a => (a.candidates ?? []).filter(c => c.block === 'dynamic').map(key)));
    // Books down to the kept rows. Entries are keyed by their own uid in the book map, but the row's uid
    // is what is authoritative, so the match is on the entry rather than on the key.
    const need = new Map();
    for (const a of kept) for (const c of (a.candidates ?? [])) {
        if (!need.has(c.book)) need.set(c.book, new Set());
        need.get(c.book).add(Number(c.uid));
    }
    sliced.books = Object.fromEntries(Object.entries(m.books ?? {}).map(([w, bk]) => [
        w, Object.fromEntries(Object.entries(bk).filter(([, e]) => need.get(w)?.has(Number(e?.uid)))),
    ]));
    // The pack's books are a SUBSET, so the capture's content hashes no longer describe them. Dropped
    // rather than recomputed: a shortlist is not a capture and nothing downstream asks it what book it holds.
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
