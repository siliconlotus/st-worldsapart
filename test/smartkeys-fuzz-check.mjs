// Seeded SmartKeys from the grammar, each tried against every text built from its own terms: a key that can match
// nothing, or matches with none of its terms present, must not get past the validator unflagged.
import { countKey } from '../extension/matcher.mjs';
import { validateSmartKey } from '../extension/smartkeys.mjs';
import { eq } from '../eval/lib/metrics.mjs';

const N = 20000;
let seed = 1;
const rnd = () => {   // mulberry32
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = a => a[Math.floor(rnd() * a.length)];

const POOL = ['alder', 'birch', 'cedar', 'dogwood', 'elm', 'fir'];
// Terms are drawn without replacement: naming one twice lets a key contradict itself, which its author can see.
const keyTokens = () => {
    const bag = [...POOL];
    const expr = depth => {
        const r = rnd();
        if (depth <= 0 || r < 0.35) {
            if (!bag.length) return [];
            const term = bag.splice(Math.floor(rnd() * bag.length), 1)[0];
            return [(rnd() < 0.3 ? '-' : '') + term + (rnd() < 0.3 ? '?' : '')];
        }
        if (r < 0.55) return [(rnd() < 0.3 ? '-' : '') + '(', ...expr(depth - 1), ...expr(depth - 1), ')' + (rnd() < 0.3 ? '?' : '')];
        return [...expr(depth - 1), pick(['OR', 'XOR', 'AND']), ...expr(depth - 1)];
    };
    return expr(3);
};
const keyOf = tokens => `? ${tokens.join(' ')}`;

// Every subset of the pool, as a text; TEXTS[0] holds none of the terms.
const TEXTS = [...Array(1 << POOL.length).keys()].map(m => ['zz', ...POOL.filter((_, i) => m & (1 << i))].join(' '));
const judge = key => {
    try {
        const alerts = validateSmartKey(key);
        if (alerts.some(a => a.severity === 'error')) return { kind: 'refused' };
        const flagged = alerts.some(a => a.severity === 'warn');
        const hits = TEXTS.map(t => countKey(key, t, false, true));
        if (hits.some(h => !Number.isFinite(h) || h < 0)) return { fail: 'a count that is not a finite, non-negative number' };
        if (hits.every(h => h === 0)) return flagged ? { kind: 'flagged' } : { fail: 'matches no text built from its own terms, unflagged' };
        if (hits[0] > 0 && !flagged) return { fail: 'matches a text holding none of its terms, unflagged' };
        return { kind: 'live' };
    } catch (e) {
        return { fail: `threw: ${e.message}` };
    }
};
// Drops tokens one at a time while the same failure holds, so what is reported is the smallest key that shows it.
const shrink = (tokens, fail) => {
    for (let i = 0; i < tokens.length; i++) {
        const fewer = tokens.toSpliced(i, 1);
        if (fewer.length && judge(keyOf(fewer)).fail === fail) return shrink(fewer, fail);
    }
    return tokens;
};

const failures = new Map(), kinds = { refused: 0, flagged: 0, live: 0 };
for (let i = 0; i < N; i++) {
    const tokens = keyTokens();
    if (!tokens.some(t => /[a-z]/.test(t))) continue;
    const { fail, kind } = judge(keyOf(tokens));
    if (kind) kinds[kind]++;
    else failures.set(keyOf(shrink(tokens, fail)), fail);
}
eq([...failures].slice(0, 10).map(([k, why]) => `${k}  (${why})`).join('\n'), '', `${N} generated keys: none fails the oracle`);
eq(kinds.live > 0 && kinds.refused > 0, true, `...and the run reached both live keys and refused ones (${JSON.stringify(kinds)})`);
