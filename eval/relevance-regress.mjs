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
//        --tier all|memory|reference [--cut 4] [--ordinal] [--loso] [--lobo] [--calibration] [--cutoff] [--at 0.10] [--degree 2] [--interactions] --features cosine,text,properNouns,density [--drop-keys flagged.json] [--emit-rows rows.json] [--emit-model relevance-model-<tier>.json] [--proper-nouns count|idf|idf-len|jaccard|gaz] [--proper-nouns-extract regex|entity|span|book]
//   --tier and --features are required. With properNouns in --features, --proper-nouns and --proper-nouns-extract are
//   required. A --sweep read with --cutoff requires --at: arms compare at one set cutoff.
//
// THE SHIPPED MEMORY FIT, which is what `relevance-model-memory.json` was emitted by — the four columns
// the doc rules (keys is computed and recorded, and deliberately not fitted), the entity name detector,
// held out by book:
//   node .../relevance-regress.mjs eval-data/*-syn-msg*.json <the rest of the graded corpus>
//        --tier memory --features cosine,text,properNouns,density --proper-nouns idf --proper-nouns-extract entity
//        --lobo --cutoff --emit-model extension/relevance-model-memory.json
import { haystackFor, indexPath, isMemory, loadScene, openSample, sceneParams, makeCandidateSet, makeGradeOf, embed, sceneLabel } from './scene.mjs';
import { ensureIndex, resolveModel } from './reindex.mjs';
import fs from 'node:fs';
import { gradeValue, gradeCredit, fbeta, RECALL_WEIGHT, signTest } from './metrics.mjs';
import { COMMON_WORDS } from '../plugin/commonwords.js';
import { logisticFit, auc, cumulativeFit, prCurve, reliability, sigmoid } from './logistic.mjs';
import * as ranking from '../extension/ranking.mjs';
import { properNames, modelKey } from '../extension/relevance.mjs';
import { nameEvidence } from '../extension/keyword-core.mjs';
import { fold, normalizeOrthography } from '../extension/smartkeys.mjs';
import { tokenize } from '../extension/lexical.mjs';
import { chunkEntry } from '../extension/chunking.mjs';

const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
// A .json that is the VALUE of a flag is not a sample — --emit takes one, and without this the file it
// is about to write is opened as an input bundle. Named flags rather than "anything after a --", or
// `--lobo scene.json` would silently DROP that scene, which is the worse failure: a wrong sample set
// prints a clean table and says nothing about what it left out.
const VALUED = new Set(['--arm', '--sweep', '--tier', '--cut', '--degree', '--square', '--features', '--emit', '--emit-rows', '--emit-model', '--drop-keys', '--proper-nouns', '--proper-nouns-extract', '--standardise', '--beta']);
const samples = argv.filter((a, i) => a.endsWith('.json') && !a.startsWith('--') && !VALUED.has(argv[i - 1]));
if (!samples.length) {
    console.error('need at least one sample: node relevance-regress.mjs <sample.json> [more.json ...] [--sweep param=v1,v2]');
    process.exit(2);
}

// One parameter, several values — the same shape param-screen's arms have, minus the pairing, because a
// coefficient is fitted over the pooled rows and has no per-scene counterpart to pair.
//
// NO DEFAULT SWEEP. Bare, this fits the shipped configuration once. It used to default to a five-value
// gazetteerSource sweep, which quintupled every bare run and — since the emits are written inside the
// per-arm block — left --emit describing whichever arm happened to run last.
const sweep = arg('--sweep');
const SWEPT = sweep ? sweep.slice(0, sweep.indexOf('=')) : 'shipped';
const valuesRaw = sweep ? sweep.slice(sweep.indexOf('=') + 1) : '';
// Values arrive as strings from a shell; a numeric parameter swept as "0.5" would silently become a string
// and compare unequal to every default. Booleans the same.
const coerce = v => (v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : (v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v));
const VALUES = sweep ? valuesRaw.split(',').map(s => coerce(s.trim())) : [null];
// THE EMBEDDING MODEL IS SWEPT HERE AND NOT IN param-screen, because it is a stage-1 change whose effect
// is only readable at stage 4: cosine is one column of the ruled predictor, and what a better cosine buys
// is a better DELIVERED SET (--cutoff), not a better ranking at a window nobody chose. It is not a
// sceneParams field — a value rebuilds the collection under that model and re-embeds the query under it,
// so unlike every other sweep the arms do not share an index. `<model>/raw` drops the task prefixes
// (reindex.mjs resolveModel).
//
// EVERY ARM IS BUILT BY ensureIndex, including the baseline, so the only difference between two arms is
// the model. Scoring bge-m3 off ST's live collection instead would contrast a model change against a
// build-path change at the same time.
const EMBED_SWEEP = SWEPT === 'embedModel';
// WHICH TIER IS FITTED. The ruled predictor fits per tier (matcher-design.md, Stage 4), and the tiers do
// not carry the same signals — memory is ~all vectorized, reference ~all keyword-only — so a pooled fit
// reads one slope across two populations that hold different columns. 'all' is the pooled fit and stays the default, because
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
// EXPERIMENT (uncommitted default): mirror gradeCredit onto recall, so a 2 is half a hit on BOTH bars
// instead of half on precision and nothing on recall. Off = the shipped asymmetric definition.
const HALF_RECALL = argv.includes('--half-recall');
// EXPERIMENT: where the relevant/irrelevant line sits for the SCORING BARS (not the fit target, which
// is --cut). At 3 the shipped definition holds: full credit >= 3, a 2 at half, recall over >= 3. At 2
// the class is "anything a delivery would not be unequivocally wrong about": full credit >= 2, nothing
// below, recall over >= 2, and the score cut on becomes P(>=2) rather than E[credit], since a half band
// no longer exists to take an expectation over.
// EXPERIMENT: treat an UNGRADED row as a graded 0 and fit on it. The pool is built to surface
// everything relevant, so an entry no arm ever surfaced is very likely irrelevant — but "very likely"
// is an assertion about the CORPUS, not a label, which is why this is a flag and not the default. It
// roughly doubles the negative class on poorly-covered scenes and moves the base rate, so it changes
// what the coefficients mean rather than only their scale.
const UNGRADED_NEGATIVE = argv.includes('--ungraded-negative');
// WHICH POPULATION THE STANDARDISATION IS COMPUTED OVER. `scene` is the shipped design: each row is
// centred among the rows it competes with. `book` pools every scene of the same book, which is the
// same statistic a runtime could accumulate across turns rather than recompute per scan.
//
// The scene version has a measured pathology: one confident match inflates its scene's sd and
// compresses every other row, so the delivered count moves inversely to confidence (matcher-design.md).
// A book-level scale cannot do that — no single row can move it.
const STD_BY = arg('--standardise') ?? 'scene';
// THE BETA OF THE SCORE OF RECORD. RECALL_WEIGHT (2) is the shipped definition — recall counts twice,
// because the cost of missing must-deliver material is higher than the cost of carrying a spare entry.
// Overridable so the arms can be read at another trade: a design that delivers FEWER is penalised by a
// high beta whether or not its ordering is worse, and separating those needs the curve, not one number.
const BETA = Number(arg('--beta') ?? RECALL_WEIGHT);
if (!Number.isFinite(BETA) || BETA <= 0) { console.error(`--beta must be a positive number, got ${arg('--beta')}`); process.exit(2); }
if (!['scene', 'book'].includes(STD_BY)) { console.error(`--standardise must be scene|book, got ${STD_BY}`); process.exit(2); }
const RELEVANT_AT = Number(arg('--relevant-at') ?? 3);
const creditOf = g => (RELEVANT_AT === 2 ? (g >= 2 ? 1 : 0) : gradeCredit(g));
const AT = arg('--at') === null ? null : Number(arg('--at'));
const DEGREE = Number(arg('--degree') ?? 1);
// Which signals get a squared term. Empty means all of them — naming a subset is how a term that
// carries support is tested apart from two that do not, since three added coefficients can lose held
// out while one of them gains.
const SQUARE = String(arg('--square') ?? '').split(',').filter(Boolean);
const INTERACT = argv.includes('--interactions');
// Extra candidate features, off by default: `proper` = shared proper nouns with the scan window,
// THE FEATURE SET, stated in full. `--features` names every fitted column, in order — there is no base
// set to add to or subtract from, so the flag IS the design matrix and two runs differing in one name
// differ in exactly that column. `time` = the entry's story-time position; `oracle` = the entry's own
// relevance rate in its OTHER scenes, a CEILING on any entry-level prior rather than a shippable column.
const KNOWN_FEATURES = ['cosine', 'text', 'keys', 'properNouns', 'time', 'oracle', 'length', 'density', 'rarity', 'chunkdens'];
const FEATURE_LIST = String(arg('--features') ?? '').split(',').filter(Boolean);
if (!FEATURE_LIST.length) { console.error(`--features is required: a comma list of fitted columns, from ${KNOWN_FEATURES.join(',')}`); process.exit(2); }
for (const f of FEATURE_LIST) if (!KNOWN_FEATURES.includes(f)) { console.error(`--features: unknown feature "${f}" — one of ${KNOWN_FEATURES.join(',')}`); process.exit(2); }
if (new Set(FEATURE_LIST).size !== FEATURE_LIST.length) { console.error('--features names a column twice'); process.exit(2); }
const has = f => FEATURE_LIST.includes(f);
// Where to write the per-scene F2 vector. Two feature sets cannot be swept in one process — the design
// matrix is built once — so the paired contrast is made between two RUNS, and this is what carries the
// per-scene numbers between them. Scene names go with it: pairing by index is only safe if both runs
// kept the same scenes, and that has to be checked rather than assumed.
const EMIT = arg('--emit');
// Every scored row at the best cutoff, delivered flag included — what --emit carries for the paired TEST,
// this carries for reading the cut. Separate flags because the per-scene F2 vector is small enough to keep
// forever and this is not.
const EMIT_ROWS = arg('--emit-rows');
const EMIT_MODEL = arg('--emit-model');

// AN EMIT DESCRIBES ONE ARM. All three are written inside the per-arm block, so a multi-value sweep would
// leave the file holding whichever arm ran last, silently and with no field saying which.
if ((EMIT || EMIT_MODEL || EMIT_ROWS) && VALUES.length > 1) {
    console.error(`--emit* writes one arm, but --sweep names ${VALUES.length} (${VALUES.join(', ')}) — run them one value at a time`);
    process.exit(2);
}
// SIMULATES A BOOK EDIT the keyword audit recommends, without editing the book: scene.mjs `dropKeys`
// stops the named keys scoring AND keyword-activating, which is what removing them would do. Takes the
// JSON array `keyword-audit.mjs --json` writes. It UNDERSTATES removal — the terms stay in the
// gazetteer, where a real edit would also take them out (scene.mjs, scoringKeys).
const DROP_KEYS = arg('--drop-keys') ? JSON.parse(fs.readFileSync(arg('--drop-keys'), 'utf8')) : null;
// How the proper-noun overlap is scored. `count` = shared names; `idf` = shared names weighted by
// log(N/df) over the book's own entries, so a name every entry mentions counts for little and the
// protagonist stops dominating; `jaccard` = intersection over union, which normalises for how many
// names an entry happens to carry; `gaz` = count restricted to the gazetteer, i.e. to names the BOOK
// declared in a key, secondary or title rather than any capitalised token.
// REQUIRED when the properNouns feature is in the run. The variants are not interchangeable — idf beats
// count at p 0.0001 (matcher-design, *IDF-WEIGHTED*) — so which one a number was measured under is part
// of the number, and the harness does not choose it.
const PROPER_MODE = arg('--proper-nouns');
// HOW a name is recognised, orthogonal to how a shared one is scored. `regex` is the private ASCII
// pattern this feature was found with; `entity` is ranking.mjs's own rule, which the entity filter
// already uses; `span` takes maximal runs of capitalised tokens as one term, so "Brackenmoor Patrol"
// is a name rather than two.
// REQUIRED under the same rule. `entity` is ranking.properNounsOf via relevance.properNames — the
// shipped extractor; `entity` beat `regex` at p 0.0002 paired over 88 scenes.
const PROPER_EXTRACT = arg('--proper-nouns-extract');
const CALIB = argv.includes('--calibration');
if (has('properNouns') && !['count', 'idf', 'idf-len', 'jaccard', 'gaz'].includes(PROPER_MODE)) {
    console.error(`--proper-nouns is required with the properNouns feature: count|idf|idf-len|jaccard|gaz (got ${PROPER_MODE})`); process.exit(2);
}
if (has('properNouns') && !['regex', 'entity', 'span', 'book'].includes(PROPER_EXTRACT)) {
    console.error(`--proper-nouns-extract is required with the properNouns feature: regex|entity|span|book (got ${PROPER_EXTRACT})`); process.exit(2);
}
// ARMS COMPARE AT ONE CUTOFF. The cutoff is a user setting, not a property of an arm, so a paired
// comparison read at each arm's own F2 peak scores two configurations neither of which ships.
if (sweep && VALUES.length > 1 && CUTOFF && AT === null) {
    console.error('--sweep with --cutoff needs --at <cutoff>: arms compare at one set cutoff, not each at its own optimum.'); process.exit(2);
}
// WHICH BOUNDARY IS THE TARGET. 3 is the project's relevance line and the default; --cut 4 fits the band
// the anchors reserve for the scene's current subject, which separates far better and is far rarer, so it
// is the one place AUC and AP disagree loudly enough to be worth reading side by side.
const CUT = Number(arg('--cut') ?? 3);
if (!Number.isFinite(CUT)) { console.error(`--cut must be a number, got ${arg('--cut')}`); process.exit(2); }
const TIER = arg('--tier');
if (!['all', 'memory', 'reference'].includes(TIER)) { console.error(`--tier is required: all|memory|reference (got ${arg('--tier')})`); process.exit(2); }
// A SHIPPED MODEL IS EMITTED AT THE SHIPPED DEFINITION, or the file's two halves describe different
// targets — which is exactly the defect this guard was added with. The emitted coefficients are the
// boundaries E[credit] is built from (2 and 3, fixed by gradeCredit), so --cut only moves the AUC printed
// beside them, --relevant-at 2 replaces the target with P(>=2) outright, and --half-recall changes the
// bars the cutoff was chosen on. Each would produce a file that reads as the shipping artefact and is not.
if (EMIT_MODEL && (CUT !== 3 || RELEVANT_AT !== 3 || HALF_RECALL
    || (has('properNouns') && (PROPER_MODE !== 'idf' || PROPER_EXTRACT !== 'entity')))) {
    console.error('--emit-model writes the shipping artefact, so it runs at the shipped definition: --cut 3, --relevant-at 3, no --half-recall, '
        + 'and with properNouns, --proper-nouns idf --proper-nouns-extract entity. Drop --emit-model to explore another target.');
    process.exit(2);
}
// And it is written inside the --cutoff block, since the operating point is half of what a selection rule
// is. Without this the flag is a silent no-op: the run prints a full table and writes nothing.
if (EMIT_MODEL && !(CUTOFF && LOBO)) {
    console.error('--emit-model needs --cutoff --lobo: the cutoff is read off the held-out delivered set, and a model shipped without its operating point is not a selection rule.');
    process.exit(2);
}
// WA_EMBED_MODEL overrides; otherwise the model is the bundle's own record. Neither present is a
// refusal — the fits are per embedding model, so a run that guessed one would fit, and emit, under it.
const MODEL = process.env.WA_EMBED_MODEL ?? openSample(samples[0], arg('--arm')).embedModel;
if (!MODEL) { console.error(`${samples[0]} records no embedModel — set WA_EMBED_MODEL`); process.exit(2); }
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';

// THE FEATURE SET. One standardised column per signal and NO ELIGIBILITY INDICATORS: whether a signal is
// absent is a question about the FEATURE SET, not about a row, and it is answered by leaving the column
// out of `--features`. Every memory entry carries cosine and text, and 4 of 496 have no keys; on reference the
// only signal that varies is cosine, missing because nobody computed one, which `reindex --all` plus
// `denseAllEntries` closes. So the model is either fitted on a signal or it is not, and a mixed state is
// an author's vectorization choices rather than something to model.
//
// THE INDICATORS DID DAMAGE. A column that is 1 on 99.2% of rows is near-collinear with the intercept, so
// how the fit splits weight between them is arbitrary AND VARIES PER FOLD — and `--lobo` pools etas from
// different folds into one AUC, where those offsets stop cancelling. **Measured**, memory tier with keys
// live: removing them moved held-out AUC 0.8155 -> 0.8238, AP 0.462 -> 0.466, F2 over the delivered set
// 0.5416 -> 0.5514, and moved Ascensus — which holds 2 of the 4 keyless entries — from -0.067 to -0.007,
// the whole of what had read as one book rejecting keys. Arms whose indicators were already constant do
// not move at all.
const FEATURES = [];
const featureDef = {
    cosine: r => (Number.isFinite(r.score) ? r.score : 0),
    text: r => Number(r.textScore) || 0,
    keys: r => Number(r.keywordScore) || 0,
};
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
// `book` mode: the suggester's own corpus name test (keyword-core nameEvidence), fed the scene's
// entries, arbitrating every capitalised token — sentence-initial included, which properNounsOf cannot
// count, and with no COMMON_WORDS subtraction, since the book's own statistics are the stoplist's job
// here. Tokens are folded and lowercased by the evidence's own fold, so entry, window and df keys agree.
const makeExtract = (mode, entries) => {
    if (mode !== 'book') return text => properNouns(text, mode);
    const ev = nameEvidence();
    for (const e of entries ?? []) if (typeof e?.content === 'string') ev.wordSeq(normalizeOrthography(e.content));
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
    // THE SHIPPED ONE IS THE SHIPPED FUNCTION, not a copy of its three lines. `relevance.properNames`
    // is what stage 4 calls at runtime, so the fit and the runtime cannot drift on what a name is — the
    // same rule countKey follows for matching and scene.mjs follows for the scorers. It was open-coded
    // here, identically, right up until there were two of them.
    if (mode === 'entity') return properNames(text);
    if (mode === 'span') return properSpans(text);
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

featureDef.properNouns = r => Number(r.properShared) || 0;
featureDef.time = storyTime;
// Built below, once every scene is loaded — an entry's prior is read off its OTHER scenes and so cannot
// be computed inside the per-scene loop the way properShared is.
featureDef.oracle = r => Number(r.entryBase) || 0;
// THE THREE COMPUTABLE PRIORS, each an attempt at part of what `oracle` bounds. All are entry-intrinsic
// — they never read the query — so they are priors rather than signals, and within-scene standardisation
// still works on them because they vary between the entries of one scene.
//
// LENGTH IS LOG, because token counts run over an order of magnitude and a raw column would let one
// 15k-token entry set the scene's SD. It is not already in the model: BM25 length-normalises INSIDE
// `text`, which is a different claim — that a long document should not out-score a short one on the same
// query — and says nothing about whether long entries are likelier to be relevant at all.
featureDef.length = r => Math.log(Math.max(1, Number(r.entryTokens) || 0));
// NAMES PER 100 TOKENS, on ranking.properNounsOf — the same detector `proper` settled on. A DENSITY, not
// the count: the count is length wearing another name, and the two would be one column.
featureDef.density = r => Number(r.properDensity) || 0;
// MEAN -log10(tf/total) over the entry's tokens, the book as the corpus. "How rare is this entry's
// vocabulary among its siblings" — the surviving half of a mean-TF-IDF prior. The English-frequency half
// is deliberately absent: ZIPF_EN scores a name maximally rare and a book's own coinages with it, so the
// two axes disagree on a tenth of a book's token mass and a min-of-percentiles combination measured
// WORSE than this column alone.
featureDef.rarity = r => Number(r.bookRarity) || 0;
// NAMES PER CHUNK, the same construct as `density` at the unit the system retrieves in. Proposed off the
// DISABLED-entry population, where length-controlled it agreed with the author's keep/drop call in 7
// books of 7 — and that finding is an ARTIFACT: disabled entries sit earlier in the story (mean position
// 0.33 against 0.60), early entries name fewer distinct people because the cast has not accumulated, and
// controlling position as well as length takes it to 3 of 7 and mean AUC 0.489. It measures nothing on
// grades either. Kept because the unit is an obvious thing to try and this answers it both ways.
featureDef.chunkdens = r => Number(r.chunkDensity) || 0;
for (const f of FEATURE_LIST) FEATURES.push([f, featureDef[f]]);


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
const PRIORS = ['length', 'density', 'rarity', 'chunkdens'];
// The shipped chunking (reindex.mjs chunkConfig), which every sample here was built under.
const CHUNK_CFG = { chunkMode: 'paragraph', chunkSize: 800, minChunkSize: 120 };
// Book term-frequency, keyed by book — see the per-scene block.
const bookTf = new Map();
// The set of entry contents each book NAME holds, for the fold-identity check below. One entry per name,
// filled the first time a scene on that book is loaded.
const bookContents = new Map();

const mean = xs => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };
const fx = n => (Number.isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(3) : '  n/a');

// One query embedding per (scene, arm). The baseline sweep embeds once per scene up front; an embedModel
// sweep cannot, since the model is what varies.
const QV = new Map();
const queryVec = async (S, name, value, em) => {
    // THE SCENE IS IN THE KEY. It was (name, value) only, so every scene of an embedModel sweep was
    // handed the FIRST scene's query vector — one query scored against every scene's collection, which
    // produces a full table of plausible numbers and compares nothing. Keyed on the query TEXT rather
    // than a label, because the text is what the embedding is of.
    const k = `${name}\u001f${value}\u001f${S.query}`;
    // `label`, not `model`: the disk cache is keyed by it, and two stems can serve the same `model` id
    // while producing different vectors. The in-memory QV map stays as the within-run hit.
    if (!QV.has(k)) QV.set(k, await embed(em.query + S.query, { model: em.model, label: em.label, endpoint: em.endpoint, url: em.endpoint === 'ollama' ? OLLAMA : em.url }));
    return QV.get(k);
};

(async () => {
    // Load once, embed once. Only the gazetteer-dependent half is rebuilt per value, and loadScene is
    // cheap next to the embed call it would otherwise repeat.
    const loaded = [];
    for (const path of samples) {
        const S = openSample(path, arg('--arm'));
        if (!S.candidates?.length) { console.error(`${path}: logs no candidates`); process.exit(2); }
        // THROUGH resolveModel, like the sweep's own queryVec above. It sent the raw spec to ollama and
        // applied no task prefix, so a server-stemmed model was an unknown ollama name and a
        // prefix-trained one was silently embedded without its instruction — which does not fail, it
        // just scores the model worse than it is.
        const qv = await queryVec(S, 'baseline', MODEL, resolveModel(MODEL));
        loaded.push({ path, name: sceneLabel(S) || path, book: S.primaryBook ?? path, S, qv });
    }
    console.log(`${loaded.length} scene(s); ${sweep ? `sweeping ${SWEPT} over ${VALUES.join(', ')}` : 'shipped configuration'}${TIER === 'all' ? '' : `; ${TIER} tier only`}${CUT === 3 ? '' : `; target grade >= ${CUT}`}`);

    const table = [];
    for (const value of VALUES) {
        // Rows keep their scene, because standardisation and the intercepts are within-scene.
        const perScene = [];
        let dropped = 0;
        for (const { S, qv, name, book } of loaded) {
            const P = sceneParams(S, { ...(sweep ? { [SWEPT]: value } : {}), ...(DROP_KEYS ? { dropKeys: DROP_KEYS } : {}) });
            // THE INDEX FOLLOWS THE PARAMS. denseAllEntries wants a collection covering every entry, not
            // only the vectorized ones — scored against the standard index it would find no extra vectors
            // and report a null result that reads like an answer. ensureIndex is cached per (book, cfg,
            // all), so this costs an existsSync on every scene after the first.
            const em = resolveModel(EMBED_SWEEP ? value : MODEL);
            const indexFile = P.denseAllEntries || EMBED_SWEEP
                ? (await ensureIndex(S, { all: !!P.denseAllEntries, model: em.model, label: em.label, endpoint: em.endpoint, url: em.endpoint === 'ollama' ? OLLAMA : em.url, log: () => {} })).path
                // THE LABEL NAMES THE FILE, not the spec: cachePath and the derived ST path are both
                // written with `omlx-Qwen3-...`, while the spec is `omlx:Qwen3-...`. Passing the spec
                // resolves a path nothing ever wrote.
                : indexPath(S, { model: em.label });
            // The query has to be embedded by the same model as the collection it is scored against. A
            // stale qv here returns plausible cosines that mean nothing, which is the one failure mode of
            // this sweep that produces a number rather than an error. Memoised per (scene, arm).
            const qvec = EMBED_SWEEP ? await queryVec(S, name, value, em) : qv;
            const scene = loadScene(S, { indexFile, indexOpts: { model: em.label }, params: P });
            // THIS BOOK'S ENTRIES, not the scene's — `scene.entries` spans every attached book now, and
            // this set feeds the leave-one-book-out lineage guard, which compares two books by the share
            // of the SMALLER one they hold in common. Pooling a second book in grows the denominator and
            // silently pushes a real lineage under the 30% bar.
            if (!bookContents.has(book)) {
                bookContents.set(book, new Set((scene.entries ?? [])
                    .filter(e => e.world === book && typeof e.content === 'string' && e.content.trim())
                    .map(e => e.content.trim())));
            }
            const tw = P.entityFilter ? ranking.buildTermWeights(S.query, scene.gaz, P.boost) : null;
            const haystack = haystackFor(S, P);
            const rows = makeCandidateSet({ ...scene, params: P })(P.K1, P.B, tw, qvec, S.query, haystack);
            if (has('properNouns')) {
                // Proper nouns are a property of the SCENE, so read off a plain entry's window: an entry's
                // own sources are its, not the scene's.
                // SWEEPABLE, so two detectors can be compared paired per scene AND per book rather than
                // by diffing two runs. Absent a sweep this is PROPER_EXTRACT, so a bare run is unchanged.
                const xMode = P.properNounsExtract ?? PROPER_EXTRACT;
                const extract = makeExtract(xMode, scene.entries);
                const win = extract(haystack({}).join('\n'));
                // df over THIS book's entries, which is the corpus the names live in — the same reason
                // content-lexical insists on one index for both classes. Computed once per scene.
                const df = new Map();
                let ndoc = 0;
                if (PROPER_MODE === 'idf' || PROPER_MODE === 'idf-len') {
                    // EVERY ENTRY IS A DOCUMENT HERE, disabled included, and that is a modelling choice
                    // rather than an oversight. df asks how DISTINCTIVE a name is in the book's
                    // vocabulary, which a disabled entry still contributes to — where buildContentIndex
                    // excludes disabled entries because it is asking what can be RETRIEVED. **Measured**,
                    // memory tier, held out by book: excluding them costs F2 0.5160 -> 0.5105 at each
                    // arm's own cutoff, 7 scenes up against 53 with 34 tied, and 4 books down of 5. The
                    // runtime can compute it either way — the entries are in the book — so parity does
                    // not decide it and the measurement does.
                    //
                    // AN ENTRY WITH NO CONTENT IS NOT A DOCUMENT, which is a different question from
                    // whether it is enabled. Counting one raises ndoc while contributing no df, so it
                    // inflates every name's idf by pretending the corpus is larger than the text in it —
                    // the one way a malformed book could move this column without anybody seeing it.
                    // **Measured** no-op on this corpus (0 empty of 844 entries across 6 books), so it is
                    // a guard for other people's books and not a change to the fit.
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
                        // ONE COLUMN FOR WHAT THE MODEL RECONSTRUCTS FROM TWO. `length` was measured to be a
                        // correction to `proper`'s COUNT — dropping proper collapses it to under 1 SE — so
                        // the normalised overlap is the quantity the pair is expressing. Divided by log
                        // tokens rather than tokens, because that is the column the fit standardises.
                        // NOT the jaccard arm, which normalises by the UNION of both name sets and lost.
                        let idf = 0;
                        for (const w of ents) if (win.has(w)) idf += Math.log((ndoc + 1) / ((df.get(w) ?? 0) + 1));
                        v = idf / Math.log(Math.max(2, tokenize(r.entry?.content).length));
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
            //
            // KEYED BY THE ROW'S OWN BOOK, as the name df is: rarity asks how unusual a term is in the
            // book the entry came from, and a scene now ranks every attached book. Keying the cache on
            // the scene's primary would give a second book's entries the primary's vocabulary.
            if (PRIORS.some(has)) {
                const tfFor = (bookName) => {
                    let bk = bookTf.get(bookName);
                    if (bk) return bk;
                    const tf = new Map();
                    let total = 0;
                    // Same corpus definition as the df map above: disabled entries in, contentless ones out.
                    for (const e of scene.entries ?? []) {
                        if (e.world !== bookName || typeof e.content !== 'string' || !e.content.trim()) continue;
                        for (const t of tokenize(e.content)) { tf.set(t, (tf.get(t) ?? 0) + 1); total++; }
                    }
                    // An unseen term would divide by a zero count; the book's own vocabulary cannot
                    // contain one, but an entry excluded from scene.entries can, so it floors at 1.
                    bk = { rarity: t => -Math.log10((tf.get(t) ?? 1) / Math.max(1, total)) };
                    bookTf.set(bookName, bk);
                    return bk;
                };
                for (const r of rows) {
                    const bk = tfFor(r.entry?.world ?? book);
                    const toks = tokenize(r.entry?.content);
                    r.entryTokens = toks.length;
                    const names = ranking.properNounsOf(normalizeOrthography(String(r.entry?.content ?? '')));
                    r.properDensity = (names?.size ?? 0) / Math.max(1, toks.length) * 100;
                    // reindex.chunkConfig's defaults, NOT the scene params — those carry no chunk settings
                    // at all, and passing them gives chunkEntry an undefined chunkSize, which recurses
                    // until the stack blows rather than failing. Verified against the built index: chunk
                    // counts match on all 199 shared uids of Sommers, so this is the split the vector
                    // collection and content-lexical actually saw.
                    r.chunkDensity = (names?.size ?? 0) / Math.max(1, chunkEntry(String(r.entry?.content ?? ''), CHUNK_CFG).length);
                    r.bookRarity = toks.length ? toks.reduce((a, t) => a + bk.rarity(t), 0) / toks.length : 0;
                }
            }
            const gradeOf = makeGradeOf(S.entries, scene);
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
                if (g === null || g === undefined || Number.isNaN(g)) {
                    dropped++;
                    // Under --ungraded-negative it MOVES from `ungraded` to `kept` as a labelled 0
                    // rather than appearing in both: the cutoff sweep reads the two lists separately and
                    // would otherwise count the row twice in precision.
                    if (UNGRADED_NEGATIVE) kept.push({ r, y: 0, g: 0, wasUngraded: true });
                    else ungraded.push({ r, g: 0 });
                    continue;
                }
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

        // Design matrix: one intercept, then each signal's standardised value. Standardising within scene
        // is what makes one slope mean one thing across corpora whose BM25 lives on different scales.
        //
        // THE STATISTICS COME FROM EVERY CANDIDATE, THE ROWS ONLY FROM THE GRADED ONES. A label exists
        // only where somebody graded, but the mean and sd a coefficient is expressed in must be the ones
        // the RUNTIME computes, and the runtime has no notion of "graded" — `scoreRelevance` centres over
        // every activated row. Taking them from the pooled subset instead was a train/serve skew: the
        // ungraded tail sits low, so leaving it out lifts the mean and shrinks the sd, and every z at
        // serving time comes out larger than the fit ever saw. **Measured** at 73% pool coverage (the
        // Time Whore turn, the corpus's worst) it delivered 49 entries where the fit's own statistics
        // gave 35 — and coverage falls as a scene grows (r -0.661), so the inflation was worst exactly
        // where over-delivery already hurt. Well-covered scenes are unaffected: 3 against 3 at 93%.
        const X = [], y = [], rawCols = FEATURES.map(() => []), stats = FEATURES.map(() => ({ sd: [], mean: [] }));
        const perSignal = FEATURES.map(() => ({ s: [], y: [] }));
        const sceneCols = [];
        // Under --standardise book, the statistics pool every candidate of every scene on that book. Built
        // up front because a scene needs its BOOK's rows, which it does not hold.
        const bookPopulation = new Map();
        if (STD_BY === 'book') {
            for (const { kept, ungraded, book } of perScene) {
                if (!bookPopulation.has(book)) bookPopulation.set(book, []);
                bookPopulation.get(book).push(...kept.map(k => k.r), ...ungraded.map(u => u.r));
            }
        }
        const bookCols = new Map();
        for (const [b, rows] of bookPopulation) bookCols.set(b, FEATURES.map(([, get]) => rows.map(get)));

        for (const [si, { kept, ungraded, book }] of perScene.entries()) {
            // Every candidate the scene offered, in the order the runtime would see them: what the
            // standardisation is computed over.
            const population = [...kept.map(k => k.r), ...ungraded.map(u => u.r)];
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
                // DEGREE 2 APPENDS, never interleaves: every readout below indexes a linear coefficient
                // as base + fi, so a squared column inserted beside its own signal would silently
                // renumber all of them.
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
        // ONE BOOK IS NOT A FOLD. holdOut trains on the rows OUTSIDE each group, so a single-book scene set
        // leaves an empty training set, the fit is skipped, every eta comes back NaN — and the cutoff grid
        // then scores an empty row set and prints `F2 0.0000, delivering 0.0` as though it were a result.
        // Fatal rather than a warning: every held-out number in the run is that same NaN, and a clean zero
        // is the failure shape this codebase has been bitten by before.
        if (LOBO && books.length < 2) {
            console.error(`--lobo needs at least 2 books; these ${perScene.length} scene(s) are all "${books[0]}". `
                + `Every held-out readout would be NaN and --cutoff would print a zero. `
                + `Run the full corpus and read the per-book fold, or use --loso.`);
            process.exit(2);
        }
        // TWO NAMES FOR ONE BOOK ARE NOT TWO FOLDS. holdOut groups by book NAME, and a book is versioned
        // and renamed in place (CLAUDE.md, *Chat-based measurement*: 43 files collapse to 34 lineages at
        // 30% shared content), so a renamed copy in the sample set splits one lineage across two folds —
        // and each is then TRAINED ON ITS OWN BOOK under the other name, which is the leak holding out by
        // book exists to prevent. Observed: `LTM - Ascensus` and `LTM - Isekai Adventure - …2026-03-04`
        // are 145 entries each and 145 of 145 identical, and the fold that read as "the one that falls"
        // was the one whose training set contained itself.
        //
        // SHARE OF THE SMALLER BOOK, not of the union, and 30% is CLAUDE.md's own lineage bar rather than
        // a number chosen here. Fatal for the same reason the guard above is: a leaked fold still prints a
        // full table, and it prints a BETTER one.
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
        // The raw fit is the same design with unstandardised signals — the per-unit reading. Same intercepts,
        // so the only difference between the two is the scale the slope is expressed in.
        const Xraw = X.map((row, i) => {
            const out = row.slice(0, 1);
            FEATURES.forEach((_, fi) => out.push(rawCols[fi][i]));
            // The raw fit carries the same terms as the standardised one or it is a different model,
            // and the per-unit column beside it would be read off a design that was never fitted.
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
                const labelsAt = c => grades.map(g => (g >= c ? 1 : 0));
                const cuts = [2, 3].map(c => holdOut(i => bookOf[i], books.length, labelsAt(c)).betas);
                // THE SAME TWO BOUNDARIES, POOLED — what --emit-model ships. The grid above scores each row
                // through the fold that did not train on its book, which is the honest way to CHOOSE a
                // cutoff and the wrong thing to ship: a fold's betas are deliberately fitted on less than
                // the corpus. So the operating point is read held out and the coefficients that ride with
                // it are the pooled fit at the same two boundaries.
                const pooled = [2, 3].map(c => logisticFit(X, labelsAt(c)).beta);
                const scoreRow = (design, fold) => {
                    const eta = b => (b ? design.reduce((a, x, j) => a + x * b[j], 0) : NaN);
                    const p2 = sigmoid(eta(cuts[0][fold])), p3 = sigmoid(eta(cuts[1][fold]));
                    return RELEVANT_AT === 2 ? p2
                        : Number.isFinite(p2) && Number.isFinite(p3) ? 0.5 * p2 + 0.5 * Math.min(p3, p2) : NaN;
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
                    // Which BOOK each scene sits on, so the paired test can be read at the n that is
                    // actually independent — see the per-book block below.
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
            // --at PINS THE OPERATING POINT so two arms can be contrasted at the SAME cutoff. Each arm's
            // own best is chosen on the same macro F2 the arms are then compared by, so an arm whose
            // optimum sits deeper is credited for delivering more as if that were free — measured, the
            // proper-noun arm optimised to 0.04 against the baseline's 0.10 and delivered twice as many
            // entries, which moved 39 of 63 scenes' per-scene F2 down while the macro mean went up. A
            // paired sign test across arms is only a statement about the feature when the cutoff is held.
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
            // THE SHIPPED MODEL IS THE POOLED FIT, and the held-out numbers above are what say whether it
            // generalises. Shipping a fold's betas would ship a model deliberately trained on less than
            // the corpus. The cutoff rides along because it is not a property of the coefficients: it is
            // read off the delivered set, and a model shipped without the operating point it was chosen
            // at is not a selection rule.
            //
            // COLUMN ORDER IS THE CONTRACT: [intercept, one standardised column per feature, then any
            // squared/interaction columns appended]. The consumer must standardise WITHIN THE SCENE it is
            // scoring, as the fit did — the coefficients are per within-scene sd and mean nothing against
            // a raw value.
            //
            // TWO COEFFICIENT VECTORS, ONE PER BOUNDARY, because the target is E[credit] and not P(>=3).
            // The file used to carry the single --cut fit beside a cutoff read off the E[credit] grid, so
            // its two halves described different quantities: E[credit] >= P(>=3) everywhere the clamp
            // holds, and a consumer thresholding the emitted beta at the emitted cutoff delivered a
            // strictly tighter set than the one the number was chosen on. The boundaries are fitted
            // SEPARATELY (proportional odds does not hold here), so neither vector can be derived from
            // the other and both have to travel.
            if (EMIT_MODEL) {
                const fit = {
                    tier: TIER, cutoff: best.cut, f2: best.f,
                    // The rule the two vectors combine under, stated where a consumer reads them. The
                    // clamp is not optional for being small: 39 of 8975 rows invert, by at most 0.0002,
                    // and an incoherent probability pair is a bug that reads as a threshold effect.
                    target: 'E[credit] = 0.5*P(>=2) + 0.5*min(P(>=3), P(>=2))',
                    features: FEATURES.map(([n]) => n),
                    properNounsMode: PROPER_MODE, properNounsExtract: PROPER_EXTRACT,
                    layout: ['intercept', ...FEATURES.map(([n]) => `${n}.z`)],
                    beta: { ge2: Array.from(b.pooled[0] ?? []), ge3: Array.from(b.pooled[1] ?? []) },
                    // BOTH AUCs, because they answer different questions and the in-sample one alone
                    // would flatter a model shipped for books it has never seen. Held out by BOOK is the
                    // generalisation number production actually gets.
                    //
                    // AT THE >= 3 BOUNDARY, which is the guard above forcing --cut 3: an AUC is read on
                    // ONE ordering and E[credit] combines two, so this names the boundary rather than the
                    // shipped target. `f2` beside it is the one number here read on E[credit] itself.
                    aucAt: 3,
                    auc: t.auc ?? null,
                    heldOutAuc: t.fits?.['held out by BOOK']
                        ? auc(t.fits['held out by BOOK'].eta, t.fits['held out by BOOK'].y) : null,
                    // COUNTS, NEVER NAMES. The model file is checked in; the corpus is one person's
                    // chats and `eval-data/` is gitignored for exactly that reason. A book title names a
                    // private story, so the fold count is what travels and the named provenance stays
                    // beside the data it describes (eval-data/README.md).
                    fittedOn: {
                        scenes: b.scenes, rows: t.nRows ?? null,
                        books: Array.isArray(t.books) ? t.books.length : (Number(t.books) || null),
                    },
                };
                // MERGED INTO THE MAP, never over it. The artifact holds one fit per embedding model
                // (extension/relevance.mjs modelKey), because coefficients fitted against one embedder's
                // cosines do not carry to another — so writing the whole file would delete every other
                // model's fit, which is what happens the first time someone refits under a new embedder
                // and is exactly what this shape exists to stop.
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
        // PAIRED against the first arm, every arm at the --at cutoff — the contrast param-screen makes,
        // and the only one that can tell a real gain from the flatness of the cutoff curve.
        const bases = table.filter(t => t.best);
        if (bases.length > 1) {
            const b0 = bases[0];
            console.log(`\npaired against ${SWEPT}=${b0.value}, every arm at the ${AT} cutoff — per-scene F2, sign test`);
            // AND AGAIN PER BOOK, because the scene-level p above is not the evidence it looks like:
            // scenes on one book share its vocabulary, its entry style and its BM25 scale, so 90 scenes
            // on 5 books is nearer 5 observations than 90 and a within-book correlation is counted as
            // independent agreement (CLAUDE.md, *Graded scenes*). A change that wins on every book is a
            // change; one that wins on the largest book and loses elsewhere is a book finding wearing the
            // parameter's name — and the scene-level test cannot tell them apart, since the largest book
            // supplies most of the scenes.
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
