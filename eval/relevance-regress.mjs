// What each stage-3 signal is worth as a predictor of per-entry relevance, and how a parameter moves that.
// Usage (from SillyTavern root):
//   node .../relevance-regress.mjs <sample.json> [...] [--sweep gazetteerSource=keys,titles]
//        --tier all|memory|reference [--cut 4] [--ordinal] [--loso] [--lobo] [--calibration] [--cutoff] [--at 0.10] [--degree 2] [--interactions] --features cosine,text,properNouns,density [--drop-keys flagged.json] [--emit-rows rows.json] [--emit-model relevance-model-<tier>.json] [--proper-nouns count|idf|idf-len|jaccard|gaz] [--proper-nouns-extract regex|entity|bare|span|book|named] [--density-extract entity|book]
//   --tier and --features are required. With properNouns in --features, --proper-nouns and --proper-nouns-extract are
//   required. A --sweep read with --cutoff requires --at: arms compare at one set cutoff.
import { haystackFor, indexPath, isMemory, loadScene, openSample, sceneParams, makeCandidateSet, makeGradeOf, embed, sceneLabel } from './scene.mjs';
import { ensureIndex, resolveModel } from './reindex.mjs';
import fs from 'node:fs';
import { gradeValue, gradeCredit, fbeta, RECALL_WEIGHT, signTest, arg } from './metrics.mjs';
import { PACK } from '../extension/zipf-en.js';
const COMMON_WORDS = new Set(PACK.common.split(' '));
import { logisticFit, auc, cumulativeFit, prCurve, reliability, sigmoid } from './logistic.mjs';
import * as entity from '../extension/entity.mjs';
import { properNames, properDensity, modelKey, properNounsOf, NAME_PARTICLES } from '../extension/relevance.mjs';
import { nameEvidence } from '../extension/keyword-suggest.mjs';
import { fold, normalizeOrthography } from '../extension/smartkeys.mjs';
import { tokenize } from '../extension/lexical.mjs';
import { chunkEntry } from '../extension/chunking.mjs';

const argv = process.argv.slice(2);
// Every flag that takes a value, or its .json argument is read as a sample.
const VALUED = new Set(['--arm', '--sweep', '--tier', '--cut', '--degree', '--square', '--features', '--density-extract', '--emit', '--emit-rows', '--emit-model', '--drop-keys', '--proper-nouns', '--proper-nouns-extract', '--standardise', '--beta']);
const samples = argv.filter((a, i) => a.endsWith('.json') && !a.startsWith('--') && !VALUED.has(argv[i - 1]));
if (!samples.length) {
    console.error('need at least one sample: node relevance-regress.mjs <sample.json> [more.json ...] [--sweep param=v1,v2]');
    process.exit(2);
}

const sweep = arg(argv, '--sweep');
const SWEPT = sweep ? sweep.slice(0, sweep.indexOf('=')) : 'shipped';
const valuesRaw = sweep ? sweep.slice(sweep.indexOf('=') + 1) : '';
const coerce = v => (v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : (v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v));
const VALUES = sweep ? valuesRaw.split(',').map(s => coerce(s.trim())) : [null];
// Not a sceneParams field: each arm rebuilds the collection and re-embeds the query under its own model.
const EMBED_SWEEP = SWEPT === 'embedModel';
const ORDINAL = argv.includes('--ordinal');
const LOSO = argv.includes('--loso');
const LOBO = argv.includes('--lobo');
const CUTOFF = argv.includes('--cutoff');
// Experiment: a 2 counts half on recall as well as on precision.
const HALF_RECALL = argv.includes('--half-recall');
// Experiment: fits an ungraded row as a labelled 0.
const UNGRADED_NEGATIVE = argv.includes('--ungraded-negative');
// scene | book (every scene of the book) | pooled (the scene, both tiers in the statistics; fitted rows stay --tier's).
const STD_BY = arg(argv, '--standardise') ?? 'scene';
const BETA = Number(arg(argv, '--beta') ?? RECALL_WEIGHT);
if (!Number.isFinite(BETA) || BETA <= 0) { console.error(`--beta must be a positive number, got ${arg(argv, '--beta')}`); process.exit(2); }
if (!['scene', 'book', 'pooled'].includes(STD_BY)) { console.error(`--standardise must be scene|book|pooled, got ${STD_BY}`); process.exit(2); }
// Experiment: the relevant line for the scoring bars; at 2 the cut score is P(>=2), with no half band.
const RELEVANT_AT = Number(arg(argv, '--relevant-at') ?? 3);
const creditOf = g => (RELEVANT_AT === 2 ? (g >= 2 ? 1 : 0) : gradeCredit(g));
const AT = arg(argv, '--at') === null ? null : Number(arg(argv, '--at'));
const DEGREE = Number(arg(argv, '--degree') ?? 1);
const SQUARE = String(arg(argv, '--square') ?? '').split(',').filter(Boolean);
const INTERACT = argv.includes('--interactions');
// time = story position (uid); oracle = the entry's relevance rate in its other scenes, a ceiling and not a shippable column.
const KNOWN_FEATURES = ['cosine', 'text', 'keys', 'properNouns', 'time', 'oracle', 'length', 'density', 'rarity', 'chunkdens'];
const FEATURE_LIST = String(arg(argv, '--features') ?? '').split(',').filter(Boolean);
if (!FEATURE_LIST.length) { console.error(`--features is required: a comma list of fitted columns, from ${KNOWN_FEATURES.join(',')}`); process.exit(2); }
for (const f of FEATURE_LIST) if (!KNOWN_FEATURES.includes(f)) { console.error(`--features: unknown feature "${f}" — one of ${KNOWN_FEATURES.join(',')}`); process.exit(2); }
if (new Set(FEATURE_LIST).size !== FEATURE_LIST.length) { console.error('--features names a column twice'); process.exit(2); }
const has = f => FEATURE_LIST.includes(f);
// Per-scene F2 vector with scene names: pair two runs on the names, never by index.
const EMIT = arg(argv, '--emit');
const EMIT_ROWS = arg(argv, '--emit-rows');
const EMIT_MODEL = arg(argv, '--emit-model');

if ((EMIT || EMIT_MODEL || EMIT_ROWS) && VALUES.length > 1) {
    console.error(`--emit* writes one arm, but --sweep names ${VALUES.length} (${VALUES.join(', ')}) — run them one value at a time`);
    process.exit(2);
}
// The array keyword-audit.mjs --json writes; dropped terms stay in the gazetteer (scene.mjs scoringKeys).
const DROP_KEYS = arg(argv, '--drop-keys') ? JSON.parse(fs.readFileSync(arg(argv, '--drop-keys'), 'utf8')) : null;
// count | idf: log(N/df) over the book's entries | idf-len: idf / log tokens | jaccard | gaz: count within the gazetteer.
const PROPER_MODE = arg(argv, '--proper-nouns');
// regex | entity: relevance.properNames, the shipped rule | span: maximal capitalised runs | book: nameEvidence | named: entity, sparing stoplist words the book attests.
const PROPER_EXTRACT = arg(argv, '--proper-nouns-extract');
const DENSITY_EXTRACT = arg(argv, '--density-extract');
const CALIB = argv.includes('--calibration');
if (has('properNouns') && !['count', 'idf', 'idf-len', 'jaccard', 'gaz'].includes(PROPER_MODE)) {
    console.error(`--proper-nouns is required with the properNouns feature: count|idf|idf-len|jaccard|gaz (got ${PROPER_MODE})`); process.exit(2);
}
if (has('properNouns') && !['regex', 'entity', 'bare', 'span', 'book', 'named'].includes(PROPER_EXTRACT)) {
    console.error(`--proper-nouns-extract is required with the properNouns feature: regex|entity|span|book|named (got ${PROPER_EXTRACT})`); process.exit(2);
}
if (has('density') && !['entity', 'book'].includes(DENSITY_EXTRACT)) {
    console.error(`--density-extract is required with the density feature: entity|book (got ${DENSITY_EXTRACT})`); process.exit(2);
}
if (sweep && VALUES.length > 1 && CUTOFF && AT === null) {
    console.error('--sweep with --cutoff needs --at <cutoff>: arms compare at one set cutoff, not each at its own optimum.'); process.exit(2);
}
const CUT = Number(arg(argv, '--cut') ?? 3);
if (!Number.isFinite(CUT)) { console.error(`--cut must be a number, got ${arg(argv, '--cut')}`); process.exit(2); }
const TIER = arg(argv, '--tier');
if (!['all', 'memory', 'reference'].includes(TIER)) { console.error(`--tier is required: all|memory|reference (got ${arg(argv, '--tier')})`); process.exit(2); }
if (STD_BY === 'pooled' && TIER === 'all') { console.error('--standardise pooled needs --tier memory|reference; with --tier all it is the scene design under another name'); process.exit(2); }
if (EMIT_MODEL && (CUT !== 3 || RELEVANT_AT !== 3 || HALF_RECALL
    || (has('properNouns') && (PROPER_MODE !== 'idf' || PROPER_EXTRACT !== 'entity'))
    || (has('density') && DENSITY_EXTRACT !== 'entity'))) {
    console.error('--emit-model writes the shipping artefact, so it runs at the shipped definition: --cut 3, --relevant-at 3, no --half-recall, '
        + 'and with properNouns, --proper-nouns idf --proper-nouns-extract entity. Drop --emit-model to explore another target.');
    process.exit(2);
}
if (EMIT_MODEL && !(CUTOFF && LOBO)) {
    console.error('--emit-model needs --cutoff --lobo: the cutoff is read off the held-out delivered set, and a model shipped without its operating point is not a selection rule.');
    process.exit(2);
}
const MODEL = process.env.WA_EMBED_MODEL ?? openSample(samples[0], arg(argv, '--arm')).embedModel;
if (!MODEL) { console.error(`${samples[0]} records no embedModel — set WA_EMBED_MODEL`); process.exit(2); }
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';

// One standardised column per signal and no eligibility indicators (F23).
const FEATURES = [];
const featureDef = {
    cosine: r => (Number.isFinite(r.score) ? r.score : 0),
    text: r => Number(r.textScore) || 0,
    keys: r => Number(r.keywordScore) || 0,
};
const PROPER_RE = /\b[A-Z][a-z]{2,}\b/g;
// Derived from the shipped list so the two cannot drift; the one difference is 'and'.
const PARTICLES = new Set([...NAME_PARTICLES].filter(w => w !== 'and'));
const properSpans = (text) => {
    const norm = normalizeOrthography(String(text ?? ''));
    const names = properNounsOf(norm);
    const out = new Set();
    const runs = [];
    for (const sentence of norm.split(/(?<=[.!?])\s+|\n+/)) {
        let run = [];
        const flush = () => {
            while (run.length && PARTICLES.has(run[run.length - 1])) run.pop();
            if (run.length) runs.push([...run]);
            run = [];
        };
        for (const tok of sentence.trim().split(/[^\p{L}\p{N}\p{M}']+/u)) {
            const lw = tok.toLowerCase();
            // names: used as a name somewhere in this text; the capital: this occurrence is the name.
            if (/^\p{Lu}/u.test(tok) && names.has(lw)) { run.push(lw); continue; }
            if (run.length && PARTICLES.has(lw)) { run.push(lw); continue; }
            flush();
        }
        flush();
    }
    // A component is a name only where the text also uses it alone: "Maren's Gap" yields maren's, not gap.
    const solo = new Set(runs.filter(r => r.length === 1).map(r => r[0]));
    for (const r of runs) {
        out.add(r.join(' '));
        if (r.length > 1) for (const t of r) if (solo.has(t)) out.add(t);
    }
    for (const w of [...out]) if (!w.includes(' ') && COMMON_WORDS.has(w)) out.delete(w);
    return out;
};
const makeExtract = (mode, entries) => {
    if (mode !== 'book' && mode !== 'named') return text => properNouns(text, mode);
    const ev = nameEvidence();
    for (const e of entries ?? []) if (typeof e?.content === 'string') ev.wordSeq(normalizeOrthography(e.content));
    if (mode === 'named') return text => {
        const out = properNounsOf(normalizeOrthography(String(text ?? '')));
        for (const w of [...out]) if (COMMON_WORDS.has(w) && !ev.isName(ev.fold(w))) out.delete(w);
        return out;
    };
    return text => {
        const out = new Set();
        for (const m of normalizeOrthography(String(text ?? '')).match(/[\p{L}][\p{L}'’-]*/gu) ?? []) {
            if (!/^\p{Lu}/u.test(m)) continue;
            const w = ev.fold(m).toLowerCase();
            if (w.length > 1 && ev.isName(w)) out.add(w);
        }
        return out;
    };
};
const properNouns = (text, mode = PROPER_EXTRACT) => {
    // The shipped function itself, so the fit and the runtime cannot drift on what a name is.
    if (mode === 'entity') return properNames(text);
    // No stoplist at all: the density extractor's function, so the column is what properNames would be without COMMON_WORDS.
    if (mode === 'bare') return properNounsOf(normalizeOrthography(String(text ?? '')));
    if (mode === 'span') return properSpans(text);
    const out = new Set();
    for (const m of String(text ?? '').match(PROPER_RE) ?? []) {
        const w = m.toLowerCase();
        if (!COMMON_WORDS.has(w)) out.add(w);
    }
    return out;
};

// Story position: STMB appends, so uid order is story order. Never entry.order, ST's insertion priority.
const storyTime = r => Number(r.entry?.uid ?? 0);

featureDef.properNouns = r => Number(r.properShared) || 0;
featureDef.time = storyTime;
featureDef.oracle = r => Number(r.entryBase) || 0;
featureDef.length = r => Math.log(Math.max(1, Number(r.entryTokens) || 0));
featureDef.density = r => Number(r.properDensity) || 0;
featureDef.rarity = r => Number(r.bookRarity) || 0;
featureDef.chunkdens = r => Number(r.chunkDensity) || 0;
for (const f of FEATURE_LIST) FEATURES.push([f, featureDef[f]]);


const SQUARED = DEGREE < 2 ? []
    : FEATURES.map((f, i) => i).filter(i => !SQUARE.length || SQUARE.includes(FEATURES[i][0]));
const PAIRS = INTERACT
    ? FEATURES.flatMap((_, i) => FEATURES.map((__, j) => [i, j]).filter(([a, b]) => a < b))
    : [];

// Share of the pooled ranking a cut on the signal's low tail drops before losing any relevant row, and before losing 5%.
// Tie-aware: a threshold cuts on a value, and an entry-level prior ties a whole block at 0.
const tailCut = (s, labels) => {
    const order = s.map((v, i) => [v, labels[i]]).sort((a, b) => a[0] - b[0]);
    const pos = order.reduce((a, [, l]) => a + (l ? 1 : 0), 0);
    if (!pos) return { at100: NaN, at95: NaN };
    let below = 0, lost = 0, at100 = NaN, at95 = NaN, i = 0;
    while (i < order.length) {
        let j = i;
        while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
        const groupPos = order.slice(i, j + 1).reduce((a, [, l]) => a + (l ? 1 : 0), 0);
        // below is recorded before the group is counted: dropping the group costs its own positives.
        if (groupPos && Number.isNaN(at100)) at100 = below / order.length;
        if (Number.isNaN(at95) && (lost + groupPos) / pos > 0.05) at95 = below / order.length;
        below = j + 1; lost += groupPos; i = j + 1;
    }
    return { at100: Number.isNaN(at100) ? 0 : at100, at95: Number.isNaN(at95) ? 1 : at95 };
};

const PRIORS = ['length', 'density', 'rarity', 'chunkdens'];
// The shipped chunking (reindex.mjs chunkConfig).
const CHUNK_CFG = { chunkMode: 'paragraph', chunkSize: 800, minChunkSize: 120 };
const bookTf = new Map();
// Entry contents per book, for the --lobo lineage guard.
const bookContents = new Map();

const mean = xs => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };
const fx = n => (Number.isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(3) : '  n/a');

// Query embedding per (scene, arm).
const QV = new Map();
const queryVec = async (S, name, value, em) => {
    // The scene is in the key, or an embedModel sweep hands every scene the first scene's vector.
    const k = `${name}\u001f${value}\u001f${S.query}`;
    // label, not model: the disk cache is keyed by label, and two stems can serve one model id.
    if (!QV.has(k)) QV.set(k, await embed(em.query + S.query, { model: em.model, label: em.label, endpoint: em.endpoint, url: em.endpoint === 'ollama' ? OLLAMA : em.url }));
    return QV.get(k);
};

(async () => {
    const loaded = [];
    for (const path of samples) {
        const S = openSample(path, arg(argv, '--arm'));
        if (!S.candidates?.length) { console.error(`${path}: logs no candidates`); process.exit(2); }
        // Through resolveModel: a raw spec drops the task prefix and scores the model worse, silently.
        const qv = await queryVec(S, 'baseline', MODEL, resolveModel(MODEL));
        loaded.push({ path, name: sceneLabel(S) || path, book: S.primaryBook ?? path, S, qv });
    }
    console.log(`${loaded.length} scene(s); ${sweep ? `sweeping ${SWEPT} over ${VALUES.join(', ')}` : 'shipped configuration'}${TIER === 'all' ? '' : `; ${TIER} tier only`}${CUT === 3 ? '' : `; target grade >= ${CUT}`}`);

    const table = [];
    for (const value of VALUES) {
        const perScene = [];
        let dropped = 0;
        for (const { S, qv, name, book } of loaded) {
            const P = sceneParams(S, { ...(sweep ? { [SWEPT]: value } : {}), ...(DROP_KEYS ? { dropKeys: DROP_KEYS } : {}) });
            // denseAllEntries needs a collection covering every entry, or it reports a null result that reads like an answer.
            const em = resolveModel(EMBED_SWEEP ? value : MODEL);
            const indexFile = P.denseAllEntries || EMBED_SWEEP
                ? (await ensureIndex(S, { all: !!P.denseAllEntries, model: em.model, label: em.label, endpoint: em.endpoint, url: em.endpoint === 'ollama' ? OLLAMA : em.url, log: () => {} })).path
                // The label names the file, not the spec (omlx-… vs omlx:…).
                : indexPath(S, { model: em.label });
            // The query must be embedded by the collection's own model; a stale qv returns plausible cosines.
            const qvec = EMBED_SWEEP ? await queryVec(S, name, value, em) : qv;
            const scene = loadScene(S, { indexFile, indexOpts: { model: em.label }, params: P });
            // This book's entries only: the lineage guard measures share of the smaller book.
            if (!bookContents.has(book)) {
                bookContents.set(book, new Set((scene.entries ?? [])
                    .filter(e => e.world === book && typeof e.content === 'string' && e.content.trim())
                    .map(e => e.content.trim())));
            }
            const tw = P.entityFilter ? entity.buildTermWeights(S.query, scene.gaz, P.boost) : null;
            const haystack = haystackFor(S, P);
            const rows = makeCandidateSet({ ...scene, params: P })(P.K1, P.B, tw, qvec, S.query, haystack);
            const xMode = P.detector ?? P.properNounsExtract ?? PROPER_EXTRACT;
            const dMode = P.detector ?? P.densityExtract ?? DENSITY_EXTRACT;
            const bookX = (xMode === 'book' || dMode === 'book') ? makeExtract('book', scene.entries) : null;
            if (has('properNouns')) {
                const extract = xMode === 'book' ? bookX : makeExtract(xMode, scene.entries);
                const win = extract(haystack({}).join('\n'));
                const df = new Map();
                let ndoc = 0;
                if (PROPER_MODE === 'idf' || PROPER_MODE === 'idf-len') {
                    // Disabled entries are documents here (F27); contentless ones are not, or ndoc inflates every idf.
                    for (const e of scene.entries ?? []) {
                        if (typeof e.content !== 'string' || !e.content.trim()) continue;
                        ndoc++;
                        for (const w of extract(e.content)) df.set(w, (df.get(w) ?? 0) + 1);
                    }
                }
                for (const r of rows) {
                    const ents = extract(r.entry?.content);
                    let v = 0;
                    if (PROPER_MODE === 'jaccard') {
                        let inter = 0;
                        for (const w of ents) if (win.has(w)) inter++;
                        const union = ents.size + win.size - inter;
                        v = union ? inter / union : 0;
                    } else if (PROPER_MODE === 'idf') {
                        for (const w of ents) if (win.has(w)) v += Math.log((ndoc + 1) / ((df.get(w) ?? 0) + 1));
                    } else if (PROPER_MODE === 'idf-len') {
                        let idf = 0;
                        for (const w of ents) if (win.has(w)) idf += Math.log((ndoc + 1) / ((df.get(w) ?? 0) + 1));
                        v = idf / Math.log(Math.max(2, tokenize(r.entry?.content).length));
                    } else if (PROPER_MODE === 'gaz') {
                        // The gazetteer holds folded tokens, so fold before testing membership.
                        for (const w of ents) if (win.has(w) && scene.gaz?.has(fold(w))) v++;
                    } else {
                        for (const w of ents) if (win.has(w)) v++;
                    }
                    r.properShared = v;
                }
            }
            // Keyed by the row's own book, not the scene's primary: a scene ranks every attached book.
            if (PRIORS.some(has)) {
                const tfFor = (bookName) => {
                    let bk = bookTf.get(bookName);
                    if (bk) return bk;
                    const tf = new Map();
                    let total = 0;
                    // Same corpus as the df map: disabled entries in, contentless ones out.
                    for (const e of scene.entries ?? []) {
                        if (e.world !== bookName || typeof e.content !== 'string' || !e.content.trim()) continue;
                        for (const t of tokenize(e.content)) { tf.set(t, (tf.get(t) ?? 0) + 1); total++; }
                    }
                    // Floors at 1: an entry outside scene.entries can carry a term the book's tf never saw.
                    bk = { rarity: t => -Math.log10((tf.get(t) ?? 1) / Math.max(1, total)) };
                    bookTf.set(bookName, bk);
                    return bk;
                };
                for (const r of rows) {
                    const bk = tfFor(r.entry?.world ?? book);
                    const toks = tokenize(r.entry?.content);
                    r.entryTokens = toks.length;
                    const names = properNounsOf(normalizeOrthography(String(r.entry?.content ?? '')));
                    r.properDensity = dMode === 'book'
                        ? (bookX(String(r.entry?.content ?? '')).size / Math.max(1, toks.length)) * 100
                        : properDensity(String(r.entry?.content ?? ''));
                    // reindex.chunkConfig's values, not the scene params: an undefined chunkSize recurses until the stack blows.
                    r.chunkDensity = (names?.size ?? 0) / Math.max(1, chunkEntry(String(r.entry?.content ?? ''), CHUNK_CFG).length);
                    r.bookRarity = toks.length ? toks.reduce((a, t) => a + bk.rarity(t), 0) / toks.length : 0;
                }
            }
            const gradeOf = makeGradeOf(S.entries, scene);
            const kept = [], ungraded = [], offTier = [];
            for (const r of rows.filter(r => !r.entry?.constant)) {
                // Kept, not dropped: under --standardise pooled the other tier is part of the statistics.
                if (TIER !== 'all' && (isMemory(r.entry) ? 'memory' : 'reference') !== TIER) { offTier.push(r); continue; }
                const g = gradeOf(r);
                // Ungraded rows leave the fit but stay in the bar sweep as 0s, the ?? 0 convention scene.mjs uses.
                if (g === null || g === undefined || Number.isNaN(g)) {
                    dropped++;
                    // Moves to kept rather than also staying in ungraded, or the cutoff sweep counts it twice.
                    if (UNGRADED_NEGATIVE) kept.push({ r, y: 0, g: 0, wasUngraded: true });
                    else ungraded.push({ r, g: 0 });
                    continue;
                }
                kept.push({ r, y: g >= CUT ? 1 : 0, g });
            }
            // A row floor only, no both-classes test: the fit pools scenes behind one intercept.
            if (kept.length >= 5) perScene.push({ name, book, kept, ungraded, offTier, query: String(S.query ?? '').slice(-4000) });
        }
        if (!perScene.length) { console.log(`  ${SWEPT}=${value}: no scene has both classes among its judged rows`); continue; }

        // Leave-one-scene-out within the entry; --lobo does not protect this column, so its held-out number is a bound.
        if (has('oracle')) {
            const tally = new Map();
            const idOf = r => `${r.entry?.world ?? ''}${r.entry?.uid ?? ''}`;
            for (const { kept } of perScene) for (const k of kept) {
                const t = tally.get(idOf(k.r)) ?? { n: 0, pos: 0 };
                t.n++; t.pos += k.y; tally.set(idOf(k.r), t);
            }
            const pooled = perScene.reduce((a, p) => a + p.kept.reduce((b, k) => b + k.y, 0), 0)
                / perScene.reduce((a, p) => a + p.kept.length, 0);
            let imputed = 0;
            for (const { kept, ungraded } of perScene) {
                for (const k of kept) {
                    const t = tally.get(idOf(k.r));
                    if (t.n > 1) k.r.entryBase = (t.pos - k.y) / (t.n - 1);
                    else { k.r.entryBase = pooled; imputed++; }
                }
                // No self to leave out for an ungraded row.
                for (const u of ungraded) {
                    const t = tally.get(idOf(u.r));
                    u.r.entryBase = t ? t.pos / t.n : pooled;
                }
            }
            console.log(`  oracle: ${tally.size} distinct entries, pooled base ${pooled.toFixed(3)}, ${imputed} single-scene rows imputed`);
        }

        // Statistics over every candidate, rows from the graded only: scoreRelevance centres over every activated row (F43).
        const X = [], y = [], rawCols = FEATURES.map(() => []), stats = FEATURES.map(() => ({ sd: [], mean: [] }));
        const perSignal = FEATURES.map(() => ({ s: [], y: [] }));
        const sceneCols = [];
        const bookPopulation = new Map();
        if (STD_BY === 'book') {
            for (const { kept, ungraded, book } of perScene) {
                if (!bookPopulation.has(book)) bookPopulation.set(book, []);
                bookPopulation.get(book).push(...kept.map(k => k.r), ...ungraded.map(u => u.r));
            }
        }
        const bookCols = new Map();
        for (const [b, rows] of bookPopulation) bookCols.set(b, FEATURES.map(([, get]) => rows.map(get)));

        for (const [si, { kept, ungraded, offTier, book }] of perScene.entries()) {
            const population = [...kept.map(k => k.r), ...ungraded.map(u => u.r),
                ...(STD_BY === 'pooled' ? offTier : [])];
            const statCols = STD_BY === 'book' ? bookCols.get(book) : FEATURES.map(([, get]) => population.map(get));
            const cols = FEATURES.map(([, get]) => kept.map(k => get(k.r)));
            sceneCols[si] = statCols;
            statCols.forEach((c, fi) => { stats[fi].sd.push(sd(c)); stats[fi].mean.push(mean(c)); });
            kept.forEach((k, i) => {
                const scene = [1];
                const feats = [];
                cols.forEach((c, fi) => {
                    const s = sd(statCols[fi]) || 1;   // a signal constant within a scene carries no information there; 1 keeps it finite and its column stays flat
                    feats.push((c[i] - mean(statCols[fi])) / s);
                    rawCols[fi].push(c[i]);
                    perSignal[fi].s.push(c[i]);
                    perSignal[fi].y.push(k.y);
                });
                // Degree 2 appends, never interleaves: every readout indexes a linear coefficient as base + fi.
                const sq = [...SQUARED.map(fi => feats[fi] ** 2),
                    ...PAIRS.map(([a, b]) => feats[a] * feats[b])];
                X.push([...scene, ...feats, ...sq]);
                y.push(k.y);
            });
        }
        const grades = perScene.flatMap(({ kept }) => kept.map(k => k.g));
        const stdFit = logisticFit(X, y);

        const sceneOf = perScene.flatMap(({ kept }, si) => kept.map(() => si));
        const etaOf = (fit, rows) => rows.map(row => row.reduce((a, x, j) => a + x * fit.beta[j], 0));
        const holdOut = (groupOf, nGroups, labels = y) => {
            const held = Array(labels.length).fill(NaN);
            const betas = Array(nGroups).fill(null);
            for (let g = 0; g < nGroups; g++) {
                const tr = [], trY = [];
                X.forEach((row, i) => { if (groupOf(i) !== g) { tr.push(row); trY.push(labels[i]); } });
                if (!trY.some(v => v) || trY.every(v => v)) continue;
                const f = logisticFit(tr, trY);
                betas[g] = f.beta;
                X.forEach((row, i) => { if (groupOf(i) === g) held[i] = row.reduce((a, x, j) => a + x * f.beta[j], 0); });
            }
            const keep = held.map((v, i) => [v, labels[i]]).filter(([v]) => Number.isFinite(v));
            // betas lets an ungraded row be scored by the fold that did not train on its book.
            return {
                eta: keep.map(k => k[0]), y: keep.map(k => k[1]), betas,
                fold: held.map((v, i) => [v, i]).filter(([v]) => Number.isFinite(v)).map(([, i]) => groupOf(i)),
            };
        };
        const books = [...new Set(perScene.map(p => p.book))];
        if (LOBO && books.length < 2) {
            console.error(`--lobo needs at least 2 books; these ${perScene.length} scene(s) are all "${books[0]}". `
                + `Every held-out readout would be NaN and --cutoff would print a zero. `
                + `Run the full corpus and read the per-book fold, or use --loso.`);
            process.exit(2);
        }
        // Share of the smaller book; 30% is the lineage bar (C11).
        if (LOBO && books.length > 1) {
            for (let i = 0; i < books.length; i++) {
                for (let j = i + 1; j < books.length; j++) {
                    const a = bookContents.get(books[i]) ?? new Set(), b = bookContents.get(books[j]) ?? new Set();
                    if (!a.size || !b.size) continue;
                    let shared = 0;
                    for (const c of a) if (b.has(c)) shared++;
                    const pct = shared / Math.min(a.size, b.size);
                    if (pct < 0.30) continue;
                    console.error(`--lobo folds by book name, but "${books[i]}" (${a.size} entries) and "${books[j]}" (${b.size}) `
                        + `share ${shared} identical entries — ${(100 * pct).toFixed(0)}% of the smaller. `
                        + `They are one lineage, so each fold would train on its own book under the other name. `
                        + `Drop one from the sample set.`);
                    process.exit(2);
                }
            }
        }
        const bookOf = perScene.flatMap(({ kept, book }) => kept.map(() => books.indexOf(book)));
        const loso = LOSO ? holdOut(i => sceneOf[i], perScene.length) : null;
        const lobo = LOBO ? holdOut(i => bookOf[i], books.length) : null;
        if (LOBO) {
            console.log(`\n  held out by book: ${books.length} folds — ${books.map(b => `${String(b).split(/[ _]/).slice(-1)[0].slice(0, 10)} ${bookOf.filter(x => x === books.indexOf(b)).length}`).join(', ')} rows`);
        }
        const Xraw = X.map((row, i) => {
            const out = row.slice(0, 1);
            FEATURES.forEach((_, fi) => out.push(rawCols[fi][i]));
            // Same terms as the standardised fit, or the per-unit column is read off a design never fitted.
            [...SQUARED, ...PAIRS].forEach((_, si) => out.push(row[1 + FEATURES.length + si]));
            return out;
        });
        const rawFit = logisticFit(Xraw, y);
        const base = 1;
        table.push({
            value, scenes: perScene.length, n: y.length, pos: y.reduce((a, b) => a + b, 0), dropped,
            stdBeta: stdFit.beta, nRows: y.length,
            rows: FEATURES.map(([name], fi) => ({
                name,
                std: stdFit.beta[base + fi], stdSe: stdFit.se[base + fi],
                raw: rawFit.beta[base + fi],
                sd: mean(stats[fi].sd),
                auc: auc(perSignal[fi].s, perSignal[fi].y),
                cut: tailCut(perSignal[fi].s, perSignal[fi].y),
            })),
            logLoss: stdFit.logLoss, converged: stdFit.converged,
            sq: [...SQUARED, ...PAIRS].map((_, si) => stdFit.beta[1 + FEATURES.length + si]),
            sqSe: [...SQUARED, ...PAIRS].map((_, si) => stdFit.se[1 + FEATURES.length + si]),
            auc: auc(X.map((row, i) => row.reduce((s, x, j) => s + x * stdFit.beta[j], 0)), y),
            ordinal: ORDINAL ? cumulativeFit(X, grades, [1, 2, 3, 4]) : null,
            base,
            fits: {
                'in-sample': { eta: etaOf(stdFit, X), y },
                ...(loso ? { 'held out by scene': loso } : {}),
                ...(lobo ? { 'held out by BOOK': lobo } : {}),
            },
            books,
            cutoff: CUTOFF && LOBO ? (() => {
                const labelsAt = c => grades.map(g => (g >= c ? 1 : 0));
                const cuts = [2, 3].map(c => holdOut(i => bookOf[i], books.length, labelsAt(c)).betas);
                // pooled is what --emit-model ships; the grid scores each row through the fold that did not train on its book.
                const pooled = [2, 3].map(c => logisticFit(X, labelsAt(c)).beta);
                // min(p3, p2) is not optional: the boundaries are fitted separately and rows genuinely invert (F31).
                const scoreRow = (design, fold) => {
                    const eta = b => (b ? design.reduce((a, x, j) => a + x * b[j], 0) : NaN);
                    const p2 = sigmoid(eta(cuts[0][fold])), p3 = sigmoid(eta(cuts[1][fold]));
                    return RELEVANT_AT === 2 ? p2
                        : Number.isFinite(p2) && Number.isFinite(p3) ? 0.5 * p2 + 0.5 * Math.min(p3, p2) : NaN;
                };
                let gi = 0;
                const scenes = perScene.map(({ kept, ungraded, name, query }, si) => {
                    const fold = bookOf[gi];
                    const idOf = r => ({ uid: r.entry?.uid, title: r.entry?.comment || r.entry?.title || `uid ${r.entry?.uid}`,
                        feats: Object.fromEntries(FEATURES.map(([n, get]) => [n, get(r)])) });
                    const rows = kept.map(k => ({ e: scoreRow(X[gi++], fold), g: k.g, ...idOf(k.r) }));
                    for (const u of ungraded) {
                        const design = [1];
                        sceneCols[si].forEach((c, fi) => {
                            design.push((FEATURES[fi][1](u.r) - mean(c)) / (sd(c) || 1));
                        });
                        rows.push({ e: scoreRow(design, fold), g: 0, ungraded: true, ...idOf(u.r) });
                    }
                    return { name, query, book: books[fold], rows: rows.filter(r => Number.isFinite(r.e)),
                        relevant: HALF_RECALL ? kept.reduce((a, k) => a + creditOf(k.g), 0) : kept.filter(k => k.g >= RELEVANT_AT).length };
                }).filter(sc => sc.relevant > 0);
                const grid = Array.from({ length: 99 }, (_, i) => (i + 1) / 100);
                return {
                    scenes: scenes.length,
                    pooled,
                    sceneNames: scenes.map(sc => sc.name),
                    sceneBooks: scenes.map(sc => sc.book),
                    sceneRows: scenes,
                    meanRelevant: mean(scenes.map(sc => sc.relevant)),
                    grid: grid.map(cut => {
                        const per = scenes.map(sc => {
                            const got = sc.rows.filter(r => r.e >= cut);
                            const precision = got.length ? mean(got.map(r => creditOf(r.g))) : 0;
                            const recall = (HALF_RECALL ? got.reduce((a, r) => a + creditOf(r.g), 0) : got.filter(r => r.g >= RELEVANT_AT).length) / sc.relevant;
                            return { f: fbeta(precision, recall, BETA), precision, recall, n: got.length };
                        });
                        return {
                            cut, f: mean(per.map(x => x.f)), precision: mean(per.map(x => x.precision)),
                            recall: mean(per.map(x => x.recall)), delivered: mean(per.map(x => x.n)),
                            perScene: per.map(x => x.f),
                        };
                    }),
                };
            })() : null,
            calib: CALIB ? [2, 3].map(cut => {
                const yc = grades.map(g => (g >= cut ? 1 : 0));
                if (!yc.some(v => v) || yc.every(v => v)) return { cut, rows: [] };
                const inSample = logisticFit(X, yc);
                const rows = [['in-sample', { eta: etaOf(inSample, X), y: yc }]];
                if (LOBO) rows.push(['held out by BOOK', holdOut(i => bookOf[i], books.length, yc)]);
                return { cut, rows };
            }) : null,
        });
    }

    console.log(`\nlogistic fit of P(grade>=${CUT}), signals standardised within ${STD_BY === 'scene' ? 'scene' : STD_BY === 'book' ? 'book' : 'scene, pooling both tiers'}`);
    console.log(`  ${SWEPT.padEnd(14)} signal | std beta (SE)   raw beta   mean within-scene SD   solo AUC   droppable @100%/95% recall`);
    for (const t of table) {
        for (const [i, r] of t.rows.entries()) {
            const head = i === 0 ? String(t.value).padEnd(14) : ' '.repeat(14);
            const pc = v => (Number.isFinite(v) ? `${(100 * v).toFixed(1)}%` : 'n/a');
            console.log(`  ${head} ${r.name.padEnd(6)} | ${fx(r.std)} (${r.stdSe.toFixed(3)})  ${fx(r.raw).padStart(9)}   ${r.sd.toFixed(4).padStart(20)}   ${r.auc.toFixed(3).padStart(8)}   ${`${pc(r.cut.at100)} / ${pc(r.cut.at95)}`.padStart(25)}`);
        }
        const extraNames = [...SQUARED.map(fi => `${FEATURES[fi][0]}^2`),
            ...PAIRS.map(([a, b]) => `${FEATURES[a][0]}*${FEATURES[b][0]}`)];
        for (const [si, name] of extraNames.entries()) {
            console.log(`  ${' '.repeat(14)} ${name.padEnd(11)} | ${fx(t.sq[si])} (${t.sqSe[si].toFixed(3)})`);
        }
        console.log(`  ${' '.repeat(14)} model  | AUC ${t.auc.toFixed(4)}  log-loss ${t.logLoss.toFixed(4)}  n ${t.n} rows (${t.pos} relevant) over ${t.scenes} scenes, ${t.dropped} ungraded dropped${t.converged ? '' : '  !! DID NOT CONVERGE'}`);
    }

    if (ORDINAL) {
        console.log('\nordinal: P(grade >= k) fitted at every boundary, same design matrix, slopes free');
        for (const t of table) {
            console.log(`  ${SWEPT}=${t.value}`);
            console.log('    cut |  n>=k |  cosine     text      keys   | model AUC  log-loss');
            for (const o of t.ordinal) {
                if (!o.fit) { console.log(`    >=${o.cut} | ${String(o.pos).padStart(5)} | not fitted — one class absent at this boundary`); continue; }
                const b = i => o.fit.beta[t.base + i * 2];
                console.log(`    >=${o.cut} | ${String(o.pos).padStart(5)} | ${fx(b(0))}   ${fx(b(1))}   ${fx(b(2))}   |   ${o.auc.toFixed(4)}    ${o.fit.logLoss.toFixed(4)}${o.fit.converged ? '' : '  !! DID NOT CONVERGE'}`);
            }
        }
    }

    console.log(`\noperational readout of P(grade>=${CUT}): average precision, and precision at recall`);
    console.log(`  ${SWEPT.padEnd(14)} scored on            | prevalence   AUC     AP   | P@R50   P@R75   P@R90`);
    for (const t of table) {
        for (const [i, [label, f]] of Object.entries(t.fits).entries()) {
            const m = prCurve(f.eta, f.y);
            const cell = R => (m.at[R] ? `${(100 * m.at[R].precision).toFixed(1)}%`.padStart(6) : '     -');
            const head = i === 0 ? String(t.value).padEnd(14) : ' '.repeat(14);
            console.log(`  ${head} ${label.padEnd(21)} | ${`${(100 * m.pos / m.n).toFixed(2)}%`.padStart(9)}  ${auc(f.eta, f.y).toFixed(4)}  ${m.ap.toFixed(3)} | ${cell(0.5)}  ${cell(0.75)}  ${cell(0.9)}`);
        }
    }
    if (LOBO) {
        console.log(`\nheld out by BOOK, one row per fold — the fit trained on every OTHER book`);
        console.log(`  ${SWEPT.padEnd(14)} book                             |     n   pos   prevalence   AUC     AP`);
        for (const t of table) {
            const f = t.fits['held out by BOOK'];
            if (!f?.fold) continue;
            for (const [bi, book] of t.books.entries()) {
                const idx = f.fold.map((g, i) => (g === bi ? i : -1)).filter(i => i >= 0);
                if (!idx.length) continue;
                const eta = idx.map(i => f.eta[i]), yy = idx.map(i => f.y[i]);
                const pos = yy.reduce((a, b) => a + b, 0);
                const m = prCurve(eta, yy);
                const name = String(book).replace(/[_]+/g, ' ').slice(0, 32);
                console.log(`  ${String(t.value).padEnd(14)} ${name.padEnd(32)} | ${String(yy.length).padStart(5)} ${String(pos).padStart(5)}   ${`${(100 * pos / yy.length).toFixed(2)}%`.padStart(9)}  ${Number.isFinite(auc(eta, yy)) ? auc(eta, yy).toFixed(4) : '   -  '}  ${Number.isFinite(m.ap) ? m.ap.toFixed(3) : '  -  '}`);
            }
        }
    }

    if (!LOSO || !LOBO) console.log('  (--loso holds out a scene, --lobo a book; only the second is the generalisation production needs)');

    if (CUTOFF) {
        if (!LOBO) console.log('\n--cutoff needs --lobo: a cutoff chosen on in-sample probabilities is chosen on rows the fit has seen.');
        else for (const t of table) {
            const b = t.cutoff;
            if (!b) continue;
            const best = AT === null ? b.grid.reduce((a, x) => (x.f > a.f ? x : a))
                : b.grid.reduce((a, x) => (Math.abs(x.cut - AT) < Math.abs(a.cut - AT) ? x : a));
            console.log(`\nthe cutoff: F2 over the delivered set, macro-averaged over ${b.scenes} scenes (mean ${b.meanRelevant.toFixed(1)} relevant each)`);
            console.log(`  ${SWEPT}=${t.value}`);
            console.log('    E[credit] >= |     F2   precision   recall   delivered');
            for (const g of b.grid) {
                if (Math.round(g.cut * 100) % 5 && g !== best) continue;
                console.log(`    ${g.cut.toFixed(2).padStart(11)} | ${g.f.toFixed(4)}     ${(100 * g.precision).toFixed(1).padStart(5)}%   ${(100 * g.recall).toFixed(1).padStart(5)}%   ${g.delivered.toFixed(1).padStart(9)}${g === best ? '   <- best' : ''}`);
            }
            console.log(`  best cutoff ${best.cut.toFixed(2)}: F2 ${best.f.toFixed(4)}, delivering ${best.delivered.toFixed(1)} entries against ${b.meanRelevant.toFixed(1)} relevant.`);
            t.best = best;
            // The pooled fit, never a fold's betas; `layout` is the column contract and the consumer standardises within scene as the fit did.
            if (EMIT_MODEL) {
                const fit = {
                    tier: TIER, standardise: STD_BY, cutoff: best.cut, f2: best.f,
                    target: 'E[credit] = 0.5*P(>=2) + 0.5*min(P(>=3), P(>=2))',
                    features: FEATURES.map(([n]) => n),
                    properNounsMode: PROPER_MODE, properNounsExtract: PROPER_EXTRACT,
                    layout: ['intercept', ...FEATURES.map(([n]) => `${n}.z`)],
                    beta: { ge2: Array.from(b.pooled[0] ?? []), ge3: Array.from(b.pooled[1] ?? []) },
                    aucAt: 3,
                    auc: t.auc ?? null,
                    heldOutAuc: t.fits?.['held out by BOOK']
                        ? auc(t.fits['held out by BOOK'].eta, t.fits['held out by BOOK'].y) : null,
                    // Counts, never names: the file is checked in and the corpus is one person's chats.
                    fittedOn: {
                        scenes: b.scenes, rows: t.nRows ?? null,
                        books: Array.isArray(t.books) ? t.books.length : (Number(t.books) || null),
                    },
                };
                // Merged into byModel, never over it: one fit per embedding model.
                const key = modelKey(resolveModel(MODEL).model);
                let file = { schema: 2, tier: TIER, byModel: {} };
                try { const prev = JSON.parse(fs.readFileSync(EMIT_MODEL, 'utf8')); if (prev?.byModel) file = prev; } catch { /* first write */ }
                const had = Object.keys(file.byModel);
                file.tier = TIER;
                file.byModel[key] = { ...fit, embedModel: resolveModel(MODEL).label };
                fs.writeFileSync(EMIT_MODEL, JSON.stringify(file, null, 1));
                console.log(`  ${had.includes(key) ? 'replaced' : 'added'} the "${key}" fit in ${EMIT_MODEL}`
                    + ` (now: ${Object.keys(file.byModel).join(', ')})`);
            }
            if (EMIT_ROWS) {
                fs.writeFileSync(EMIT_ROWS, JSON.stringify({
                    swept: SWEPT, value: t.value, tier: TIER, features: FEATURE_LIST,
                    interactions: INTERACT, properNounsMode: PROPER_MODE, properNounsExtract: PROPER_EXTRACT,
                    cut: best.cut, f2: best.f,
                    features: FEATURES.map(([n]) => n),
                    scenes: b.sceneRows.map(sc => ({
                        name: sc.name, relevant: sc.relevant, query: sc.query,
                        rows: sc.rows.map(r => ({ uid: r.uid, title: r.title, g: r.g, ungraded: !!r.ungraded,
                            e: Number(r.e.toFixed(4)), delivered: r.e >= best.cut, feats: r.feats })),
                    })),
                }, null, 1));
                console.log(`  per-row delivery written to ${EMIT_ROWS}`);
            }
            if (EMIT) {
                fs.writeFileSync(EMIT, JSON.stringify({
                    swept: SWEPT, value: t.value, tier: TIER, features: FEATURE_LIST, interactions: INTERACT, properNounsMode: PROPER_MODE, properNounsExtract: PROPER_EXTRACT,
                    cut: best.cut, f2: best.f, scenes: b.sceneNames, perScene: best.perScene,
                    grid: b.grid.map(g => ({ cut: g.cut, f2: g.f, precision: g.precision, recall: g.recall, delivered: g.delivered })),
                }, null, 1));
                console.log(`  per-scene F2 written to ${EMIT}`);
            }
        }
        const bases = table.filter(t => t.best);
        if (bases.length > 1) {
            const b0 = bases[0];
            console.log(`\npaired against ${SWEPT}=${b0.value}, every arm at the ${AT} cutoff — per-scene F2, sign test`);
            // Per book too: scenes on one book are nearer one observation than many (CLAUDE.md, Graded scenes).
            const bk = b0.cutoff?.sceneBooks ?? [];
            const bookNames = [...new Set(bk)];
            for (const t of bases.slice(1)) {
                const d = t.best.perScene.map((f, i) => f - b0.best.perScene[i]);
                const st = signTest(d);
                console.log(`  ${String(t.value).padEnd(22)} | mean ${(st.mean >= 0 ? '+' : '') + st.mean.toFixed(4)}  ${st.plus} up / ${st.minus} down / ${st.ties} tied  p ${st.p.toFixed(3)}`);
                if (bk.length !== d.length || bookNames.length < 2) continue;
                const perBook = bookNames.map(n => mean(d.filter((_, i) => bk[i] === n)));
                const sb = signTest(perBook);
                console.log(`      per book: ${bookNames.map((n, i) => `${n} ${fx(perBook[i])}`).join('   ')}`);
                console.log(`      across books: ${sb.plus} up / ${sb.minus} down of ${bookNames.length}, mean ${fx(sb.mean)}, p ${sb.p.toFixed(3)} — the honest n for a corpus-level change`);
            }
        }
    }

    if (CALIB) {
        console.log('\nreliability of P(grade >= k), quantile bins — ECE is the n-weighted mean gap, MCE the worst bin');
        for (const t of table) {
            for (const c of t.calib ?? []) {
                if (!c.rows.length) { console.log(`  ${SWEPT}=${t.value}  >=${c.cut} | not fitted — one class absent at this boundary`); continue; }
                for (const [label, f] of c.rows) {
                    const r = reliability(f.eta.map(sigmoid), f.y, { nullSamples: 500, seed: 1 });
                    console.log(`  ${SWEPT}=${t.value}  >=${c.cut}  ${label.padEnd(18)} | ECE ${r.ece.toFixed(4)} (null ${r.eceNull.toFixed(4)}, p ${r.eceP.toFixed(3)})  MCE ${r.mce.toFixed(4)}  mean p ${r.meanP.toFixed(4)} vs observed ${r.observed.toFixed(4)}  n ${r.n}`);
                    console.log(`      bin |     n | p range         | mean p | observed |    gap`);
                    for (const b of r.bins) {
                        const gap = b.observed - b.meanP;
                        console.log(`      ${String(r.bins.indexOf(b)).padStart(3)} | ${String(b.n).padStart(5)} | ${b.lo.toFixed(4)}-${b.hi.toFixed(4)} | ${b.meanP.toFixed(4)} |   ${b.observed.toFixed(4)} | ${(gap >= 0 ? '+' : '') + gap.toFixed(4)}`);
                    }
                }
            }
        }
        console.log('  a positive gap is the model UNDER-confident in that bin, a negative one over-confident.');
        console.log('  NULL is the ECE a perfectly calibrated model of this size would score; p is the share of such');
        console.log('  models scoring at least the observed value. Raw ECE is not comparable across tiers — the floor');
        console.log('  rises as the sample shrinks, so a small tier looks miscalibrated when only its n is different.');
    }

    if (table.length > 1) {
        const b = table[0];
        console.log(`\ndeltas against ${SWEPT}=${b.value} — a std-beta shift is the signal's discriminative value moving;`);
        console.log('a raw-beta shift with std flat is only the scale moving, which the gazetteer does by construction.');
        for (const t of table.slice(1)) {
            const parts = t.rows.map((r, i) => `${r.name} std ${fx(r.std - b.rows[i].std)} raw ${fx(r.raw - b.rows[i].raw)} AUC ${fx(r.auc - b.rows[i].auc)}`);
            console.log(`  ${String(t.value).padEnd(14)} ${parts.join('   ')}`);
            console.log(`  ${' '.repeat(14)} model AUC ${fx(t.auc - b.auc)}  log-loss ${fx(t.logLoss - b.logLoss)}  n ${t.n - b.n >= 0 ? '+' : ''}${t.n - b.n} rows`);
        }
    }

    console.log('\nA coefficient is fitted over POOLED rows, so it has no paired sign test behind it — read the SE,');
    console.log('and remember these rows sit on 3 corpora however many scenes they span (CLAUDE.md, graded scenes).');
})();
