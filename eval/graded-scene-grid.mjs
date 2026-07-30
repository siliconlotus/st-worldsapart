// Graded-scene grid: reproduce WA's retrieval ranking for a REAL scene (chat query) offline, score it
// against human 0-5 grades with nDCG, and sweep any parameter — the sensitive complement to the LOO grid.
//
// Vector + BM25 + chunk-selection come from the SHARED scoring module (scoring.mjs), the exact code the
// server plugin runs; query construction, the entity filter, keyword scoring and RRF fusion come from the
// SHARED ranking module (ranking.mjs), the exact code the extension runs. Nothing here is reimplemented,
// so no signal can drift. The query embedding is the same model via ollama (validated: re-embedding a
// stored chunk → cosine ~1).
//
// VALIDATE FIRST: --validate <capture.json> prints my per-entry cosine/text/keys vs a /wa-debug capture.
//
// Usage (from SillyTavern root):
//   node .../graded-scene-grid.mjs --chat <chat.jsonl> --book <world.json> --grades <grades.txt> \
//        [--depth 5] [--index <index.json>] [--validate <capture.json>]
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { scoreCollection, selectTopK } from '../plugin/scoring.mjs';
import { buildLexical } from '../plugin/lexical.mjs';
import { corpusMean, norm } from '../plugin/vector.mjs';
import * as ranking from '../extension/ranking.mjs';   // shared client tuning layer — same code the extension runs

const arg = k => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const CHAT = arg('--chat'), BOOK = arg('--book'), GRADES = arg('--grades'), VALIDATE = arg('--validate');
const DEPTH = Number(arg('--depth') ?? 5);
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434', MODEL = process.env.WA_EMBED_MODEL ?? 'bge-m3';
const P = { K: 20, K1: 2, B: 0.75, LEXW: 1.5, boost: 3, stopwordDf: 0.25, commonWordWeight: 1, caseSensitive: false, wholeWords: false, includeNames: true, threshold: 0.1, maxVectorEntries: 20 };
if (!CHAT || !BOOK) { console.error('need --chat --book (--index optional; derived from book name)'); process.exit(2); }
// WA stores each book's vectors at wa_${getStringHash(bookName)} — derive the collection deterministically.
const getStringHash = (str, seed = 0) => { let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed; for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return 4294967296 * (2097151 & h2) + (h1 >>> 0); };
const VECTORS = arg('--vectors') ?? 'data/default-user/vectors/ollama';
const INDEX = arg('--index') ?? `${VECTORS}/wa_${getStringHash(basename(BOOK, '.json'))}/${MODEL}/index.json`;
const CID = 'wa';
const TOPK = Math.max(10, P.maxVectorEntries * 20);

const wiTitle = e => (e.comment && e.comment.trim()) ? e.comment.trim() : (e.key?.length ? e.key.join(', ') : `UID ${e.uid}`);
const nrm = s => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(t => t.length > 1);

// --- inputs ---
const chat = readFileSync(CHAT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const entries = Object.values(JSON.parse(readFileSync(BOOK, 'utf8')).entries);
const byUid = new Map(entries.map(e => [Number(e.uid), e]));
const items = JSON.parse(readFileSync(INDEX, 'utf8')).items;
const loaded = { items, mean: corpusMean(items), lexical: buildLexical(items) };

// --- query (shared buildQuery; macros left literal via identity substituteParams) + scan window ---
const query = ranking.buildQuery(chat, { depth: DEPTH });
const scanText = chat.slice(-DEPTH).map(x => (P.includeNames && x?.name ? `${x.name}: ${x.mes ?? ''}` : String(x?.mes ?? ''))).join('\n');

// --- entity filter (shared buildGazetteer + buildTermWeights) ---
const gaz = ranking.buildGazetteer(entries);
const termWeights = ranking.buildTermWeights(query, gaz, P.boost);

// --- keyword score via shared ranking.keywordScore (returns {score,hits}; harness wants the number) ---
const keywordScore = (e, text, k1) => ranking.keywordScore(e, text, e.key, { k1, caseSensitiveDefault: P.caseSensitive, wholeWordsDefault: P.wholeWords }).score;

const embed = async text => { const r = await fetch(`${OLLAMA}/api/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, input: text }) }); return (await r.json()).embeddings[0]; };
const fmt = n => (n == null ? '·' : (+n).toFixed(3));

(async () => {
    const qv = await embed(query);
    // self-check: re-embed a stored chunk → mean-centered cosine ~1
    const c0 = (v => { const o = v.map((x, i) => x - loaded.mean[i]); const n = norm(o) || 1; return o.map(x => x / n); })(items[0].vector);
    const r0 = (v => { const o = v.map((x, i) => x - loaded.mean[i]); const n = norm(o) || 1; return o.map(x => x / n); })(await embed(items[0].metadata.text));
    console.log(`query (${DEPTH} msgs, ${query.length} chars): "${query.slice(0, 80).replace(/\n/g, ' ')}…"`);
    console.log(`self-check cosine: ${r0.reduce((s, x, i) => s + x * c0[i], 0).toFixed(4)} | entities kept: ${Object.keys(termWeights).length}\n`);

    // Per-entry signals via the SHARED plugin scoring (exact vector + BM25 + selection), then keyword.
    const scoreAll = (k1, b) => {
        const grouped = selectTopK(scoreCollection(CID, loaded, qv, { centered: true, threshold: P.threshold, queryText: query, k1, b, termWeights, stopwordDf: P.stopwordDf, commonWordWeight: P.commonWordWeight }), TOPK);
        const per = new Map();   // best vector chunk + best bm25 chunk per entry (pooled independently, as the client does)
        for (const m of grouped[CID]?.metadata ?? []) { const uid = Number(m.index); const c = per.get(uid) ?? { score: -Infinity, bm25: 0 }; c.score = Math.max(c.score, m.score); c.bm25 = Math.max(c.bm25, m.bm25); per.set(uid, c); }
        const rows = [];
        for (const [uid, s] of per) { const e = byUid.get(uid); if (e) rows.push({ uid, title: wiTitle(e), score: s.score, textScore: s.bm25, keywordScore: keywordScore(e, scanText, k1) }); }
        for (const e of entries) { const uid = Number(e.uid); if (per.has(uid)) continue; const kw = keywordScore(e, scanText, k1); if (kw > 0) rows.push({ uid, title: wiTitle(e), score: undefined, textScore: 0, keywordScore: kw }); }
        return rows;
    };
    // fuse via shared ranking.fuseRanks (weightByOrder off, hybrid). It keys on item.key, so alias uid.
    const fuse = (rows, lexW) => {
        rows.forEach(r => { r.key = r.uid; });
        ranking.fuseRanks(rows, { rrfK: P.K, retrievalMode: 'hybrid', weightByOrder: false, lexicalWeight: lexW });
        return [...rows].sort((a, b) => b.fused - a.fused);
    };

    if (VALIDATE) {
        const cap = JSON.parse(readFileSync(VALIDATE, 'utf8')).filter(r => (r.block === undefined || r.block === 'dynamic') && !(Number(r.sticky) > 0));
        const mine = fuse(scoreAll(P.K1, P.B), P.LEXW);
        const find = title => { const gt = nrm(title); return mine.find(m => { const mt = new Set(nrm(m.title)); return gt.length && gt.every(t => mt.has(t)); }); };
        console.log('validation vs capture (dynamic) — cosine / text / keys, then ranks:');
        console.log('cap#  my#  | cosine(cap/mine)  text(cap/mine)  keys(cap/mine)  title');
        let n = 0, sd = 0;
        cap.forEach((c, ci) => { const m = find(c.title); if (!m) { console.log(`${String(ci).padStart(3)}   --  | (no match)  ${c.title}`); return; } const mi = mine.indexOf(m); n++; sd += (ci - mi) ** 2; console.log(`${String(ci).padStart(3)}  ${String(mi).padStart(3)}  | ${fmt(c.cosine)}/${fmt(m.score)}   ${fmt(c.text)}/${fmt(m.textScore)}   ${fmt(c.keys)}/${fmt(m.keywordScore)}   ${c.title.slice(0, 38)}`); });
        console.log(`\nmatched ${n}/${cap.length}; rank MSE ${(sd / n).toFixed(1)} (0 = identical order)`);
        return;
    }

    const grades = readFileSync(GRADES, 'utf8').split('\n').flatMap(l => { const i = l.lastIndexOf('|'); if (i < 0) return []; const t = l.slice(0, i).trim().replace(/^['"]|['"]$/g, ''); const g = Number(l.slice(i + 1).replace(/[^0-9.]/g, '')); return t && Number.isFinite(g) ? [{ tk: nrm(t), g }] : []; });
    const gradeOf = title => { const mt = new Set(nrm(title)); const h = grades.find(x => x.tk.length && x.tk.every(t => mt.has(t))); return h ? h.g : 0; };
    const dcg = (v, k) => v.slice(0, k).reduce((s, x, i) => s + x / Math.log2(i + 2), 0);
    const ndcg = (vec, k) => { const ideal = [...vec].sort((a, b) => b - a); return dcg(ideal, k) ? dcg(vec, k) / dcg(ideal, k) : 0; };
    console.log('grid (lexW × k1) — graded nDCG on the scene\n lexW   k1  | nDCG@5  nDCG@10');
    for (const lexW of [0.5, 1, 1.5, 2, 3]) for (const k1 of [1.2, 2, 3]) { const g = fuse(scoreAll(k1, P.B), lexW).map(r => gradeOf(r.title)); console.log(`${String(lexW).padStart(4)}  ${String(k1).padStart(3)}  | ${ndcg(g, 5).toFixed(4)}  ${ndcg(g, 10).toFixed(4)}`); }
})();
