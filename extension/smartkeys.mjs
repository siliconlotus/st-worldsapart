// smartkeys.mjs — boolean query engine for `?`-prefixed World Info keys.
//
// A key starting with `?` opts into query syntax instead of substring matching:
//   ? moon mission -apollo          implicit AND, prefix - negates
//   ? =cat                          = word boundary, ^ case-sensitive (combinable: ^=NASA)
//   ? "moon mission" OR cosmonaut   quoted phrases, AND/OR/NOT/XOR, &&/||/!/-/+, (...) grouping
//   ? fire::2.5                     ::weight scales the key's BM25 contribution (Midjourney's form)
//   ? fire^2.5                      ^N is accepted as an alias — Lucene/Elasticsearch/Solr boost
//   ? meeting 10:30                 a SINGLE colon is ordinary text -- times, verse refs, re:code and
//                                   URLs need no quoting. Only :: introduces a weight.
//   ? +fire +water                  Lucene's per-term required-marker; absorbed, since AND is implicit
//
// WHEN IN DOUBT, QUOTE IT. Quoting is the one escape in this syntax: it turns off operator, weight,
// paren and wildcard interpretation, and marks a punctuation-only term as deliberate rather than a
// typo. Quoting a SINGLE term never changes what it matches — "fire" and fire are identical, flags
// and weights compose either way — so there is no cost to quoting when unsure.
//
// The exception is quoting ACROSS A SPACE, which is a different query rather than a safer one:
//   ? hot tub       two terms, implicit AND — matches a hot bath beside a cold tub
//   ? "hot tub"     one phrase — matches the words adjacent, in that order
// Sigur Rós's "()" and its 142-character successor are both single quoted terms; unquoted they parse
// as parens and a conjunction of punctuation.

// Un-extended ST cores see the raw string "? moon ..." and silently never match it — that
// degradation is the compatibility story, so lorebooks stay portable.
//
// Isomorphic like ranking.mjs: no DOM, no ST imports. Entry point is evaluateSmartKey();
// countKey() in ranking.mjs routes `?` keys here.

import { escapeRegex, isRegexKey, WORD_CHAR } from './ranking.mjs';
// The literal matcher and its text fold live under plugin/ so the server can use them too — one copy, or
// the browser and the server would silently disagree about what a key matches. Re-exported because
// ranking.mjs, keyword-tools.mjs and studio.mjs all import them from here.
import { buildAutomaton, scanAutomaton, fold, normalizeOrthography } from '../plugin/automaton.mjs';
export { buildAutomaton, scanAutomaton, fold, normalizeOrthography };

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
        // Term: optional =/^ flags, quoted phrase or bare word, optional ::weight postfix.
        m = src.match(/^([=^]{0,2})(?:"([^"]*)"|([^\s()|&]+))/);
        if (!m) { src = src.slice(1); continue; } // lone stray char (e.g. unmatched ") — drop
        src = src.slice(m[0].length);
        let value = m[2] ?? m[3];
        let weight = 1.0;
        // WEIGHT IS `::`, NOT `:`. A single colon is an ordinary character, so `10:30`, `Judges 3:16`,
        // `re:code` and `https://…` all tokenise as written and need no quoting. With one colon they
        // did not: `3:16` parsed as the term `3` at weight 16, which is silent and absurd, and the
        // documented escape (quoting) was the only way out of a construction nobody expects to escape.
        //
        // `::` is Midjourney's multi-prompt weight, so it is a convention rather than an invention. It
        // cannot collide with times or ratios, which never double the colon. Lucene's boost is `^N`,
        // which is unavailable here — `^` is already the case-sensitivity flag, and that is worth more.
        //
        // Delimiter followed by non-digits stays part of the term (`fire::abc`), same as a lone colon.
        //
        // `^N` is accepted as an ALIAS. It is Lucene's boost, and Elasticsearch's query_string and Solr
        // carry it too, so it is muscle memory worth not breaking. It cannot be confused with the `^`
        // case-sensitivity flag, which is a PREFIX consumed before the value; this one is a postfix
        // followed by digits. Measured collision surface across the books on disk: 0 keys contain `^`
        // followed by a digit, and 0 in 367KB of scan text.
        if (m[2] !== undefined) {
            const w = src.match(/^(?:::|\^)(\d+(?:\.\d+)?)/); // quoted: weight sits after the close quote
            if (w) { weight = parseFloat(w[1]); src = src.slice(w[0].length); }
        } else {
            const w = value.match(/^(.+?)(?:::|\^)(\d+(?:\.\d+)?)$/);
            if (w) { value = w[1]; weight = parseFloat(w[2]); }
        }
        if (!value) continue;
        tokens.push({
            type: 'TERM',
            value,
            isExact: m[1].includes('='),
            isCaseSensitive: m[1].includes('^'),
            // Quoting already means "this exact string, deliberately" for colons and wildcards. Kept on
            // the token so validation can tell a considered literal from a typo.
            quoted: m[2] !== undefined,
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
    // A binary operator with nothing on one side is a typo, not an instruction. Building the node
    // anyway made the whole key dead — AND(x, null) can never match — so `? fire &` matched nothing
    // at all rather than matching `fire`. Keep the side that exists; the Studio validator is what
    // tells the author their key is malformed, rather than the matcher silently refusing to fire.
    const bin = (type, left, right) => (left && right ? { type, left, right } : left ?? right);
    const parseOr = () => {
        let left = parseAnd();
        while (peek()?.type === 'OR' || peek()?.type === 'XOR') {
            const type = tokens[i++].type;
            left = bin(type, left, parseAnd());
        }
        return left;
    };
    const parseAnd = () => {
        let left = parseUnary();
        while (peek() && (peek().type === 'AND' || peek().type === 'TERM' || peek().type === 'LPAREN' || peek().type === 'NOT')) {
            if (peek().type === 'AND') i++;
            left = bin('AND', left, parseUnary());
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
        // A binary operator in PREFIX position is Lucene's per-term marker, not an operator: `+fire`
        // means "fire is required", which is already what an implicit AND says here. Skip it rather
        // than treating it as a missing left operand — `? +fire +water` is the single most idiomatic
        // Lucene form there is, and it matched nothing at all. Covers the same form after `(`.
        while (peek() && (peek().type === 'AND' || peek().type === 'OR' || peek().type === 'XOR')) i++;
        const t = tokens[i++];
        if (!t) return null;
        if (t.type === 'LPAREN') {
            const node = parseOr();
            if (peek()?.type === 'RPAREN') i++;
            return node;
        }
        return t.type === 'TERM' ? t : null; // stray RPAREN — drop
    };
    return parseOr();
}

/**
 * Whether any TERM contributes POSITIVELY — reachable without passing through an odd number of NOTs.
 * Mirrors how evaluate() accumulates: NOT yields no score and discards its subtree's, so a query with
 * no positive term matches on absence alone.
 */
const hasPositiveTerm = (node, negated = false) => {
    if (!node) return false;
    if (node.type === 'TERM') return !negated;
    if (node.type === 'NOT') return hasPositiveTerm(node.operand, !negated);
    return hasPositiveTerm(node.left, negated) || hasPositiveTerm(node.right, negated);
};

/**
 * Structural problems in a `?` query, for the Studio's save check and the audit — one definition, so
 * the two surfaces cannot disagree about what is valid.
 *
 * STRUCTURE ONLY. Whether a term ever occurs is a question about a book's text, and belongs to the
 * audit's df machinery rather than here; this needs nothing but the string.
 *
 * Severity is the split that matters. `error` is a query that cannot do what its author meant under
 * any text. `warn` is legal and probably a typo. Nothing here is fatal at match time — the matcher's
 * job is to fire, and telling an author their key is malformed is this function's job instead.
 *
 * @param {string} raw The key, with or without its leading `?`
 * @returns {Array<{severity: 'error'|'warn', code: string, message: string}>} empty when clean
 */
export function validateSmartKey(raw) {
    const out = [];
    const src = String(raw ?? '');
    if (!src.trim().startsWith('?')) return out;   // not a SmartKey; nothing to say
    const tokens = tokenize(src);
    const terms = tokens.filter(t => t.type === 'TERM');

    if (!terms.length) {
        out.push({ severity: 'error', code: 'no-terms', message: 'No search terms — this key can never match.' });
        return out;   // everything below reads the terms; no point compounding the report
    }

    // A query that only says what must be ABSENT matches on nearly every scan. Core forbids the shape
    // outright (an entry with no primary keys is skipped before its secondaries are ever read), so this
    // is not WA being stricter than the platform.
    if (!hasPositiveTerm(parse(tokens))) {
        out.push({
            severity: 'error', code: 'negation-only',
            message: 'Every term is negated, so this matches whenever they are absent — which is almost always. Add a term that must be present.',
        });
    }

    // A term with no letters and no digits fires on punctuation, which is in nearly every message. The
    // usual cause is a doubled sentinel: only the FIRST `?` is stripped as the prefix, so `? or ? ()`
    // leaves `?` behind as a literal term and the query quietly matches any text containing one.
    for (const t of terms) {
        // A QUOTED punctuation term is deliberate — Sigur Rós really did name an album "()" — and
        // quoting is already how this syntax says "exactly this, I meant it". Only unquoted ones warn.
        if (!t.quoted && !/[\p{L}\p{N}]/u.test(String(t.value))) {
            out.push({
                severity: 'warn', code: 'punctuation-term',
                message: String(t.value) === '?'
                    ? 'Only the first “?” marks a SmartKey, so the second one is being searched for as text — this matches nearly every message. Remove it, or quote it as "?" if you meant it.'
                    : `The term ${JSON.stringify(String(t.value))} is punctuation only, so it matches almost anything.`,
            });
        }
    }

    // Lucene syntax WA does not implement. Each of these currently becomes a literal term and quietly
    // matches nothing, which the audit eventually reports as a dead key — but "never matches" is a much
    // worse thing to be told than "fuzzy matching is not a feature here". Quoted terms are exempt: an
    // author who quoted it said they meant the characters.
    for (const t of terms) {
        if (t.quoted) continue;
        const v = String(t.value);
        if (v.includes('~')) {
            out.push({
                severity: 'warn', code: 'lucene-fuzzy',
                message: 'Fuzzy and proximity matching (~) are not supported — the term is matched literally, so this will not fire. Use a /regex/ key for pattern matching.',
            });
        }
        if (v.includes('*')) {
            out.push({
                severity: 'warn', code: 'lucene-wildcard',
                message: 'Wildcards (*) are not supported — the term is matched literally. Matching is substring by default, so “fir” already finds “confirm”; use a /regex/ key for anything more.',
            });
        }
    }

    for (const t of terms) {
        if (String(t.value).includes('"')) {
            out.push({
                severity: 'error', code: 'stray-quote',
                message: 'Unclosed quote — close the phrase, or remove the quote.',
            });
        }
    }

    const lp = tokens.filter(t => t.type === 'LPAREN').length;
    const rp = tokens.filter(t => t.type === 'RPAREN').length;
    if (lp !== rp) {
        out.push({
            severity: 'warn', code: 'unbalanced-parens',
            message: `${lp} “(” against ${rp} “)”. The query still parses, but probably not the way you grouped it.`,
        });
    }

    // Legal, and meaningful once WA owns activation: "fire on this, but do not rank on it". Worth
    // surfacing because it is indistinguishable from a mistyped weight until then.
    if (terms.every(t => t.weight === 0)) {
        out.push({
            severity: 'warn', code: 'all-zero-weights',
            message: 'Every term is weighted 0, so this key gates without contributing to the score.',
        });
    }

    return out;
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
        node.acIndex = internLiteral(scope, fold(node.value));
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
        counts = scanAutomaton(scope.automaton, fold(text));
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
        // A TERM's contribution is weight x OCCURRENCES, not weight alone. Scoring on presence made a
        // query blind to recurrence: "? (glasses | spectacles)" returned the same number whether the
        // concept appeared once or nine times, so it scored WORSE than the bare key `glasses` the moment
        // the word repeated — being thorough about spelling was penalised. The counts were already
        // computed and cached: the automaton's scan returns a per-term occurrence map, and this function
        // was handed it and called .has() on it.
        case 'TERM': {
            if (acHits && node.acIndex !== undefined) {
                // Candidate filter: no folded-substring hit means no match under any flags.
                const n = acHits.get(node.acIndex);
                if (!n) return { matched: false, scoreBoost: 0 };
                // Unflagged term = case-insensitive substring, which is exactly what Pass 1 proved.
                if (!node.isExact && !node.isCaseSensitive) return { matched: true, scoreBoost: node.weight * n };
            }
            let pattern = escapeRegex(node.value);
            // Same lookaround boundary as countKey's whole-word path — \b would make punctuation-edged
            // terms like =c++ unmatchable. Shares WORD_CHAR with countKey rather than restating it:
            // two boundary definitions is two matchers, which is exactly what CLAUDE.md forbids.
            if (node.isExact) pattern = `(?<!${WORD_CHAR})${pattern}(?!${WORD_CHAR})`;
            // Counted, not tested: same walk of the text either way, and a flagged term has as much
            // right to recurrence as an unflagged one.
            const n = (text.match(new RegExp(pattern, node.isCaseSensitive ? 'gu' : 'giu')) ?? []).length;
            return { matched: n > 0, scoreBoost: node.weight * n };
        }
        case 'NOT': {
            const r = evaluate(node.operand, text, acHits);
            return { matched: !r.matched, scoreBoost: 0 };
        }
        // Invariant: an unmatched node carries scoreBoost 0. Parents read child boosts without
        // re-checking child.matched (AND and OR both sum), so a failed branch that kept a
        // boost would leak it upward — e.g. "? (fire:3 XOR flood:3) OR water:0.5" with both fire
        // and flood present must score 0.5, not 3.
        case 'AND': {
            const l = evaluate(node.left, text, acHits), r = evaluate(node.right, text, acHits);
            const matched = l.matched && r.matched;
            return { matched, scoreBoost: matched ? l.scoreBoost + r.scoreBoost : 0 };
        }
        // OR SUMS, like AND. max() was only ever right because it coincided with the sum whenever a
        // single branch matched — unmatched branches carry 0 — and it diverged exactly where a synonym
        // group needs the total: "(glasses | spectacles)" is one concept, and its mentions are its
        // mentions however they were spelled. Summing is also what keywordScore already does across
        // keys, and saturation caps the result, so a wide alternation cannot run away.
        case 'OR': {
            const l = evaluate(node.left, text, acHits), r = evaluate(node.right, text, acHits);
            return { matched: l.matched || r.matched, scoreBoost: l.scoreBoost + r.scoreBoost };
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
            internLiteral(scope, fold(raw));
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
    const idx = scope.termIndex.get(fold(raw));
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
