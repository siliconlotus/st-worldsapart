// Offline batch version of the Studio's keyword audit: per key, dfContent (entries whose content contains it) and bookListedBy (entries listing it); prunable when dead. Shared triggers are never flagged.
// Usage:  node keyword-audit.mjs <index.json> <lorebook.json> [--json out.json]   (--json writes the flagged strings as a flat array, what scene.mjs dropKeys takes)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isRegexKey } from '../extension/matcher.mjs';
// The threshold has an authoritative home; a restated 0.50 here is how this and the in-app audit drift.
import { stInstall } from './lib/scene.mjs';

// The install is located, never named: an absolute path here is one machine's (scene.mjs stInstall).
const ST = stInstall();
const JSON_OUT = (() => { const i = process.argv.indexOf('--json'); return i >= 0 ? process.argv[i + 1] : null; })();
const positional = process.argv.slice(2).filter((a, i, xs) => !a.startsWith('--') && xs[i - 1] !== '--json');
const INDEX = positional[0];
const LORE = positional[1];
if (!INDEX || !LORE) { console.error('usage: node keyword-audit.mjs <index.json> <lorebook.json> [--json out.json]'); process.exit(2); }
for (const [what, path] of [['index', INDEX], ['lorebook', LORE]]) {
    if (path && existsSync(path)) continue;
    console.error(`${what} not found: ${path}`);
    console.error('usage: node keyword-audit.mjs <path/to/index.json> <path/to/lorebook.json> [--json out.json]');
    process.exit(2);
}
const idx = JSON.parse(readFileSync(INDEX, 'utf8'));
const lb = JSON.parse(readFileSync(LORE, 'utf8'));

// per-entry concatenated content, lowercased (from the vector index chunks)
const contentOf = new Map();
for (const it of idx.items) {
    const uid = Number(it.metadata.index);
    contentOf.set(uid, (contentOf.get(uid) ?? '') + '\n' + String(it.metadata.text ?? '').toLowerCase());
}
const uids = [...contentOf.keys()];
const nE = uids.length;

const entryRows = Object.values(lb.entries)
    .map(e => ({ uid: Number(e.uid), title: e.comment || `uid ${e.uid}`, keys: (Array.isArray(e.key) ? e.key : []).map(String) }))
    .filter(e => contentOf.has(e.uid) && e.keys.length);

const isRegex = isRegexKey;
const bookListedBy = new Map();
for (const r of entryRows) for (const k of new Set(r.keys.map(k => k.toLowerCase()))) bookListedBy.set(k, (bookListedBy.get(k) ?? 0) + 1);

const dfCache = new Map();
const dfContent = key => {
    const kk = key.toLowerCase();
    if (dfCache.has(kk)) return dfCache.get(kk);
    let n = 0;
    for (const uid of uids) if (contentOf.get(uid).includes(kk)) n++;
    dfCache.set(kk, n);
    return n;
};
const prunable = key => !isRegex(key) && dfContent(key) === 0;

let totalKeys = 0, flaggedKeys = 0, deadKeys = 0, commonKeys = 0;
const flaggedEntries = [];
for (const r of entryRows) {
    const marks = r.keys.map(k => ({ key: k, bookContent: dfContent(k), bookListed: bookListedBy.get(k.toLowerCase()) ?? 1, prune: prunable(k) }));
    totalKeys += marks.length;
    for (const m of marks) { if (m.prune) { flaggedKeys++; m.bookContent === 0 ? deadKeys++ : commonKeys++; } }
    const flagged = marks.filter(m => m.prune);
    if (flagged.length) flaggedEntries.push({ ...r, marks, flagged: flagged.length });
}
flaggedEntries.sort((a, b) => b.flagged - a.flagged || a.title.localeCompare(b.title));

const pct = n => `${(100 * n / totalKeys).toFixed(0)}%`;
console.log(`corpus: ${nE} entries, ${totalKeys} keys  (prune = dead)`);
console.log(`prunable keys: ${flaggedKeys} (${pct(flaggedKeys)}) — dead ${deadKeys}, too-common ${commonKeys}`);
console.log(`\nENTRIES WITH FLAGGED KEYS (${flaggedEntries.length} of ${entryRows.length}):`);
for (const e of flaggedEntries) {
    console.log(`  ${e.title}  (${e.flagged} to prune)`);
    for (const m of e.marks.filter(x => x.prune)) console.log(`      * ${m.key} — content ${m.bookContent}/${nE}, keyed ×${m.bookListed}${m.bookContent === 0 ? ' (dead)' : ` (${Math.round(100 * m.bookContent / nE)}% of entries)`}`);
}

if (JSON_OUT) {
    // Deduped by exact string: dropKeys matches exactly, and a shared trigger flagged once is flagged everywhere.
    const keys = [...new Set(flaggedEntries.flatMap(e => e.marks.filter(m => m.prune).map(m => m.key)))];
    writeFileSync(JSON_OUT, JSON.stringify(keys, null, 1));
    console.log(`\n${keys.length} distinct flagged key strings -> ${JSON_OUT}`);
}
