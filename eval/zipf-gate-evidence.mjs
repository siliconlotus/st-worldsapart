// Is the suggester's Zipf gate redundant with evidence? Diffs buildKeySuggest with the English gate on and off, and asks
// of every term the gate killed whether the chat would have flagged it anyway (over KEY_CHAT_COMMON, the audit's own gate).
// Usage:  node zipf-gate-evidence.mjs <book.json> <chat.jsonl> [<book.json> <chat.jsonl> ...]   — gold pairs only; n is the pair count.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { buildKeySuggest, STUDIO_SUGGEST_OPTS as OPTS } from '../extension/keyword-suggest.mjs';
import { KEY_CHAT_COMMON } from '../extension/keyword-audit.mjs';
import { countKey } from '../extension/matcher.mjs';

// --dump <file> writes {pair: killed terms} for a table-vs-table diff.
const argv = process.argv.slice(2);
const di = argv.indexOf('--dump');
const DUMP = di >= 0 ? argv[di + 1] : null;
const args = argv.filter((a, i) => i !== di && i !== di + 1);
const dumped = {};
if (!args.length || args.length % 2) { console.error('usage: node zipf-gate-evidence.mjs <book.json> <chat.jsonl> [...]'); process.exit(2); }

const pct = n => `${(100 * n).toFixed(1)}%`;
// Uncapped, or the diff reads the display budget as a kill.
const run = (data, msgs, englishGate) => {
    const out = new Map();
    for (const pe of buildKeySuggest(data, { ...OPTS, cap: Infinity, bgDocs: msgs, englishGate }).perEntry) {
        for (const r of pe.newRows) { const k = r.display.toLowerCase(); if (!out.has(k)) out.set(k, { term: r.display, n: r.n, df: r.df, entries: 0 }); out.get(k).entries++; }
    }
    return out;
};

for (let i = 0; i < args.length; i += 2) {
    const [bookPath, chatPath] = [args[i], args[i + 1]];
    const data = JSON.parse(readFileSync(bookPath, 'utf8'));
    const msgs = readFileSync(chatPath, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { const m = JSON.parse(l); return m.is_system ? null : m.mes; } catch { return null; } })
        .filter(m => typeof m === 'string' && m.trim());
    const on = run(data, msgs, true), off = run(data, msgs, false);
    const killed = [...off.values()].filter(r => !on.has(r.term.toLowerCase()));
    for (const r of killed) { let n = 0; for (const m of msgs) if (countKey(r.term, m, false, false) > 0) n++; r.hits = n; r.share = n / msgs.length; }
    const common = killed.filter(r => r.share >= KEY_CHAT_COMMON);
    const dead = killed.filter(r => r.hits === 0);
    const rare = killed.filter(r => r.hits >= 1 && r.hits <= 3);
    const useful = killed.filter(r => r.hits >= 4 && r.share < KEY_CHAT_COMMON);
    console.log(`\n=== ${basename(bookPath, '.json')} × ${basename(chatPath, '.jsonl')} — ${msgs.length} messages ===`);
    console.log(`gate on ${on.size} unique candidates, off ${off.size}; the gate kills ${killed.length}`);
    console.log(`  caught by chat common (>= ${KEY_CHAT_COMMON}):  ${String(common.length).padStart(5)}  ${pct(common.length / killed.length)}`);
    console.log(`  dead in the chat (0 hits):             ${String(dead.length).padStart(5)}  ${pct(dead.length / killed.length)}`);
    console.log(`  1-3 hits:                              ${String(rare.length).padStart(5)}  ${pct(rare.length / killed.length)}`);
    console.log(`  4+ hits and under the share — SURVIVES: ${String(useful.length).padStart(5)}  ${pct(useful.length / killed.length)}`);
    const show = rows => rows.sort((a, b) => b.hits - a.hits).slice(0, 25).map(r => `${r.term}(${r.hits})`).join('  ');
    console.log(`  survivors, most-firing first: ${show(useful)}`);
    console.log(`  caught, most-firing first:    ${show(common)}`);
    dumped[basename(bookPath, '.json')] = { killed: killed.map(r => ({ term: r.term, hits: r.hits })), offered: [...on.values()].map(r => r.term) };
}
if (DUMP) writeFileSync(DUMP, JSON.stringify(dumped));
