// smartkeys.mjs — boolean query engine for `?`-prefixed World Info keys.
//
// A key starting with `?` opts into query syntax instead of substring matching:
//   ? moon mission -apollo          implicit AND, prefix - negates
//   ? =cat                          = word boundary, ^ case-sensitive (combinable: ^=NASA)
//   ? "moon mission" OR cosmonaut   quoted phrases, AND/OR/NOT/XOR, &&/||/!/-/+, (...) grouping
//   ? fire:2.5                      :weight scales the key's BM25 contribution
//   ? meeting "10:30"               a bare token's trailing :number is ALWAYS a weight;
//                                   a literal colon must be quoted
//
// Un-extended ST cores see the raw string "? moon ..." and silently never match it — that
// degradation is the compatibility story, so lorebooks stay portable.
//
// Isomorphic like ranking.mjs: no DOM, no ST imports. Entry point is evaluateSmartKey();
// countKey() in ranking.mjs routes `?` keys here.

import { escapeRegex, isRegexKey } from './ranking.mjs';

const OPS = {
    '&&': 'AND', '&': 'AND', '+': 'AND', 'AND': 'AND',
    '||': 'OR', '|': 'OR', 'OR': 'OR',
    '!': 'NOT', '-': 'NOT', 'NOT': 'NOT',
    'XOR': 'XOR',
};

/**
 * Lexes a SmartKeys query (leading `?` already meaningful but tolerated) into tokens.
 * `-`/`!`/`+` are operators only at token start, so internal hyphens (sci-fi) stay in the term.
 * @param {string} input
 * @returns {object[]} tokens
 */
export function tokenize(input) {
    let src = String(input).replace(/^\?/, '').trim();
    const tokens = [];
    while (src.length > 0) {
        let m = src.match(/^\s+/);
        if (m) { src = src.slice(m[0].length); continue; }
        if (src[0] === '(') { tokens.push({ type: 'LPAREN' }); src = src.slice(1); continue; }
        if (src[0] === ')') { tokens.push({ type: 'RPAREN' }); src = src.slice(1); continue; }
        m = src.match(/^(&&|\|\||&|\||\+|!|-)/) ?? src.match(/^(AND|OR|NOT|XOR)\b(?=\s|[()]|$)/i);
        if (m) {
            tokens.push({ type: OPS[m[1].toUpperCase()] });
            src = src.slice(m[0].length);
            continue;
        }
        // Term: optional =/^ flags, quoted phrase or bare word, optional :weight postfix.
        m = src.match(/^([=^]{0,2})(?:"([^"]*)"|([^\s()|&]+))/);
        if (!m) { src = src.slice(1); continue; } // lone stray char (e.g. unmatched ") — drop
        src = src.slice(m[0].length);
        let value = m[2] ?? m[3];
        let weight = 1.0;
        if (m[2] !== undefined) {
            const w = src.match(/^:(\d+(?:\.\d+)?)/); // quoted: weight sits after the close quote
            if (w) { weight = parseFloat(w[1]); src = src.slice(w[0].length); }
        } else {
            // Bare: split a trailing :weight off the token. This claims "10:30"-style tokens too —
            // by design, a literal colon requires quoting (? "10:30").
            const w = value.match(/^(.+?):(\d+(?:\.\d+)?)$/);
            if (w) { value = w[1]; weight = parseFloat(w[2]); }
        }
        if (!value) continue;
        tokens.push({
            type: 'TERM',
            value,
            isExact: m[1].includes('='),
            isCaseSensitive: m[1].includes('^'),
            weight,
        });
    }
    return tokens;
}

/**
 * Recursive-descent parse. Adjacent primaries (TERM/LPAREN/NOT) get an implicit AND.
 * Precedence: (...) > NOT > AND > OR/XOR. Malformed tails degrade to null (matches nothing).
 * @param {object[]} tokens
 * @returns {object|null} AST root
 */
export function parse(tokens) {
    let i = 0;
    const peek = () => tokens[i];
    const parseOr = () => {
        let left = parseAnd();
        while (peek()?.type === 'OR' || peek()?.type === 'XOR') {
            const type = tokens[i++].type;
            left = { type, left, right: parseAnd() };
        }
        return left;
    };
    const parseAnd = () => {
        let left = parseUnary();
        while (peek() && (peek().type === 'AND' || peek().type === 'TERM' || peek().type === 'LPAREN' || peek().type === 'NOT')) {
            if (peek().type === 'AND') i++;
            left = { type: 'AND', left, right: parseUnary() };
        }
        return left;
    };
    const parseUnary = () => {
        if (peek()?.type === 'NOT') {
            i++;
            const operand = parseUnary();
            // Dangling NOT ("? -") must not become NOT(null) = matches-everything.
            return operand ? { type: 'NOT', operand } : null;
        }
        return parsePrimary();
    };
    const parsePrimary = () => {
        const t = tokens[i++];
        if (!t) return null;
        if (t.type === 'LPAREN') {
            const node = parseOr();
            if (peek()?.type === 'RPAREN') i++;
            return node;
        }
        return t.type === 'TERM' ? t : null; // stray operator/RPAREN — drop
    };
    return parseOr();
}

/**
 * Pass 1 — Aho-Corasick automaton over the case-folded literals of every registered term.
 * One scan of the text yields the set of terms present as substrings; per-key evaluation
 * then never re-walks the text (except to verify =/^ flags on candidate terms).
 * @param {string[]} patterns Case-folded literals
 * @returns {{next: Map[], fail: number[], out: Set[]}}
 */
export function buildAutomaton(patterns) {
    const next = [new Map()], fail = [0], out = [new Set()];
    for (let p = 0; p < patterns.length; p++) {
        let node = 0;
        for (let i = 0; i < patterns[p].length; i++) {
            const ch = patterns[p][i];
            if (!next[node].has(ch)) {
                next[node].set(ch, next.length);
                next.push(new Map()); fail.push(0); out.push(new Set());
            }
            node = next[node].get(ch);
        }
        out[node].add(p);
    }
    // Failure links, breadth-first: fail[v] is the longest proper suffix of v's path that is
    // also a path in the trie; outputs propagate along it so nested patterns still report.
    const queue = [...next[0].values()];
    while (queue.length) {
        const u = queue.shift();
        for (const [ch, v] of next[u]) {
            queue.push(v);
            let f = fail[u];
            while (f !== 0 && !next[f].has(ch)) f = fail[f];
            fail[v] = next[f].get(ch) ?? 0;
            for (const o of out[fail[v]]) out[v].add(o);
        }
    }
    return { next, fail, out, len: patterns.map(p => p.length) };
}

/**
 * Scans case-folded text through the automaton, counting NON-overlapping occurrences per
 * pattern (greedy left-to-right) — exact parity with countKey's indexOf loop, where "aa"
 * in "aaa" counts once.
 * @returns {Map<number, number>} pattern index -> occurrence count (present patterns only)
 */
export function scanAutomaton(aut, foldedText) {
    const counts = new Map();
    const lastEnd = new Map();
    let node = 0;
    for (let i = 0; i < foldedText.length; i++) {
        const ch = foldedText[i];
        while (node !== 0 && !aut.next[node].has(ch)) node = aut.fail[node];
        node = aut.next[node].get(ch) ?? 0;
        for (const p of aut.out[node]) {
            if (i - aut.len[p] + 1 > (lastEnd.get(p) ?? -1)) {
                counts.set(p, (counts.get(p) ?? 0) + 1);
                lastEnd.set(p, i);
            }
        }
    }
    return counts;
}

/**
 * One matching context: the term registry (folded literal -> pattern index), the automaton built from
 * it, the parsed-AST cache, and the per-text scan results.
 *
 * Scoped rather than module-global because two callers want batching over disjoint key sets and very
 * different lifetimes: live retrieval primes the chat's scan window with the active books' keys and
 * keeps it for the session, while the keyword audit primes every key in one book against every entry's
 * text and is done. Sharing one registry meant each paid for the other's vocabulary, and the audit's
 * few-hundred keys would linger in the retrieval automaton for the rest of the session.
 *
 * ASTs live here too rather than in a shared cache, because registerTerms stamps a scope-local pattern
 * index onto each TERM node.
 */
export function createScanScope() {
    return { termIndex: new Map(), patterns: [], automaton: null, dirty: false, scans: new Map(), astCache: new Map() };
}

// The default scope, used whenever a caller doesn't supply one — i.e. live retrieval.
const defaultScope = createScanScope();

function internLiteral(scope, folded) {
    let idx = scope.termIndex.get(folded);
    if (idx === undefined) {
        idx = scope.patterns.length;
        scope.patterns.push(folded);
        scope.termIndex.set(folded, idx);
        scope.dirty = true;
    }
    return idx;
}

function registerTerms(scope, node) {
    if (!node) return;
    if (node.type === 'TERM') {
        node.acIndex = internLiteral(scope, node.value.toLowerCase());
    } else if (node.type === 'NOT') {
        registerTerms(scope, node.operand);
    } else {
        registerTerms(scope, node.left);
        registerTerms(scope, node.right);
    }
}

// Pass-1 results per text buffer: text -> counts Map. A handful of distinct buffers coexist in
// one retrieval pass (per-depth windows x per-entry match-source suffixes), so a small cache keeps
// each of them scanned once per automaton generation. Cleared on rebuild — with registerKeys()
// batching registration up front, rebuilds happen at most once per pass.
const SCAN_CACHE_MAX = 8;   // per scope; insertion-ordered, oldest evicted first

function ensureScan(scope, text) {
    if (scope.dirty || scope.automaton === null) {
        scope.automaton = buildAutomaton(scope.patterns);
        scope.dirty = false;
        scope.scans.clear();
    }
    let counts = scope.scans.get(text);
    if (counts === undefined) {
        counts = scanAutomaton(scope.automaton, text.toLowerCase());
        scope.scans.set(text, counts);
        if (scope.scans.size > SCAN_CACHE_MAX) scope.scans.delete(scope.scans.keys().next().value);
    }
    return counts;
}

/**
 * Evaluates an AST against a text buffer.
 * @param {Map<number, number>} [acHits] Pass-1 counts for this text; omitted = pure regex path.
 * @returns {{matched: boolean, scoreBoost: number}}
 */
export function evaluate(node, text, acHits) {
    if (!node) return { matched: false, scoreBoost: 0 };
    switch (node.type) {
        case 'TERM': {
            if (acHits && node.acIndex !== undefined) {
                // Candidate filter: no folded-substring hit means no match under any flags.
                if (!acHits.has(node.acIndex)) return { matched: false, scoreBoost: 0 };
                // Unflagged term = case-insensitive substring, which is exactly what Pass 1 proved.
                if (!node.isExact && !node.isCaseSensitive) return { matched: true, scoreBoost: node.weight };
            }
            let pattern = escapeRegex(node.value);
            // Same lookaround boundary as countKey's whole-word path (see ranking.mjs) — \b would
            // make punctuation-edged terms like =c++ unmatchable.
            if (node.isExact) pattern = `(?<!\\w)${pattern}(?!\\w)`;
            const hit = new RegExp(pattern, node.isCaseSensitive ? '' : 'i').test(text);
            return { matched: hit, scoreBoost: hit ? node.weight : 0 };
        }
        case 'NOT': {
            const r = evaluate(node.operand, text, acHits);
            return { matched: !r.matched, scoreBoost: 0 };
        }
        // Invariant: an unmatched node carries scoreBoost 0. Parents read child boosts without
        // re-checking child.matched (OR takes the max, AND sums), so a failed branch that kept a
        // boost would leak it upward — e.g. "? (fire:3 XOR flood:3) OR water:0.5" with both fire
        // and flood present must score 0.5, not 3.
        case 'AND': {
            const l = evaluate(node.left, text, acHits), r = evaluate(node.right, text, acHits);
            const matched = l.matched && r.matched;
            return { matched, scoreBoost: matched ? l.scoreBoost + r.scoreBoost : 0 };
        }
        case 'OR': {
            const l = evaluate(node.left, text, acHits), r = evaluate(node.right, text, acHits);
            return { matched: l.matched || r.matched, scoreBoost: Math.max(l.scoreBoost, r.scoreBoost) };
        }
        case 'XOR': {
            const l = evaluate(node.left, text, acHits), r = evaluate(node.right, text, acHits);
            const matched = l.matched !== r.matched;
            return { matched, scoreBoost: matched ? (l.matched ? l.scoreBoost : r.scoreBoost) : 0 };
        }
    }
}

function ensureAst(scope, raw) {
    let ast = scope.astCache.get(raw);
    if (ast === undefined) {
        ast = parse(tokenize(raw));
        registerTerms(scope, ast);
        scope.astCache.set(raw, ast);
    }
    return ast;
}

/**
 * Full pipeline for one key against one text buffer:
 * Pass 1 candidate scan (Aho-Corasick, cached per text) -> Pass 2 parse (cached per key) -> evaluate.
 * @param {string} rawKey Key string including the leading `?`
 * @param {string} text Scan text
 * @param {object} [scope] Matching context (default: the shared retrieval scope)
 * @returns {{matched: boolean, scoreBoost: number}}
 */
export function evaluateSmartKey(rawKey, text, scope = defaultScope) {
    const ast = ensureAst(scope, rawKey);
    return evaluate(ast, text, ensureScan(scope, text));
}

/**
 * Registers a key list with the scope's automaton without scanning anything. Plain keys register
 * their folded literal; smart keys parse and register their terms; regex keys are skipped (they
 * stay regex). Call this ONCE per pass with every key the pass will score, BEFORE any scoring —
 * a new key mid-pass dirties the automaton, and the rebuild throws away every cached scan.
 * @param {string[]} rawKeys
 * @param {object} [scope]
 */
export function registerKeys(rawKeys, scope = defaultScope) {
    for (const key of rawKeys) {
        const raw = String(key ?? '').trim();
        if (!raw || isRegexKey(raw)) continue;
        if (raw.startsWith('?')) {
            ensureAst(scope, raw);
        } else {
            internLiteral(scope, raw.toLowerCase());
        }
    }
}

/**
 * Batch-registers a key list and scans the text once, so subsequent countKey calls against
 * the same text answer from the automaton instead of walking the buffer per key.
 * @param {string[]} rawKeys
 * @param {string} text
 * @param {object} [scope]
 */
export function primeScan(rawKeys, text, scope = defaultScope) {
    registerKeys(rawKeys, scope);
    ensureScan(scope, text);
}

/**
 * Occurrence count for a plain key from a primed scan, or undefined when the cache can't
 * answer (unscanned text, unregistered key, or a pending rebuild) — caller falls back to the
 * naive walk. A 0 is authoritative under ANY flags: no folded-substring hit means no
 * case-sensitive or whole-word hit either.
 * @param {string} raw Plain key (not regex, not smart)
 * @param {string} text
 * @param {object} [scope]
 * @returns {number|undefined}
 */
export function cachedCount(raw, text, scope = defaultScope) {
    if (scope.dirty || scope.automaton === null) return undefined;
    const counts = scope.scans.get(text);
    if (counts === undefined) return undefined;
    const idx = scope.termIndex.get(raw.toLowerCase());
    if (idx === undefined) return undefined;
    return counts.get(idx) ?? 0;
}

/**
 * Drops every registered key, cached AST, and cached scan in a scope. Called on chat switch for the
 * default scope, so the automaton tracks the ACTIVE books' vocabulary instead of the union of every
 * book ever seen — the next pass re-registers what it needs (one rebuild + one scan per buffer).
 * @param {object} [scope]
 */
export function resetSmartKeys(scope = defaultScope) {
    scope.termIndex.clear();
    scope.patterns.length = 0;
    scope.astCache.clear();
    scope.scans.clear();
    scope.automaton = null;
    scope.dirty = false;
}
