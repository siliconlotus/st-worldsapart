// relevance-model-check — the stage-4 relevance prediction's pure half.
//
// Every claim here is about WA's own semantics, so none of it belongs in core-matcher-check: what a name
// is worth, what corpus df counts, and how a fitted model file becomes one number per entry. The
// arithmetic is pinned against closed forms computed by hand rather than against a second implementation,
// because a second implementation is the drift this codebase keeps paying for.
import { properNames, buildNameDf, properShared, properDensity, scoreRelevance } from '../extension/relevance.mjs';
import { eq } from './metrics.mjs';
import fs from 'node:fs';

// ---- properNames -------------------------------------------------------------------------------

// SENTENCE-INITIAL CAPITALS ARE NOT NAMES. "Then" opens both sentences and is capitalised nowhere else,
// so it never enters; "Maren" appears mid-sentence and does.
eq([...properNames('Then Maren left. Then she returned.')].sort().join(','), 'maren',
    'a name is a capital that is not sentence-initial');

// COMMON ENGLISH IS DROPPED even when it passes the capitalisation rule — "London" is in the top-2000
// list, so a book whose prose mentions it gets no signal from it.
eq(properNames('We met in London today.').has('london'), false,
    'a common English word is not counted as a name even mid-sentence');

// ORTHOGRAPHY IS NORMALISED BEFORE DETECTION, so the two apostrophes are one name. This is the rule that
// makes the entry side and the window side intersectable at all.
eq(properNames('At Maren’s Gap').has([...properNames("At Maren's Gap")][0]), true,
    'a curly and a straight apostrophe produce the same name');

// ---- buildNameDf -------------------------------------------------------------------------------

const book = [
    { world: 'B', uid: 1, content: 'The camp held Maren and Brackenmoor.' },
    { world: 'B', uid: 2, content: 'A report on Maren.', disable: true },
    { world: 'B', uid: 3, content: '   ' },
    { world: 'B', uid: 4, content: 'Nothing about the patrol at Kesh.' },
];
const idx = buildNameDf(book);

// ndoc COUNTS ENTRIES, and the contentless one is not a document — 4 entries, 3 with text.
eq(idx.ndoc, 3, 'ndoc counts entries with content, not chunks and not blank entries');
eq(idx.names.has('B.3'), false, 'a contentless entry contributes no name set');

// DISABLED ENTRIES ARE IN THE CORPUS. uid 2 is disabled and still raises maren's df to 2 — the decision
// recorded in matcher-design.md, measured at F2 0.5160 against 0.5105 for excluding them.
eq(idx.df.get('maren'), 2, 'a disabled entry still contributes to df');
eq(idx.df.get('brackenmoor'), 1, 'a name in one entry has df 1');

// ---- properShared ------------------------------------------------------------------------------

// THE CLOSED FORM, by hand: ndoc 3, brackenmoor df 1 -> log(4/2), kesh is not in the window so it pays
// nothing, and maren at df 2 -> log(4/3) is worth less than the name only one entry uses.
//
// THE WINDOW OBEYS THE SAME SENTENCE-INITIAL RULE, which is not a detail of the fixture: written as
// "Brackenmoor burned while Maren watched." the window contains no `brackenmoor` at all, because the
// only occurrence opens the sentence. The intersection is over names as BOTH sides detect them.
const win = properNames('Smoke rose as Brackenmoor burned while Maren watched.');
const rare = Math.log(4 / 2), common = Math.log(4 / 3);
eq(properShared(idx.names.get('B.1'), win, idx).toFixed(10), (rare + common).toFixed(10),
    'shared names score log((ndoc+1)/(df+1)) each');
eq(rare > common, true, 'a name fewer entries use is worth more');
eq(properShared(idx.names.get('B.4'), win, idx), 0, 'an entry sharing no name with the window scores 0');
eq(properShared(idx.names.get('B.1'), properNames('Brackenmoor burned alone.'), idx), 0,
    'a name only ever sentence-initial in the window is not in the window');

// ---- properDensity -----------------------------------------------------------------------------

// NAMES PER 100 TOKENS, pinned to a literal rather than recomputed from properNames — an assertion that
// calls the same function on both sides passes whatever that function does.
// "Word said Maren met Kesh here." is 6 tokens, 2 of them names (maren, kesh) -> 33.3333 per 100.
eq(properDensity('Word said Maren met Kesh here.').toFixed(4), (200 / 6).toFixed(4),
    'density is names per 100 tokens of the entry');
eq(properDensity(''), 0, 'an empty entry has no density rather than a division by zero');

// ---- scoreRelevance ----------------------------------------------------------------------------

// A HAND-COMPUTED MODEL. One feature, two rows: the column is [0, 2], so standardised it is [-1, +1].
// With intercept 0 and slope 1 at both boundaries, row 0 gets sigmoid(-1) at each and row 1 sigmoid(+1).
const toy = { features: ['cosine'], beta: { ge2: [0, 1], ge3: [0, 1] } };
const sig = x => 1 / (1 + Math.exp(-x));
const got = scoreRelevance(toy, [{ cosine: 0 }, { cosine: 2 }]);
eq(got[0].toFixed(10), sig(-1).toFixed(10), 'a row is standardised within the scene, not against a stored scale');
eq(got[1].toFixed(10), sig(1).toFixed(10), 'the high row takes the same curve on the other side');

// STANDARDISATION IS WITHIN THE SCENE, so the SAME raw value scores differently beside different
// neighbours. This is the property that makes an entry-level cache wrong by construction.
const alone = scoreRelevance(toy, [{ cosine: 0 }, { cosine: 100 }]);
eq(alone[0].toFixed(10), sig(-1).toFixed(10), 'the scale is the scene\'s own spread, so 0-vs-100 lands where 0-vs-2 did');

// A CONSTANT COLUMN STANDARDISES TO 0 rather than dividing by zero — the `sd || 1` guard, which has to
// match the fit's or a signal carrying no information here would meet a slope fitted on other books.
const flat = scoreRelevance(toy, [{ cosine: 7 }, { cosine: 7 }]);
eq(flat.every(v => Math.abs(v - sig(0)) < 1e-12), true, 'a within-scene constant column contributes nothing');

// THE CLAMP. ge3 is given a large positive intercept so P(>=3) would exceed P(>=2) on every row; clamped,
// E[credit] can never exceed P(>=2), which is what makes the pair a coherent probability.
const inverted = { features: ['cosine'], beta: { ge2: [0, 0], ge3: [5, 0] } };
const clamped = scoreRelevance(inverted, [{ cosine: 1 }, { cosine: 3 }]);
eq(clamped.every(v => Math.abs(v - 0.5) < 1e-12), true, 'P(>=3) is clamped to P(>=2), so E[credit] stays at P(>=2)');

// A MISSING FEATURE READS 0, not NaN: the column is a question about the FEATURE SET, and a row that
// carries no value for one still has to be scored beside its neighbours.
eq(Number.isFinite(scoreRelevance(toy, [{}, { cosine: 1 }])[0]), true, 'a row missing a signal still scores');

// A COEFFICIENT VECTOR OF THE WRONG LENGTH IS A FILE FROM ANOTHER DESIGN, and must throw rather than
// return plausible numbers — the one failure mode here that would produce a result instead of an error.
let threw = false;
try { scoreRelevance({ features: ['cosine', 'text'], beta: { ge2: [0, 1], ge3: [0, 1] } }, [{ cosine: 1 }, { cosine: 2 }]); }
catch { threw = true; }
eq(threw, true, 'a model whose beta does not match its feature count throws');

// ---- the shipped model file --------------------------------------------------------------------

// THE CHECKED-IN FILE IS THE CONTRACT the consumer reads, so its shape is pinned here rather than
// trusted: a file emitted by an older harness carried ONE beta vector at a boundary the cutoff was not
// chosen on, and nothing would have noticed at runtime.
const shipped = JSON.parse(fs.readFileSync(new URL('./relevance-model-memory.json', import.meta.url), 'utf8'));
eq(shipped.tier, 'memory', 'the shipped fit is the memory tier');
eq(Array.isArray(shipped.beta?.ge2) && Array.isArray(shipped.beta?.ge3), true,
    'the model carries one coefficient vector per boundary E[credit] is built from');
eq(shipped.beta.ge2.length, shipped.features.length + 1, 'ge2 has an intercept plus one slope per feature');
eq(shipped.beta.ge3.length, shipped.features.length + 1, 'ge3 has an intercept plus one slope per feature');
eq(shipped.layout.join(','), ['intercept', ...shipped.features.map(f => `${f}.z`)].join(','),
    'layout names the design the coefficients are in, intercept first');
eq(shipped.cutoff > 0 && shipped.cutoff < 1, true, 'the operating point ships with the coefficients');
// The two features this module exists to compute must actually be in the shipped design, or the runtime
// would be building signals nothing reads.
eq(shipped.features.includes('properNouns') && shipped.features.includes('density'), true,
    'the shipped design carries the two signals relevance.mjs computes');
// It scores end to end through the real file, which is the only assertion here that would catch a
// coefficient layout change the shape checks above accept.
const live = scoreRelevance(shipped, [
    Object.fromEntries(shipped.features.map(f => [f, 0])),
    Object.fromEntries(shipped.features.map(f => [f, 1])),
]);
eq(live.every(v => v > 0 && v < 1), true, 'the shipped model returns a probability for every row');
eq(live[1] > live[0], true, 'a row stronger on every signal scores higher, so no sign is inverted');

console.log('ok');
