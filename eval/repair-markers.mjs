// repair-markers.mjs — reconciles a bundle's embedded books with what its entries actually are.
//
// Two fields decide how scene.mjs treats an entry and both drift through ordinary editing (F47). The STMB
// marker says memory-or-reference (scene.mjs's isMemory reads its presence, never the range), and
// `vectorized` says which route can reach the entry at all. Neither is repairable from the other, but on
// this corpus the title convention settles it: an STMB entry is titled with a number, or ARC + number. That
// convention is the author's, not a property of World Info, so it lives here as a repair rule over data and
// must not become a predicate in scene.mjs or matcher.mjs — those keep testing fields.
//
// Durable entries are left alone: a constant or sticky entry is included by authorial assertion, so this
// pass neither vectorizes it nor changes its flags.
//
// Takes either a bundle or a live world file. Repairing the book itself is what makes every future capture
// correct; repairing a bundle only patches one fixture, and the two then disagree about what ST would
// activate. A world is written back at ST's own 4-space indent so the file stays diffable and ST's next
// save is not a whole-file rewrite.
//
// Usage (any cwd):
//   node eval/repair-markers.mjs <bundle.json | world.json ...> [--write]
// Dry by default. A repaired world needs its collection re-synced; a repaired bundle needs re-deriving.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { cachePath, chunkConfig } from './reindex.mjs';
import { openBundle } from '../extension/grading.mjs';

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
    // A world file is `{ entries, name }`; a document is `{ books: { book: entries }, scenes }`. Normalising to
    // the bundle's shape means one repair rule serves both rather than two copies drifting apart.
    const isWorld = !m.books && Boolean(m.entries);
    // The filename is the world's identity, not the `name` inside it: ST addresses a book by file and hashes
    // that name into the collection id, while the embedded `name` is whatever the file was last copied from
    // and goes stale silently.
    const books = isWorld ? { [basename(path, '.json')]: m.entries } : (m.books ?? {});
    // primaryBook and paramSnapshot live on the ARM, not at the root, so the read goes through the same
    // adapter openSample uses. Reading them off the root silently yields undefined, which is a book name
    // that matches nothing and a chunk config that falls back to defaults.
    const view = isWorld ? m : openBundle(m);
    let dirty = false;
    for (const [book, entries] of Object.entries(books)) {
        const log = seen.get(book) ?? seen.set(book, new Map()).get(book);
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
            if (acts.includes('vectorize') && book === view.primaryBook) vectorized.add(path);
            if (WRITE) {
                if (acts.includes('strip-marker')) { delete e.stmemorybooks; delete e.STMB_start; delete e.STMB_end; }
                // Presence is the whole signal — scene.mjs's isMemory and keyword-suggest's `generated` both test
                // for it and never read the range, which a repair has no way to recover anyway.
                if (acts.includes('add-marker')) e.stmemorybooks = true;
                if (acts.includes('vectorize')) e.vectorized = true;
                dirty = true;
            }
            touched++;
        }
    }
    // A repaired book outgrows its recorded collection: the live ST collection holds chunks for the entries
    // vectorized when it was synced, entries vectorized here have none, and loadScene gives a row with no
    // item no cosine at all — so re-deriving against the old path scores as if the repair had not happened.
    // Repoint at the rebuild cache, which keys on book + model + chunk settings and so names the same file
    // on any machine.
    if (!isWorld && vectorized.has(path)) {
        if (!m.embedModel) throw new Error(`${path}: marker records no embedModel — cannot name its rebuild cache`);
        const target = cachePath(view, chunkConfig(view), m.embedModel);
        // Every arm, whichever schema: the repair changed the book, so no arm's recorded collection is
        // current any more.
        for (const a of (m.scenes?.[0]?.arms ?? (Array.isArray(m.arms) ? m.arms : [m]))) a.index = target;
        if (!m.scenes && !Array.isArray(m.arms)) m.index = target;
        dirty = true;
    }
    // ST writes worlds pretty-printed at 4 spaces; bundles are minified. Match whichever this was,
    // so a repair is a small diff rather than a whole-file reformat.
    if (WRITE && dirty) writeFileSync(path, isWorld ? `${JSON.stringify(m, null, 4)}\n` : JSON.stringify(m));
}

for (const [book, log] of seen) {
    const by = a => [...log.values()].filter(x => x.acts === a);
    console.log(`\n${book}  — ${log.size} distinct entries across ${files.length} document(s)`);
    for (const a of ['strip-marker', 'add-marker', 'vectorize', 'add-marker+vectorize']) {
        const rows = by(a);
        if (!rows.length) continue;
        console.log(`  ${a.padEnd(20)} ${String(rows.length).padStart(3)}   ${rows.slice(0, 4).map(r => r.title).join(' / ').slice(0, 96)}${rows.length > 4 ? ' …' : ''}`);
    }
}
console.log(`\n${WRITE ? 'WROTE' : 'DRY'}: ${touched} entry-edits across ${files.length} bundle(s)`);
if (!WRITE) console.log('re-run with --write to apply, then rebuild the collection and re-derive');
