// Does a suggested key match? Buckets buildKeySuggest's candidates by how many messages of a real chat they match (countKey, so /regex/ and ?SmartKeys score too), beside the book's own keys under their entries' flags; the chat doubles as bgDocs, exactly as the Studio passes it.
// Usage:  node suggest-match-rate.mjs <book.json> <chat.jsonl> [<book.json> <chat.jsonl> ...]   (pass several pairs; n=1 book overstates any finding)
// Both denominators are printed: per-row and unique diverge enough to invert a comparison (S11), so neither may be the only one on screen.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { buildKeySuggest, STUDIO_SUGGEST_OPTS as OPTS } from '../extension/keyword-suggest.mjs';
import { countKey } from '../extension/matcher.mjs';

const args = process.argv.slice(2);
if (!args.length || args.length % 2) {
    console.error('usage: node suggest-match-rate.mjs <book.json> <chat.jsonl> [<book.json> <chat.jsonl> ...]');
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

/** Messages this key matches in; `flags` is [caseSensitive, wholeWords]. Memoised: the naive walk is the whole runtime. */
const fireCache = new Map();
const firesIn = (key, msgs, [cs, ww] = [false, false]) => {
    const ck = `${key}${cs}${ww}`;
    if (fireCache.has(ck)) return fireCache.get(ck);
    let n = 0;
    for (const m of msgs) if (countKey(key, m, cs, ww) > 0) n++;
    fireCache.set(ck, n);
    return n;
};

/** Distinct strings per pair: the same string against two chats is two observations. */
const uniqueBy = rows => [...new Map(rows.map(r => [`${r.pair}${r.term.toLowerCase()}`, r])).values()];

const summarise = (label, rows) => {
    const inBand = BANDS.map(([lo, hi]) => rows.filter(r => r.hits >= lo && r.hits <= hi).length);
    // Bands must stay exhaustive and disjoint, or every percentage below is silently wrong.
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

    // Once per entry that lists it: a key shared by five entries is five chances to match.
    const keys = entries.flatMap(e => (Array.isArray(e.key) ? e.key : [])
        .filter(k => String(k ?? '').trim())
        .map(k => ({ pair, term: String(k), hits: firesIn(String(k), msgs, [!!e.caseSensitive, !!e.matchWholeWords]) })));

    allCand.push(...cand); allKeys.push(...keys);
    console.log(`\n${basename(bookPath)}  x  ${basename(chatPath)}   (${entries.length} entries, ${msgs.length} messages)`);
    report('this pair', cand, keys);

    const worst = uniqueBy(cand).sort((a, b) => b.hits - a.hits).slice(0, 8);
    if (worst.length) {
        console.log('\n  broadest candidates (match most often — the other failure mode):');
        for (const r of worst) console.log(`    ${String(r.hits).padStart(5)}  ${r.term}`);
    }
}

if (args.length > 2) report(`ALL ${args.length / 2} PAIRS`, allCand, allKeys);
