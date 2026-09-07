// Does a suggested key actually fire? Scores buildKeySuggest's candidates against a real chat and
// buckets them by how many messages they would match, alongside the book's own existing keys as the
// baseline. This is the harness behind the numbers in the suggester's tuning commits, which were
// otherwise reproducible only from prose.
//
// WHY THE BANDS. Utility is parabolic in firing rate, not monotonic. A key matching 0 messages can
// never do anything; one matching most of them carries no information about WHICH message. The
// middle is the product. So "% dead" and "% in 4-100" are the two numbers worth moving, and a
// candidate set that beats the book's hand-written keys on both is doing its job.
//
// Matching goes through countKey — the same matcher ST core uses, per this repo's one-matcher rule.
// That is not pedantry here: it is what lets existing keys be scored at all, since a book's keys can
// include /regex/ and ?SmartKeys that a substring test has to skip. Existing keys are matched under
// their own entry's case/whole-word flags; candidates under the defaults a newly added key would get.
//
// BOTH DENOMINATORS ARE PRINTED, and that is the point of this file as much as the bands are. The
// measurement this replaces compared per-entry candidate rows against UNIQUE existing keys and
// concluded the suggester beat the book's own keys on dead rate — the two denominators diverge
// enough on the same key set that the comparison inverted its own result (S11). Per-row counts what
// the user is offered; unique counts distinct strings. Either is
// defensible, mixing them is not, so neither is allowed to be the only one on screen.
//
// The chat doubles as bgDocs, exactly as the Studio passes the open chat, so this measures shipped
// behaviour rather than an idealisation. Scoring against the same chat that informed the ranking is
// not circular — "would these keys fire in the conversation the user is having" is the real question.
//
// Usage:  node suggest-firing.mjs <book.json> <chat.jsonl> [<book.json> <chat.jsonl> ...]
// Pairs are independent; several are worth passing because n=1 book is how the original measurement
// got its scope overstated.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { buildKeySuggest, STUDIO_SUGGEST_OPTS as OPTS } from '../extension/keyword-suggest.mjs';
import { countKey } from '../extension/matcher.mjs';

const args = process.argv.slice(2);
if (!args.length || args.length % 2) {
    console.error('usage: node suggest-firing.mjs <book.json> <chat.jsonl> [<book.json> <chat.jsonl> ...]');
    process.exit(2);
}

const BANDS = [[0, 0, '0 (dead)'], [1, 3, '1-3'], [4, 20, '4-20'], [21, 100, '21-100'], [101, Infinity, '>100 (broad)']];

const pct = n => `${(100 * n).toFixed(1)}%`;
const share = (rows, f) => rows.length ? rows.filter(f).length / rows.length : 0;
const quant = (rows, q) => {
    if (!rows.length) return 0;
    const v = rows.map(r => r.hits).sort((a, b) => a - b);
    return v[Math.floor(q * (v.length - 1))];
};

/**
 * Messages this key fires in. `flags` is [caseSensitive, wholeWords]. Memoised because the same
 * string is commonly suggested for several entries and shared triggers are listed by many, and the
 * naive walk over thousands of messages is the whole runtime.
 */
const fireCache = new Map();
const firesIn = (key, msgs, [cs, ww] = [false, false]) => {
    const ck = `${key}${cs}${ww}`;
    if (fireCache.has(ck)) return fireCache.get(ck);
    let n = 0;
    for (const m of msgs) if (countKey(key, m, cs, ww) > 0) n++;
    fireCache.set(ck, n);
    return n;
};

/**
 * Distinct strings, keeping each one's hit count. Scoped by pair: the same string measured against
 * two different chats is two different observations, so an aggregate must not fold them together.
 */
const uniqueBy = rows => [...new Map(rows.map(r => [`${r.pair}${r.term.toLowerCase()}`, r])).values()];

const summarise = (label, rows) => {
    const inBand = BANDS.map(([lo, hi]) => rows.filter(r => r.hits >= lo && r.hits <= hi).length);
    // Bands are exhaustive and disjoint by construction; if that ever stops being true every
    // percentage printed below is wrong, and silently so.
    console.assert(inBand.reduce((a, b) => a + b, 0) === rows.length, `${label}: bands do not partition ${rows.length} rows`);
    return {
        label, rows,
        dead: share(rows, r => r.hits === 0),
        useful: share(rows, r => r.hits >= 4 && r.hits <= 100),
        bands: inBand.map(n => rows.length ? n / rows.length : 0),
    };
};

const report = (title, cand, keys) => {
    console.log(`\n=== ${title} ===`);
    for (const [what, rows] of [['candidates', cand], ['existing keys', keys]]) {
        for (const [den, set] of [['per-row', rows], ['unique ', uniqueBy(rows)]]) {
            const s = summarise(`${what} ${den}`, set);
            console.log(`${what.padEnd(14)} ${den}  n=${String(s.rows.length).padStart(5)}   dead ${pct(s.dead).padStart(6)}   useful(4-100) ${pct(s.useful).padStart(6)}   median ${quant(s.rows, .5)}  p90 ${quant(s.rows, .9)}  max ${quant(s.rows, 1)}`);
        }
    }
    // Bands on per-row: that is the view of what a user is actually shown.
    const [c, k] = [summarise('candidates', cand), summarise('existing keys', keys)];
    console.log('\n  band (per-row)  candidates      keys');
    BANDS.forEach(([, , lbl], i) => console.log(`  ${lbl.padEnd(14)} ${pct(c.bands[i]).padStart(9)} ${pct(k.bands[i]).padStart(9)}`));
};

const allCand = [], allKeys = [];
for (let i = 0; i < args.length; i += 2) {
    const [bookPath, chatPath] = [args[i], args[i + 1]];
    const data = JSON.parse(readFileSync(bookPath, 'utf8'));
    const msgs = readFileSync(chatPath, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l).mes; } catch { return null; } })
        .filter(m => typeof m === 'string' && m.trim());
    if (!msgs.length) { console.error(`no messages in ${chatPath}`); process.exit(2); }
    fireCache.clear();   // counts are per chat; carrying them between pairs would silently mix books

    const pair = i / 2;
    const entries = Object.values(data.entries ?? {});
    const suggest = buildKeySuggest(data, { ...OPTS, bgDocs: msgs });
    const cand = suggest.perEntry.flatMap(pe => pe.newRows.map(r => ({ pair, term: r.display, n: r.n, hits: firesIn(r.display, msgs) })));

    // An existing key is scored once per entry that lists it: a key shared by five entries is five
    // chances to fire, and averaging it away would understate a deliberate shared trigger.
    const keys = entries.flatMap(e => (Array.isArray(e.key) ? e.key : [])
        .filter(k => String(k ?? '').trim())
        .map(k => ({ pair, term: String(k), hits: firesIn(String(k), msgs, [!!e.caseSensitive, !!e.matchWholeWords]) })));

    allCand.push(...cand); allKeys.push(...keys);
    console.log(`\n${basename(bookPath)}  x  ${basename(chatPath)}   (${entries.length} entries, ${msgs.length} messages)`);
    report('this pair', cand, keys);

    const worst = uniqueBy(cand).sort((a, b) => b.hits - a.hits).slice(0, 8);
    if (worst.length) {
        console.log('\n  broadest candidates (fire most often — the other failure mode):');
        for (const r of worst) console.log(`    ${String(r.hits).padStart(5)}  ${r.term}`);
    }
}

if (args.length > 2) report(`ALL ${args.length / 2} PAIRS`, allCand, allKeys);
