// What each stage-3 signal is WORTH as a predictor of per-entry relevance, and how a parameter moves that.
//
// Stage 4 predicts whether an individual entry is relevant, so the question a tuning parameter has to
// answer is no longer "did the ranking improve" but "did this signal become a better or worse predictor".
// param-screen answers the first; this answers the second. They can disagree, and that disagreement is
// informative rather than a contradiction: a parameter can leave nDCG flat while moving what the fusion
// would have to weight, because RRF reads only RANKS and this reads the scores themselves.
//
// THE MODEL IS LOGISTIC, on the project's own relevance line (grade >= 3, metrics.mjs). Linear would put
// predictions outside [0,1] on a bounded target and weight a 0-vs-1 error the same as a 0.4-vs-0.5 one;
// polynomial terms MEASURED WORSE and `--degree 2` is what measured them (see the doc). Fit quality is
// printed (AUC, log-loss) so the case is always against a number rather than against the shape of the
// model.
//
// THREE READINGS OF A COEFFICIENT, because they answer different questions and only one of them is what
// "the weight moved" usually means:
//
//   raw     per unit of the signal. Moves when the SCALE moves — and the gazetteer changes which query
//           terms reach BM25, so it changes BM25's scale by construction. A raw shift alone is not
//           evidence the signal got better.
//   std     per within-scene standard deviation. Scale-free, so this is the discriminative value: it
//           moves only when the signal separates relevant from irrelevant better or worse.
//   AUC     the signal alone, ranked. No fit, no other columns — what the column would be worth if it
//           were the only thing stage 4 read.
//
// WITHIN-SCENE standardisation, not pooled: BM25 is not comparable across queries or corpora (the same
// note governs bm25FloorPct in scene.mjs), so pooling raw scores across 71 scenes would let a scene's
// scale masquerade as a coefficient. ONE intercept over all of them — a per-scene intercept was tried as
// a control for differing base rates and measured to buy nothing, while reproducing each scene's base
// rate by construction and so inflating any in-sample number that carried it.
//
// THE POOL IS WHAT WAS JUDGED. An ungraded row has no label, so it is dropped rather than scored 0 — a
// 0 here would be a claim about relevance, where in a ranking metric it is a claim about a rank. Judged
// coverage is printed per arm for the same reason param-screen prints it.
//
// Usage (from SillyTavern root):
//   node .../relevance-regress.mjs <sample.json> [...] [--sweep gazetteerSource=keys,titles]
//        [--tier memory|reference] [--cut 4] [--ordinal] [--loso] [--lobo] [--calibration] [--cutoff] [--degree 2] [--interactions] [--with proper,time,oracle,length,density,rarity] [--emit-rows rows.json] [--proper count|idf|jaccard|gaz] [--proper-extract regex|entity|span]
import { indexPath, isMemory, loadScene, openSample, sceneParams, makeCandidateSet, makeGradeOf, embed } from './scene.mjs';
import { ensureIndex } from './reindex.mjs';
import fs from 'node:fs';
import { gradeValue, gradeCredit, fbeta, RECALL_WEIGHT, signTest } from './metrics.mjs';
import { COMMON_WORDS } from '../plugin/commonwords.js';
import { logisticFit, auc, cumulativeFit, prCurve, reliability, sigmoid } from './logistic.mjs';
import * as ranking from '../extension/ranking.mjs';
import { fold, normalizeOrthography } from '../extension/smartkeys.mjs';
import { tokenize } from '../extension/lexical.mjs';

const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
// A .json that is the VALUE of a flag is not a sample — --emit takes one, and without this the file it
// is about to write is opened as an input bundle. Named flags rather than "anything after a --", or
// `--lobo scene.json` would silently DROP that scene, which is the worse failure: a wrong sample set
// prints a clean table and says nothing about what it left out.
const VALUED = new Set(['--arm', '--sweep', '--tier', '--cut', '--degree', '--square', '--with', '--emit', '--emit-rows', '--proper', '--proper-extract']);
const samples = argv.filter((a, i) => a.endsWith('.json') && !a.startsWith('--') && !VALUED.has(argv[i - 1]));
if (!samples.length) {
    console.error('need at least one sample: node relevance-regress.mjs <sample.json> [more.json ...] [--sweep param=v1,v2]');
    process.exit(2);
}

// One parameter, several values — the same shape param-screen's arms have, minus the pairing, because a
// coefficient is fitted over the pooled rows and has no per-scene counterpart to pair.
const sweep = arg('--sweep') ?? 'gazetteerSource=keys+titles,keys,titles,bodies,none';
const [SWEPT, valuesRaw] = [sweep.slice(0, sweep.indexOf('=')), sweep.slice(sweep.indexOf('=') + 1)];
// Values arrive as strings from a shell; a numeric parameter swept as "0.5" would silently become a string
// and compare unequal to every default. Booleans the same.
const coerce = v => (v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : (v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v));
const VALUES = valuesRaw.split(',').map(s => coerce(s.trim()));
// WHICH TIER IS FITTED. The ruled predictor fits per tier (matcher-design.md, Stage 4), and the tiers do
// not carry the same signals — memory is ~all vectorized, reference ~all keyword-only — so a pooled fit
// reads one slope across two eligibility regimes. 'all' is the pooled fit and stays the default, because
// it is what the recorded figures were measured on.
// ORDINAL MODE. The 0-4 scale asserts four boundaries and the shipped model fits only one of them
// (>=3), which is also the one the signals separate worst: pooled, grades 2 and 3 sit at the same mean
// standardised cosine. --ordinal fits every boundary so the scale can be read rather than assumed — see
// logistic.mjs cumulativeFit for why the slopes are fitted separately instead of shared.
const ORDINAL = argv.includes('--ordinal');
// HELD OUT BY SCENE. Within-scene standardisation leaks nothing across the fold: it reads only the
// held-out scene's own candidates, which stage 3 also holds.
const LOSO = argv.includes('--loso');
// HELD OUT BY BOOK, which is the generalisation the system actually needs. A held-out SCENE still shares
// its book's vocabulary, entry style, chunk statistics and BM25 scale with the rows that fitted the model,
// so --loso measures "another moment in a book we know" — and production meets books it has never seen.
// Folds are wildly unequal here (one book is 58% of the rows), so read the per-fold sizes, not just the
// pooled number.
const LOBO = argv.includes('--lobo');
const CUTOFF = argv.includes('--cutoff');
const DEGREE = Number(arg('--degree') ?? 1);
// Which signals get a squared term. Empty means all of them — naming a subset is how a term that
// carries support is tested apart from two that do not, since three added coefficients can lose held
// out while one of them gains.
const SQUARE = String(arg('--square') ?? '').split(',').filter(Boolean);
const INTERACT = argv.includes('--interactions');
// Extra candidate features, off by default: `proper` = shared proper nouns with the scan window,
// `time` = the entry's story-time position, `oracle` = the entry's own relevance rate in its OTHER
// scenes, a CEILING on any entry-level prior rather than a shippable column. All are ADDITIONS to the
// three shipped signals, never replacements, and all are here to be measured rather than to ship.
const WITH = String(arg('--with') ?? '').split(',').filter(Boolean);
// Where to write the per-scene F2 vector. Two feature sets cannot be swept in one process — the design
// matrix is built once — so the paired contrast is made between two RUNS, and this is what carries the
// per-scene numbers between them. Scene names go with it: pairing by index is only safe if both runs
// kept the same scenes, and that has to be checked rather than assumed.
const EMIT = arg('--emit');
// Every scored row at the best cutoff, delivered flag included — what --emit carries for the paired TEST,
// this carries for reading the cut. Separate flags because the per-scene F2 vector is small enough to keep
// forever and this is not.
const EMIT_ROWS = arg('--emit-rows');
// How the proper-noun overlap is scored. `count` = shared names; `idf` = shared names weighted by
// log(N/df) over the book's own entries, so a name every entry mentions counts for little and the
// protagonist stops dominating; `jaccard` = intersection over union, which normalises for how many
// names an entry happens to carry; `gaz` = count restricted to the gazetteer, i.e. to names the BOOK
// declared in a key, secondary or title rather than any capitalised token.
const PROPER_MODE = arg('--proper') ?? 'count';
// HOW a name is recognised, orthogonal to how a shared one is scored. `regex` is the private ASCII
// pattern this feature was found with; `entity` is ranking.mjs's own rule, which the entity filter
// already uses; `span` takes maximal runs of capitalised tokens as one term, so "Brackenmoor Patrol"
// is a name rather than two.
const PROPER_EXTRACT = arg('--proper-extract') ?? 'regex';
const CALIB = argv.includes('--calibration');
// WHICH BOUNDARY IS THE TARGET. 3 is the project's relevance line and the default; --cut 4 fits the band
// the anchors reserve for the scene's current subject, which separates far better and is far rarer, so it
// is the one place AUC and AP disagree loudly enough to be worth reading side by side.
const CUT = Number(arg('--cut') ?? 3);
if (!Number.isFinite(CUT)) { console.error(`--cut must be a number, got ${arg('--cut')}`); process.exit(2); }
const TIER = arg('--tier') ?? 'all';
if (!['all', 'memory', 'reference'].includes(TIER)) { console.error(`--tier must be all|memory|reference, got ${TIER}`); process.exit(2); }
const MODEL = process.env.WA_EMBED_MODEL ?? 'bge-m3';
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';

// THE FEATURE SET, and the eligibility indicators that go with it. An absent signal and a signal that
// competed and scored zero are different states — the distinction fuseRanks is built around — so each
// signal carries its own indicator and the slope is read on the rows that could earn it. Without them a
// keyword-only entry's missing cosine reads as "average-cosine entry", which is the one reading that is
// certainly wrong.
const FEATURES = [
    ['cosine', r => (Number.isFinite(r.score) ? r.score : 0), r => (Number.isFinite(r.score) ? 1 : 0)],
    ['text', r => Number(r.textScore) || 0, r => (r.textEligible ? 1 : 0)],
    ['keys', r => Number(r.keywordScore) || 0, r => (r.keysEligible ? 1 : 0)],
];
// PROPER NOUNS shared between the entry and the scan window. NOT a reweighting of `text`: BM25 spreads
// its mass over every term the two share, so a character name arrives diluted among hundreds of ordinary
// words. Restricting the vocabulary to names asks a different question — is this entry about someone who
// is on screen — and that is the axis the three shipped signals do not have.
//
// Title-case token minus the common-English list, which is the same heuristic keyword-core's looksProper
// uses. It over-fires on sentence-initial words; that noise is shared by both sides of the intersection,
// so it inflates the floor rather than the discrimination, and a POS tagger is not worth it to find out
// whether the axis exists at all.
const PROPER_RE = /\b[A-Z][a-z]{2,}\b/g;
// A name may CONTAIN lowercase — "Church of the Sun", "Maren's Gap", "van der Berg" — so a run cannot
// simply break at the first uncapitalised token. Particles join a run only between name tokens, and a
// trailing one is trimmed, so "Sun of" never forms.
//
// Built on ranking.properNounsOf rather than on capitalisation directly: the first span arm started runs
// at sentence-initial capitals, which is how "The" became the head of a name, and it lost to plain
// unigrams because of it.
//
// EMITS THE SPAN AND ITS PARTS. Spans alone are brittle — an entry saying "Brackenmoor Patrol" against a
// window saying only "Brackenmoor" would share nothing, which is worse than the unigram arm rather than
// better. Both levels means the phrase is extra evidence when it agrees, never a replacement.
// NOT 'and': it joins two entities rather than living inside one, so "Maren and Brackenmoor Patrol"
// formed a single three-name span. Every member here is a genitive or article particle that appears
// INSIDE a name.
const PARTICLES = new Set(['of', 'the', 'de', 'del', 'della', 'di', 'da', 'van', 'von', 'der', 'den',
    'du', 'la', 'le', 'el', 'bin', 'ibn']);
const properSpans = (text) => {
    const norm = normalizeOrthography(String(text ?? ''));
    const names = ranking.properNounsOf(norm);
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
            // BOTH tests, and the per-occurrence one is not optional. `names` says the token is used as
            // a name SOMEWHERE in this text; the capital says THIS occurrence is the name rather than
            // the common noun. Testing membership alone discards exactly the distinction the
            // capitalisation rule exists to make, so a later "church of the sun" would build the same
            // span as "Church of the Sun" in a text that used both.
            if (/^\p{Lu}/u.test(tok) && names.has(lw)) { run.push(lw); continue; }
            if (run.length && PARTICLES.has(lw)) { run.push(lw); continue; }
            flush();
        }
        flush();
    }
    // A COMPONENT IS ONLY A NAME IF THE TEXT USES IT ALONE. "Maren's Gap" splitting to `maren's` is
    // right and to `gap` is not — `gap` is a common noun capitalised because it sits inside a name, and
    // nothing but standalone use distinguishes it from `maren's`. Same for `corporal` in "Corporal
    // Persh". So components come from the runs of length ONE, and a longer run contributes only itself
    // plus whichever of its tokens the text also attests standalone.
    const solo = new Set(runs.filter(r => r.length === 1).map(r => r[0]));
    for (const r of runs) {
        out.add(r.join(' '));
        if (r.length > 1) for (const t of r) if (solo.has(t)) out.add(t);
    }
    for (const w of [...out]) if (!w.includes(' ') && COMMON_WORDS.has(w)) out.delete(w);
    return out;
};
const properNouns = text => {
    if (PROPER_EXTRACT === 'entity') {
        // ranking.mjs's rule, imported rather than copied: orthography-normalised, sentence-initial
        // capitals excluded, \p{Lu} so an accented initial still reads as a name. The common-word
        // filter still applies — that rule is about which names are worth counting, not what a name is.
        const out = ranking.properNounsOf(normalizeOrthography(String(text ?? '')));
        for (const w of [...out]) if (COMMON_WORDS.has(w)) out.delete(w);
        return out;
    }
    if (PROPER_EXTRACT === 'span') return properSpans(text);
    const out = new Set();
    for (const m of String(text ?? '').match(PROPER_RE) ?? []) {
        const w = m.toLowerCase();
        if (!COMMON_WORDS.has(w)) out.add(w);
    }
    return out;
};

// STORY TIME. Within-scene standardisation makes "distance from the current point" and "position in the
// book" the same column up to sign, because the current point is one value per scene — so the position
// is what is stored and the coefficient's SIGN says whether recent wins. STMB appends, so uid order is
// story order.
//
// uid ONLY, never `order`: that field is ST's insertion PRIORITY and an author may or may not have set
// it, so a column that fell back between the two would mean story position in one book and priority in
// the next — which a fit held out BY BOOK cannot survive, and which reads as a feature failing to
// transfer rather than as two features sharing a column.
const storyTime = r => Number(r.entry?.uid ?? 0);

if (WITH.includes('proper')) FEATURES.push(['proper', r => Number(r.properShared) || 0, () => 1]);
if (WITH.includes('time')) FEATURES.push(['time', storyTime, () => 1]);
// Built below, once every scene is loaded — an entry's prior is read off its OTHER scenes and so cannot
// be computed inside the per-scene loop the way properShared is.
if (WITH.includes('oracle')) FEATURES.push(['oracle', r => Number(r.entryBase) || 0, () => 1]);
// THE THREE COMPUTABLE PRIORS, each an attempt at part of what `oracle` bounds. All are entry-intrinsic
// — they never read the query — so they are priors rather than signals, and within-scene standardisation
// still works on them because they vary between the entries of one scene.
//
// LENGTH IS LOG, because token counts run over an order of magnitude and a raw column would let one
// 15k-token entry set the scene's SD. It is not already in the model: BM25 length-normalises INSIDE
// `text`, which is a different claim — that a long document should not out-score a short one on the same
// query — and says nothing about whether long entries are likelier to be relevant at all.
if (WITH.includes('length')) FEATURES.push(['length', r => Math.log(Math.max(1, Number(r.entryTokens) || 0)), () => 1]);
// NAMES PER 100 TOKENS, on ranking.properNounsOf — the same detector `proper` settled on. A DENSITY, not
// the count: the count is length wearing another name, and the two would be one column.
if (WITH.includes('density')) FEATURES.push(['density', r => Number(r.properDensity) || 0, () => 1]);
// MEAN -log10(tf/total) over the entry's tokens, the book as the corpus. "How rare is this entry's
// vocabulary among its siblings" — the surviving half of a mean-TF-IDF prior. The English-frequency half
// is deliberately absent: ZIPF_EN scores a name maximally rare and a book's own coinages with it, so the
// two axes disagree on a tenth of a book's token mass and a min-of-percentiles combination measured
// WORSE than this column alone.
if (WITH.includes('rarity')) FEATURES.push(['rarity', r => Number(r.bookRarity) || 0, () => 1]);

// Feature indices carrying a squared term: none at degree 1, the named subset if --square was given,
// otherwise all of them.
const SQUARED = DEGREE < 2 ? []
    : FEATURES.map((f, i) => i).filter(i => !SQUARE.length || SQUARE.includes(FEATURES[i][0]));
// Two-way products of the standardised signals. A DIFFERENT question from the squares: those ask
// whether one signal bends, these ask whether two of them combine — which is the structure a tree
// ensemble would be reaching for, and the cheap way to find out whether any exists.
const PAIRS = INTERACT
    ? FEATURES.flatMap((_, i) => FEATURES.map((__, j) => [i, j]).filter(([a, b]) => a < b))
    : [];

// WHAT A SIGNAL IS WORTH AS A REJECTION FILTER, which is a different question from AUC and the one an
// entry-level prior is actually for. A prior that says "this entry is generic" is not a claim that a
// high-scoring entry is relevant, so the symmetric number hides it: a column can sit near 0.5 AUC and
// still have a pure low tail. This walks the signal's own ranking from the bottom and reports how much
// of the pool can be cut before the first relevant row is lost, and again at 95% recall.
//
// POOLED ACROSS SCENES ON PURPOSE, where solo AUC carries the same caveat by accident: a rejection
// filter has ONE threshold for every scene, so the pooled ranking is the population it would face. That
// makes the number honest for a scene-independent prior and pessimistic for a signal whose scale moves
// per scene (BM25), which is the right way round.
// TIE-AWARE, which is not a detail here: a threshold cuts on a VALUE, so every row sharing the lowest
// positive's value is kept with it. An entry-level prior is tied by construction — a whole block of
// entries scores exactly 0 — and walking row indices instead would let the sort order inside that block
// decide the answer, reporting a filter as pure when the tie it sits on contains relevant rows.
const tailCut = (s, labels) => {
    const order = s.map((v, i) => [v, labels[i]]).sort((a, b) => a[0] - b[0]);
    const pos = order.reduce((a, [, l]) => a + (l ? 1 : 0), 0);
    if (!pos) return { at100: NaN, at95: NaN };
    let below = 0, lost = 0, at100 = NaN, at95 = NaN, i = 0;
    while (i < order.length) {
        let j = i;
        while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
        const groupPos = order.slice(i, j + 1).reduce((a, [, l]) => a + (l ? 1 : 0), 0);
        // `below` is what a cut placed under this group would drop, and it is recorded BEFORE the group
        // is counted — dropping the group itself costs the positives inside it.
        if (groupPos && Number.isNaN(at100)) at100 = below / order.length;
        if (Number.isNaN(at95) && (lost + groupPos) / pos > 0.05) at95 = below / order.length;
        below = j + 1; lost += groupPos; i = j + 1;
    }
    return { at100: Number.isNaN(at100) ? 0 : at100, at95: Number.isNaN(at95) ? 1 : at95 };
};

// The entry-intrinsic columns, named once so the per-scene block can ask whether any was requested.
const PRIORS = ['length', 'density', 'rarity'];
// Book term-frequency, keyed by book — see the per-scene block.
const bookTf = new Map();

const mean = xs => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };
const fx = n => (Number.isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(3) : '  n/a');

(async () => {
    // Load once, embed once. Only the gazetteer-dependent half is rebuilt per value, and loadScene is
    // cheap next to the embed call it would otherwise repeat.
    const loaded = [];
    for (const path of samples) {
        const S = openSample(path, arg('--arm'));
        if (!S.candidates?.length) { console.error(`${path}: logs no candidates`); process.exit(2); }
        const qv = await embed(S.query, { ollama: OLLAMA, model: MODEL });
        loaded.push({ path, name: S.name ?? path, book: S.primaryBook ?? path, S, qv });
    }
    console.log(`${loaded.length} scene(s); sweeping ${SWEPT} over ${VALUES.join(', ')}${TIER === 'all' ? '' : `; ${TIER} tier only`}${CUT === 3 ? '' : `; target grade >= ${CUT}`}`);

    const table = [];
    for (const value of VALUES) {
        // Rows keep their scene, because standardisation and the intercepts are within-scene.
        const perScene = [];
        let dropped = 0;
        for (const { S, qv, name, book } of loaded) {
            const P = sceneParams(S, { [SWEPT]: value });
            // THE INDEX FOLLOWS THE PARAMS. denseAllEntries wants a collection covering every entry, not
            // only the vectorized ones — scored against the standard index it would find no extra vectors
            // and report a null result that reads like an answer. ensureIndex is cached per (book, cfg,
            // all), so this costs an existsSync on every scene after the first.
            const indexFile = P.denseAllEntries
                ? (await ensureIndex(S, { all: true, model: MODEL, ollama: OLLAMA, log: () => {} })).path
                : indexPath(S, { model: MODEL });
            const scene = loadScene(S, { indexFile, params: P });
            const tw = (P.entityFilter && P.queryMode !== 'summary') ? ranking.buildTermWeights(S.query, scene.gaz, P.boost) : null;
            const rows = makeCandidateSet({ ...scene, params: P })(P.K1, P.B, tw, qv, S.query, S.scanText);
            if (WITH.includes('proper')) {
                const win = properNouns(Array.isArray(S.scanText) ? S.scanText.join('\n') : S.scanText);
                // df over THIS book's entries, which is the corpus the names live in — the same reason
                // content-lexical insists on one index for both classes. Computed once per scene.
                const df = new Map();
                let ndoc = 0;
                if (PROPER_MODE === 'idf') {
                    for (const e of scene.entries ?? []) {
                        ndoc++;
                        for (const w of properNouns(e.content)) df.set(w, (df.get(w) ?? 0) + 1);
                    }
                }
                for (const r of rows) {
                    const ents = properNouns(r.entry?.content);
                    let v = 0;
                    if (PROPER_MODE === 'jaccard') {
                        let inter = 0;
                        for (const w of ents) if (win.has(w)) inter++;
                        const union = ents.size + win.size - inter;
                        v = union ? inter / union : 0;
                    } else if (PROPER_MODE === 'idf') {
                        for (const w of ents) if (win.has(w)) v += Math.log((ndoc + 1) / ((df.get(w) ?? 0) + 1));
                    } else if (PROPER_MODE === 'gaz') {
                        // buildGazetteer stores FOLDED tokens, so the membership test folds too — a
                        // lowercase compare misses every accented name the book declared.
                        for (const w of ents) if (win.has(w) && scene.gaz?.has(fold(w))) v++;
                    } else {
                        for (const w of ents) if (win.has(w)) v++;
                    }
                    r.properShared = v;
                }
            }
            // THE ENTRY-INTRINSIC PRIORS, stamped on the row so the feature accessors stay pure lookups.
            // Book term-frequency is CACHED PER BOOK: it reads scene.entries, which is the same corpus for
            // every scene of a book, and recomputing it per scene would tokenize the book 14 times over on
            // the larger lines for an identical answer.
            if (PRIORS.some(p => WITH.includes(p))) {
                let bk = bookTf.get(book);
                if (!bk) {
                    const tf = new Map();
                    let total = 0;
                    for (const e of scene.entries ?? []) {
                        for (const t of tokenize(e.content)) { tf.set(t, (tf.get(t) ?? 0) + 1); total++; }
                    }
                    // An unseen term would divide by a zero count; the book's own vocabulary cannot
                    // contain one, but an entry excluded from scene.entries can, so it floors at 1.
                    bk = { rarity: t => -Math.log10((tf.get(t) ?? 1) / Math.max(1, total)) };
                    bookTf.set(book, bk);
                }
                for (const r of rows) {
                    const toks = tokenize(r.entry?.content);
                    r.entryTokens = toks.length;
                    const names = ranking.properNounsOf(normalizeOrthography(String(r.entry?.content ?? '')));
                    r.properDensity = (names?.size ?? 0) / Math.max(1, toks.length) * 100;
                    r.bookRarity = toks.length ? toks.reduce((a, t) => a + bk.rarity(t), 0) / toks.length : 0;
                }
            }
            const gradeOf = makeGradeOf(S.grades, scene.isExcluded);
            // Same population scoreScene ranks: constants are out, because relevance is not a concept that
            // applies to them. Ungraded rows are out because they carry no label.
            const kept = [], ungraded = [];
            for (const r of rows.filter(r => !r.entry?.constant)) {
                if (TIER !== 'all' && (isMemory(r.entry) ? 'memory' : 'reference') !== TIER) continue;
                const g = gradeOf(r);
                // An ungraded row carries no label, so it is out of the FIT — a 0 there would be a claim
                // about relevance. It is kept for the bar sweep, where the same row scored 0 is a claim
                // about DELIVERY: a bar that admits it puts an unvetted entry in front of a user and
                // should pay precision for it, which is the `?? 0` convention scene.mjs already uses.
                // Dropping them from both would score every bar on the rows some arm already surfaced,
                // and so would reward a bar for reaching deeper than the pool.
                if (g === null || g === undefined || Number.isNaN(g)) { dropped++; ungraded.push({ r, g: 0 }); continue; }
                kept.push({ r, y: g >= CUT ? 1 : 0, g });
            }
            // A ROW FLOOR, and nothing about the labels. The features are standardised within scene, so a
            // scene with a couple of rows scales its columns by an sd estimated from a couple of points;
            // 5 is where that stops being nonsense. There is no both-classes test: the fit POOLS ACROSS
            // SCENES behind one intercept, so an all-negative scene still contrasts its own rows against
            // each other and still informs the slopes. Requiring both classes dropped those rows for a
            // property the fit does not need, and the cutoff sweep separately drops scenes with no
            // relevant row, where recall is undefined rather than uninformative.
            // THE SCENE TEXT RIDES ALONG for --emit-rows. A grade is a verdict about a (scene, entry)
            // PAIR, so a dropped row cannot be judged from its title: the same entry is right in one
            // scene and wrong in the next. Bounded, because the whole query over 103 scenes is a file
            // nobody opens.
            if (kept.length >= 5) perScene.push({ name, book, kept, ungraded, query: String(S.query ?? '').slice(-4000) });
        }
        if (!perScene.length) { console.log(`  ${SWEPT}=${value}: no scene has both classes among its judged rows`); continue; }

        // THE ORACLE ENTRY PRIOR — a CEILING, not a candidate feature. It reads the entry's own grades in
        // the OTHER scenes, so nothing computable from an entry's text can beat it; the question it answers
        // is whether an entry-level prior has any room at all beside the query-dependent signals, before a
        // proxy for one is built. `RELEVANCE IS A PROPERTY OF THE PAIR` (matcher-design.md) rules out
        // caching a verdict per entry; it does not rule out an INTERCEPT, and this measures that intercept
        // at its best possible value.
        //
        // LEAVE-ONE-SCENE-OUT within the entry, which removes the self-leak — with the row's own label in
        // the average, a singleton entry would predict itself perfectly and the column would read as an
        // oracle for being one. What it does NOT remove is the cross-scene leak inside a book, so --lobo
        // does not protect this column and its held-out number is optimistic BY CONSTRUCTION. That is what
        // makes it a bound: a real prior gets none of this.
        //
        // An entry seen in one scene only has no out-of-fold estimate, so it takes the pooled base rate —
        // the neutral value, which keeps the row population identical to the run without the column and so
        // keeps the two runs paired. The count is printed because a column mostly made of imputed rows is
        // measuring the imputation.
        if (WITH.includes('oracle')) {
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
                // An ungraded row never entered the tally, so it has no estimate of its own even when its
                // entry does. It takes the entry's full rate where one exists — there is no self to leave
                // out — and the pooled rate otherwise.
                for (const u of ungraded) {
                    const t = tally.get(idOf(u.r));
                    u.r.entryBase = t ? t.pos / t.n : pooled;
                }
            }
            console.log(`  oracle: ${tally.size} distinct entries, pooled base ${pooled.toFixed(3)}, ${imputed} single-scene rows imputed`);
        }

        // Design matrix: one intercept, then for each signal its standardised value and its eligibility
        // indicator. Standardising within scene is what makes one slope mean one thing across corpora
        // whose BM25 lives on different scales.
        const X = [], y = [], rawCols = FEATURES.map(() => []), stats = FEATURES.map(() => ({ sd: [], mean: [] }));
        const perSignal = FEATURES.map(() => ({ s: [], y: [] }));
        const sceneCols = [];
        for (const [si, { kept }] of perScene.entries()) {
            const cols = FEATURES.map(([, get]) => kept.map(k => get(k.r)));
            sceneCols[si] = cols;
            cols.forEach((c, fi) => { stats[fi].sd.push(sd(c)); stats[fi].mean.push(mean(c)); });
            kept.forEach((k, i) => {
                const scene = [1];
                const feats = [];
                cols.forEach((c, fi) => {
                    const s = sd(c) || 1;   // a signal constant within a scene carries no information there; 1 keeps it finite and its column stays flat
                    feats.push((c[i] - mean(c)) / s, FEATURES[fi][2](k.r));
                    rawCols[fi].push(c[i]);
                    perSignal[fi].s.push(c[i]);
                    perSignal[fi].y.push(k.y);
                });
                // DEGREE 2 APPENDS, never interleaves: every readout below indexes a linear coefficient
                // as base + fi*2, so a squared column inserted beside its own signal would silently
                // renumber all of them. The ELIGIBILITY indicators are not squared — they are 0/1, so
                // x^2 == x and the duplicate column makes the design singular.
                const sq = [...SQUARED.map(fi => feats[fi * 2] ** 2),
                    ...PAIRS.map(([a, b]) => feats[a * 2] * feats[b * 2])];
                X.push([...scene, ...feats, ...sq]);
                y.push(k.y);
            });
        }
        const grades = perScene.flatMap(({ kept }) => kept.map(k => k.g));
        const stdFit = logisticFit(X, y);

        const sceneOf = perScene.flatMap(({ kept }, si) => kept.map(() => si));
        const etaOf = (fit, rows) => rows.map(row => row.reduce((a, x, j) => a + x * fit.beta[j], 0));
        // One held-out estimator, two groupings. The fold is the unit the model must generalise ACROSS.
        // `labels` defaults to the shipped cut, and is a parameter so the SAME held-out estimator can be
        // run at another boundary — E[credit] is built from P(>=2) and P(>=3), and a calibration claim
        // about it has to hold for both.
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
            // `betas` is what lets a row the fit never saw — an ungraded one — be scored by the fold that
            // did not train on its book, which is the only honest way to put it in a delivered set.
            // `fold` rides along so the readout can report ONE held-out book on its own: pooling every
            // fold answers "does this generalise on average", and a validation book asks something else.
            return {
                eta: keep.map(k => k[0]), y: keep.map(k => k[1]), betas,
                fold: held.map((v, i) => [v, i]).filter(([v]) => Number.isFinite(v)).map(([, i]) => groupOf(i)),
            };
        };
        const books = [...new Set(perScene.map(p => p.book))];
        const bookOf = perScene.flatMap(({ kept, book }) => kept.map(() => books.indexOf(book)));
        const loso = LOSO ? holdOut(i => sceneOf[i], perScene.length) : null;
        const lobo = LOBO ? holdOut(i => bookOf[i], books.length) : null;
        if (LOBO) {
            console.log(`\n  held out by book: ${books.length} folds — ${books.map(b => `${String(b).split(/[ _]/).slice(-1)[0].slice(0, 10)} ${bookOf.filter(x => x === books.indexOf(b)).length}`).join(', ')} rows`);
        }
        // The raw fit is the same design with unstandardised signals — the per-unit reading. Same intercepts,
        // so the only difference between the two is the scale the slope is expressed in.
        const Xraw = X.map((row, i) => {
            const out = row.slice(0, 1);
            FEATURES.forEach((_, fi) => out.push(rawCols[fi][i], row[1 + fi * 2 + 1]));
            // The raw fit carries the same terms as the standardised one or it is a different model,
            // and the per-unit column beside it would be read off a design that was never fitted.
            [...SQUARED, ...PAIRS].forEach((_, si) => out.push(row[1 + 2 * FEATURES.length + si]));
            return out;
        });
        const rawFit = logisticFit(Xraw, y);
        const base = 1;
        table.push({
            value, scenes: perScene.length, n: y.length, pos: y.reduce((a, b) => a + b, 0), dropped,
            rows: FEATURES.map(([name], fi) => ({
                name,
                std: stdFit.beta[base + fi * 2], stdSe: stdFit.se[base + fi * 2],
                raw: rawFit.beta[base + fi * 2],
                sd: mean(stats[fi].sd),
                auc: auc(perSignal[fi].s, perSignal[fi].y),
                cut: tailCut(perSignal[fi].s, perSignal[fi].y),
            })),
            logLoss: stdFit.logLoss, converged: stdFit.converged,
            sq: [...SQUARED, ...PAIRS].map((_, si) => stdFit.beta[1 + 2 * FEATURES.length + si]),
            sqSe: [...SQUARED, ...PAIRS].map((_, si) => stdFit.se[1 + 2 * FEATURES.length + si]),
            auc: auc(X.map((row, i) => row.reduce((s, x, j) => s + x * stdFit.beta[j], 0)), y),
            ordinal: ORDINAL ? cumulativeFit(X, grades, [1, 2, 3, 4]) : null,
            base,
            fits: {
                'in-sample': { eta: etaOf(stdFit, X), y },
                ...(loso ? { 'held out by scene': loso } : {}),
                ...(lobo ? { 'held out by BOOK': lobo } : {}),
            },
            books,
            // Calibration is read at BOTH boundaries E[credit] combines, not only the shipped cut: the
            // target is 0.5*P(>=2) + 0.5*P(>=3), and a convex combination of two probabilities is
            // calibrated only if each of them is. Held out by book where that was asked for, and
            // in-sample beside it so the near-zero there is visible as the score equation it is.
            // THE CUTOFF. Stage 4's question is not "which rows rank highest" but "which rows belong", so the
            // sweep scores the DELIVERED SET at each candidate cutoff rather than a window: F2 on the asymmetric
            // bars (recall at grade >= 3, precision crediting a 2 at half), macro-averaged over scenes so a
            // scene with many candidates does not outvote one with few.
            //
            // Scored on E[credit] = 0.5*P(>=2) + 0.5*P(>=3), both held out BY BOOK and P(>=3) clamped to
            // P(>=2) — the boundaries are fitted separately, so nothing guarantees the nesting the events
            // have, and E[credit] is malformed where they invert.
            cutoff: CUTOFF && LOBO ? (() => {
                const cuts = [2, 3].map(c => holdOut(i => bookOf[i], books.length, grades.map(g => (g >= c ? 1 : 0))).betas);
                const scoreRow = (design, fold) => {
                    const eta = b => (b ? design.reduce((a, x, j) => a + x * b[j], 0) : NaN);
                    const p2 = sigmoid(eta(cuts[0][fold])), p3 = sigmoid(eta(cuts[1][fold]));
                    return Number.isFinite(p2) && Number.isFinite(p3) ? 0.5 * p2 + 0.5 * Math.min(p3, p2) : NaN;
                };
                let gi = 0;
                const scenes = perScene.map(({ kept, ungraded, name, query }, si) => {
                    const fold = bookOf[gi];
                    // IDENTITY AND RAW FEATURES RIDE ALONG, for --emit-rows. The cutoff readout needs
                    // only (score, grade); what a human reads to understand a cut needs to know WHICH
                    // entry and what it scored on each column, and reconstructing that from a second run
                    // would re-derive the standardisation the fit used.
                    const idOf = r => ({ uid: r.entry?.uid, title: r.entry?.comment || r.entry?.title || `uid ${r.entry?.uid}`,
                        feats: Object.fromEntries(FEATURES.map(([n, get]) => [n, get(r)])) });
                    const rows = kept.map(k => ({ e: scoreRow(X[gi++], fold), g: k.g, ...idOf(k.r) }));
                    // An ungraded row is projected through ITS OWN scene's standardisation, the same
                    // statistics the fit used, so it lands on one scale with the rows beside it.
                    for (const u of ungraded) {
                        const design = [1];
                        sceneCols[si].forEach((c, fi) => {
                            design.push((FEATURES[fi][1](u.r) - mean(c)) / (sd(c) || 1), FEATURES[fi][2](u.r));
                        });
                        rows.push({ e: scoreRow(design, fold), g: 0, ungraded: true, ...idOf(u.r) });
                    }
                    return { name, query, rows: rows.filter(r => Number.isFinite(r.e)), relevant: kept.filter(k => k.g >= 3).length };
                }).filter(sc => sc.relevant > 0);
                const grid = Array.from({ length: 99 }, (_, i) => (i + 1) / 100);
                return {
                    scenes: scenes.length,
                    sceneNames: scenes.map(sc => sc.name),
                    sceneRows: scenes,
                    meanRelevant: mean(scenes.map(sc => sc.relevant)),
                    grid: grid.map(cut => {
                        const per = scenes.map(sc => {
                            const got = sc.rows.filter(r => r.e >= cut);
                            const precision = got.length ? mean(got.map(r => gradeCredit(r.g))) : 0;
                            const recall = got.filter(r => r.g >= 3).length / sc.relevant;
                            return { f: fbeta(precision, recall, RECALL_WEIGHT), precision, recall, n: got.length };
                        });
                        return {
                            cut, f: mean(per.map(x => x.f)), precision: mean(per.map(x => x.precision)),
                            recall: mean(per.map(x => x.recall)), delivered: mean(per.map(x => x.n)),
                            // Per scene, kept so arms can be contrasted against each other's OWN scenes.
                            // A macro-averaged difference between two arms is one number with no test
                            // behind it, and at 68 scenes on 7 books that is how a flat band gets
                            // reported as an improvement (CLAUDE.md, graded scenes).
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

    console.log(`\nlogistic fit of P(grade>=${CUT}), signals standardised within scene`);
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
        // ONE ROW PER BOUNDARY OF THE SCALE. `n>=k` is how many rows sit at or above that grade, so the
        // boundaries get rarer down the column and the last one is often too thin to fit. Read the slopes
        // ACROSS boundaries: a scale whose levels the signals can see gives similar slopes with rising
        // intercepts, and a boundary whose slope collapses is a distinction the grader made and the
        // features cannot reproduce.
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

    // WHAT A THRESHOLD WOULD DELIVER, which the AUC above does not say: AP moves with prevalence and the
    // precision-at-recall rows are in the units a bar is chosen in. The in-sample row is the same fit
    // scored on the rows that produced it; the held-out rows are what the number of record reads.
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
    // PER HELD-OUT BOOK. The pooled row above answers "does this generalise on average"; a VALIDATION
    // book asks whether it generalised to one specific corpus nobody fitted on, and averaging that away
    // is the whole thing being avoided. Small folds are reported with their n rather than suppressed —
    // an AUC on 40 rows is not wrong, it is imprecise, and hiding it would hide the imprecision too.
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

    // WHERE THE CUTOFF GOES. This is the only readout here that scores what stage 4 actually ships — a SET,
    // chosen by the model rather than cut at a rank someone picked. Everything above is a diagnostic on
    // the ordering; F2 over the delivered set is the score of record.
    if (CUTOFF) {
        if (!LOBO) console.log('\n--cutoff needs --lobo: a cutoff chosen on in-sample probabilities is chosen on rows the fit has seen.');
        else for (const t of table) {
            const b = t.cutoff;
            if (!b) continue;
            const best = b.grid.reduce((a, x) => (x.f > a.f ? x : a));
            console.log(`\nthe cutoff: F2 over the delivered set, macro-averaged over ${b.scenes} scenes (mean ${b.meanRelevant.toFixed(1)} relevant each)`);
            console.log(`  ${SWEPT}=${t.value}`);
            console.log('    E[credit] >= |     F2   precision   recall   delivered');
            for (const g of b.grid) {
                if (Math.round(g.cut * 100) % 5 && g !== best) continue;
                console.log(`    ${g.cut.toFixed(2).padStart(11)} | ${g.f.toFixed(4)}     ${(100 * g.precision).toFixed(1).padStart(5)}%   ${(100 * g.recall).toFixed(1).padStart(5)}%   ${g.delivered.toFixed(1).padStart(9)}${g === best ? '   <- best' : ''}`);
            }
            console.log(`  best cutoff ${best.cut.toFixed(2)}: F2 ${best.f.toFixed(4)}, delivering ${best.delivered.toFixed(1)} entries against ${b.meanRelevant.toFixed(1)} relevant.`);
            t.best = best;
            if (EMIT_ROWS) {
                fs.writeFileSync(EMIT_ROWS, JSON.stringify({
                    swept: SWEPT, value: t.value, tier: TIER, with: WITH, cut: best.cut, f2: best.f,
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
                    swept: SWEPT, value: t.value, tier: TIER, with: WITH, interactions: INTERACT, properMode: PROPER_MODE, properExtract: PROPER_EXTRACT,
                    cut: best.cut, f2: best.f, scenes: b.sceneNames, perScene: best.perScene,
                }, null, 1));
                console.log(`  per-scene F2 written to ${EMIT}`);
            }
        }
        // PAIRED against the first arm, each at its own best cutoff — the contrast param-screen makes,
        // and the only one that can tell a real gain from the flatness of the cutoff curve.
        const bases = table.filter(t => t.best);
        if (bases.length > 1) {
            const b0 = bases[0];
            console.log(`\npaired against ${SWEPT}=${b0.value}, each arm at its own best cutoff — per-scene F2, sign test`);
            for (const t of bases.slice(1)) {
                const d = t.best.perScene.map((f, i) => f - b0.best.perScene[i]);
                const st = signTest(d);
                console.log(`  ${String(t.value).padEnd(14)} | mean ${(st.mean >= 0 ? '+' : '') + st.mean.toFixed(4)}  ${st.plus} up / ${st.minus} down / ${st.ties} tied  p ${st.p.toFixed(3)}`);
            }
        }
    }

    // DO THE PROBABILITIES MEAN WHAT THEY SAY. Everything above reads the ORDERING, and a monotone
    // rescaling leaves AUC and AP untouched — so the readout that decides where a bar goes is not in
    // any of it. The bar is argued in probability terms, so this is the check that argument rests on.
    //
    // The in-sample row is printed to be discounted: a logistic fit with an intercept forces
    // mean(p) == base rate, so a near-zero ECE there is one of its own score equations. Only the
    // held-out row is evidence, which is why --calibration is worth little without --lobo.
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
