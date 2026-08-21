// graft-grades.mjs — puts existing judgements back onto a freshly derived bundle.
//
// A grade is a verdict about a (scene, entry) PAIR, so grafting is only meaningful where both halves are
// the same. The entry half is a row identity, book + uid. The scene half is the turn, and it is the one
// that can look right while being wrong: two bundles can name the same message id and hold different
// scenes, because the id is a position in a file that gets branched, edited and replayed — and because
// the query is built at a depth that is itself a parameter. So the scene is compared by its FROZEN TEXT,
// not by its id, and a mismatch refuses rather than warns. Measured while building the generator: reading
// depth from a default instead of the source turned msg2919 into a 3484-character query where the graded
// scene was 5896, identical in every field a reader would think to check.
//
// ORPHANS ARE REPORTED BY REASON, not counted. Four of the five reasons are classification facts and carry
// no information about retrieval — an entry that is durable, disabled, reference tier, or deleted was never
// going to be in a ranked pool. Only "rankable, but nothing surfaced it" says the population moved. Lumping
// them together is how a real pool change hides inside bookkeeping.
//
// Usage (any cwd):
//   node eval/graft-grades.mjs <fresh.json ...> --from <graded.json> [--write]
//   node eval/graft-grades.mjs <fresh.json ...> --from-dir <dir> [--rename-book "old=new"] [--write]
// Dry by default. Writes the grafted bundle in place and <name>-pending.json beside it.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import { armNames, openBundle, rowKey, setGrades } from '../extension/grading.mjs';
import * as matcher from '../extension/matcher.mjs';
import { gradeValue } from './metrics.mjs';

/** Unit Separator — joins title to content so neither can spell the other's boundary. */
const US = String.fromCharCode(31);
const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const VALUE_FLAGS = new Set(['--from', '--from-dir', '--rename-book']);
const files = argv.filter((a, i) => a.endsWith('.json') && !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]));
const WRITE = argv.includes('--write');
const FROM = arg('--from');
const FROM_DIR = arg('--from-dir');
const WS_DRIFT = argv.includes('--allow-whitespace-drift');

if (!files.length || (!FROM && !FROM_DIR)) {
    console.error('usage: node eval/graft-grades.mjs <fresh.json ...> (--from <graded.json> | --from-dir <dir>) [--rename-book "old=new"] [--write]');
    console.error('  refuses unless the frozen scene matches; reports orphans by reason');
    console.error('  --allow-whitespace-drift accepts a scene differing only in trailing whitespace, and records that it did');
    process.exit(2);
}

/** A book renamed between grading and generation. rowKey is book+uid, so without this every grade orphans
 *  while the uids line up perfectly — named explicitly because "the uids overlap" is also true of a book's
 *  wrong-book control, and a uid-only fallback would graft that silently. */
const RENAME = (() => {
    const raw = arg('--rename-book');
    if (!raw) return null;
    const i = raw.indexOf('=');
    if (i < 0) { console.error('--rename-book takes "old=new"'); process.exit(2); }
    return { from: raw.slice(0, i), to: raw.slice(i + 1) };
})();

/** One arm as a flat sample. Every read of a bundle here goes through openBundle, so this tool never
 *  learns where in the document a query, a haystack or a verdict lives — v3 moved all three. */
const armOf = b => openBundle(b);
const isMemoryTitle = t => /^\s*\[?\s*ARC\s*[-—]?\s*\d+/i.test(String(t)) || /^\s*\d+[A-Za-z]?\s*[-—.:]/.test(String(t));

let failed = 0;
console.log('bundle                                grafted  orphan  pending   lost>=3');
for (const path of files) {
    const fresh = JSON.parse(readFileSync(resolvePath(path), 'utf8'));
    const srcPath = FROM ?? `${resolvePath(FROM_DIR)}/${basename(path)}`;
    if (!existsSync(srcPath)) { console.error(`!! ${basename(path)}: no graded source at ${srcPath}`); failed++; continue; }
    const src = JSON.parse(readFileSync(srcPath, 'utf8'));

    // --- the scene guard, before anything is read out of the source -----------------------------------
    const a = armOf(fresh), b = armOf(src);
    // Compared on the scan MESSAGES rather than a joined window: that is what the document stores, and a
    // window would compare two derivations rather than the frozen input.
    const scanOf = v => matcher.scanWindow(v.scanChat ?? [], { depth: v.depth, includeNames: true });
    let diff = ['query'].filter(f => a[f] !== b[f])
        .concat(scanOf(a) !== scanOf(b) ? ['scanChat'] : [])
        .concat(Number(a.depth) !== Number(b.depth) ? ['depth'] : []);
    // TRAILING WHITESPACE ONLY, and only when asked for. Measured on 4 of 56 scenes across 3 chats: the
    // capture's scanText is one character shorter than the window rebuilt from the same turn, because a
    // message in the chat file ends with a space that the capture did not record. Production reads `mes`
    // raw into scanSegments, so the rebuilt window is the faithful one and the recorded text was subtly
    // wrong — and under strict word boundaries a space before a newline is a boundary either way, so no
    // count can move. The escape is a flag rather than the default because a guard that quietly normalises
    // its input stops being able to tell you the scene changed.
    let drifted = false;
    if (diff.length && WS_DRIFT) {
        const flat = s => String(s).split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n');
        const still = diff.filter(f => (f === 'depth' ? Number(a.depth) !== Number(b.depth) : flat(f === 'scanChat' ? scanOf(a) : a[f]) !== flat(f === 'scanChat' ? scanOf(b) : b[f])));
        if (!still.length) { drifted = true; console.error(`   ${basename(path)}: ${diff.join(', ')} differ by trailing whitespace only — accepted under --allow-whitespace-drift`); }
        diff = still;
    }
    if (diff.length) {
        console.error(`!! ${basename(path)}: REFUSED — ${diff.join(', ')} differ from ${basename(srcPath)}, so these grades were not made about this scene`);
        for (const f of diff) {
            const [x, y] = (f === 'scanChat' ? [scanOf(a), scanOf(b)] : [a[f], b[f]])
                .map(v => (typeof v === 'string' ? `${v.length}ch` : String(v)));
            console.error(`     ${f}: fresh ${x}, graded ${y}`);
        }
        failed++;
        continue;
    }

    // --- the entry half -------------------------------------------------------------------------------
    const key = r => rowKey(RENAME && r.book === RENAME.from ? { ...r, book: RENAME.to } : r);
    const pool = new Map();
    for (const name of armNames(fresh)) for (const c of openBundle(fresh, name).candidates) if (!pool.has(rowKey(c))) pool.set(rowKey(c), c);
    const grades = (armOf(src).entries ?? []).map(g => (RENAME && g.book === RENAME.from ? { ...g, book: RENAME.to } : g));

    // THE ENTRY HALF IS A NAME TOO, and the scene half already taught this lesson: book + uid says the row
    // is the same ROW, not that the entry still says what it said when it was graded. Books are edited
    // outside ST between captures — new reference entries, a summary split in two — so a grade can land on
    // text its rater never read. What a relevance verdict is about is the TITLE AND CONTENT the rater saw,
    // so those are what must match; a new key, a changed order or a flipped flag does not invalidate it.
    // The book hash is the fast path — equal books cannot have moved an entry, which is the ordinary case —
    // and a MISSING hash on either side compares anyway, since absence is not proof of sameness.
    const srcName = n => (RENAME && n === RENAME.to ? RENAME.from : n);
    const settled = n => {
        const a = src.bookHashes?.[srcName(n)], b = fresh.bookHashes?.[n];
        return Boolean(a && b && a === b);
    };
    const textOf = e => (e ? `${e.comment ?? ''}${US}${e.content ?? ''}` : null);
    // BOTH SIDES OR NO VERDICT. A conforming bundle embeds its books, so a missing entry means the text was
    // never recorded — a malformed bundle — rather than that the entry moved. Comparing against that absence
    // would orphan every grade in it and report the malformation as drift.
    const rewritten = g => {
        if (settled(g.book)) return false;
        const was = src.books?.[srcName(g.book)]?.[String(g.uid)];
        const now = fresh.books?.[g.book]?.[String(g.uid)];
        return was !== undefined && now !== undefined && textOf(was) !== textOf(now);
    };

    const landed = grades.filter(g => pool.has(key(g)) && !rewritten(g));
    const orphan = grades.filter(g => !pool.has(key(g)) || rewritten(g));

    // Reason per orphan, read off the FRESH bundle's embedded book, which is the live one.
    const entries = new Map(Object.values(fresh.books?.[armOf(fresh).primaryBook] ?? {}).map(e => [Number(e.uid), e]));
    const reasonOf = g => {
        const e = entries.get(Number(g.uid));
        if (!e) return 'uid gone from the book';
        // Ahead of the classification facts, because it is the one that says the GRADE is stale rather than
        // that the entry was never rankable. Re-grading recovers it; nothing recovers the others.
        if (rewritten(g)) return 'entry text changed since it was graded';
        if (e.disable) return 'disabled';
        if (e.constant || Number(e.sticky) > 0) return 'durable (constant/sticky)';
        if (!isMemoryTitle(e.comment ?? e.title)) return 'reference tier (no STMB marker)';
        return 'rankable, but nothing surfaced it';
    };
    const byReason = new Map();
    for (const g of orphan) {
        const r = reasonOf(g);
        byReason.set(r, [...(byReason.get(r) ?? []), g]);
    }

    const pending = [...pool.values()].filter(r => !grades.some(g => key(g) === rowKey(r)));
    const rel = g => gradeValue(g) >= 3;
    console.log(`${basename(path).slice(0, 36).padEnd(36)} ${String(landed.length).padStart(8)} ${String(orphan.length).padStart(7)} ${String(pending.length).padStart(8)}   ${orphan.filter(rel).length}/${grades.filter(rel).length}`);
    for (const [r, gs] of [...byReason].sort((x, y) => y[1].length - x[1].length)) {
        // The one reason that means retrieval moved is spelled out row by row; the rest are counted.
        const alarming = r.startsWith('rankable');
        console.log(`   ${String(gs.length).padStart(3)} ${r}${alarming ? '  <<' : ''}`);
        if (alarming) for (const g of gs) console.log(`       grade ${gradeValue(g)}  ${String(g.title).slice(0, 60)}`);
    }

    if (WRITE) {
        const out = setGrades(fresh, grades);
        Object.assign(out, {
            gradeScale: src.gradeScale,
            // GRADING provenance, separate from the generation provenance synth-scenes wrote. They are
            // different events by different agents and only one of them is repeatable.
            grading: {
                from: basename(srcPath),
                by: src.grading?.by ?? src.createdBy ?? null,
                at: src.grading?.at ?? src.createdAt ?? null,
                notes: src.grading?.notes ?? src.notes ?? null,
                graftedAt: new Date().toISOString(),
                ...(RENAME ? { renamedBook: `${RENAME.from} -> ${RENAME.to}` } : {}),
                ...(drifted ? { sceneMatchedIgnoringTrailingWhitespace: true } : {}),
                orphans: [...byReason].map(([reason, gs]) => ({ reason, uids: gs.map(g => Number(g.uid)) })),
            },
        });
        writeFileSync(resolvePath(path), JSON.stringify(out));
        writeFileSync(resolvePath(path).replace(/\.json$/, '-pending.json'), JSON.stringify({
            name: `${fresh.name} — pending`, of: basename(path), createdAt: new Date().toISOString(),
            rows: pending.map(r => ({ book: r.book, uid: r.uid, title: r.title })),
        }));
    }
}

console.log(`\n${WRITE ? 'wrote' : 'DRY —'} ${files.length - failed} bundle(s)${failed ? `, ${failed} refused` : ''}${WRITE ? '' : '. Re-run with --write.'}`);
process.exit(failed ? 1 : 0);
