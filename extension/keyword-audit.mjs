// keyword-audit.mjs — the key audit: does an existing key work, and if not why. The prune classifier
// (buildKeyPruneScan) and the predicates its flags rest on. ST-free; keyword-tools.mjs injects the match flags.
import { NAME_PARTICLES } from './relevance.mjs';
import { table } from './lang.mjs';
import { countKey, countRegexKey, escapeRegex, isRegexKey, secondaryKeys, segment, swapLiteralHyphens, usableKeys } from './matcher.mjs';
import { cachedCount, createScanScope, hitLiterals, ORTHO_FAMILIES, parse, primeScan, registerKeys, tokenize, validateSmartKey } from './smartkeys.mjs';


/** Below this many entries the df-based book-shared flag is skipped; common word still applies. */
export const KEY_MIN_SHARED_ENTRIES = 10;

export const KEY_MIN_LENGTH = 4;

/** Share of the book that may LIST a key before it is flagged: how many entries one match activates. */
export const KEY_BOOK_SHARED = 0.75;

/** Rare-vocabulary Jaccard at which two entries are reported near-duplicates. Advisory only: it colours (K14). */
export const KEY_DUPE_MIN = 0.35;

export const FUNCTION_WORDS = new Set('a an the and or but if then else for to of in on at by with from as is are was were be been being this that these those it its he she they them his her their you your i we our my me not no do does did has have had will would can could should'.split(' '));

/** A multi-word key containing an English function word, unless it is a constructed proper noun (looksProper) — a titular
 *  `the` in either case does not break the frame, so `the Spire` is a name where `the door` is not; a single word is never a fragment. */
export function looksLikeFragment(key) {
    const raw = String(key ?? '').trim();
    if (looksProper(raw) || looksProper(raw.replace(/^the\s+/i, ''))) return false;
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
/** A TERM as its author wrote it — flags, and quotes where the value would not lex as one term — so a probe built from
 *  it evaluates under the same rules. */
const renderTerm = n => {
    const v = String(n.value ?? '').trim();
    const bare = /^[^\s()|&"]+$/.test(v) && !/^(?:AND|OR|NOT|XOR)$/i.test(v) && !/^[-!+]/.test(v);
    return `${n.isExact ? '=' : ''}${n.isCaseSensitive ? '^' : ''}${bare ? v : `"${v}"`}`;
};

/** Every path through the AST as its TERM nodes: an OR contributes each member, an AND the cross-product of its sides. */
function pathsOf(node) {
    if (!node) return [];
    switch (node.type) {
        case 'TERM': return [[node]];
        case 'OR': return [...pathsOf(node.left), ...pathsOf(node.right)];
        case 'AND': { const l = pathsOf(node.left), r = pathsOf(node.right); return l.flatMap(a => r.map(b => [...a, ...b])); }
        default: return [];
    }
}
// A case-sensitive capitalised term can never be the common word: `? ^Mark` never matches `mark`.
const commonTerm = (n, isLoose) => { const v = String(n.value ?? '').trim(); return Boolean(v) && isLoose(v) && !(n.isCaseSensitive && v !== v.toLowerCase()); };

/** A SmartKey's paths, each as a probe the chat scan can count — `? =mom =my` — with `common` set on a path made entirely
 *  of common words. The whole product: the path that matches most is the one to name, common or not. */
function smartPaths(raw, isLoose) {
    if (!String(raw ?? '').trim().startsWith('?')) return [];
    let paths;
    try { paths = pathsOf(parse(tokenize(String(raw)))); } catch { return []; }
    return paths.map(p => ({ label: p.map(n => String(n.value).trim()).join(' & '), probe: `? ${p.map(renderTerm).join(' ')}`, common: p.every(n => commonTerm(n, isLoose)) }));
}

/** The probes the chat scan counts beside a SmartKey so `chat common` can name the path that matches most. A single path
 *  needs no probe: it is the key. Sent only for keys over the chat-common share, a probe being a SmartKey evaluated per
 *  message. */
export const pathProbes = k => { const p = smartPaths(k, isCommonWord(table().common)); return p.length > 1 ? p.map(x => x.probe) : []; };

const isCommonWord = (list) => (v) => !/\s/.test(v) && list.has(v.toLowerCase());

/** Share of messages a key must match to be `chat common`, and to turn `common word` red. */
export const KEY_CHAT_COMMON = 0.20;
/** Share of messages at which `chat common` is severe rather than moderate: more messages than not. An assertion. */
export const KEY_CHAT_SEVERE = 0.50;
/** Share of the book's entries whose content a key must appear in to be `book common` — the no-chat fallback for
 *  `chat common`. An assertion; 0.45 rather than a half so a book of few entries does not sit on the line. */
export const KEY_BOOK_COMMON = 0.45;

/**
 * The prune classifier for one loaded lorebook, shared by the Studio audit and eval/keyword-audit.mjs. Live closures:
 * classifyEntry re-reads each entry's flags. `bookContent` and `bookListed` are counts over `nBook`; `chatRate` is a share.
 * @param {{messagesWith: Map<string, number>, messages: number}} [chatScan] MESSAGES containing each key (addMessageHits), never occurrences; absent = no chat evidence
 * @param {Function} [t] the template tag every verdict text goes through; ST passes its i18n `t`, the checks take the plain default
 * @returns {{entries, nE, classifyEntry, reasonOf, severityOf, effCase, effWhole, dupes, unusableKeysOf}}
 */
/** The audit's three severities, by name. The colours they are drawn in belong to the display, and the order to RANK there. */
export const SEVERE = 'severe', MODERATE = 'moderate', MINOR = 'minor';

/** The order `classify` tests its branches in, so a display can rank verdicts without re-deriving them. */
export const FLAG_PRIORITY = ['unusable', 'substring', 'chat common', 'book common', 'book shared', 'regex orthography', 'common word', 'fragment', 'short', 'unattested', 'variant only'];

/** Each orthographic form a regex key cannot reach: `alt` is the pattern rewritten into it, `label` names it, and
 *  `shape` marks the one that flags without evidence. Exported so a chat scan can count these beside the keys —
 *  a verdict can only cite evidence for a pattern somebody counted. */
export function orthoAlternates(k) {
    const raw = String(k ?? '').trim();
    if (!isRegexKey(raw)) return [];
    const out = [];
    for (const f of ORTHO_FAMILIES) {
        const straight = raw.includes(f.ascii);
        const curly = [...f.pair].some(c => raw.includes(c));
        if (straight === curly) continue;                        // both sides, or neither: nothing to say
        const common = { label: straight ? 'curly form' : 'straight form', suggest: `[${f.ascii}${f.pair}]` };
        // A quote is never a metacharacter, so a 1-for-1 swap is safe anywhere, class or not.
        if (straight) for (const v of f.pair) out.push({ alt: raw.replaceAll(f.ascii, v), shape: true, ...common });
        else out.push({ alt: [...f.pair].reduce((a, v) => a.replaceAll(v, f.ascii), raw), shape: false, ...common });
    }
    // The hyphen never flags on shape: a literal hyphen in a pattern is ordinary.
    const en = raw.includes('–') ? null : swapLiteralHyphens(raw, '–');
    if (en && en !== raw) out.push({ alt: en, shape: false, label: 'en-dash', suggest: '[-–]' });
    return out;
}

/** The probes `substring` reads for a literal key: the key whole-word, and — only where the key has a capital, since
 *  the wrong-case case is `Mark` hitting `mark` and a lowercase key hitting sentence-initial "Morning" is the right
 *  word — the key case-sensitive. Each is a quoted SmartKey so an operator character or a space lexes as one term. Scanned beside the key by
 *  whoever scans the chat, and only for keys already over the chat-common gate: a probe is a SmartKey evaluated per
 *  message, so probing every key would cost more than the scan. */
export const substringProbes = k => (k.includes('"') ? [] : [`? ="${k}"`, ...(/\p{Lu}/u.test(k) ? [`? ^"${k}"`] : [])]);

/** Plain interpolation: what the injected `t` does when nobody supplies one, so the checks assert English. */
const plain = (s, ...v) => s.reduce((a, str, i) => a + str + (i < v.length ? String(v[i] ?? '') : ''), '');

export function buildKeyPruneScan(data, opts, ignoreSet, { caseSensitiveDefault = false, wholeWordsDefault = false, matchWindow = 'scan', chatScan, t = plain } = {}) {
    // undefined: no scan, or a scan that did not cover this key; 0: scanned and silent. chatChecked reads the difference.
    // The unit the chat scan counted, named for a chip: what a rate is a rate of.
    const units = { message: t`messages`, paragraph: t`paragraphs`, window: t`scan windows` }[chatScan?.unit] ?? t`messages`;
    // Messages holding the key AS WRITTEN. undefined when no scan covered it; absent from a scan that predates the field.
    const chatTypedOf = key => chatScan?.typedWith?.get(key);
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

    const allKeys = [...new Set(allEntries.flatMap(e => (Array.isArray(e.key) ? e.key : []).map(k => String(k).trim())).filter(Boolean))];
    // Its OWN scope: sharing the retrieval scope would leave thousands of keys in the live automaton.
    const scanScope = createScanScope();
    registerKeys(allKeys, scanScope);
    const comboId = (cs, ww) => `${cs ? 1 : 0}${ww ? 1 : 0}`;
    const ck = (key, cs, ww) => `${comboId(cs, ww)} ${cs ? key : String(key).toLowerCase()}`;
    // Segmented like the scan window; df still counts entries, not segments (K5).
    const contentSegments = contents.map(c => segment([c], matchWindow));

    // The questions the verdicts will ask of the book, fixed before the pass so it can answer them all at once: which
    // flag combos each key is counted under — its entries' own, and for a whole-word entry the substring combo too,
    // which `short` reads for its total — and which keys want their title-cased form looked for.
    const combosOf = new Map();
    for (const e of entries) {
        const cs = e.caseSensitive ?? caseSensitiveDefault, ww = e.matchWholeWords ?? wholeWordsDefault;
        for (const k of (Array.isArray(e.key) ? e.key : []).map(x => String(x).trim()).filter(Boolean)) {
            let list = combosOf.get(k);
            if (!list) combosOf.set(k, list = new Map());
            for (const w of ww ? [true, false] : [false]) list.set(comboId(cs, w), { cs, ww: w });
        }
    }
    const titledOf = k => {
        const tokens = k.split(/\s+/);
        const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
        const titled = tokens.map((t, i) => (i === 0 || i === tokens.length - 1 || !NAME_PARTICLES.has(t.toLowerCase()) ? cap(t) : t)).join(' ');
        return titled === k ? null : titled;
    };
    const isLiteral = k => !k.startsWith('?') && !isRegexKey(k);
    const literalKeys = allKeys.filter(isLiteral);
    const otherKeys = allKeys.filter(k => !isLiteral(k));
    const wantsTitled = new Map(literalKeys.filter(looksLikeFragment).map(k => [k, titledOf(k)]).filter(([, t]) => t));

    // ONE pass over the book: each segment through the automaton once, and every fact recorded as it goes. Literal keys
    // are counted only in the segments the automaton found a variant of them in; `?` and regex keys in every segment,
    // being evaluated rather than found. Same verdicts as countKey for every key in every segment, its own first step
    // being that same lookup — the pass changes only when and how often it is called.
    const bookScan = new Map();   // ck(key, cs, ww) -> { df, total, typed }, the chatScan's twin
    const named = new Map();      // key -> the book holds its title-cased form case-sensitively somewhere
    for (const segments of contentSegments) {
        primeScan([], segments, scanScope);
        const perKey = new Map();   // key -> combo id -> { n, typed }, this content only
        const tally = (key, seg) => {
            const combos = combosOf.get(key);
            if (!combos) return;
            let byCombo = perKey.get(key);
            for (const [id, { cs, ww }] of combos) {
                const n = countKey(key, seg, cs, ww, scanScope);
                if (!n) continue;
                if (!byCombo) perKey.set(key, byCombo = new Map());
                let r = byCombo.get(id);
                if (!r) byCombo.set(id, r = { n: 0, typed: 0 });
                r.n += n;
                r.typed += cachedCount(key, seg, scanScope, false) ?? 0;
            }
            // The titled form folds to the key's own pattern, so a segment the automaton reported is the only kind that can
            // hold it: only those are walked case-sensitively.
            const titled = wantsTitled.get(key);
            if (titled && !named.get(key) && countKey(titled, seg, true, false, scanScope) > 0) named.set(key, true);
        };
        for (const seg of segments) {
            for (const key of hitLiterals(scanScope, seg, literalKeys)) tally(key, seg);
            for (const key of otherKeys) tally(key, seg);
        }
        // Case variants of one key (`Pack` and `pack`) share a slot when cs is off, and both would count this entry:
        // df would exceed nBook and the ratio read over 100%.
        const counted = new Set();
        for (const [key, byCombo] of perKey) {
            for (const [id, { n, typed }] of byCombo) {
                const { cs, ww } = combosOf.get(key).get(id);
                const k = ck(key, cs, ww);
                if (counted.has(k)) continue;
                counted.add(k);
                let r = bookScan.get(k);
                if (!r) bookScan.set(k, r = { df: 0, total: 0, typed: 0 });
                r.df++; r.total += n; r.typed += typed;
            }
        }
    }
    // Every question asked has an answer, the silent ones zeros: a miss below means a key the audit never saw.
    for (const [key, combos] of combosOf) for (const { cs, ww } of combos.values()) { const k = ck(key, cs, ww); if (!bookScan.has(k)) bookScan.set(k, { df: 0, total: 0, typed: 0 }); }
    for (const key of wantsTitled.keys()) if (!named.has(key)) named.set(key, false);

    /** A key the pass never saw — edited since the audit — judged on demand: one key over the contents through a private
     *  scope, so the shared automaton is not rebuilt, and the answer is a verdict rather than "0/0". */
    const onDemand = (key, cs, ww) => {
        const r = { df: 0, total: 0, typed: 0 };
        const own = createScanScope();
        for (const segments of contentSegments) {
            primeScan([key], segments, own);
            let n = 0, typed = 0;
            for (const seg of segments) { n += countKey(key, seg, cs, ww, own); typed += cachedCount(key, seg, own, false) ?? 0; }
            if (n) { r.df++; r.total += n; r.typed += typed; }
        }
        bookScan.set(ck(key, cs, ww), r);
        return r;
    };
    const scan = (key, cs, ww) => bookScan.get(ck(key, cs, ww)) ?? onDemand(key, cs, ww);
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
    /** A regex key's orthography verdict. `needEvidence` asks whether a chat or the book holds the form the pattern
     *  cannot reach, which is what lets this outrank `unattested`; the chat is the stronger claim and is cited first. */
    const regexOrtho = (k, needEvidence) => {
        for (const a of orthoAlternates(k)) {
            if (needEvidence) {
                const chat = chatRateOf(a.alt), mine = chatRateOf(k) ?? 0;
                const where = (chat !== undefined && chat > mine) ? 'chat'
                    : contents.some(c => countRegexKey(a.alt, c) > countRegexKey(k, c)) ? 'book' : null;
                if (where) return { flag: 'regex orthography', bookContent: 0, suggest: a.suggest, where, label: a.label };
                continue;
            }
            if (a.shape) return { flag: 'regex orthography', bookContent: 0, suggest: a.suggest, label: a.label };
        }
        return null;
    };

    /** A lowercase-typed key whose title-cased form — particles left lowercase, the frame capitalised as looksProper
     *  wants it — appears case-sensitively in the book's own text is a name, not a phrase: `isle of wight` clears on
     *  "Isle of Wight" in an entry. The shape test cannot see this; the pass did. A key it never saw is walked now. */
    const namedInBook = k => {
        const known = named.get(k);
        if (known !== undefined) return known;
        const titled = titledOf(k);
        const found = Boolean(titled) && contentSegments.some(segments => segments.some(seg => countKey(titled, seg, true, false) > 0));
        named.set(k, found);
        return found;
    };

    // Tested in FLAG_PRIORITY order; the first hit wins, so moving a branch changes what a key reports.
    const classify = (key, cs, ww, declared = false) => {
        const k = String(key).trim();
        if (!k) return null;
        // usableKeys, not a validator call, so which codes are fatal here stays a matcher.mjs rule.
        if (!usableKeys([k]).length) return { flag: 'unusable', code: validateSmartKey(k).find(f => f.severity === 'error')?.code };
        // English-common, fragment and short read the key as a literal; a SmartKey or regex is judged on its terms (smartPaths) or skipped.
        const literal = !k.startsWith('?') && !isRegexKey(k);
        const bookContent = scan(k, cs, ww).df;
        const chatRate = chatRateOf(k);
        const hits = scan(k, cs, ww);

        // --- evidence about this chat and this book, in the order the more specific diagnosis wins ---------------
        // Gated on breadth, judged on how the breadth was earned: `authoriz` is what substring matching is for, bare `Eve`
        // on "even" and "never" is not. Only the flag the entry lacks can be suggested.
        if (literal && chatRate !== undefined && chatRate >= (opts.chatCommon ?? KEY_CHAT_COMMON)) {
            const [word, cased] = substringProbes(k).map(pr => chatScan.messagesWith?.get(pr));
            const any = chatScan.messagesWith.get(k);
            const wordShare = word === undefined ? undefined : word / any;
            const caseShare = cased === undefined ? undefined : cased / any;
            const wantWord = !ww && wordShare !== undefined && wordShare <= 1 / 3;
            const wantCase = !cs && caseShare !== undefined && caseShare <= 1 / 3;
            if (wantWord || wantCase) return { flag: 'substring', bookContent, chatRate, wordShare, caseShare, suggest: `? ${wantWord ? '=' : ''}${wantCase ? '^' : ''}${k}` };
        }
        // A key that floods the chat, whatever list it is or is not on. Not a `constant` or sticky entry: those are the
        // author declaring the entry ubiquitous, and the flag claims something about the key against this chat, not the wiring.
        if (!declared && chatRate !== undefined && chatRate >= (opts.chatCommon ?? KEY_CHAT_COMMON)) {
            // A SmartKey names the path that matches most, where its paths were probed; a single path is the key itself.
            const paths = literal ? [] : smartPaths(k, isCommonWord(table().common));
            const hit = p => chatScan.messagesWith?.get(p.probe) ?? -1;
            const top = paths.length > 1 ? paths.reduce((a, p) => (hit(p) > hit(a) ? p : a), paths[0]) : null;
            return { flag: 'chat common', bookContent, chatRate, via: top && hit(top) >= 0 ? top.label : null };
        }
        // The fallback for a key no chat was scanned for: the book's own prose stands in for the chat it does not have.
        // With a chat, ubiquity in entry text is a fact about the story and draws nothing on its own.
        if (!declared && chatRate === undefined && nBook >= KEY_MIN_SHARED_ENTRIES && bookContent / nBook >= (opts.bookCommon ?? KEY_BOOK_COMMON)) return { flag: 'book common', bookContent };
        const bookListed = bookListedBy.get(k.toLowerCase()) ?? 0;
        if (nBook >= KEY_MIN_SHARED_ENTRIES && bookListed / nBook > opts.bookShared * 0.75 && opts.pruneShared) return { flag: 'book shared', bookContent, bookListed };
        const evidenced = regexOrtho(k, true);
        if (evidenced) return evidenced;

        // --- the pack's common list: the fallback for a key no chat was scanned for. With a chat, the chat has answered: over
        // the gate it read as chat common above, under it the list is contradicted and says nothing. -------------------
        if (opts.pruneCommon && chatRate === undefined) {
            if (literal && !/\s/.test(k) && table().common.has(k.toLowerCase())) return { flag: 'common word', bookContent, chatRate };
            // Named by its first all-common path: which path matches is the chat's question, and `chat common` answers it.
            const common = literal ? null : smartPaths(k, isCommonWord(table().common)).find(p => p.common);
            if (common) return { flag: 'common word', term: common.label, bookContent, chatRate };
        }

        // --- the key's shape; then dead last, a dead key being neutral --------------------------------------------
        // bookContent first: a name the book never mentions cannot be attested by it, and that spares the case-sensitive pass.
        if (literal && opts.pruneFragment !== false && looksLikeFragment(k) && !(bookContent > 0 && namedInBook(k))) return { flag: 'fragment', bookContent };
        // Nothing to judge without a hit: a dead short key is dead, not "0/0 clean".
        if (literal && k.length < opts.minLength && !ww && opts.pruneShort && hits.total > 0) return { flag: 'short', bookContent, clean: strictClean(k, cs), total: scan(k, cs, false).total, key: k, ww };
        if (bookContent === 0 && opts.pruneUnattested && !(literal && opts.ignoreProper && looksProper(k)) && !chatRate) return { flag: 'unattested', bookContent, literal, chatChecked: chatRate !== undefined };
        if (literal) {
            const chatAny = chatScan?.messagesWith?.get(k), chatTyped = chatTypedOf(k);
            // Chat first: what the model writes is the stronger claim about which form a key will meet.
            if (chatAny > 0 && chatTyped === 0) return { flag: 'variant only', bookContent, where: 'chat' };
            if (hits.total > 0 && hits.typed === 0 && !chatTyped) return { flag: 'variant only', bookContent, where: 'book' };
        }
        return regexOrtho(k, false);
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
        const declared = Boolean(e.constant) || Number(e.sticky) > 0;
        const out = [];
        for (const key of (Array.isArray(e.key) ? e.key : [])) {
            if (ignoreSet.has(key)) continue;
            const c = classify(key, cs, ww, declared);
            if (c) out.push({ uid: e.uid, key, ...c });
        }
        return out;
    };
    // Shared by reasonOf and the Studio badge, so severity and problem status agree. A name, not a
    // colour: a caller comparing shades breaks the moment one is retuned, and this module has no business holding either.
    const severityOf = p => {
        if (p.flag === 'unattested') return '';
        if (p.flag === 'unusable') return SEVERE;
        if (p.flag === 'common word') return MODERATE;   // an assertion about the language; only the chat can make it severe, as chat common
        if (p.flag === 'book shared') return p.bookListed / nBook >= opts.bookShared ? SEVERE : MODERATE;
        if (p.flag === 'fragment') return SEVERE;
        if (p.flag === 'substring') return MODERATE;
        // By degree: over the gate is worth a look, in more messages than not is a problem. book common is a proxy and stays moderate.
        if (p.flag === 'chat common') return p.chatRate >= KEY_CHAT_SEVERE ? SEVERE : MODERATE;
        if (p.flag === 'book common') return MODERATE;
        if (p.flag === 'variant only') return MINOR;
        if (p.flag === 'regex orthography') return MINOR;
        const ratio = p.total ? p.clean / p.total : 0;
        return ratio >= 1 ? MINOR : ratio <= 1 / 3 ? SEVERE : MODERATE;
    };
    const reasonOf = p => {
        const severity = severityOf(p);
        // A SmartKey or a pattern is not "absent from the text": it evaluated false everywhere.
        const pct = x => Math.round(100 * x);
        // Every text is one template, so a translation can reorder it; a branch per variant rather than a joined fragment.
        if (p.flag === 'unattested') {
            // A SmartKey or a pattern is not absent from the text: it evaluated false everywhere it was run.
            const text = p.literal ? (p.chatChecked ? t`unattested (book/chat)` : t`unattested (book)`)
                : (p.chatChecked ? t`never matches (book/chat)` : t`never matches (book)`);
            return { text, severity };
        }
        if (p.flag === 'unusable') return { text: p.code ? t`unusable — ${p.code}` : t`unusable`, severity };
        if (p.flag === 'common word') return { text: p.term ? t`common word (${p.term})` : t`common word`, severity };
        if (p.flag === 'book shared') return { text: t`book shared (${pct(p.bookListed / nBook)}%)`, severity };
        if (p.flag === 'chat common') return { text: p.via ? t`chat common (${pct(p.chatRate)}%, mostly ${p.via})` : t`chat common (${pct(p.chatRate)}%)`, severity };
        if (p.flag === 'book common') return { text: t`book common (${pct(p.bookContent / nBook)}%)`, severity };
        if (p.flag === 'fragment') return { text: t`phrase fragment`, severity };
        if (p.flag === 'substring') {
            const how = [p.wordShare !== undefined && p.suggest.includes('=') ? t`${pct(p.wordShare)}% as a word` : null,
                p.caseShare !== undefined && p.suggest.includes('^') ? t`${pct(p.caseShare)}% in this case` : null].filter(Boolean).join(', ');
            return { text: t`matches in ${pct(p.chatRate)}% of ${units}, ${how} — consider ${p.suggest}`, severity };
        }
        if (p.flag === 'variant only') return { text: p.where === 'chat' ? t`chat uses it only un-hyphenated` : t`book uses it only un-hyphenated`, severity };
        if (p.flag === 'regex orthography') {
            const form = { 'curly form': t`curly form`, 'straight form': t`straight form`, 'en-dash': t`en-dash` }[p.label] ?? p.label;
            const lead = p.where === 'chat' ? t`chat uses ${form}` : p.where === 'book' ? t`book uses ${form}` : t`will not match ${form}`;
            return { text: t`${lead}, consider ${p.suggest}`, severity };
        }
        // The same suggestion substring makes, measured over the book: hits mostly inside longer words want `=`.
        const ratio = p.total ? p.clean / p.total : 0;
        return { text: ratio <= 1 / 3 && !p.ww ? t`short (${p.clean}/${p.total} exact) — consider ? =${p.key}` : t`short (${p.clean}/${p.total} exact)`, severity };
    };
    // Near-duplicates: Jaccard over rare vocabulary; an arc and its member scene are skipped. Advisory only.
    const isArc = e => e?.stmbArc === true || /^\s*\[?\s*arc\b/i.test(String(e?.comment ?? ''));
    const dupeVocab = e => {
        const out = new Set();
        for (const w of String(e.content ?? '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []) {
            if ((table().zipf.get(w) ?? 0) < 3.0) out.add(w);
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

    return { entries, nE, classifyEntry, reasonOf, severityOf, effCase, effWhole, dupes, unusableKeysOf };
}

/** Every entry, every mode. */
export const STUDIO_PRUNE_OPTS = { scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true, pruneUnattested: true, pruneCommon: true, pruneShort: true, pruneShared: true, pruneFragment: true, ignoreProper: false, minLength: KEY_MIN_LENGTH, bookShared: KEY_BOOK_SHARED, chatCommon: KEY_CHAT_COMMON, bookCommon: KEY_BOOK_COMMON };
