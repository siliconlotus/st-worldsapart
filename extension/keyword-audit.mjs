// keyword-audit.mjs — the key audit: does an existing key work, and if not why. The prune classifier
// (buildKeyPruneScan) and the predicates its flags rest on. ST-free; keyword-tools.mjs injects the match flags.
import { COMMON_WORDS } from '../plugin/commonwords.js';
import { NAME_PARTICLES } from './relevance.mjs';
import { ZIPF_EN } from './zipf-en.js';
import { countKey, escapeRegex, isRegexKey, secondaryKeys, segment, usableKeys } from './matcher.mjs';
import { createScanScope, parse, primeScan, tokenize, validateSmartKey } from './smartkeys.mjs';


export const KEY_BOOK_COMMON = 0.5;

/** Below this many entries the df-based book-common flag is skipped; English-common still fires. */
export const KEY_MIN_BOOK_COMMON_ENTRIES = 10;

export const KEY_MIN_LENGTH = 4;

/** Share of the book that may LIST a key before it is flagged: activation breadth, not KEY_BOOK_COMMON's firing rate. */
export const KEY_BOOK_SHARED = 0.75;

/** Rare-vocabulary Jaccard at which two entries are reported near-duplicates. Advisory only: it colours, never pre-ticks (K14). */
export const KEY_DUPE_MIN = 0.35;

export const FUNCTION_WORDS = new Set('a an the and or but if then else for to of in on at by with from as is are was were be been being this that these those it its he she they them his her their you your i we our my me not no do does did has have had will would can could should'.split(' '));

/** A multi-word key containing an English function word, unless it is a constructed proper noun (looksProper); a single word is never a fragment. */
export function looksLikeFragment(key) {
    const raw = String(key ?? '').trim();
    if (looksProper(raw)) return false;
    const words = raw.toLowerCase().match(/[\p{L}][\p{L}'-]*/gu) ?? [];
    return words.length > 1 && words.some(w => FUNCTION_WORDS.has(w));
}

/** A capitalised frame with a name-particle interior; a single capitalised word qualifies. `\p{Lu}`, not `[A-Z]`. */
export function looksProper(key) {
    const tokens = String(key ?? '').trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return false;
    const cap = t => /^[^\p{L}]*\p{Lu}/u.test(t);
    return cap(tokens[0]) && cap(tokens[tokens.length - 1])
        && tokens.every(t => cap(t) || NAME_PARTICLES.has(t.toLowerCase()));
}

/** The loose term a SmartKey reduces to under `isLoose`, or null once it has a selective term anywhere: OR takes the loosest branch, AND the tightest conjunct; NOT and REGEX read as selective. */
function commonSurfaceOf(node, isLoose) {
    if (!node) return null;
    switch (node.type) {
        // A case-sensitive capitalised term can never be the common word: `? ^Mark` never matches `mark`.
        case 'TERM': {
            const v = String(node.value ?? '').trim();
            if (node.isCaseSensitive && v !== v.toLowerCase()) return null;
            return v && isLoose(v) ? v : null;
        }
        case 'OR': {
            const l = commonSurfaceOf(node.left, isLoose);
            return l ?? commonSurfaceOf(node.right, isLoose);
        }
        case 'AND': {
            const l = commonSurfaceOf(node.left, isLoose);
            if (!l) return null;
            const r = commonSurfaceOf(node.right, isLoose);
            return r ? l : null;
        }
        default: return null;
    }
}

function commonSmartKey(raw, isLoose) {
    if (!String(raw ?? '').trim().startsWith('?')) return null;
    try { return commonSurfaceOf(parse(tokenize(String(raw))), isLoose); } catch { return null; }
}

const isEnglishCommon = (list) => (v) => !/\s/.test(v) && list.has(v.toLowerCase());

/** Share of messages a key must match before a chat scan turns english-common red. Confirms only, never raises a flag (K14, K16). */
export const KEY_CHAT_COMMON = 0.20;

/**
 * The prune classifier for one loaded lorebook, shared by the Studio audit and eval/keyword-audit.mjs. Live closures:
 * classifyEntry re-reads each entry's flags. `bookContent` and `bookListed` are counts over `nBook`; `chatRate` is a share.
 * @param {{messagesWith: Map<string, number>, messages: number}} [chatScan] MESSAGES containing each key (addMessageHits), never occurrences; absent = no chat evidence
 * @returns {{entries, nE, classifyEntry, reasonOf, defChecked, severityOf, effCase, effWhole, dupes, unusableKeysOf}}
 */
/** The audit's three severities, by name. The colours they are drawn in belong to the display, and the order to RANK there. */
export const SEVERE = 'severe', MODERATE = 'moderate', MINOR = 'minor';

export function buildKeyPruneScan(data, opts, ignoreSet, { caseSensitiveDefault = false, wholeWordsDefault = false, matchWindow = 'scan', chatScan } = {}) {
    // undefined: no scan, or a scan that did not cover this key; 0: scanned and silent. chatChecked reads the difference.
    const chatRateOf = key => {
        if (!chatScan?.messages) return undefined;
        const n = chatScan.messagesWith?.get(key);
        return n === undefined ? undefined : n / chatScan.messages;
    };

    const inScope = e => {
        if (!opts.includeInactive && e.disable) return false;
        if (e.constant) return opts.scanConstant;
        if (e.vectorized) return opts.scanVectorized;
        return opts.scanKeyword;
    };
    const allEntries = Object.values(data.entries);
    const entries = allEntries.filter(inScope);
    const nE = entries.length;                                  // scan targets (which keys get audited)
    // df is over the whole book, not the scanned subset.
    const contents = allEntries.map(e => String(e.content ?? ''));
    const nBook = allEntries.length;                            // df denominator

    const bookListedBy = new Map();
    for (const e of allEntries) {
        for (const k of new Set((Array.isArray(e.key) ? e.key : []).map(x => String(x).trim().toLowerCase()))) {
            if (k) bookListedBy.set(k, (bookListedBy.get(k) ?? 0) + 1);
        }
    }

    const scanCache = new Map();
    const allKeys = [...new Set(allEntries.flatMap(e => (Array.isArray(e.key) ? e.key : []).map(k => String(k).trim())).filter(Boolean))];
    // Its OWN scope: sharing the retrieval scope would leave thousands of keys in the live automaton.
    const scanScope = createScanScope();
    const ck = (key, cs, ww) => `${cs ? 1 : 0}${ww ? 1 : 0} ${cs ? key : String(key).toLowerCase()}`;
    // Content-outer, key-inner: one automaton walk per entry serves every key.
    const batched = new Set();
    const runBatch = (cs, ww) => {
        const combo = `${cs ? 1 : 0}${ww ? 1 : 0}`;
        if (batched.has(combo)) return;
        batched.add(combo);
        // Segmented like the scan window; df still counts entries, not segments (K5).
        for (const c of contents) {
            const segments = segment([c], matchWindow);
            primeScan(allKeys, segments, scanScope);
            for (const key of allKeys) {
                let n = 0;
                for (const s of segments) n += countKey(key, s, cs, ww, scanScope);
                if (!n) continue;
                const k = ck(key, cs, ww);
                let r = scanCache.get(k);
                if (!r) scanCache.set(k, r = { df: 0, total: 0 });
                r.df++; r.total += n;
            }
        }
    };
    const scan = (key, cs, ww) => {
        runBatch(cs, ww);
        return scanCache.get(ck(key, cs, ww)) ?? { df: 0, total: 0 };
    };
    // Short-key second pass: a boundary hit is rejected when a digit sits in the surrounding run of [\d.,$£€¥], so "007" is clean in "Agent 007." but not in "$10,007.08".
    const NUMRUN = /[\d.,$£€¥]/;
    const cleanCache = new Map();
    const strictClean = (key, cs) => {
        const ck = `${cs ? 1 : 0} ${cs ? key : String(key).toLowerCase()}`;
        let n = cleanCache.get(ck);
        if (n !== undefined) return n;
        const needle = String(key);
        n = 0;
        if (needle && !/\s/.test(needle) && !isRegexKey(needle)) {
            const re = new RegExp(`(?<!\\w)${escapeRegex(needle)}(?!\\w)`, cs ? 'g' : 'gi');
            for (const hay of contents) {
                re.lastIndex = 0;
                let m;
                while ((m = re.exec(hay)) !== null) {
                    const start = m.index, end = start + m[0].length;
                    let embedded = false;
                    for (let j = start - 1; j >= 0 && NUMRUN.test(hay[j]); j--) if (hay[j] >= '0' && hay[j] <= '9') { embedded = true; break; }
                    if (!embedded) for (let j = end; j < hay.length && NUMRUN.test(hay[j]); j++) if (hay[j] >= '0' && hay[j] <= '9') { embedded = true; break; }
                    if (!embedded) n++;
                }
            }
        }
        cleanCache.set(ck, n);
        return n;
    };
    const effCase = e => e.caseSensitive ?? caseSensitiveDefault;
    const effWhole = e => e.matchWholeWords ?? wholeWordsDefault;
    // Priority: unusable, english common, unattested, book common, book shared, fragment, short.
    const classify = (key, cs, ww) => {
        const k = String(key).trim();
        if (!k) return null;
        // usableKeys, not a validator call, so which codes are fatal here stays a matcher.mjs rule.
        if (!usableKeys([k]).length) return { flag: 'unusable', code: validateSmartKey(k).find(f => f.severity === 'error')?.code };
        // English-common, fragment and short read the key as a literal; a SmartKey or regex is judged on its terms (commonSmartKey) or skipped.
        const literal = !k.startsWith('?') && !isRegexKey(k);
        const bookContent = scan(k, cs, ww).df;
        const chatRate = chatRateOf(k);
        if (opts.pruneCommon) {
            if (literal && !/\s/.test(k) && COMMON_WORDS.has(k.toLowerCase())) return { flag: 'english common', bookContent, chatRate };
            const term = literal ? null : commonSmartKey(k, isEnglishCommon(COMMON_WORDS));
            if (term) return { flag: 'english common', term, bookContent, chatRate };
        }
        if (bookContent === 0 && opts.pruneUnattested && !(literal && opts.ignoreProper && looksProper(k)) && !chatRate) return { flag: 'unattested', bookContent, literal, chatChecked: chatRate !== undefined };
        if (nBook >= KEY_MIN_BOOK_COMMON_ENTRIES && bookContent / nBook > opts.bookCommon * 0.75 && opts.pruneCommon) return { flag: 'book common', bookContent };
        if (nBook >= KEY_MIN_BOOK_COMMON_ENTRIES && !literal && opts.pruneCommon) {
            const term = commonSmartKey(k, v => scan(v, cs, ww).df / nBook > opts.bookCommon * 0.75);
            if (term) return { flag: 'book common', term, bookContent: scan(term, cs, ww).df };
        }
        const bookListed = bookListedBy.get(k.toLowerCase()) ?? 0;
        if (nBook >= KEY_MIN_BOOK_COMMON_ENTRIES && bookListed / nBook > opts.bookShared * 0.75 && opts.pruneShared) return { flag: 'book shared', bookContent, bookListed };
        if (literal && opts.pruneFragment !== false && looksLikeFragment(k)) return { flag: 'fragment', bookContent };
        if (literal && k.length < opts.minLength && !ww && opts.pruneShort) return { flag: 'short', bookContent, clean: strictClean(k, cs), total: scan(k, cs, false).total };
        return null;
    };
    /** Secondary keys the matcher will not act on, with the validator's message: a set difference against secondaryKeys, so which codes are fatal here stays a matcher.mjs rule. */
    const unusableKeysOf = (e) => {
        // `selective: false` switches the whole list off by declaration; nothing there is malformed.
        if (e?.selective === false) return [];
        const live = new Set(secondaryKeys(e));
        return (Array.isArray(e?.keysecondary) ? e.keysecondary : [])
            .filter(k => String(k ?? '').trim() && !live.has(k))
            .map(k => ({ uid: e?.uid, key: k, ...(validateSmartKey(k).find(f => f.severity === 'error') ?? {}) }));
    };
    const classifyEntry = e => {
        if (!inScope(e)) return [];
        const cs = effCase(e), ww = effWhole(e);
        const out = [];
        for (const key of (Array.isArray(e.key) ? e.key : [])) {
            if (ignoreSet.has(key)) continue;
            const c = classify(key, cs, ww);
            if (c) out.push({ uid: e.uid, key, ...c });
        }
        return out;
    };
    // Shared by reasonOf, defChecked and the Studio badge, so severity, pre-tick and problem status agree. A name, not a
    // colour: a caller comparing shades breaks the moment one is retuned, and this module has no business holding either.
    const severityOf = p => {
        if (p.flag === 'unattested') return '';
        if (p.flag === 'unusable') return SEVERE;
        if (p.flag === 'english common') return p.chatRate >= (opts.chatCommon ?? KEY_CHAT_COMMON) ? SEVERE : MODERATE;
        if (p.flag === 'book common') return p.bookContent / nBook >= opts.bookCommon ? SEVERE : MODERATE;
        if (p.flag === 'book shared') return p.bookListed / nBook >= opts.bookShared ? SEVERE : MODERATE;
        if (p.flag === 'fragment') return SEVERE;
        const ratio = p.total ? p.clean / p.total : 0;
        return ratio >= 1 ? MINOR : ratio <= 1 / 3 ? SEVERE : MODERATE;
    };
    const reasonOf = p => {
        const severity = severityOf(p);
        // A SmartKey or a pattern is not "absent from the text": it evaluated false everywhere.
        if (p.flag === 'unattested') {
            return { text: !p.literal ? 'never matches' : (p.chatChecked ? 'not in entry text or chat' : 'not in entry text'), severity };
        }
        if (p.flag === 'unusable') return { text: p.code ? `unusable — ${p.code}` : 'unusable', severity };
        if (p.flag === 'book common') return { text: `book common${p.term ? ` · ${p.term}` : ''} (${Math.round(100 * p.bookContent / nBook)}%)`, severity };
        if (p.flag === 'english common') {
            const which = p.term ? ` · ${p.term}` : '';
            return { text: p.chatRate === undefined ? `english common${which}` : `english common${which} · ${Math.round(100 * p.chatRate)}% of chat`, severity };
        }
        if (p.flag === 'book shared') return { text: `book shared (${Math.round(100 * p.bookListed / nBook)}%)`, severity };
        if (p.flag === 'fragment') return { text: 'phrase fragment', severity };
        return { text: `short (${p.clean}/${p.total} clean)`, severity };
    };
    // Pre-ticked: the red tier, plus unattested on machine-written entries only (K14). Unusable is red but wants a correction, not a deletion.
    const generated = e => e?.stmemorybooks !== undefined || e?.STMB_start !== undefined || e?.stmbArc !== undefined;
    const byUid = new Map(allEntries.map(e => [String(e.uid), e]));
    const defChecked = p => p.flag !== 'unusable' && (severityOf(p) === SEVERE || (p.flag === 'unattested' && generated(byUid.get(String(p.uid)))));

    // Near-duplicates: Jaccard over rare vocabulary; an arc and its member scene are skipped. Advisory only.
    const isArc = e => e?.stmbArc === true || /^\s*\[?\s*arc\b/i.test(String(e?.comment ?? ''));
    const dupeVocab = e => {
        const out = new Set();
        for (const w of String(e.content ?? '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []) {
            if ((ZIPF_EN.get(w) ?? 0) < 3.0) out.add(w);
        }
        return out;
    };
    // ponytail: O(n^2) over in-scope entries; if it bites, index rare term -> entries and compare only pairs sharing one.
    const dupes = new Map();
    {
        const cand = entries.filter(e => String(e.content ?? '').length > 200);
        const vocab = cand.map(dupeVocab);
        for (let i = 0; i < cand.length; i++) {
            for (let j = i + 1; j < cand.length; j++) {
                if (isArc(cand[i]) !== isArc(cand[j])) continue;
                const a = vocab[i], b = vocab[j];
                if (!a.size || !b.size) continue;
                let shared = 0;
                for (const w of a) if (b.has(w)) shared++;
                const sim = shared / (a.size + b.size - shared);
                if (sim < KEY_DUPE_MIN) continue;
                for (const [x, y] of [[i, j], [j, i]]) {
                    const list = dupes.get(cand[x].uid) ?? [];
                    list.push({ uid: cand[y].uid, title: String(cand[y].comment ?? '').trim(), sim, disabled: !!cand[y].disable });
                    dupes.set(cand[x].uid, list);
                }
            }
        }
        for (const list of dupes.values()) list.sort((p, q) => q.sim - p.sim);
    }

    return { entries, nE, classifyEntry, reasonOf, defChecked, severityOf, effCase, effWhole, dupes, unusableKeysOf };
}

/** Every entry, every mode; the suggester's dfCeil sits under bookCommon so a suggested key is never one this would flag. */
export const STUDIO_PRUNE_OPTS = { scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true, pruneUnattested: true, pruneCommon: true, pruneShort: true, pruneShared: true, pruneFragment: true, ignoreProper: false, bookCommon: KEY_BOOK_COMMON, minLength: KEY_MIN_LENGTH, bookShared: KEY_BOOK_SHARED, chatCommon: KEY_CHAT_COMMON };
