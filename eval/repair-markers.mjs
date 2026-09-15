// repair-markers.mjs — reconciles a bundle's or world file's embedded books with what its entries are (F47): the STMB marker off the title convention, and `vectorized` on memory entries; durable entries are left alone.
// Usage (any cwd):
//   node eval/repair-markers.mjs <bundle.json | world.json ...> [--write]   (dry by default; a repaired world needs its collection re-synced, a repaired bundle re-deriving)
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { cachePath, chunkConfig } from './lib/reindex.mjs';
import { openBundle } from '../extension/grading.mjs';

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const files = argv.filter(a => a.endsWith('.json') && !a.startsWith('--'));
if (!files.length) {
    console.error('usage: node eval/repair-markers.mjs <bundle.json ...> [--write]');
    console.error('  dry by default; reports every entry it would touch, grouped by book');
    process.exit(2);
}

/** This corpus only: an STMB entry is titled with a number, or ARC + number; letter suffix = a manual split. A repair rule over data, never a predicate in scene.mjs or matcher.mjs, which keep testing fields. */
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
    const isWorld = !m.books && Boolean(m.entries);
    // The filename, not the embedded name: ST hashes the filename into the collection id, and name goes stale silently.
    const books = isWorld ? { [basename(path, '.json')]: m.entries } : (m.books ?? {});
    // primaryBook and paramSnapshot live on the arm: read off the root they are silently undefined.
    const view = isWorld ? m : openBundle(m);
    let dirty = false;
    for (const [book, entries] of Object.entries(books)) {
        const log = seen.get(book) ?? seen.set(book, new Map()).get(book);
        for (const e of Object.values(entries)) {
            const memory = isMemoryTitle(title(e));
            const acts = [];
            if (marked(e) && !memory) { acts.push('strip-marker'); }
            if (!marked(e) && memory) { acts.push('add-marker'); }
            // memory, not the marker: an entry repaired into memory this pass needs its vector decided too.
            if (memory && !e.vectorized && indexable(e) && !durable(e)) acts.push('vectorize');
            if (!acts.length) continue;
            log.set(Number(e.uid), { acts: acts.join('+'), title: title(e) });
            if (acts.includes('vectorize') && book === view.primaryBook) vectorized.add(path);
            if (WRITE) {
                if (acts.includes('strip-marker')) { delete e.stmemorybooks; delete e.STMB_start; delete e.STMB_end; }
                // Presence is the whole signal: scene.mjs isMemory and keyword-suggest's generated never read the range.
                if (acts.includes('add-marker')) e.stmemorybooks = true;
                if (acts.includes('vectorize')) e.vectorized = true;
                dirty = true;
            }
            touched++;
        }
    }
    // Entries vectorized here have no chunks in the live collection, so every arm's index is repointed at the rebuild cache, which keys on book + model + chunk settings.
    if (!isWorld && vectorized.has(path)) {
        if (!m.embedModel) throw new Error(`${path}: marker records no embedModel — cannot name its rebuild cache`);
        const target = cachePath(view, chunkConfig(view), m.embedModel);
        for (const a of (m.scenes?.[0]?.arms ?? (Array.isArray(m.arms) ? m.arms : [m]))) a.index = target;
        if (!m.scenes && !Array.isArray(m.arms)) m.index = target;
        dirty = true;
    }
    // ST writes worlds at 4 spaces and bundles minified; match whichever this was, so a repair is a small diff.
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
