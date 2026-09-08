// graft-grades.mjs — puts existing judgements back onto a freshly derived bundle; refuses unless the frozen scene TEXT matches (a message id is a position in a file that gets branched and replayed, G9), and reports orphans by reason — only "rankable, but nothing surfaced it" says the population moved.
// Usage (any cwd):
//   node eval/graft-grades.mjs <fresh.json ...> (--from <graded.json> | --from-dir <dir>) [--rename-book "old=new"] [--allow-whitespace-drift] [--write]   (dry by default; writes in place; the ungraded remainder is reported, not written)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import { armNames, openBundle, rowKey, sceneDiff, setGrades } from '../extension/grading.mjs';
import * as matcher from '../extension/matcher.mjs';
import { gradeValue, arg } from './metrics.mjs';

/** Unit Separator — joins title to content so neither can spell the other's boundary. */
const US = String.fromCharCode(31);
const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--from', '--from-dir', '--rename-book']);
const files = argv.filter((a, i) => a.endsWith('.json') && !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]));
const WRITE = argv.includes('--write');
const FROM = arg(argv, '--from');
const FROM_DIR = arg(argv, '--from-dir');
const WS_DRIFT = argv.includes('--allow-whitespace-drift');

if (!files.length || (!FROM && !FROM_DIR)) {
    console.error('usage: node eval/graft-grades.mjs <fresh.json ...> (--from <graded.json> | --from-dir <dir>) [--rename-book "old=new"] [--write]');
    console.error('  refuses unless the frozen scene matches; reports orphans by reason');
    console.error('  --allow-whitespace-drift accepts a scene differing only in trailing whitespace, and records that it did');
    process.exit(2);
}

/** --rename-book old=new: rowKey is book+uid, so a rename between grading and generation orphans every grade; no uid-only fallback, since the wrong-book control shares uids too. */
const RENAME = (() => {
    const raw = arg(argv, '--rename-book');
    if (!raw) return null;
    const i = raw.indexOf('=');
    if (i < 0) { console.error('--rename-book takes "old=new"'); process.exit(2); }
    return { from: raw.slice(0, i), to: raw.slice(i + 1) };
})();

const armOf = b => openBundle(b);
const isMemoryTitle = t => /^\s*\[?\s*ARC\s*[-—]?\s*\d+/i.test(String(t)) || /^\s*\d+[A-Za-z]?\s*[-—.:]/.test(String(t));

let failed = 0;
console.log('bundle                                grafted  orphan  pending   lost>=3');
for (const path of files) {
    const fresh = JSON.parse(readFileSync(resolvePath(path), 'utf8'));
    const srcPath = FROM ?? `${resolvePath(FROM_DIR)}/${basename(path)}`;
    if (!existsSync(srcPath)) { console.error(`!! ${basename(path)}: no graded source at ${srcPath}`); failed++; continue; }
    const src = JSON.parse(readFileSync(srcPath, 'utf8'));

    // sceneDiff lives in grading.mjs: the browser's prior-sample loader needs the same guard (G9).
    const a = armOf(fresh), b = armOf(src);
    let diff = sceneDiff(a, b);
    // Trailing whitespace only, and only under the flag: a guard that quietly normalises cannot say the scene changed (G9).
    let drifted = false;
    if (diff.length && WS_DRIFT) {
        const still = sceneDiff(a, b, { ignoreTrailingWhitespace: true });
        if (!still.length) { drifted = true; console.error(`   ${basename(path)}: ${diff.join(', ')} differ by trailing whitespace only — accepted under --allow-whitespace-drift`); }
        diff = still;
    }
    if (diff.length) {
        console.error(`!! ${basename(path)}: REFUSED — ${diff.join(', ')} differ from ${basename(srcPath)}, so these grades were not made about this scene`);
        // Sizes only, for the reader — the verdict was `sceneDiff`'s.
        const scanOf = v => matcher.scanWindow(v.scanChat ?? [], { depth: v.depth, includeNames: true });
        for (const f of diff) {
            const [x, y] = (f === 'scanChat' ? [scanOf(a), scanOf(b)] : [a[f], b[f]])
                .map(v => (typeof v === 'string' ? `${v.length}ch` : String(v)));
            console.error(`     ${f}: fresh ${x}, graded ${y}`);
        }
        failed++;
        continue;
    }

    const key = r => rowKey(RENAME && r.book === RENAME.from ? { ...r, book: RENAME.to } : r);
    const pool = new Map();
    for (const name of armNames(fresh)) for (const c of openBundle(fresh, name).candidates) if (!pool.has(rowKey(c))) pool.set(rowKey(c), c);
    const grades = (armOf(src).entries ?? []).map(g => (RENAME && g.book === RENAME.from ? { ...g, book: RENAME.to } : g));

    // book + uid says the row is the same row, not that the entry still says what it did: the title and content the rater saw must match. Equal book hashes are the fast path; a missing hash compares anyway.
    const srcName = n => (RENAME && n === RENAME.to ? RENAME.from : n);
    const settled = n => {
        const a = src.bookHashes?.[srcName(n)], b = fresh.bookHashes?.[n];
        return Boolean(a && b && a === b);
    };
    const textOf = e => (e ? `${e.comment ?? ''}${US}${e.content ?? ''}` : null);
    // Both sides or no verdict: a missing embedded entry means the text was never recorded, not that it moved.
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
        // First: the one reason re-grading recovers.
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
    }
}

console.log(`\n${WRITE ? 'wrote' : 'DRY —'} ${files.length - failed} bundle(s)${failed ? `, ${failed} refused` : ''}${WRITE ? '' : '. Re-run with --write.'}`);
process.exit(failed ? 1 : 0);
