// smartkeys.mjs — boolean query engine for `?`-prefixed World Info keys. Entry point evaluateSmartKey(); countKey() routes `?` keys here.
//   ? moon mission -apollo          implicit AND, prefix - negates
//   ? =cat                          = word boundary, ^ case-sensitive (combinable: ^=NASA)
//   ? "moon mission" OR cosmonaut   quoted phrases, AND/OR/NOT/XOR, &&/||/!/-/+, (...) grouping
//   ? fire::2.5                     ::weight scales the key's BM25 contribution; ^N is an alias (Lucene's boost)
//   ? meeting 10:30                 a single colon is ordinary text; only :: introduces a weight
//   ? +fire +water                  Lucene's required-marker, absorbed: AND is implicit
//   ? /co(l|s)monaut/i landed       /pattern/flags is a term — negatable, weightable, not folded
//   ? M*A*S*H   ? ~5                * and ~ are literals; a /regex/ term is the only pattern syntax
//   ? "hot tub"                     quoting is the one escape: operators, weights, parens and wildcards off. `? hot tub` is two terms.

import { coreReadsAsRegex, countRegexKey, escapeRegex, foldedHay, isRegexKey, REGEX_KEY_RE, boundaryAfter, boundaryBefore, wordChar } from './matcher.mjs';
// Re-exported: matcher.mjs, keyword-tools.mjs and studio.mjs import these from here. One copy, or the browser and the server disagree.
import { buildAutomaton, scanAutomaton, fold, normalizeOrthography, addMessageHits } from '../plugin/automaton.mjs';
export { buildAutomaton, scanAutomaton, fold, normalizeOrthography, addMessageHits };

const OPS = {
    '&&': 'AND', '&': 'AND', '+': 'AND', 'AND': 'AND',
    '||': 'OR', '|': 'OR', 'OR': 'OR',
    '!': 'NOT', '-': 'NOT', 'NOT': 'NOT',
    'XOR': 'XOR',
};

/** The regex literal opening at position 0 of `s` as `{value, rest}`, or null: the leftmost close whose body compiles and whose flag run ends
 *  at a token boundary. Must accept exactly what REGEX_KEY_RE accepts of a whole key, so a term reads as the same string reads as a key. */
function regexLiteral(s) {
    let inClass = false;
    for (let i = 1; i < s.length; i++) {
        const c = s[i];
        if (c === '\\') { i++; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
            const body = s.slice(1, i);
            if (!body) continue;
            const f = s.slice(i + 1).match(/^[gimsuy]*(?=[\s()|&]|::|\^|$)/);
            if (!f) continue;
            try { new RegExp(body, f[0]); } catch { continue; }
            return { value: `/${body}/${f[0]}`, rest: s.slice(i + 1 + f[0].length) };
        }
    }
    return null;
}

/** Lexes a SmartKey (leading `?` tolerated) into tokens. `-`/`!`/`+` are operators only at token start, so sci-fi stays a term. */
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
        // A `/re/` at token start is a REGEX — after the operator match, so `? -/re/` negates a pattern; the literal is reachable via `? "/re/"`.
        if (src[0] === '/') {
            // A well-formed but uncompilable `/…/flags` is still a REGEX, as it is as a bare key; only the shape being absent makes a literal.
            const re = regexLiteral(src) ?? (REGEX_KEY_RE.test(src) ? { value: src, rest: '' } : null);
            if (re) {
                const w = re.rest.match(/^(?:::|\^)(\d+(?:\.\d+)?)/);
                src = w ? re.rest.slice(w[0].length) : re.rest;
                tokens.push({ type: 'REGEX', value: re.value, weight: w ? parseFloat(w[1]) : 1.0 });
                continue;
            }
        }
        m = src.match(/^([=^]{0,2})(?:"([^"]*)"|([^\s()|&]+))/);
        if (!m) { src = src.slice(1); continue; } // lone stray char (e.g. unmatched ") — drop
        src = src.slice(m[0].length);
        let value = m[2] ?? m[3];
        let weight = 1.0;
        // Weight is `::` or `^N`, never `:`, so `10:30`, `re:code` and URLs need no quoting; a delimiter followed by non-digits stays in the term.
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
            quoted: m[2] !== undefined,
            weight,
        });
    }
    return tokens;
}

/** Recursive descent; adjacent primaries get an implicit AND. Precedence: (...) > NOT > AND > OR/XOR. Malformed tails degrade to null (matches nothing). */
export function parse(tokens) {
    let i = 0;
    const peek = () => tokens[i];
    // A binary operator with nothing on one side keeps the side that exists; the validator is what tells the author.
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
        while (peek() && (peek().type === 'AND' || peek().type === 'TERM' || peek().type === 'REGEX' || peek().type === 'LPAREN' || peek().type === 'NOT')) {
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
        // A binary operator in prefix position is Lucene's per-term marker (`+fire`): skipped, not a missing left operand.
        while (peek() && (peek().type === 'AND' || peek().type === 'OR' || peek().type === 'XOR')) i++;
        const t = tokens[i++];
        if (!t) return null;
        if (t.type === 'LPAREN') {
            const node = parseOr();
            if (peek()?.type === 'RPAREN') i++;
            return node;
        }
        return t.type === 'TERM' || t.type === 'REGEX' ? t : null; // stray RPAREN — drop
    };
    return parseOr();
}

/** Whether any term is reachable without passing through an odd number of NOTs — evaluate() gives NOT no score. */
const hasPositiveTerm = (node, negated = false) => {
    if (!node) return false;
    if (node.type === 'TERM' || node.type === 'REGEX') return !negated;
    if (node.type === 'NOT') return hasPositiveTerm(node.operand, !negated);
    return hasPositiveTerm(node.left, negated) || hasPositiveTerm(node.right, negated);
};

/** Structural problems in a key: `error` cannot do what the author meant under any text, `warn` is legal and probably a typo. Structure only; whether a term ever occurs is the audit's df question. */
export function validateSmartKey(raw) {
    const out = [];
    const src = String(raw ?? '');
    if (!src.trim().startsWith('?')) {
        // A bare key: the only finding is a `/re/` core and WA read differently. The literal hatch is `? "…"`, never `"…"`; a key holding a `"` has none.
        const bare = src.trim();
        // An error, not a warning, and usableKeys bars it: countRegexKey's catch would otherwise count 0 forever.
        const rx = bare.match(REGEX_KEY_RE);
        if (rx) {
            try {
                new RegExp(rx[1], rx[2]);
            } catch (e) {
                out.push({
                    severity: 'error', code: 'regex-invalid',
                    message: `The pattern ${JSON.stringify(bare)} is not a valid regular expression (${e.message}), so it can never match.`,
                });
                return out;   // the reading question below is moot for a pattern that cannot run
            }
        }
        if (isRegexKey(bare) && !coreReadsAsRegex(bare)) {
            const hatch = bare.includes('"') ? '' : ` If you meant the literal string, use ? "${bare}".`;
            out.push({
                severity: 'warn', code: 'regex-core-refuses',
                message: `WA runs “${bare}” as a pattern. SillyTavern's own matcher refuses any pattern with an unescaped “/” inside it, so without WA the key matches only where that exact delimited string appears in the text.${hatch}`,
            });
        }
        return out;   // not a SmartKey; nothing further to say
    }
    const tokens = tokenize(src);
    const terms = tokens.filter(t => t.type === 'TERM' || t.type === 'REGEX');

    if (!terms.length) {
        out.push({ severity: 'error', code: 'no-terms', message: 'No search terms — this key can never match.' });
        return out;   // everything below reads the terms; no point compounding the report
    }

    if (!hasPositiveTerm(parse(tokens))) {
        out.push({
            severity: 'error', code: 'negation-only',
            message: 'Every term is negated, so this matches whenever they are absent — which is almost always. Add a term that must be present.',
        });
    }

    // The usual cause is a doubled `?`: only the first is stripped. A quoted punctuation term is deliberate.
    for (const t of terms) {
        if (t.type !== 'TERM') continue;
        if (!t.quoted && !/[\p{L}\p{N}]/u.test(String(t.value))) {
            out.push({
                severity: 'warn', code: 'punctuation-term',
                message: String(t.value) === '?'
                    ? 'Only the first “?” marks a SmartKey, so the second one is being searched for as text — this matches nearly every message. Remove it, or quote it as "?" if you meant it.'
                    : `The term ${JSON.stringify(String(t.value))} is punctuation only, so it matches almost anything.`,
            });
        }
    }

    // The only shape the lexer makes of an unclosed quote: `? "moon` keeps the `"` as the value's first character. Any other `"` is text.
    for (const t of terms) {
        if (t.type === 'TERM' && !t.quoted && String(t.value).startsWith('"')) {
            out.push({
                severity: 'error', code: 'stray-quote',
                message: 'Unclosed quote — close the phrase, or remove the quote.',
            });
        }
    }

    for (const t of terms) {
        if (t.type !== 'REGEX') continue;
        const val = String(t.value);
        const m = val.match(REGEX_KEY_RE);
        try {
            new RegExp(m[1], m[2]);
        } catch (e) {
            out.push({
                severity: 'error', code: 'regex-invalid',
                message: `The pattern ${JSON.stringify(val)} is not a valid regular expression (${e.message}), so it can never match.`,
            });
            continue;
        }
        if (!coreReadsAsRegex(val)) {
            const hatch = val.includes('"') ? '' : ` If you meant the literal string, quote the term: "${val}".`;
            out.push({
                severity: 'warn', code: 'regex-core-refuses',
                message: `WA runs “${val}” as a pattern. SillyTavern's own matcher refuses any pattern with an unescaped “/” inside it, so without WA the key matches only where that exact delimited string appears in the text.${hatch}`,
            });
        }
    }

    const lp = tokens.filter(t => t.type === 'LPAREN').length;
    const rp = tokens.filter(t => t.type === 'RPAREN').length;
    if (lp !== rp) {
        out.push({
            severity: 'warn', code: 'unbalanced-parens',
            message: `${lp} “(” against ${rp} “)”. The SmartKey still parses, but probably not the way you grouped it.`,
        });
    }

    if (terms.every(t => t.weight === 0)) {
        out.push({
            severity: 'warn', code: 'all-zero-weights',
            message: 'Every term is weighted 0, so this key gates without contributing to the score.',
        });
    }

    return out;
}



// Cache floor for scanned buffers per scope, oldest evicted first; primeScan raises it to fit a segmented window.
const SCAN_CACHE_MAX = 8;

/** One key as one node, by countKey's three-way split: `? …` splices in with its own per-term flags, `/re/` is a REGEX, anything else a TERM carrying the entry's flags. No escaping. */
const keyNode = (raw, { caseSensitive = false, wholeWords = false } = {}, weight = 1) => {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    if (s.startsWith('?')) return parse(tokenize(s));
    if (isRegexKey(s)) return { type: 'REGEX', value: s, weight };
    return { type: 'TERM', value: s, isExact: !!wholeWords, isCaseSensitive: !!caseSensitive, quoted: true, weight };
};

/** Core's `(key, keysecondary, selectiveLogic)` as one AST per primary key, `flags` being the entry's resolved match flags:
 *    AND_ANY  AND(p, OR(s1, s2))    AND_ALL  AND(p, AND(s1, s2))    NOT_ANY  AND(AND(p, NOT(s1)), NOT(s2))    NOT_ALL  AND(p, NOT(AND(s1, s2)))
 *  A non-blank secondary that parses to nothing stays as a null child: evaluate reads null as "did not match", which is core's answer. */
export function synthesizeSecondary(primary, secondaries, logic = 0, flags = {}) {
    const p = keyNode(primary, flags, 1);
    if (!p) return null;

    const sec = [];
    for (const k of Array.isArray(secondaries) ? secondaries : []) {
        if (!String(k ?? '').trim()) continue;   // blanks are dropped before the logic, as core does
        sec.push(keyNode(k, flags, 1));
    }
    if (!sec.length) return p;                   // no secondaries: the condition is vacuously true

    const and = (left, right) => ({ type: 'AND', left, right });
    switch (Number(logic)) {
        case 1: return and(p, { type: 'NOT', operand: sec.reduce(and) });                          // NOT_ALL
        case 2: return sec.reduce((acc, n) => and(acc, { type: 'NOT', operand: n }), p);           // NOT_ANY
        case 3: return and(p, sec.reduce(and));                                                    // AND_ALL
        default: return and(p, sec.reduce((l, r) => ({ type: 'OR', left: l, right: r })));         // AND_ANY
    }
}

/** One matching context: the term registry, the automaton, the AST cache and the per-text scans. Scoped, not global: registerTerms stamps a scope-local index onto each TERM. */
export function createScanScope() {
    return { termIndex: new Map(), patterns: [], automaton: null, dirty: false, scans: new Map(), scanMax: SCAN_CACHE_MAX, astCache: new Map() };
}

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
    if (node.type === 'REGEX') {
        // No acIndex: a pattern is not a literal, so it skips pass 1.
    } else if (node.type === 'TERM') {
        node.acIndex = internLiteral(scope, fold(node.value));
    } else if (node.type === 'NOT') {
        registerTerms(scope, node.operand);
    } else {
        registerTerms(scope, node.left);
        registerTerms(scope, node.right);
    }
}

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
        while (scope.scans.size > scope.scanMax) scope.scans.delete(scope.scans.keys().next().value);
    }
    return counts;
}

/** A scoring unit: `n` occurrences carrying `wsum` = weight x count. AND's operands are separate units, OR's pool into one; a condition yields none, as does weight 0. `id` is the interned node. */
const unit = (id, wsum, n) => (wsum > 0 && n > 0 ? [{ id, wsum, n }] : []);
const pool = (id, units) => (units.length
    ? unit(id, units.reduce((a, u) => a + u.wsum, 0), units.reduce((a, u) => a + u.n, 0))
    : []);
/** Σ weighted occurrences — the same scalar under every operator, so countKey's contract is unaffected by the unit split. */
const boostOf = units => units.reduce((a, u) => a + u.wsum, 0);

/** Evaluates an AST against a text; `acHits` is pass-1 counts for this text, omitted for the pure regex path. An unmatched node
 *  must carry scoreBoost 0: parents sum child boosts without re-checking matched. */
export function evaluate(node, text, acHits) {
    if (!node) return { matched: false, scoreBoost: 0, units: [] };
    switch (node.type) {
        case 'TERM': {
            if (acHits && node.acIndex !== undefined) {
                // No folded-substring hit means no match under any flags; an unflagged term is exactly what pass 1 proved.
                const n = acHits.get(node.acIndex);
                if (!n) return { matched: false, scoreBoost: 0, units: [] };
                if (!node.isExact && !node.isCaseSensitive) return { matched: true, scoreBoost: node.weight * n, units: unit(node, node.weight * n, n) };
            }
            // Fold both sides and use the same lookaround as countKey's naive walk — two boundary definitions is two matchers.
            const hay = foldedHay(text, node.isCaseSensitive);
            let pattern = escapeRegex(node.isCaseSensitive ? normalizeOrthography(node.value) : fold(node.value));
            if (node.isExact) pattern = `${boundaryBefore()}${pattern}${boundaryAfter()}`;
            const n = (hay.match(new RegExp(pattern, 'gu')) ?? []).length;
            return { matched: n > 0, scoreBoost: node.weight * n, units: unit(node, node.weight * n, n) };
        }
        // Shares countRegexKey with countKey: case-sensitive, fold-exempt, on raw text; `/i` is how insensitivity is written.
        case 'REGEX': {
            const n = countRegexKey(node.value, text);
            return { matched: n > 0, scoreBoost: node.weight * n, units: unit(node, node.weight * n, n) };
        }
        // A condition, not a thing: no unit, no boost.
        case 'NOT': {
            const r = evaluate(node.operand, text, acHits);
            return { matched: !r.matched, scoreBoost: 0, units: [] };
        }
        // AND short-circuits, alone among the operators; OR and XOR must visit both sides.
        case 'AND': {
            const l = evaluate(node.left, text, acHits);
            if (!l.matched) return { matched: false, scoreBoost: 0, units: [] };
            const r = evaluate(node.right, text, acHits);
            const units = r.matched ? [...l.units, ...r.units] : [];
            return { matched: r.matched, scoreBoost: boostOf(units), units };
        }
        case 'OR': {
            const l = evaluate(node.left, text, acHits), r = evaluate(node.right, text, acHits);
            const units = pool(node, [...l.units, ...r.units]);
            return { matched: l.matched || r.matched, scoreBoost: boostOf(units), units };
        }
        case 'XOR': {
            const l = evaluate(node.left, text, acHits), r = evaluate(node.right, text, acHits);
            const matched = l.matched !== r.matched;
            const units = matched ? pool(node, l.matched ? l.units : r.units) : [];
            return { matched, scoreBoost: boostOf(units), units };
        }
    }
}

function ensureAst(scope, id, build) {
    let ast = scope.astCache.get(id);
    if (ast === undefined) {
        ast = build();
        registerTerms(scope, ast);
        scope.astCache.set(id, ast);
    }
    return ast;
}

/** Pass 1 (automaton, cached per text) -> build (cached per `id`) -> evaluate. `id` must capture everything the tree depends on:
 *  registerTerms stamps a scope-local index onto each TERM, and a mis-keyed hit evaluates the wrong expression. */
export function evaluateAst(id, build, text, scope = defaultScope) {
    const ast = ensureAst(scope, id, build);
    return evaluate(ast, text, ensureScan(scope, text));
}

/** Full pipeline for one `?` key, which is its own cache id. */
export function evaluateSmartKey(rawKey, text, scope = defaultScope) {
    return evaluateAst(rawKey, () => parse(tokenize(rawKey)), text, scope);
}

/** Registers keys with the scope's automaton without scanning; once per pass, before any scoring — a new key mid-pass dirties the automaton and discards every cached scan. */
export function registerKeys(rawKeys, scope = defaultScope) {
    for (const key of rawKeys) {
        const raw = String(key ?? '').trim();
        if (!raw || isRegexKey(raw)) continue;
        if (raw.startsWith('?')) {
            ensureAst(scope, raw, () => parse(tokenize(raw)));
        } else {
            internLiteral(scope, fold(raw));
        }
    }
}

/** Registers keys and scans each segment once, raising the cache to hold all of them so no segment is evicted mid-pass. */
export function primeScan(rawKeys, text, scope = defaultScope) {
    registerKeys(rawKeys, scope);
    const segments = Array.isArray(text) ? text : [text];
    scope.scanMax = Math.max(scope.scanMax, segments.length + SCAN_CACHE_MAX);
    for (const segment of segments) ensureScan(scope, segment);
}

/** A plain key's count from a primed scan, or undefined when the cache cannot answer (unscanned text, unregistered key, pending
 *  rebuild). A 0 is authoritative under any flags: no folded-substring hit means no case-sensitive or whole-word hit. */
export function cachedCount(raw, text, scope = defaultScope) {
    if (scope.dirty || scope.automaton === null) return undefined;
    const counts = scope.scans.get(text);
    if (counts === undefined) return undefined;
    const idx = scope.termIndex.get(fold(raw));
    if (idx === undefined) return undefined;
    return counts.get(idx) ?? 0;
}

/** Drops every registered key, cached AST and scan; called on chat switch so the automaton tracks the active books' vocabulary. */
export function resetSmartKeys(scope = defaultScope) {
    scope.termIndex.clear();
    scope.patterns.length = 0;
    scope.astCache.clear();
    scope.scans.clear();
    scope.scanMax = SCAN_CACHE_MAX;
    scope.automaton = null;
    scope.dirty = false;
}
