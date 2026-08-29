// Checks the nested entry caps: vector ⊆ dynamic ⊆ all.
import { applyBudget } from '../extension/delivery.mjs';
import { eq } from './metrics.mjs';

const mk = (key, tokens, opts = {}) => ({ key, tokens, entry: { ...opts } });

// 7 constants then 12 dynamic, which is the walk order onScanDone produces.
const constants = Array.from({ length: 7 }, (_, i) => mk(`c${i + 1}`, 10));
const dynamic = Array.from({ length: 12 }, (_, i) => mk(`d${i + 1}`, 10));
const walkAll = [...constants, ...dynamic];
const dynamicSet = new Set(dynamic);

const run = (opts) => applyBudget({
    walk: walkAll,
    isDynamic: item => dynamicSet.has(item),
    tokensOf: item => item.tokens,
    maxTokens: 0,
    maxTotal: 0,
    maxDynamic: 0,
    ...opts,
});
const dyn = r => [...r.survivors].filter(x => dynamicSet.has(x)).length;

// Pattern 1: all constants + top-K dynamic.
let r = await run({ maxDynamic: 10 });
eq(r.survivors.size, 17, 'dynamic cap 10 + 7 constants = 17 total');
eq(dyn(r), 10, 'dynamic cap 10 keeps 10 dynamic');
eq(constants.every(c => r.survivors.has(c)), true, 'dynamic cap never touches constants');

// Pattern 2: top-K of everything.
r = await run({ maxTotal: 10 });
eq(r.survivors.size, 10, 'total cap 10 = 10 total');
eq(dyn(r), 3, 'total cap 10 leaves room for 3 dynamic');

// Both at once — the thing the modal design could not express.
r = await run({ maxDynamic: 10, maxTotal: 25 });
eq(r.survivors.size, 17, 'both caps: dynamic binds first');
r = await run({ maxDynamic: 10, maxTotal: 12 });
eq(r.survivors.size, 12, 'both caps: total binds first');
eq(dyn(r), 5, 'both caps: total leaves 5 dynamic');

// A total cap below the constant count does cut into them; a dynamic cap never can.
r = await run({ maxTotal: 5 });
eq(r.survivors.size, 5, 'total cap below constant count cuts constants');
r = await run({ maxDynamic: 5 });
eq(r.survivors.size, 12, 'dynamic cap 5 keeps all 7 constants + 5 dynamic');

// Zero means off, independently.
r = await run({});
eq(r.survivors.size, 19, 'no caps: nothing dropped');
eq(r.dropped, 0, 'no caps: dropped count is 0');

// Token cap spans everything.
r = await run({ maxTokens: 45 });
eq(r.survivors.size, 4, 'token cap 45 at 10 each = 4 entries');
eq(r.budgeted, 40, 'token cap reports budgeted tokens');
eq(r.inPrompt, 40, 'with nothing exempt, budgeted and in-prompt agree');

// Skip-don't-stop: an entry too big for the remainder must not bar smaller ones.
const mixed = [mk('big', 100), mk('small1', 10), mk('small2', 10)];
r = await applyBudget({
    walk: mixed, isDynamic: () => true, tokensOf: i => i.tokens,
    maxTokens: 25, maxTotal: 0, maxDynamic: 0,
});
eq(r.survivors.size, 2, 'oversized entry is skipped, smaller ones behind it still fit');
eq(r.survivors.has(mixed[0]), false, 'the oversized entry is the one dropped');

// ignoreBudget is honoured even after a cap is exhausted, which requires not stopping.
const vip = mk('vip', 10, { ignoreBudget: true });
r = await applyBudget({
    walk: [...dynamic.slice(0, 3), vip], isDynamic: () => true, tokensOf: i => i.tokens,
    maxTokens: 0, maxTotal: 2, maxDynamic: 0,
});
eq(r.survivors.size, 3, 'ignoreBudget entry gets in past an exhausted cap');
eq(r.survivors.has(vip), true, 'and it is the ignoreBudget one');

// ignoreBudget entries are outside the budgeted population: not capped, not counted.
// The motivating case — 10 exempt entries against a cap of 10 must not return zero.
const exempt10 = Array.from({ length: 10 }, (_, i) => mk(`x${i + 1}`, 10, { ignoreBudget: true }));
r = await applyBudget({
    walk: [...exempt10, ...dynamic], isDynamic: item => dynamicSet.has(item), tokensOf: i => i.tokens,
    maxTokens: 0, maxTotal: 10, maxDynamic: 0,
});
eq(r.counted, 10, '10 exempt + cap 10: the cap applies to non-exempt entries only');
eq(r.survivors.size, 20, '10 exempt + cap 10 = 20 in prompt, not 10');
eq([...r.survivors].filter(x => dynamicSet.has(x)).length, 10, 'and retrieval still returns 10, not 0');

// Same for the dynamic cap — an exempt dynamic entry must not eat a dynamic slot.
const exemptDyn = Array.from({ length: 4 }, (_, i) => mk(`xd${i + 1}`, 10, { ignoreBudget: true }));
const exemptDynSet = new Set([...exemptDyn, ...dynamic]);
r = await applyBudget({
    walk: [...exemptDyn, ...dynamic], isDynamic: item => exemptDynSet.has(item), tokensOf: i => i.tokens,
    maxTokens: 0, maxTotal: 0, maxDynamic: 5,
});
eq(r.survivors.size, 9, 'exempt dynamic entries do not consume the dynamic cap');

// EXEMPT MEANS EXEMPT, on tokens as on the count caps. maxTokens is a cost guard rather than a limit
// anything downstream enforces, so charging a mandatory entry against it would collapse retrieval to pay
// for entries the author marked must-have, at flat cost — the same failure the count caps refuse.
const withVip = [mk('vip2', 40, { ignoreBudget: true }), ...dynamic];
r = await applyBudget({
    walk: withVip, isDynamic: () => true, tokensOf: i => i.tokens,
    maxTokens: 60, maxTotal: 0, maxDynamic: 0,
});
eq(r.budgeted, 60, 'the exempt entry does not spend the budget');
eq(r.inPrompt, 100, '...so the prompt is the budget PLUS what was marked mandatory');

// maxTokensIncludesExempt turns it back on, for a book whose exempt entries could overrun the context by
// themselves — there a ceiling is worth more than an honest bill.
r = await applyBudget({
    walk: withVip, isDynamic: () => true, tokensOf: i => i.tokens,
    maxTokens: 60, maxTotal: 0, maxDynamic: 0, exemptIsBudgeted: true,
});
eq(r.budgeted, 60, 'with it on, the exempt entry takes its tokens off the top');
eq(r.inPrompt, 60, '...and maxTokens is an honest ceiling on the whole of World Info');
eq(r.survivors.size, 3, 'and squeezes what fits below it');

// ...unless the user turns that off, at which point exemption is total.
r = await applyBudget({
    walk: withVip, isDynamic: () => true, tokensOf: i => i.tokens,
    maxTokens: 60, maxTotal: 0, maxDynamic: 0, exemptIsBudgeted: false,
});
eq(r.budgeted, 60, 'exemptIsBudgeted off: only the 6 non-exempt entries are budgeted');
eq(r.inPrompt, 100, 'but 100 tokens still reach the prompt — 60 budgeted, 40 exempt');
eq(r.survivors.size, 7, 'so six budgeted entries fit instead of two');

// --- budget slack: keeps the entry genuinely next in line from losing its slot ---
// Budget 400. Entries in rank order: 300, 250, 100, 100. After the 300 there are 100
// tokens left, so the 250 does not fit — without slack it is skipped and the 100 behind
// it takes the slot, which is a worse entry beating a better one.
const boundary = [mk('a', 300), mk('big', 250), mk('s1', 100), mk('s2', 100)];
const budgetRun = (opts) => applyBudget({
    walk: boundary, isDynamic: () => true, tokensOf: i => i.tokens,
    maxTokens: 400, maxTotal: 0, maxDynamic: 0, ...opts,
});

r = await budgetRun({});
eq(r.survivors.has(boundary[1]), false, 'no slack: the 250 entry is skipped at 400');
eq(r.survivors.has(boundary[2]), true, 'no slack: a smaller lower-ranked entry takes its place');
eq(r.budgeted, 400, 'no slack: budget respected exactly');

r = await budgetRun({ slack: 0.5 });
eq(r.survivors.has(boundary[1]), true, 'slack 50%: the entry next in line keeps its slot');
eq(r.budgeted, 550, 'slack 50%: 550 is within the 600 ceiling');

r = await budgetRun({ slack: 0.1 });
eq(r.survivors.has(boundary[1]), false, 'slack too small to cover the overhang: still skipped');

// Once vs all: after the slack is spent, does the ceiling snap back?
// The 40 at the end is what discriminates — it fits under the raised ceiling (490 <= 500)
// but not under the plain budget (490 > 400), so only continuous admits it.
const drift = [mk('d1', 300), mk('d2', 150), mk('d3', 40)];
const driftRun = (opts) => applyBudget({
    walk: drift, isDynamic: () => true, tokensOf: i => i.tokens,
    maxTokens: 400, maxTotal: 0, maxDynamic: 0, slack: 0.25, ...opts,
});

r = await driftRun({ slackOnce: true });
eq(r.budgeted, 450, 'once: one entry straddles to 450, then the ceiling snaps back');
eq(r.survivors.has(drift[2]), false, 'once: the 40 that would fit the raised ceiling is refused');
r = await driftRun({ slackOnce: false });
eq(r.budgeted, 490, 'all: the raised ceiling stays open');
eq(r.survivors.has(drift[2]), true, 'all: so the 40 gets in');

// --- skip reporting: every rejection names the cap(s) that caused it ---
r = await budgetRun({});
eq(r.skipped.length, 2, 'skip list records both rejected entries');
eq(r.skipped[0].blockedBy[0].cap, 'tokens', 'and names the cap');
eq(r.skipped[0].blockedBy[0].shortfall, 150, 'shortfall: 300+250 over a 400 budget');
eq(r.skipped[0].blockedBy[0].slackNeeded, 38, 'or 38% slack would have covered it');

// An entry blocked by two caps reports both, so raising one is not a wasted trip.
r = await applyBudget({
    walk: [mk('p', 300), mk('q', 300)], isDynamic: () => true, tokensOf: i => i.tokens,
    maxTokens: 400, maxTotal: 1, maxDynamic: 0,
});
eq(r.skipped[0].blockedBy.length, 2, 'both caps reported for one entry');
eq(r.skipped[0].blockedBy.map(x => x.cap).join('+'), 'tokens+total', 'named in cap order');

// Slack already spent is distinguished from slack never configured.
r = await driftRun({ slackOnce: true });
eq(r.skipped[0].blockedBy[0].slackSpent, true, 'reports that slack was already used this scan');

// --- near-miss vs exhausted tail ---
// 300 fits, 250 does not but 100 does after it (near miss), then 100 more fits, and the
// budget is exactly spent — anything after that is tail.
r = await applyBudget({
    walk: [mk('a', 300), mk('big', 250), mk('s1', 100), mk('s2', 100), mk('s3', 100)],
    isDynamic: () => true, tokensOf: i => i.tokens, maxTokens: 400, maxTotal: 0, maxDynamic: 0,
});
eq(r.skipped.length, 3, 'three entries skipped');
eq(r.skipped[0].tail, false, 'the 250 is a near miss — a later entry still got in');
eq(r.skipped[1].tail, true, 'the first 100 after the budget filled is tail');
eq(r.skipped[2].tail, true, 'and so is everything behind it');
eq(r.skipped[0].blockedBy[0].remaining, 100, 'near miss reports the room that was left');

// Everything rejected after the last admission is tail, even if sizes vary.
r = await applyBudget({
    walk: [mk('a', 400), mk('b', 10), mk('c', 500), mk('d', 10)],
    isDynamic: () => true, tokensOf: i => i.tokens, maxTokens: 400, maxTotal: 0, maxDynamic: 0,
});
eq(r.skipped.every(x => x.tail), true, 'budget exactly filled by the first entry: all rejections are tail');

// --- per-book quota: a book's dynamic entries are capped independently ---
// Two books, 4 dynamic entries each, cap book "a" at 2. Book "a" contributes at most 2;
// book "b" is untouched. This is the reservation the priority modes can't express.
const bookEntry = (world, i) => ({ key: `${world}${i}`, tokens: 10, entry: { world } });
const twoBooks = [
    bookEntry('a', 1), bookEntry('a', 2), bookEntry('a', 3), bookEntry('a', 4),
    bookEntry('b', 1), bookEntry('b', 2), bookEntry('b', 3), bookEntry('b', 4),
];
r = await applyBudget({
    walk: twoBooks, isDynamic: () => true, tokensOf: i => i.tokens,
    maxTokens: 0, maxTotal: 0, maxDynamic: 0, capOf: i => (i.entry.world === 'a' ? 2 : 0),
});
eq([...r.survivors].filter(x => x.entry.world === 'a').length, 2, 'book cap 2 admits exactly 2 from book a');
eq([...r.survivors].filter(x => x.entry.world === 'b').length, 4, 'uncapped book b keeps all 4');
eq(r.skipped.every(x => x.blockedBy[0].cap === 'book'), true, 'the skips name the book cap');
eq(r.skipped[0].blockedBy[0].world, 'a', 'and which book');

// The cap counts dynamic only — a book's constants ride free, like maxDynamic.
const withConstant = [
    { key: 'ac', tokens: 10, entry: { world: 'a', constant: true } },
    bookEntry('a', 1), bookEntry('a', 2), bookEntry('a', 3),
];
const constSet = new Set(withConstant.slice(1));
r = await applyBudget({
    walk: withConstant, isDynamic: i => constSet.has(i), tokensOf: i => i.tokens,
    maxTokens: 0, maxTotal: 0, maxDynamic: 0, capOf: () => 1,
});
eq(r.survivors.size, 2, 'book cap 1: the constant plus 1 dynamic survive');
eq(r.survivors.has(withConstant[0]), true, 'the constant is not counted against the book cap');

// A count cap has no near-miss case — once it is reached nothing else can qualify.
r = await applyBudget({
    walk: [mk('a', 10), mk('b', 10), mk('c', 10)],
    isDynamic: () => true, tokensOf: i => i.tokens, maxTokens: 0, maxTotal: 1, maxDynamic: 0,
});
eq(r.skipped.every(x => x.tail), true, 'count cap rejections are always tail');

// Sticky rows ride at the HEAD of the walk (onScanDone partitions sticky, then constant, then
// results — always-on by authorial intent), so a token squeeze exhausts the budget on them first
// and the cut lands entirely in the retrieved block. Sticky's timed-effect detection is ST-side;
// what is pure — and what this pins — is that head placement IS the protection.
{
    const sticky = Array.from({ length: 3 }, (_, i) => mk(`s${i + 1}`, 10));
    const walk = [...sticky, ...constants, ...dynamic];
    const r = await applyBudget({
        walk: walk,
        isDynamic: item => dynamicSet.has(item),
        tokensOf: item => item.tokens,
        maxTokens: 120, maxTotal: 0, maxDynamic: 0,
    });
    eq(sticky.every(s => r.survivors.has(s)), true, 'a token squeeze never reaches the sticky block');
    eq(constants.every(c => r.survivors.has(c)), true, 'nor the constants behind it');
    eq(dyn(r), 2, '120 tokens = 3 sticky + 7 constants + 2 retrieved — the cut is entirely retrieved-side');
}

// --- vector cap: the third nesting level, vector ⊆ dynamic ⊆ all -------------------------------------
// Provenance, not the `vectorized` flag: the cap bounds what RETRIEVAL contributed, so an entry admitted
// on a key it kept is keyword no matter what its flag says (see worldsapart.js onScanDone).
const vectorSet = new Set(dynamic.slice(0, 6));   // 6 of the 12 dynamic rows came from retrieval
const runV = (opts) => run({ isVector: item => vectorSet.has(item), ...opts });

let v = await runV({ maxVectorEntries: 4 });
eq(v.survivors.size, 17, 'vector cap 4: 7 constants + 4 vector + 6 keyword-only dynamic, 2 vector rows blocked');
eq([...v.survivors].filter(x => vectorSet.has(x)).length, 4, 'vector cap 4 keeps 4 vector entries');
eq(dyn(v), 10, 'the 6 non-vector dynamic rows are untouched by the vector cap');
eq(constants.every(c => v.survivors.has(c)), true, 'vector cap never touches constants');

// Nesting: a dynamic cap below the vector cap binds first, because vector rows are dynamic rows.
v = await runV({ maxVectorEntries: 6, maxDynamic: 3 });
eq(dyn(v), 3, 'dynamic cap binds before the vector cap, since vector is a subset of dynamic');
eq([...v.survivors].filter(x => vectorSet.has(x)).length, 3, 'and the survivors are vector rows, being first in walk order');

// 0 is off, matching every other cap here.
v = await runV({ maxVectorEntries: 0 });
eq(dyn(v), 12, 'vector cap 0 is off');

// A blocked row reports the cap by name, so the panel can tell the user which knob to raise.
v = await runV({ maxVectorEntries: 2 });
eq(v.skipped.some(s => s.blockedBy.some(b => b.cap === 'vector')), true, 'a vector-blocked row names the vector cap');
eq(v.skipped.filter(s => s.blockedBy.some(b => b.cap === 'vector')).length, 4, 'the 4 vector rows past the cap are each reported');

// A vectorized CONSTANT is not dynamic, so no entry cap may reject it — the vector cap included.
// isVector reads the entry's own flag and answers true for one, which is exactly why the block clause
// guards on isDynamic rather than trusting the predicate.
//
// The shared walk (constants then dynamic) cannot exercise this: applyBudget always walks
// constants before dynamic, so `vector` is still 0 throughout the constant block on any ordering a
// caller actually produces, and the guard is never reached either way. This local order — two
// vector rows exhausting the cap, THEN a constant, which no caller produces — exists only to pin
// that the function holds vector ⊆ dynamic itself rather than inheriting it from walk order. Do not
// "fix" this to match production order; that would delete the only case that tells the guard apart
// from the counter.
const constantAfterVectorCap = [dynamic[0], dynamic[1], constants[0]];
const vAfterCap = await applyBudget({
    walk: constantAfterVectorCap,
    isDynamic: item => dynamicSet.has(item),
    isVector: () => true,
    tokensOf: item => item.tokens,
    maxTokens: 0, maxTotal: 0, maxDynamic: 0, maxVectorEntries: 2,
});
eq(vAfterCap.survivors.has(constants[0]), true, 'a constant walked after the vector cap is spent still survives — the block clause checks isDynamic, not just the counter');

// --- walkOrder: the list the budget walks ------------------------------------------------------------
// The cliff that used to cut this list is gone (extension/selection.mjs); what is left is the ORDER, and
// the order is load-bearing on its own — it is what makes every cap in applyBudget a prefix cut.
import { walkOrder } from '../extension/delivery.mjs';

const row = (key, fused) => ({ key, fused, entry: {} });
const res = [row('r1', 9), row('r2', 8.9), row('r3', 8.8), row('r4', 1)];
const stick = [row('s1', 0.1)];
const cons = [row('k1', 0)];

// CONSTANT BEFORE STICKY: constant means always, so a world rule only loses its place when constants
// alone overflow the budget. The walk order is a prefix cut, so whichever class leads is served first.
eq(walkOrder({ sticky: [row('s1', 0.9)], constant: [row('k1', 0.1)], results: [] })[0].key, 'k1',
    'a constant is walked before an armed sticky, whatever their fused scores');
eq(walkOrder({ sticky: stick, constant: cons, results: res }).map(x => x.key).join(','), 'k1,s1,r1,r2,r3,r4',
    'constant and sticky lead, then the dynamic block in retention order');
eq(walkOrder({ sticky: stick, constant: cons, results: res }).length, 6,
    'nothing is dropped on the way in — every cut at this stage is applyBudget s');

// Empty blocks are the ordinary keyword-only and retrieval-only cases, not edge cases.
eq(walkOrder({ sticky: [], constant: [], results: [] }).length, 0, 'nothing activated');
eq(walkOrder({ sticky: stick, constant: cons, results: [] }).map(x => x.key).join(','), 'k1,s1',
    'a scene with no dynamic rows still ranks its always-on ones');
