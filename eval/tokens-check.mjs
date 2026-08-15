// The offline token count must equal what the runtime recorded, or a replayed budget is not the budget.
//
// Re-derives the offset from every capture on disk that carries both a recorded `tokens` and its entry
// text, and asserts it against the table in tokens.mjs. That is what keeps TOKENIZER_OFFSET a measurement
// rather than a comment: if ST's counter changes, or a bundle appears under a tokenizer nobody calibrated,
// this fails instead of silently mis-costing every entry by a constant.
//
// Skips cleanly when no such capture is present — the synthetic bundles carry no recorded counts, and a
// checkout without eval-data has none at all. Absence is not a failure; disagreement is.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOKENIZER_OFFSET, deriveOffsets, offlineTokenCounter } from './tokens.mjs';

const DATA = resolve(dirname(fileURLToPath(import.meta.url)), 'eval-data');
let fails = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}`); if (!cond) fails++; };

const manifests = [];
if (existsSync(DATA)) {
    for (const f of readdirSync(DATA).filter(x => x.endsWith('.json') && !x.endsWith('-pending.json'))) {
        try {
            const m = JSON.parse(readFileSync(`${DATA}/${f}`, 'utf8'));
            if (m && typeof m === 'object' && (m.arms || m.candidates)) manifests.push(m);
        } catch { /* not a bundle */ }
    }
}

const derived = deriveOffsets(manifests);
if (!derived.size) {
    console.log('ok    no capture on disk carries both a recorded token count and its entry text — nothing to verify');
    process.exit(0);
}

for (const [tok, d] of derived) {
    ok(d.constant, `"${tok}": the residual is a single value across all ${d.n} rows (min ${d.min}, max ${d.max})`);
    ok(TOKENIZER_OFFSET[tok] === d.offset, `"${tok}": TOKENIZER_OFFSET says ${TOKENIZER_OFFSET[tok]}, captures say ${d.offset}`);
}

// End to end on one real row: the counter reproduces a recorded number exactly, which is the claim the
// offset table exists to support.
const withRows = manifests.find(m => (Array.isArray(m.arms) ? m.arms : [m]).some(a => a.paramSnapshot?.budget?.tokenizer && (a.candidates ?? []).some(c => Number(c.tokens) > 0)));
if (withRows) {
    const arm = (Array.isArray(withRows.arms) ? withRows.arms : [withRows]).find(a => a.paramSnapshot?.budget?.tokenizer);
    const byUid = new Map();
    for (const [world, bk] of Object.entries(withRows.books ?? {})) for (const e of Object.values(bk)) byUid.set(`${world}${e.uid}`, e);
    const counter = offlineTokenCounter(arm.paramSnapshot.budget.tokenizer);
    const rows = (arm.candidates ?? []).filter(c => Number(c.tokens) > 0 && byUid.get(`${c.world}${c.uid}`)?.content);
    const wrong = rows.filter(c => counter.count(byUid.get(`${c.world}${c.uid}`).content) !== Number(c.tokens));
    counter.free();
    ok(wrong.length === 0, `offlineTokenCounter reproduces every recorded count on one capture (${rows.length} rows, ${wrong.length} mismatched)`);
}

console.log(fails ? `\n${fails} FAILED` : '\nok');
process.exit(fails ? 1 : 0);
