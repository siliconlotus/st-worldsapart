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

let r = await run({ maxDynamic: 10 });
eq(r.survivors.size, 17, 'dynamic cap 10 + 7 constants = 17 total');
eq(dyn(r), 10, 'dynamic cap 10 keeps 10 dynamic');
eq(constants.every(c => r.survivors.has(c)), true, 'dynamic cap never touches constants');

r = await run({ maxTotal: 10 });
eq(r.survivors.size, 10, 'total cap 10 = 10 total');
eq(dyn(r), 3, 'total cap 10 leaves room for 3 dynamic');

r = await run({ maxDynamic: 10, maxTotal: 25 });
eq(r.survivors.size, 17, 'both caps: dynamic binds first');
r = await run({ maxDynamic: 10, maxTotal: 12 });
eq(r.survivors.size, 12, 'both caps: total binds first');
eq(dyn(r), 5, 'both caps: total leaves 5 dynamic');

r = await run({ maxTotal: 5 });
eq(r.survivors.size, 5, 'total cap below constant count cuts constants');
r = await run({ maxDynamic: 5 });
eq(r.survivors.size, 12, 'dynamic cap 5 keeps all 7 constants + 5 dynamic');

r = await run({});
eq(r.survivors.size, 19, 'no caps: nothing dropped');
eq(r.dropped, 0, 'no caps: dropped count is 0');

r = await run({ maxTokens: 45 });
eq(r.survivors.size, 4, 'token cap 45 at 10 each = 4 entries');
eq(r.budgeted, 40, 'token cap reports budgeted tokens');
eq(r.inPrompt, 40, 'with nothing exempt, budgeted and in-prompt agree');

// The per-item counts the delivery panel reads back: survivors only, and they must add up to what was delivered.
const sum = m => [...m.values()].reduce((a, x) => a + x, 0);
eq(r.tokens.size, r.survivors.size, 'every survivor carries its token count');
eq([...r.survivors].every(x => r.tokens.has(x)), true, 'and the map is keyed by the item itself');
eq(sum(r.tokens), r.inPrompt, 'the per-item counts add up to inPrompt');
eq(r.skipped.every(x => !r.tokens.has(x.item)), true, 'a skipped row is not in the map; it carries its own cost');
eq(r.skipped.every(x => x.tokens === 10), true, 'and that cost is what it would have spent');

const mixed = [mk('big', 100), mk('small1', 10), mk('small2', 10)];
r = await run({ walk: mixed, isDynamic: () => true, maxTokens: 25 });
eq(r.survivors.size, 2, 'oversized entry is skipped, smaller ones behind it still fit');
eq(r.survivors.has(mixed[0]), false, 'the oversized entry is the one dropped');

const vip = mk('vip', 10, { ignoreBudget: true });
r = await run({ walk: [...dynamic.slice(0, 3), vip], isDynamic: () => true, maxTotal: 2 });
eq(r.survivors.size, 3, 'ignoreBudget entry gets in past an exhausted cap');
eq(r.survivors.has(vip), true, 'and it is the ignoreBudget one');

const exempt10 = Array.from({ length: 10 }, (_, i) => mk(`x${i + 1}`, 10, { ignoreBudget: true }));
r = await run({ walk: [...exempt10, ...dynamic], maxTotal: 10 });
eq(r.counted, 10, '10 exempt + cap 10: the cap applies to non-exempt entries only');
eq(r.survivors.size, 20, '10 exempt + cap 10 = 20 in prompt, not 10');
eq([...r.survivors].filter(x => dynamicSet.has(x)).length, 10, 'and retrieval still returns 10, not 0');

const exemptDyn = Array.from({ length: 4 }, (_, i) => mk(`xd${i + 1}`, 10, { ignoreBudget: true }));
const exemptDynSet = new Set([...exemptDyn, ...dynamic]);
r = await run({ walk: [...exemptDyn, ...dynamic], isDynamic: item => exemptDynSet.has(item), maxDynamic: 5 });
eq(r.survivors.size, 9, 'exempt dynamic entries do not consume the dynamic cap');

const withVip = [mk('vip2', 40, { ignoreBudget: true }), ...dynamic];
r = await run({ walk: withVip, isDynamic: () => true, maxTokens: 60 });
eq(r.budgeted, 60, 'the exempt entry does not spend the budget');
eq(r.inPrompt, 100, '...so the prompt is the budget PLUS what was marked mandatory');
eq(sum(r.tokens), 100, '...and the per-item counts follow the prompt, not the budget');
eq(r.tokens.get(withVip[0]), 40, 'the exempt entry carries its own count like any other');

r = await run({ walk: withVip, isDynamic: () => true, maxTokens: 60, exemptIsBudgeted: true });
eq(r.budgeted, 60, 'with it on, the exempt entry takes its tokens off the top');
eq(r.inPrompt, 60, '...and maxTokens is an honest ceiling on the whole of World Info');
eq(r.survivors.size, 3, 'and squeezes what fits below it');

r = await run({ walk: withVip, isDynamic: () => true, maxTokens: 60, exemptIsBudgeted: false });
eq(r.budgeted, 60, 'exemptIsBudgeted off: only the 6 non-exempt entries are budgeted');
eq(r.inPrompt, 100, 'but 100 tokens still reach the prompt — 60 budgeted, 40 exempt');
eq(r.survivors.size, 7, 'so six budgeted entries fit instead of two');

// --- budget slack ---
const boundary = [mk('a', 300), mk('big', 250), mk('s1', 100), mk('s2', 100)];
const budgetRun = (opts) => run({ walk: boundary, isDynamic: () => true, maxTokens: 400, ...opts });

r = await budgetRun({});
eq(r.survivors.has(boundary[1]), false, 'no slack: the 250 entry is skipped at 400');
eq(r.survivors.has(boundary[2]), true, 'no slack: a smaller lower-ranked entry takes its place');
eq(r.budgeted, 400, 'no slack: budget respected exactly');

r = await budgetRun({ slack: 0.5 });
eq(r.survivors.has(boundary[1]), true, 'slack 50%: the entry next in line keeps its slot');
eq(r.budgeted, 550, 'slack 50%: 550 is within the 600 ceiling');

r = await budgetRun({ slack: 0.1 });
eq(r.survivors.has(boundary[1]), false, 'slack too small to cover the overhang: still skipped');

// The 40 at the end discriminates: it fits the raised ceiling (490 <= 500) but not the plain budget (490 > 400).
const drift = [mk('d1', 300), mk('d2', 150), mk('d3', 40)];
const driftRun = (opts) => run({ walk: drift, isDynamic: () => true, maxTokens: 400, slack: 0.25, ...opts });

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

r = await run({ walk: [mk('p', 300), mk('q', 300)], isDynamic: () => true, maxTokens: 400, maxTotal: 1 });
eq(r.skipped[0].blockedBy.length, 2, 'both caps reported for one entry');
eq(r.skipped[0].blockedBy.map(x => x.cap).join('+'), 'tokens+total', 'named in cap order');

r = await driftRun({ slackOnce: true });
eq(r.skipped[0].blockedBy[0].slackSpent, true, 'reports that slack was already used this scan');

// --- near-miss vs exhausted tail ---
r = await run({ walk: [mk('a', 300), mk('big', 250), mk('s1', 100), mk('s2', 100), mk('s3', 100)], isDynamic: () => true, maxTokens: 400 });
eq(r.skipped.length, 3, 'three entries skipped');
eq(r.skipped[0].tail, false, 'the 250 is a near miss — a later entry still got in');
eq(r.skipped[1].tail, true, 'the first 100 after the budget filled is tail');
eq(r.skipped[2].tail, true, 'and so is everything behind it');
eq(r.skipped[0].blockedBy[0].remaining, 100, 'near miss reports the room that was left');

r = await run({ walk: [mk('a', 400), mk('b', 10), mk('c', 500), mk('d', 10)], isDynamic: () => true, maxTokens: 400 });
eq(r.skipped.every(x => x.tail), true, 'budget exactly filled by the first entry: all rejections are tail');

// --- per-book quota: a book's dynamic entries are capped independently ---
const bookEntry = (world, i) => ({ key: `${world}${i}`, tokens: 10, entry: { world } });
const twoBooks = [
    bookEntry('a', 1), bookEntry('a', 2), bookEntry('a', 3), bookEntry('a', 4),
    bookEntry('b', 1), bookEntry('b', 2), bookEntry('b', 3), bookEntry('b', 4),
];
r = await run({ walk: twoBooks, isDynamic: () => true, capOf: i => (i.entry.world === 'a' ? 2 : 0) });
eq([...r.survivors].filter(x => x.entry.world === 'a').length, 2, 'book cap 2 admits exactly 2 from book a');
eq([...r.survivors].filter(x => x.entry.world === 'b').length, 4, 'uncapped book b keeps all 4');
eq(r.skipped.every(x => x.blockedBy[0].cap === 'book'), true, 'the skips name the book cap');
eq(r.skipped[0].blockedBy[0].world, 'a', 'and which book');

const withConstant = [
    { key: 'ac', tokens: 10, entry: { world: 'a', constant: true } },
    bookEntry('a', 1), bookEntry('a', 2), bookEntry('a', 3),
];
const constSet = new Set(withConstant.slice(1));
r = await run({ walk: withConstant, isDynamic: i => constSet.has(i), capOf: () => 1 });
eq(r.survivors.size, 2, 'book cap 1: the constant plus 1 dynamic survive');
eq(r.survivors.has(withConstant[0]), true, 'the constant is not counted against the book cap');

r = await run({ walk: [mk('a', 10), mk('b', 10), mk('c', 10)], isDynamic: () => true, maxTotal: 1 });
eq(r.skipped.every(x => x.tail), true, 'count cap rejections are always tail');

// Sticky rows ride at the HEAD of the walk, as onScanDone partitions it; head placement IS the protection.
{
    const sticky = Array.from({ length: 3 }, (_, i) => mk(`s${i + 1}`, 10));
    const walk = [...sticky, ...constants, ...dynamic];
    const r = await run({ walk, maxTokens: 120 });
    eq(sticky.every(s => r.survivors.has(s)), true, 'a token squeeze never reaches the sticky block');
    eq(constants.every(c => r.survivors.has(c)), true, 'nor the constants behind it');
    eq(dyn(r), 2, '120 tokens = 3 sticky + 7 constants + 2 retrieved — the cut is entirely retrieved-side');
}

// --- vector cap: the third nesting level, vector ⊆ dynamic ⊆ all -------------------------------------
const vectorSet = new Set(dynamic.slice(0, 6));   // 6 of the 12 dynamic rows came from retrieval
const runV = (opts) => run({ isVector: item => vectorSet.has(item), ...opts });

let v = await runV({ maxVectorEntries: 4 });
eq(v.survivors.size, 17, 'vector cap 4: 7 constants + 4 vector + 6 keyword-only dynamic, 2 vector rows blocked');
eq([...v.survivors].filter(x => vectorSet.has(x)).length, 4, 'vector cap 4 keeps 4 vector entries');
eq(dyn(v), 10, 'the 6 non-vector dynamic rows are untouched by the vector cap');
eq(constants.every(c => v.survivors.has(c)), true, 'vector cap never touches constants');

v = await runV({ maxVectorEntries: 6, maxDynamic: 3 });
eq(dyn(v), 3, 'dynamic cap binds before the vector cap, since vector is a subset of dynamic');
eq([...v.survivors].filter(x => vectorSet.has(x)).length, 3, 'and the survivors are vector rows, being first in walk order');

v = await runV({ maxVectorEntries: 0 });
eq(dyn(v), 12, 'vector cap 0 is off');

v = await runV({ maxVectorEntries: 2 });
eq(v.skipped.some(s => s.blockedBy.some(b => b.cap === 'vector')), true, 'a vector-blocked row names the vector cap');
eq(v.skipped.filter(s => s.blockedBy.some(b => b.cap === 'vector')).length, 4, 'the 4 vector rows past the cap are each reported');

// The local order — two vector rows exhausting the cap, THEN a constant, which no caller produces — pins that the
// function holds vector ⊆ dynamic itself. Do not "fix" it to match production order: that deletes the only case.
const constantAfterVectorCap = [dynamic[0], dynamic[1], constants[0]];
const vAfterCap = await run({ walk: constantAfterVectorCap, isVector: () => true, maxVectorEntries: 2 });
eq(vAfterCap.survivors.has(constants[0]), true, 'a constant walked after the vector cap is spent still survives — the block clause checks isDynamic, not just the counter');

// --- walkOrder ---
import { walkOrder } from '../extension/delivery.mjs';

const row = (key, fused) => ({ key, fused, entry: {} });
const res = [row('r1', 9), row('r2', 8.9), row('r3', 8.8), row('r4', 1)];
const stick = [row('s1', 0.1)];
const cons = [row('k1', 0)];

eq(walkOrder({ sticky: [row('s1', 0.9)], constant: [row('k1', 0.1)], results: [] })[0].key, 'k1',
    'a constant is walked before an armed sticky, whatever their fused scores');
eq(walkOrder({ sticky: stick, constant: cons, results: res }).map(x => x.key).join(','), 'k1,s1,r1,r2,r3,r4',
    'constant and sticky lead, then the dynamic block in retention order');
eq(walkOrder({ sticky: stick, constant: cons, results: res }).length, 6,
    'nothing is dropped on the way in — every cut at this stage is applyBudget s');
eq(walkOrder({ sticky: stick, constant: cons, promoted: [row('p1', 0.5)], results: res }).map(x => x.key).join(','),
    'k1,s1,p1,r1,r2,r3,r4', 'promoted rows walk behind both durable blocks and ahead of the dynamic one');
eq(walkOrder({ sticky: stick, constant: cons, results: res }).map(x => x.key).join(','), 'k1,s1,r1,r2,r3,r4',
    'a caller passing no promoted block gets the walk it always got');

eq(walkOrder({ sticky: [], constant: [], results: [] }).length, 0, 'nothing activated');
eq(walkOrder({ sticky: stick, constant: cons, results: [] }).map(x => x.key).join(','), 'k1,s1',
    'a scene with no dynamic rows still ranks its always-on ones');

// --- promotion: exempt from relevance, NOT from capacity ---
{
    const promoted = Array.from({ length: 4 }, (_, i) => mk(`p${i + 1}`, 10, { world: 'A', vectorized: true }));
    const dyn4 = Array.from({ length: 4 }, (_, i) => mk(`x${i + 1}`, 10, { world: 'A', vectorized: true }));
    const dynSet = new Set(dyn4);
    const promSet = new Set(promoted);
    // The runtime's walk order: promoted ahead of dynamic.
    const walk = [...promoted, ...dyn4];
    const go = (opts) => applyBudget({
        walk,
        isDynamic: i => dynSet.has(i),
        isCapped: i => dynSet.has(i) || promSet.has(i),
        isVector: i => Boolean(i.entry.vectorized),
        tokensOf: i => i.tokens,
        maxTokens: 0, maxTotal: 0, maxDynamic: 0,
        ...opts,
    });

    let p = await go({ maxDynamic: 2 });
    eq(p.survivors.size, 6, 'maxDynamic bounds only the dynamic block: 4 promoted + 2 dynamic');
    eq(promoted.every(x => p.survivors.has(x)), true, '...so promotion cannot be eaten by a retrieval cap');

    p = await go({ maxVectorEntries: 3 });
    eq(p.survivors.size, 3, 'the vector cap counts promoted rows — capacity is not exempted');
    eq([...p.survivors].every(x => promSet.has(x)), true, '...and the walk order means they take the slots');

    p = await go({ capOf: () => 3 });
    eq(p.survivors.size, 3, 'the per-book cap counts them too, which is what stops one book flooding');

    const legacy = await run({ walk, isDynamic: i => dynSet.has(i), isVector: i => Boolean(i.entry.vectorized), maxVectorEntries: 3 });
    eq(legacy.survivors.size, 7, 'isCapped defaults to isDynamic, so a caller with no promoted block is unchanged');
}
