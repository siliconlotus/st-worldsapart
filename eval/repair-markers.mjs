// repair-markers.mjs — reconciles a bundle's embedded books with what its entries actually are.
//
// Two fields decide how scene.mjs treats an entry and both drifted through ordinary editing as these books
// grew. The STMB marker says memory-or-reference (scene.mjs's isMemory reads its PRESENCE, never the range),
// and `vectorized` says which route can reach the entry at all. Neither is repairable from the other, but on
// THIS corpus the title convention settles it: an STMB entry is titled with a number, or ARC + number. That
// convention is the author's, not a property of World Info, so it lives here as a repair rule over data and
// must not become a predicate in scene.mjs or matcher.mjs — those keep testing fields.
//
// WHAT DRIFTED, MEASURED. In Time Whore 13 character and place sheets carry a marker copied from entry 001,
// so they rank as memory. In Ascensus 6 arc summaries lost theirs and are excluded from every ranking metric,
// as is Sommers 051B, which was split off 051 by hand. Separately, 109 Time Whore memory entries are not
// vectorized — a workaround for an ST core limitation, not intent — and being reachable only by key they are
// normalised over keys alone in fuseRanks, which lifts them above vectorized entries carrying a real cosine.
// Measured across 28 scenes, that displacement cost 8.2 of 10 judged rows and F2 -0.387 against the same
// grades.
//
// DURABLE ENTRIES ARE LEFT ALONE. A constant or sticky entry is included by authorial assertion, so this
// pass neither vectorizes it nor changes its flags — whether a given pin still means what it meant is a
// judgement about that entry, not something a title tells you.
//
// TAKES EITHER A BUNDLE OR A LIVE WORLD FILE. Repairing the book itself is what makes every future capture
// correct; repairing a bundle only patches one fixture, and the two then disagree about what ST would
// activate. A world is written back at ST's own 4-space indent so the file stays diffable and so ST's next
// save is not a whole-file rewrite.
//
// Usage (any cwd):
//   node eval/repair-markers.mjs <bundle.json | world.json ...> [--write]
// Dry by default. A repaired world needs its collection re-synced; a repaired bundle needs re-deriving.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { cachePath, chunkConfig } from './reindex.mjs';

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const files = argv.filter(a => a.endsWith('.json') && !a.startsWith('--'));
if (!files.length) {
    console.error('usage: node eval/repair-markers.mjs <bundle.json ...> [--write]');
    console.error('  dry by default; reports every entry it would touch, grouped by book');
    process.exit(2);
}

/** This corpus only: an STMB entry is titled with a number, or ARC + number. Letter suffix = a manual split. */
const isMemoryTitle = t => /^\s*\[?\s*ARC\s*[-—]?\s*\d+/i.test(String(t)) || /^\s*\d+[A-Za-z]?\s*[-—.:]/.test(String(t));
const marked = e => ('stmemorybooks' in e) || ('STMB_start' in e);
const durable = e => Boolean(e.constant) || Number(e.sticky) > 0;
const title = e => e.comment ?? e.title ?? '';

/** Same gate reindex.mjs buildItems applies — an entry it would not index cannot need a vector. */
const indexable = e => !e.disable && Boolean(e.content);

const seen = new Map();   // book -> Map(uid -> {action, title})
const vectorized = new Set();   // bundles whose primary book gained vectors, so their collection moved
let touched = 0;

for (const path of files) {
    const m = JSON.parse(readFileSync(path, 'utf8'));
    // A world file is `{ entries, name }`; a bundle is `{ books: { world: entries }, arms }`. Normalising to
    // the bundle's shape means one repair rule serves both rather than two copies drifting apart.
    const isWorld = !m.books && Boolean(m.entries);
    // THE FILENAME IS THE WORLD'S IDENTITY, not the `name` inside it. ST addresses a book by file and hashes
    // that name into the collection id, while the embedded `name` is whatever the file was last copied from
    // and goes stale silently — Sommers_Pack__v22.json still calls itself a Daddy Next Door book.
    const books = isWorld ? { [basename(path, '.json')]: m.entries } : (m.books ?? {});
    // primaryBook and paramSnapshot live on the ARM in a multi-arm bundle, not at the root — same merge
    // openSample does. Reading them off the root silently yields undefined, which is a book name that
    // matches nothing and a chunk config that falls back to defaults.
    const shipped = Array.isArray(m.arms) ? (m.arms.find(a => a.arm === 'shipped') ?? m.arms[0]) : m;
    const view = { ...m, ...shipped };
    let dirty = false;
    for (const [world, entries] of Object.entries(books)) {
        const log = seen.get(world) ?? seen.set(world, new Map()).get(world);
        for (const e of Object.values(entries)) {
            const memory = isMemoryTitle(title(e));
            const acts = [];
            if (marked(e) && !memory) { acts.push('strip-marker'); }
            if (!marked(e) && memory) { acts.push('add-marker'); }
            // Read `memory`, not the marker: an entry being repaired into memory this pass needs its vector
            // decided on the same footing as one that always was.
            if (memory && !e.vectorized && indexable(e) && !durable(e)) acts.push('vectorize');
            if (!acts.length) continue;
            log.set(Number(e.uid), { acts: acts.join('+'), title: title(e) });
            if (acts.includes('vectorize') && world === view.primaryBook) vectorized.add(path);
            if (WRITE) {
                if (acts.includes('strip-marker')) { delete e.stmemorybooks; delete e.STMB_start; delete e.STMB_end; }
                // Presence is the whole signal — scene.mjs's isMemory and keyword-core's `generated` both test
                // for it and never read the range, which a repair has no way to recover anyway.
                if (acts.includes('add-marker')) e.stmemorybooks = true;
                if (acts.includes('vectorize')) e.vectorized = true;
                dirty = true;
            }
            touched++;
        }
    }
    // A REPAIRED BOOK OUTGROWS ITS RECORDED COLLECTION. The live ST collection holds chunks for the entries
    // that were vectorized when it was synced; entries vectorized here have none, and loadScene gives a row
    // with no item no cosine at all — so re-deriving against the old path would score exactly as if the
    // repair had not happened, silently. Repoint at the rebuild cache, which keys on book + model + chunk
    // settings and so names the same file on any machine (absent there, indexPath falls through to it anyway).
    if (!isWorld && vectorized.has(path)) {
        const target = cachePath(view, chunkConfig(view), m.embedModel ?? 'bge-m3');
        for (const a of (Array.isArray(m.arms) ? m.arms : [m])) a.index = target;
        if (!Array.isArray(m.arms)) m.index = target;
        dirty = true;
    }
    // ST writes worlds pretty-printed at 4 spaces; bundles are minified. Match whichever this was,
    // so a repair is a small diff rather than a whole-file reformat.
    if (WRITE && dirty) writeFileSync(path, isWorld ? `${JSON.stringify(m, null, 4)}\n` : JSON.stringify(m));
}

for (const [world, log] of seen) {
    const by = a => [...log.values()].filter(x => x.acts === a);
    console.log(`\n${world}  — ${log.size} distinct entries across ${files.length} bundle(s)`);
    for (const a of ['strip-marker', 'add-marker', 'vectorize', 'add-marker+vectorize']) {
        const rows = by(a);
        if (!rows.length) continue;
        console.log(`  ${a.padEnd(20)} ${String(rows.length).padStart(3)}   ${rows.slice(0, 4).map(r => r.title).join(' / ').slice(0, 96)}${rows.length > 4 ? ' …' : ''}`);
    }
}
console.log(`\n${WRITE ? 'WROTE' : 'DRY'}: ${touched} entry-edits across ${files.length} bundle(s)`);
if (!WRITE) console.log('re-run with --write to apply, then rebuild the collection and re-derive');
