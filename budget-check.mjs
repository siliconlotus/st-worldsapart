// Checks the nested entry caps: vector ⊆ dynamic ⊆ all.
// Pulls applyBudget out of worldsapart.js by source slice — worldsapart.js only loads in a browser.
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('./worldsapart.js', import.meta.url), 'utf8');
const start = src.indexOf('async function applyBudget');
const body = src.slice(start, src.indexOf('\n}', start) + 2);
const applyBudget = new Function(`${body}; return applyBudget;`)();

const mk = (key, tokens, opts = {}) => ({ key, tokens, entry: { ...opts } });
const eq = (got, want, label) => console.log(`${got === want ? 'ok  ' : 'FAIL'} ${label}: ${got}${got === want ? '' : ` (want ${want})`}`);

// 7 constants then 12 dynamic, which is the walk order rankActivated produces.
const constants = Array.from({ length: 7 }, (_, i) => mk(`c${i + 1}`, 10));
const dynamic = Array.from({ length: 12 }, (_, i) => mk(`d${i + 1}`, 10));
const ranked = [...constants, ...dynamic];
const dynamicSet = new Set(dynamic);

const run = (opts) => applyBudget({
    ranked,
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
    ranked: mixed, isDynamic: () => true, tokensOf: i => i.tokens,
    maxTokens: 25, maxTotal: 0, maxDynamic: 0,
});
eq(r.survivors.size, 2, 'oversized entry is skipped, smaller ones behind it still fit');
eq(r.survivors.has(mixed[0]), false, 'the oversized entry is the one dropped');

// ignoreBudget is honoured even after a cap is exhausted, which requires not stopping.
const vip = mk('vip', 10, { ignoreBudget: true });
r = await applyBudget({
    ranked: [...dynamic.slice(0, 3), vip], isDynamic: () => true, tokensOf: i => i.tokens,
    maxTokens: 0, maxTotal: 2, maxDynamic: 0,
});
eq(r.survivors.size, 3, 'ignoreBudget entry gets in past an exhausted cap');
eq(r.survivors.has(vip), true, 'and it is the ignoreBudget one');

// ignoreBudget entries are outside the budgeted population: not capped, not counted.
// The motivating case — 10 exempt entries against a cap of 10 must not return zero.
const exempt10 = Array.from({ length: 10 }, (_, i) => mk(`x${i + 1}`, 10, { ignoreBudget: true }));
r = await applyBudget({
    ranked: [...exempt10, ...dynamic], isDynamic: item => dynamicSet.has(item), tokensOf: i => i.tokens,
    maxTokens: 0, maxTotal: 10, maxDynamic: 0,
});
eq(r.counted, 10, '10 exempt + cap 10: the cap applies to non-exempt entries only');
eq(r.survivors.size, 20, '10 exempt + cap 10 = 20 in prompt, not 10');
eq([...r.survivors].filter(x => dynamicSet.has(x)).length, 10, 'and retrieval still returns 10, not 0');

// Same for the dynamic cap — an exempt dynamic entry must not eat a dynamic slot.
const exemptDyn = Array.from({ length: 4 }, (_, i) => mk(`xd${i + 1}`, 10, { ignoreBudget: true }));
const exemptDynSet = new Set([...exemptDyn, ...dynamic]);
r = await applyBudget({
    ranked: [...exemptDyn, ...dynamic], isDynamic: item => exemptDynSet.has(item), tokensOf: i => i.tokens,
    maxTokens: 0, maxTotal: 0, maxDynamic: 5,
});
eq(r.survivors.size, 9, 'exempt dynamic entries do not consume the dynamic cap');

// Tokens are the exception by default: exempt entries are still budgeted.
const withVip = [mk('vip2', 40, { ignoreBudget: true }), ...dynamic];
r = await applyBudget({
    ranked: withVip, isDynamic: () => true, tokensOf: i => i.tokens,
    maxTokens: 60, maxTotal: 0, maxDynamic: 0,
});
eq(r.budgeted, 60, 'exempt entry takes its tokens off the top');
eq(r.inPrompt, 60, 'budgeted equals in-prompt when exempt entries are budgeted');
eq(r.survivors.size, 3, 'and squeezes what fits below it');

// ...unless the user turns that off, at which point exemption is total.
r = await applyBudget({
    ranked: withVip, isDynamic: () => true, tokensOf: i => i.tokens,
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
    ranked: boundary, isDynamic: () => true, tokensOf: i => i.tokens,
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
    ranked: drift, isDynamic: () => true, tokensOf: i => i.tokens,
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
    ranked: [mk('p', 300), mk('q', 300)], isDynamic: () => true, tokensOf: i => i.tokens,
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
    ranked: [mk('a', 300), mk('big', 250), mk('s1', 100), mk('s2', 100), mk('s3', 100)],
    isDynamic: () => true, tokensOf: i => i.tokens, maxTokens: 400, maxTotal: 0, maxDynamic: 0,
});
eq(r.skipped.length, 3, 'three entries skipped');
eq(r.skipped[0].tail, false, 'the 250 is a near miss — a later entry still got in');
eq(r.skipped[1].tail, true, 'the first 100 after the budget filled is tail');
eq(r.skipped[2].tail, true, 'and so is everything behind it');
eq(r.skipped[0].blockedBy[0].remaining, 100, 'near miss reports the room that was left');

// Everything rejected after the last admission is tail, even if sizes vary.
r = await applyBudget({
    ranked: [mk('a', 400), mk('b', 10), mk('c', 500), mk('d', 10)],
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
    ranked: twoBooks, isDynamic: () => true, tokensOf: i => i.tokens,
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
    ranked: withConstant, isDynamic: i => constSet.has(i), tokensOf: i => i.tokens,
    maxTokens: 0, maxTotal: 0, maxDynamic: 0, capOf: () => 1,
});
eq(r.survivors.size, 2, 'book cap 1: the constant plus 1 dynamic survive');
eq(r.survivors.has(withConstant[0]), true, 'the constant is not counted against the book cap');

// A count cap has no near-miss case — once it is reached nothing else can qualify.
r = await applyBudget({
    ranked: [mk('a', 10), mk('b', 10), mk('c', 10)],
    isDynamic: () => true, tokensOf: i => i.tokens, maxTokens: 0, maxTotal: 1, maxDynamic: 0,
});
eq(r.skipped.every(x => x.tail), true, 'count cap rejections are always tail');
