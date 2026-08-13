// rederive-syn.mjs — rebuilds a synthetic bundle's candidate lists from its OWN frozen scene, under the
// current harness, and carries the grades across.
//
// WHY REBUILD RATHER THAN RECAPTURE. The synthetic set was generated offline in the first place: dumped
// books, a random message per scene, and a model grading the entries that scoring surfaced. So its pools
// carry whatever the offline scorer admitted at the time — including disabled entries, which the retrieval
// route did not exclude until scene.mjs's guard. On the sommers set that is 70 of 649 graded rows, 9 of them
// graded >= 3: the judge was asked to rate entries production can never deliver, and it did.
//
// THE SCENE IS NOT RE-RANDOMISED, and that is the whole economy of this. Every bundle already froze the turn
// it was built from — `query`, `scanText`, `depth` — so re-deriving reuses the identical scene and a grade
// still means what it meant. Picking fresh messages would produce scenes nothing has judged and put the
// entire grading spend back on the table.
//
// WHAT CHANGES AND WHAT DOES NOT. Candidate lists are recomputed; grades, query, scan window and the embedded
// books are carried verbatim. Two consequences fall out and both are reported rather than hidden: grades
// whose entry no longer surfaces become ORPHANS (they stay in the bundle — a grade is a judgement about a
// (scene, entry) pair, not about a ranking, and re-admitting that entry later should not cost a second
// judgement), and rows that surface with no grade become PENDING, written alongside for grading.
//
// Usage (from SillyTavern root):
//   node eval/rederive-syn.mjs <syn-bundle.json ...> --books-from <dump.json> [--tokenizer <name>] [--write] [--out-dir <dir>]
//
// Dry by default.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve as resolvePath } from 'node:path';
import { loadScene, makeCandidateSet, makeFuse, sceneParams, indexPath, embed, stInstall, wiTitle } from './scene.mjs';
import * as ranking from '../extension/ranking.mjs';
import { makeTokenCounter, whyFor } from './migrate-bundle.mjs';
import { BUNDLE_VERSION } from '../extension/grading.mjs';

/**
 * The pooling arms, in HARNESS vocabulary. Mirrors worldsapart.js POOL_ARMS, which is written in settings
 * vocabulary and cannot be imported (that module pulls in ST). Two things this must not get wrong:
 *
 *   - `lexical` also moves commonWordWeight. captureParams derives it (`retrievalMode === 'lexical' ? 0.7 : 1`)
 *     rather than reading a setting, so declaring the arm by retrievalMode alone silently scores it at 1.
 *   - `loose-thr` is scoreThreshold in settings and `threshold` here.
 *
 * The per-arm captureParams recorded in a v1 synthetic bundle are NOT usable as the arm definition: every
 * one of them records suppressVectorKeys true, including keys-live, whose whole point is false. They were
 * read outside the override window. So the arms are re-applied over the `shipped` arm's baseline instead.
 */
const POOL_ARMS = {
    shipped: {},
    'no-filter': { entityFilter: false },
    vector: { retrievalMode: 'vector', commonWordWeight: 1 },
    lexical: { retrievalMode: 'lexical', commonWordWeight: 0.7 },
    'loose-thr': { threshold: 0 },
    'keys-live': { suppressVectorKeys: false },
};

const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
// A flag's VALUE is not an input file. --books-from takes a .json, so the naive "ends in .json and does not
// start with --" filter fed the dump back in as a bundle to re-derive.
const VALUE_FLAGS = new Set(['--arms', '--tokenizer', '--out-dir', '--books-from']);
const files = argv.filter((a, i) => a.endsWith('.json') && !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]));
// Subset of the arms, same spelling as --list would print. Mostly for attributing a pool change to the arm
// that caused it: keys-live was recorded wrong in every v1 synthetic bundle, so re-deriving with it fixed
// and re-deriving without it are different questions.
const ARMS = arg('--arms') ? String(arg('--arms')).split(',').map(x => x.trim()).filter(Boolean) : null;
const TOKENIZER = arg('--tokenizer');
const WRITE = argv.includes('--write');
const OUT_DIR = arg('--out-dir');
/**
 * A fresh capture of the same chat, supplying the BOOK and the baseline parameters. Without it each bundle
 * re-derives against its own embedded copy, which is the book as it stood when the synthetic set was
 * generated — so the pools come back current in every respect except the one that moved most.
 *
 * ONE DUMP PER INVOCATION, named explicitly, rather than a chat->dump table. Chat matching is not safe here:
 * the wrong-book control shares a chat with the real Time Whore capture, so an automatic match re-derives
 * fourteen scenes against a deliberately-wrong book and nothing in the output says so. Naming the dump makes
 * that a typo rather than a silent default, and the primaryBook check below catches the typo.
 */
const BOOKS_FROM = arg('--books-from');
const FORCE = argv.includes('--force');

if (!files.length) {
    console.error('usage: node eval/rederive-syn.mjs <syn-bundle.json ...> --books-from <dump.json> [--tokenizer <name>] [--write] [--out-dir <dir>]');
    console.error('  dry by default. Writes <name>.json (rebuilt) and <name>-pending.json (rows needing a grade).');
    process.exit(2);
}

const st = stInstall();
if (TOKENIZER && !st) { console.error('--tokenizer needs a reachable SillyTavern install'); process.exit(2); }
const dump = BOOKS_FROM ? JSON.parse(readFileSync(BOOKS_FROM, 'utf8')) : null;
const counter = TOKENIZER ? makeTokenCounter(st, TOKENIZER) : null;
const US = String.fromCharCode(31);
const id = r => `${r.world ?? ''}${US}${Number(r.uid)}`;
const r5 = x => (Number.isFinite(x) ? Number(x.toFixed(5)) : null);
const r2 = x => (Number.isFinite(x) ? Number(x.toFixed(2)) : null);

console.log(`bundle                                   arms  pooled  carried  orphan  pending   lost>=3`);
let failed = 0;
for (const path of files) {
    try {
        const m = JSON.parse(readFileSync(path, 'utf8'));
        const armsIn = Array.isArray(m.arms) ? m.arms : [m];
        const shipped = armsIn.find(a => a.arm === 'shipped') ?? armsIn[0];
        const { arms: _drop, ...shared } = m;
        // The frozen scene, taken from the baseline arm: every arm but the withdrawn summary one shared it.
        let scene0 = { ...shared, ...shipped };

        // The book, index and baseline parameters come from the fresh capture when one is named — the scene
        // (query, scan window, depth, chat) always stays the bundle's own. That split is the point: the turn
        // is what the grades were made about and must not move; the book is what has since been curated.
        if (dump) {
            const dumpArm = Array.isArray(dump.arms) ? (dump.arms.find(a => a.arm === 'shipped') ?? dump.arms[0]) : dump;
            const want = String(dumpArm.primaryBook ?? dump.primaryBook);
            const have = String(scene0.primaryBook);
            if (want !== have && !FORCE) {
                throw new Error(`--books-from is a different book: dump has "${want}", bundle has "${have}". `
                    + 'A wrong-book control shares a chat with a real capture, so this is checked rather than assumed (--force to override).');
            }
            scene0 = {
                ...scene0,
                books: dump.books, primaryBook: dumpArm.primaryBook ?? dump.primaryBook,
                book: dumpArm.book ?? dump.book, index: dumpArm.index ?? dump.index,
                captureParams: dumpArm.captureParams ?? scene0.captureParams,
                paramSnapshot: dumpArm.paramSnapshot ?? scene0.paramSnapshot,
            };
        }
        const qv = await embed(scene0.query, {});

        const armsOut = [];
        const pool = new Map();          // rowKey -> row (first arm to surface it wins the record)
        for (const [armName, override] of Object.entries(POOL_ARMS).filter(([n]) => !ARMS || ARMS.includes(n))) {
            // Baseline from scene0, so --books-from's fresher parameters are what the arms are applied over.
            const capture = { ...(scene0.captureParams ?? {}), ...override };
            const S = { ...scene0, captureParams: capture };
            const P = sceneParams(S);
            // Loaded per arm, not once: the gazetteer bakes in suppressVectorKeys at load time, and keys-live
            // moves it. scoreScene throws rather than reuse a scene across that change, for the same reason.
            const scene = loadScene(S, { indexFile: indexPath(S, {}), params: P });
            // Term weights exactly as scoreScene derives them. Passing null here instead would run every arm
            // with the entity filter off — the gazetteer path that admitted 2.3x the query terms and moved
            // BM25 by up to 74%, which is a difference no arm label would have shown.
            const tw = P.entityFilter ? ranking.buildTermWeights(S.query, scene.gaz, P.boost) : null;
            const rows = makeCandidateSet({ ...scene, params: P, topK: Math.max(100, P.maxVectorEntries * 2) })(
                P.K1, P.B, tw, qv, S.query, S.scanText,
            );
            // EVERY ACTIVATED ROW, ordered but not truncated. A capture does not choose how many entries to
            // record — /wa-super-grade widens the cutoff to a plain count and then writes down whatever
            // activated — so a re-derivation has no prefix to take either. Truncating here also cut the
            // WRONG ranking: production's cut is on the retrieval ranking (fuseRetrieval -> cutRetrieved),
            // and slicing the layout ranking lets a keyword-only entry displace a retrieved one from a
            // decision it is not a candidate in (ranking.mjs fuseRetrieval). Recording all of it makes the
            // pool the whole population, so no later re-ranking can orphan a grade.
            const ranked = makeFuse(P)(rows, P.LEXW);

            const out = [];
            for (const [i, r] of ranked.entries()) {
                const e = r.entry;
                const row = {
                    title: wiTitle(e),
                    // DERIVED, not observed: offline there is no runtime budget class, so this reads the
                    // entry's own always-on fields. A live capture records what actually happened.
                    block: e.constant ? 'constant' : (Number(e.sticky) > 0 ? 'sticky' : 'dynamic'),
                    sticky: e.sticky || 0,
                    score: r5(r.fused),
                    uid: Number(e.uid),
                    wiOrder: e.waOriginalOrder ?? e.order ?? null,
                    cosine: r.score !== undefined ? r5(r.score) : null,
                    vRank: r.vectorRank ?? null,
                    text: r.score !== undefined ? r2(r.textScore) : null,
                    tRank: r.textRank ?? null,
                    keys: r.keysEligible === false ? null : r2(r.keywordScore),
                    kRank: r.keywordRank ?? null,
                    '#': i,
                    world: e.world ?? scene0.primaryBook,
                    why: whyFor(e, S.scanText, P),
                };
                if (counter) row.tokens = await counter.count(e.content, TOKENIZER);
                out.push(row);
                if (!pool.has(id(row))) pool.set(id(row), row);
            }
            armsOut.push({
                arm: armName,
                query: S.query, queryChat: S.queryChat, scanText: S.scanText, depth: S.depth,
                primaryBook: S.primaryBook, book: S.book, index: S.index,
                captureParams: capture,
                paramSnapshot: shipped.paramSnapshot ? { ...shipped.paramSnapshot } : undefined,
                excludeTitles: S.excludeTitles,
                // Nothing was cut, so there is no cutoff to report — recorded explicitly rather than omitted.
                cutoff: { mode: 'none', maxVectorEntries: null, note: 'offline re-derivation records the full activated population' },
                candidates: out,
            });
        }

        const graded = new Set((m.grades ?? []).map(id));
        const pending = [...pool.values()].filter(r => !graded.has(id(r)));
        const orphan = (m.grades ?? []).filter(g => !pool.has(id(g)));
        // RELEVANT ORPHANS ARE THE ONLY ALARMING KIND. A scene's relevant set is small — single digits out of
        // forty-odd graded — so churn among the 0s and 1s costs nothing, while losing a >=3 removes something
        // recall is measured against. The two are indistinguishable in a raw orphan count.
        const rel = g => Number(g.grade) >= 3;
        const orphanRel = orphan.filter(rel).length;
        const totalRel = (m.grades ?? []).filter(rel).length;
        console.log(`${basename(path).slice(0, 40).padEnd(40)} ${String(armsOut.length).padStart(4)} ${String(pool.size).padStart(7)} ${String((m.grades ?? []).length - orphan.length).padStart(8)} ${String(orphan.length).padStart(7)} ${String(pending.length).padStart(8)}   ${orphanRel}/${totalRel}`);

        if (WRITE) {
            const out = {
                ...shared,
                bundleVersion: BUNDLE_VERSION,
                arms: armsOut,
                population: 'ranked',
                rederivedFrom: m.bundleVersion ?? 'flat-sample',
                rederivedAt: new Date().toISOString().slice(0, 10),
                // WHERE EACH PART CAME FROM, named separately, because they came from different places and a
                // reader cannot tell by looking. The scene is the bundle's own; the book and the parameters
                // are the fresh capture's. Saying "carried verbatim" of all of them was true only until
                // --books-from existed.
                booksFrom: BOOKS_FROM ? basename(BOOKS_FROM) : null,
                paramsFrom: BOOKS_FROM ? basename(BOOKS_FROM) : null,
                rederivedWhy: 'candidate lists rebuilt offline under the retrieval-route disable guard, recording the FULL '
                    + 'activated population rather than any prefix of it. '
                    + 'The SCENE (query, scan window, depth, chat) is the bundle\'s own and is NOT re-randomised, so every '
                    + 'carried grade still describes the pair it was made about. '
                    + (BOOKS_FROM
                        ? `The BOOK and the baseline captureParams come from ${basename(BOOKS_FROM)}, so the pool is centred on the `
                          + 'settings in force at that capture rather than the ones the grades were originally pooled under — '
                          + 'which is why rows this configuration no longer ranks appear as orphaned grades rather than as misses.'
                        : 'Books and captureParams are the bundle\'s own.'),
            };
            const dest = OUT_DIR ? `${resolvePath(OUT_DIR)}/${basename(path)}` : path;
            if (OUT_DIR) mkdirSync(dirname(dest), { recursive: true });
            writeFileSync(dest, JSON.stringify(out));
            if (pending.length) {
                writeFileSync(dest.replace(/\.json$/, '-pending.json'), JSON.stringify({
                    name: `${m.name ?? basename(path)} — pending`,
                    of: basename(dest), createdAt: out.rederivedAt,
                    rows: pending.map(r => ({ world: r.world, uid: r.uid, title: r.title })),
                }));
            }
        }
        counter?.flush();
    } catch (e) {
        console.log(`${basename(path).slice(0, 40).padEnd(40)} FAILED — ${e.message}`);
        counter?.flush();
        failed++;
    }
}
if (!WRITE) console.log('\nDRY — nothing written. Re-run with --write.');
if (failed) process.exit(1);
