// graft-grades.mjs — puts existing judgements back onto a freshly derived bundle.
//
// A grade is a verdict about a (scene, entry) PAIR, so grafting is only meaningful where both halves are
// the same. The entry half is a row identity, world + uid. The scene half is the turn, and it is the one
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
//   node eval/graft-grades.mjs <fresh.json ...> --from-dir <dir> [--rename-world "old=new"] [--write]
// Dry by default. Writes the grafted bundle in place and <name>-pending.json beside it.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import { rowKey } from '../extension/grading.mjs';

const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const VALUE_FLAGS = new Set(['--from', '--from-dir', '--rename-world']);
const files = argv.filter((a, i) => a.endsWith('.json') && !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]));
const WRITE = argv.includes('--write');
const FROM = arg('--from');
const FROM_DIR = arg('--from-dir');

if (!files.length || (!FROM && !FROM_DIR)) {
    console.error('usage: node eval/graft-grades.mjs <fresh.json ...> (--from <graded.json> | --from-dir <dir>) [--rename-world "old=new"] [--write]');
    console.error('  refuses unless the frozen scene matches; reports orphans by reason');
    process.exit(2);
}

/** A book renamed between grading and generation. rowKey is world+uid, so without this every grade orphans
 *  while the uids line up perfectly — named explicitly because "the uids overlap" is also true of a book's
 *  wrong-book control, and a uid-only fallback would graft that silently. */
const RENAME = (() => {
    const raw = arg('--rename-world');
    if (!raw) return null;
    const i = raw.indexOf('=');
    if (i < 0) { console.error('--rename-world takes "old=new"'); process.exit(2); }
    return { from: raw.slice(0, i), to: raw.slice(i + 1) };
})();

const armOf = b => (Array.isArray(b.arms) ? (b.arms.find(a => a.arm === 'shipped') ?? b.arms[0]) : b);
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
    const diff = ['query', 'scanText'].filter(f => a[f] !== b[f]).concat(Number(a.depth) !== Number(b.depth) ? ['depth'] : []);
    if (diff.length) {
        console.error(`!! ${basename(path)}: REFUSED — ${diff.join(', ')} differ from ${basename(srcPath)}, so these grades were not made about this scene`);
        for (const f of diff) {
            const [x, y] = [a[f], b[f]].map(v => (typeof v === 'string' ? `${v.length}ch` : String(v)));
            console.error(`     ${f}: fresh ${x}, graded ${y}`);
        }
        failed++;
        continue;
    }

    // --- the entry half -------------------------------------------------------------------------------
    const key = r => rowKey(RENAME && r.world === RENAME.from ? { ...r, world: RENAME.to } : r);
    const pool = new Map();
    for (const arm of fresh.arms) for (const c of arm.candidates) if (!pool.has(rowKey(c))) pool.set(rowKey(c), c);
    const grades = (src.grades ?? []).map(g => (RENAME && g.world === RENAME.from ? { ...g, world: RENAME.to } : g));
    const landed = grades.filter(g => pool.has(key(g)));
    const orphan = grades.filter(g => !pool.has(key(g)));

    // Reason per orphan, read off the FRESH bundle's embedded book, which is the live one.
    const entries = new Map(Object.values(fresh.books?.[armOf(fresh).primaryBook] ?? {}).map(e => [Number(e.uid), e]));
    const reasonOf = g => {
        const e = entries.get(Number(g.uid));
        if (!e) return 'uid gone from the world';
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
    const rel = g => Number(g.grade) >= 3;
    console.log(`${basename(path).slice(0, 36).padEnd(36)} ${String(landed.length).padStart(8)} ${String(orphan.length).padStart(7)} ${String(pending.length).padStart(8)}   ${orphan.filter(rel).length}/${grades.filter(rel).length}`);
    for (const [r, gs] of [...byReason].sort((x, y) => y[1].length - x[1].length)) {
        // The one reason that means retrieval moved is spelled out row by row; the rest are counted.
        const alarming = r.startsWith('rankable');
        console.log(`   ${String(gs.length).padStart(3)} ${r}${alarming ? '  <<' : ''}`);
        if (alarming) for (const g of gs) console.log(`       grade ${g.grade}  ${String(g.title).slice(0, 60)}`);
    }

    if (WRITE) {
        const out = {
            ...fresh,
            grades,
            gradeScale: src.gradeScale,
            // GRADING provenance, separate from the generation provenance synth-scenes wrote. They are
            // different events by different agents and only one of them is repeatable.
            grading: {
                from: basename(srcPath),
                by: src.grading?.by ?? src.createdBy ?? null,
                at: src.grading?.at ?? src.createdAt ?? null,
                notes: src.grading?.notes ?? src.notes ?? null,
                graftedAt: new Date().toISOString().slice(0, 10),
                ...(RENAME ? { renamedWorld: `${RENAME.from} -> ${RENAME.to}` } : {}),
                orphans: [...byReason].map(([reason, gs]) => ({ reason, uids: gs.map(g => Number(g.uid)) })),
            },
        };
        writeFileSync(resolvePath(path), JSON.stringify(out));
        writeFileSync(resolvePath(path).replace(/\.json$/, '-pending.json'), JSON.stringify({
            name: `${fresh.name} — pending`, of: basename(path), createdAt: new Date().toISOString().slice(0, 10),
            rows: pending.map(r => ({ world: r.world, uid: r.uid, title: r.title })),
        }));
    }
}

console.log(`\n${WRITE ? 'wrote' : 'DRY —'} ${files.length - failed} bundle(s)${failed ? `, ${failed} refused` : ''}${WRITE ? '' : '. Re-run with --write.'}`);
process.exit(failed ? 1 : 0);
