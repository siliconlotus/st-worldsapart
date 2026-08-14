// synth-scenes.mjs — derives synthetic graded-scene bundles from a LIVE chat and a LIVE world.
//
// One operation, two ways to pick the turns. `--msgs` names them, which is how you re-derive an existing
// set against a changed book; `--n` samples them, which is how you grow one. There is no separate
// "rederive" mode: re-deriving is this tool with the old message ids, followed by graft-grades.mjs putting
// the old judgements back on the (scene, entry) pairs they were made about.
//
// NOTHING IS CARRIED FROM A PREVIOUS BUNDLE. The predecessor built its output as "the old bundle, minus
// arms, plus overrides", so any field nobody remembered to overwrite survived — which is how all 56
// bundles ended up recording candidate lists derived from one book beside an embedded copy of another, six
// weeks older, with nothing saying so. Everything here comes from the chat and the world as they are now,
// and the only inputs that may come from elsewhere are the message ids.
//
// MESSAGE IDS ARE RAW RECORD INDICES — line N of the .jsonl, counting hidden messages. Verified against the
// existing set: sommers-syn-msg5347 sits at raw 5347 and usable 5340 in a chat with 7 hidden records. The
// query and scan window are built from is_system-filtered messages, because ranking.queryMessages and
// matcher.scanWindow both expect the caller to have dropped them (matcher.scanWindow's own docstring says
// so), but the id that names the scene stays the raw one so it can be found in the file by line.
//
// Usage (any cwd):
//   node eval/synth-scenes.mjs --chat <chat.jsonl> --book <world name> --msgs 123,456 [--write]
//   node eval/synth-scenes.mjs --chat <chat.jsonl> --book <world name> --n 14 --seed 7 [--write]
//   node eval/synth-scenes.mjs --from <bundle.json> --msgs same [--write]
// Dry by default: prints what it would generate. Each bundle is written as it is produced, never at the end.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, resolve as resolvePath } from 'node:path';
import { loadScene, makeCandidateSet, makeFuse, sceneParams, indexPath, embed, stInstall, wiTitle } from './scene.mjs';
import { ensureIndex } from './reindex.mjs';
import { whyFor } from './migrate-bundle.mjs';
import * as ranking from '../extension/ranking.mjs';
import * as matcher from '../extension/matcher.mjs';
import { BUNDLE_VERSION } from '../extension/grading.mjs';

/**
 * The pooling arms, in HARNESS vocabulary. Mirrors worldsapart.js POOL_ARMS, which is written in settings
 * vocabulary and cannot be imported (that module pulls in ST). One thing this must not get wrong:
 * `loose-thr` is scoreThreshold in settings and `threshold` here.
 */
const POOL_ARMS = {
    shipped: {},
    'no-filter': { entityFilter: false },
    'loose-thr': { threshold: 0 },
    'keys-live': { suppressVectorKeys: false },
};

const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const WRITE = argv.includes('--write');
const FROM = arg('--from');
const MIN_HISTORY = Number(arg('--min-history') ?? 50);
const OUT_DIR = arg('--out-dir') ?? (FROM ? dirname(resolvePath(FROM)) : '.');
const MODEL = arg('--model') ?? process.env.WA_EMBED_MODEL ?? 'bge-m3';
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';

const src = FROM ? JSON.parse(readFileSync(FROM, 'utf8')) : null;
const srcArm = src && (Array.isArray(src.arms) ? (src.arms.find(a => a.arm === 'shipped') ?? src.arms[0]) : src);
// DEPTH IS PART OF THE SCENE, so --from inherits it. Defaulting to 5 under --from silently builds a
// different query out of the same turn: the source scenes were captured at 10, and the shorter window
// scored as a scene nobody had graded while looking identical in every field a reader checks.
const DEPTH = Number(arg('--depth') ?? srcArm?.depth ?? 5);
const CHAT = arg('--chat') ?? src?.chat ?? srcArm?.chat;
const BOOK = arg('--book') ?? srcArm?.primaryBook ?? src?.primaryBook;
const PREFIX = arg('--prefix') ?? (FROM ? basename(FROM).replace(/-msg\d+\.json$/, '') : 'syn');

if (!CHAT || !BOOK) {
    console.error('usage: node eval/synth-scenes.mjs --chat <chat.jsonl> --book <world name> (--msgs a,b,c | --n N [--seed S]) [--write]');
    console.error('       node eval/synth-scenes.mjs --from <bundle.json> --msgs same [--write]');
    console.error('  --from takes the chat, book and parameter identity from an existing bundle; "--msgs same" reuses its own turn');
    process.exit(2);
}

const st = stInstall();
if (!st) { console.error('no SillyTavern install reachable — synth-scenes reads the live chat and world (set WA_ST_ROOT)'); process.exit(2); }

// --- the live world -----------------------------------------------------------------------------------
// BY FILENAME, which is how ST addresses a book and what it hashes into the collection id. The `name`
// inside the file is whatever it was last copied from and goes stale silently.
const worldPath = st.resolve(`data/default-user/worlds/${BOOK}.json`);
if (!existsSync(worldPath)) { console.error(`no world file for "${BOOK}" at ${worldPath}`); process.exit(2); }
const entries = JSON.parse(readFileSync(worldPath, 'utf8')).entries;
const byUidWorld = Object.fromEntries(Object.values(entries).map(e => [e.uid, { ...e, world: BOOK }]));

// --- the live chat ------------------------------------------------------------------------------------
// WHOLE FILE, not a tail read. graded-scene-grid tails 8MB because it only ever wants the newest turn;
// sampling msg123 of a 5000-message chat needs the beginning, and a raw index is only meaningful against
// every record.
const chatPath = st.resolve(CHAT);
if (!existsSync(chatPath)) { console.error(`no chat at ${chatPath}`); process.exit(2); }
const records = readFileSync(chatPath, 'utf8').split('\n').filter(Boolean)
    .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
// A chat file's first record is the character card header, not a message; it has no `mes`.
const isMessage = r => typeof r?.mes === 'string';

/** Raw indices eligible to be a scene: a visible message with enough visible history behind it. */
const eligible = [];
{
    let usable = 0;
    for (const [i, r] of records.entries()) {
        if (!isMessage(r) || r.is_system) continue;
        if (usable >= MIN_HISTORY) eligible.push(i);
        usable++;
    }
}

/** Deterministic PRNG so --seed reproduces a sample exactly. */
const mulberry32 = a => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

let picks;
if (arg('--msgs') === 'same') {
    if (!srcArm) { console.error('--msgs same needs --from'); process.exit(2); }
    const m = basename(FROM).match(/-msg(\d+)\.json$/);
    if (!m) { console.error(`cannot read a message id out of ${basename(FROM)}`); process.exit(2); }
    picks = [Number(m[1])];
} else if (arg('--msgs')) {
    picks = String(arg('--msgs')).split(',').map(x => Number(x.trim())).filter(Number.isFinite);
} else if (arg('--n')) {
    const rng = mulberry32(Number(arg('--seed') ?? 1));
    const pool = [...eligible];
    picks = [];
    for (let k = 0; k < Number(arg('--n')) && pool.length; k++) picks.push(...pool.splice(Math.floor(rng() * pool.length), 1));
    picks.sort((a, b) => a - b);
} else { console.error('pass --msgs a,b,c or --n N'); process.exit(2); }

const bad = picks.filter(i => !records[i] || !isMessage(records[i]) || records[i].is_system);
if (bad.length) { console.error(`message id(s) ${bad.join(', ')} are missing or hidden in ${basename(chatPath)} — a raw index must name a visible message`); process.exit(2); }

console.log(`chat ${basename(chatPath)}: ${records.length} records, ${eligible.length} eligible turns`);
console.log(`world "${BOOK}": ${Object.keys(entries).length} entries, ${Object.values(entries).filter(e => e.vectorized && !e.disable && e.content).length} vectorized`);
console.log(`generating ${picks.length} scene(s) at depth ${DEPTH}: ${picks.join(', ')}\n`);

// A DRY RUN STOPS HERE, BEFORE THE COLLECTION IS BUILT. Everything a dry run is for — which turns, at what
// depth, against which book — is already on screen, and ensureIndex is the one step that spends: it embeds
// the whole book, which is thousands of chunks on these. It also writes into a cache keyed by book name, so
// a dry run that got that far left a real collection behind under whatever name it was passed.
if (!WRITE) {
    console.log('\nDRY — nothing written and nothing embedded. Re-run with --write.');
    process.exit(0);
}

const r5 = x => (Number.isFinite(x) ? Number(x.toFixed(5)) : null);
const r2 = x => (Number.isFinite(x) ? Number(x.toFixed(2)) : null);

// The collection, built once from the live world and shared by every scene — same book, same chunking.
const chunkOverrides = srcArm?.paramSnapshot?.vectors ?? {};
const shell = { primaryBook: BOOK, books: { [BOOK]: byUidWorld }, paramSnapshot: srcArm?.paramSnapshot };
const built = await ensureIndex(shell, { overrides: chunkOverrides, model: MODEL, ollama: OLLAMA, log: m => console.log(`  ${m}`) });
console.log(`collection: ${built.items} chunks${built.built ? ' (built)' : ' (cached)'}\n`);

console.log(`scene                          arms  pooled  vectorized  keyword-only`);
for (const idx of picks) {
    const visible = records.slice(0, idx + 1).filter(r => isMessage(r) && !r.is_system);
    const query = ranking.buildQuery(visible, { depth: DEPTH });
    const queryChat = ranking.queryMessages(visible, { depth: DEPTH });
    const base = { ...(srcArm?.captureParams ?? {}) };
    const scanText = matcher.scanWindow(visible, { depth: DEPTH, includeNames: sceneParams({ captureParams: base }).includeNames });
    const qv = await embed(query, { ollama: OLLAMA, model: MODEL });

    const armsOut = [];
    const pool = new Map();
    for (const [armName, override] of Object.entries(POOL_ARMS)) {
        const capture = { ...base, ...override };
        const S = {
            primaryBook: BOOK, books: { [BOOK]: byUidWorld }, chat: CHAT,
            query, queryChat, scanText, depth: DEPTH, captureParams: capture,
            paramSnapshot: srcArm?.paramSnapshot, excludeTitles: [], index: built.path,
        };
        const P = sceneParams(S);
        // Loaded per arm, not once: the gazetteer bakes in suppressVectorKeys at load time and keys-live
        // moves it. scoreScene throws rather than reuse a scene across that change, for the same reason.
        const scene = loadScene(S, { indexFile: indexPath(S, { model: MODEL }), params: P });
        // Term weights exactly as scoreScene derives them. Passing null instead runs every arm with the
        // entity filter off — the gazetteer path that admitted 2.3x the query terms and moved BM25 by up
        // to 74%, which is a difference no arm label would have shown.
        const tw = P.entityFilter ? ranking.buildTermWeights(query, scene.gaz, P.boost) : null;
        const rows = makeCandidateSet({ ...scene, params: P, topK: Math.max(100, P.maxVectorEntries * 2) })(
            P.K1, P.B, tw, qv, query, scanText,
        );
        // EVERY ACTIVATED ROW, ordered but not truncated — a pool that is the whole population is one no
        // later re-ranking can orphan a grade out of.
        const ranked = makeFuse(P)(rows, P.LEXW);
        const out = ranked.map((r, i) => {
            const e = r.entry;
            const row = {
                title: wiTitle(e),
                // DERIVED, not observed: offline there is no runtime budget class, so this reads the
                // entry's own always-on fields.
                block: e.constant ? 'constant' : (Number(e.sticky) > 0 ? 'sticky' : 'dynamic'),
                sticky: e.sticky || 0,
                score: r5(r.fused), uid: Number(e.uid),
                wiOrder: e.waOriginalOrder ?? e.order ?? null,
                cosine: r.score !== undefined ? r5(r.score) : null, vRank: r.vectorRank ?? null,
                text: r.score !== undefined ? r2(r.textScore) : null, tRank: r.textRank ?? null,
                keys: r.keysEligible === false ? null : r2(r.keywordScore), kRank: r.keywordRank ?? null,
                '#': i, world: e.world ?? BOOK,
                why: whyFor(e, scanText, P),
            };
            if (!pool.has(`${row.world}${row.uid}`)) pool.set(`${row.world}${row.uid}`, row);
            return row;
        });
        armsOut.push({
            arm: armName, query, queryChat, scanText, depth: DEPTH,
            primaryBook: BOOK, index: built.path, captureParams: capture,
            paramSnapshot: srcArm?.paramSnapshot, excludeTitles: [],
            // Nothing was cut, so there is no cutoff to report — recorded explicitly rather than omitted.
            cutoff: { mode: 'none', maxVectorEntries: null, note: 'offline derivation records the full activated population' },
            candidates: out,
        });
    }

    const name = `${PREFIX}-msg${idx}`;
    const vec = [...pool.values()].filter(r => r.cosine !== null).length;
    console.log(`${name.slice(0, 30).padEnd(30)} ${String(armsOut.length).padStart(4)} ${String(pool.size).padStart(7)} ${String(vec).padStart(11)} ${String(pool.size - vec).padStart(13)}`);

    if (WRITE) {
        const bundle = {
            bundleVersion: BUNDLE_VERSION,
            name,
            // GENERATION provenance only. How the grades were made is the grades' own, and travels with
            // them in graft-grades.mjs — conflating the two is what made a bundle's history unreadable.
            createdAt: new Date().toISOString().slice(0, 10),
            createdBy: 'synth-scenes',
            generatedFrom: { chat: CHAT, world: BOOK, msg: idx, depth: DEPTH, model: MODEL, records: records.length },
            books: { [BOOK]: byUidWorld }, bookMode: 'full',
            embedModel: MODEL, chat: CHAT,
            arms: armsOut, population: 'ranked',
        };
        mkdirSync(resolvePath(OUT_DIR), { recursive: true });
        // Written per scene as it is produced: a run killed halfway keeps every scene it finished.
        writeFileSync(`${resolvePath(OUT_DIR)}/${name}.json`, JSON.stringify(bundle));
    }
}

console.log(`\nwrote ${picks.length} bundle(s) to ${resolvePath(OUT_DIR)}`);
console.log('ungraded by construction — run graft-grades.mjs to bring prior judgements onto matching (scene, entry) pairs');
