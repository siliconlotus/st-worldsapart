// Offline batch version of the Studio's keyword audit: audits EVERY entry's keys. Same classifier
// (keyword-core buildKeyPruneScan / KEY_TOO_COMMON), so this and the in-app audit never drift.
//
// Per key:  dfContent — entries whose CONTENT contains the key (firing commonness)
//           dfKeys    — entries that LIST the key (shared-memory span; NOT a defect)
// A key is prunable (*) when dead (dfContent 0, never findable) or too common (in >TOO_COMMON of
// entries — fires almost always, no discrimination). Shared triggers carry continuous memory of a
// person/event, so they are never flagged.
//
// Usage:  node keyword-audit.mjs [path/to/index.json] [path/to/lorebook.json]
import { readFileSync } from 'node:fs';
import { isRegexKey } from '../extension/ranking.mjs';

const ROOT = '/Users/user/SillyTavern-Launcher/SillyTavern';
const INDEX = process.argv[2] ?? `${ROOT}/data/default-user/vectors/ollama/wa_3810524038950542/bge-m3/index.json`;
const LORE = process.argv[3] ?? `${ROOT}/data/default-user/worlds/Sommers_Pack__v22.json`;
const TOO_COMMON = 0.50;   // matches KEY_TOO_COMMON in worldsapart.js

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
const dfKeys = new Map();
for (const r of entryRows) for (const k of new Set(r.keys.map(k => k.toLowerCase()))) dfKeys.set(k, (dfKeys.get(k) ?? 0) + 1);

const dfCache = new Map();
const dfContent = key => {
    const kk = key.toLowerCase();
    if (dfCache.has(kk)) return dfCache.get(kk);
    let n = 0;
    for (const uid of uids) if (contentOf.get(uid).includes(kk)) n++;
    dfCache.set(kk, n);
    return n;
};
const prunable = key => !isRegex(key) && (dfContent(key) === 0 || dfContent(key) / nE > TOO_COMMON);

let totalKeys = 0, flaggedKeys = 0, deadKeys = 0, commonKeys = 0;
const flaggedEntries = [];
for (const r of entryRows) {
    const marks = r.keys.map(k => ({ key: k, dc: dfContent(k), dk: dfKeys.get(k.toLowerCase()) ?? 1, prune: prunable(k) }));
    totalKeys += marks.length;
    for (const m of marks) { if (m.prune) { flaggedKeys++; m.dc === 0 ? deadKeys++ : commonKeys++; } }
    const flagged = marks.filter(m => m.prune);
    if (flagged.length) flaggedEntries.push({ ...r, marks, flagged: flagged.length });
}
flaggedEntries.sort((a, b) => b.flagged - a.flagged || a.title.localeCompare(b.title));

const pct = n => `${(100 * n / totalKeys).toFixed(0)}%`;
console.log(`corpus: ${nE} entries, ${totalKeys} keys  (prune = dead, or in >${TOO_COMMON * 100}% of entries' content)`);
console.log(`prunable keys: ${flaggedKeys} (${pct(flaggedKeys)}) — dead ${deadKeys}, too-common ${commonKeys}`);
console.log(`\nENTRIES WITH FLAGGED KEYS (${flaggedEntries.length} of ${entryRows.length}):`);
for (const e of flaggedEntries) {
    console.log(`  ${e.title}  (${e.flagged} to prune)`);
    for (const m of e.marks.filter(x => x.prune)) console.log(`      * ${m.key} — content ${m.dc}/${nE}, keyed ×${m.dk}${m.dc === 0 ? ' (dead)' : ` (${Math.round(100 * m.dc / nE)}% of entries)`}`);
}
