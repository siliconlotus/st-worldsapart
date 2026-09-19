// smartkeys.mjs — boolean query engine for `?`-prefixed World Info keys. Entry point evaluateSmartKey(); countKey() routes `?` keys here.
// The grammar is docs/smartkeys.md's; docs/matching-architecture.md holds what each operator is worth.

import { coreReadsAsRegex, countRegexKey, escapeRegex, foldedHay, isRegexKey, keyExcerpts, maskMarkup, REGEX_FLAGS, REGEX_KEY_RE, boundaryAfter, boundaryBefore, wordChar } from './matcher.mjs';
// Re-exported: matcher.mjs, keyword-tools.mjs and studio.mjs import these from here. One copy, or the browser and the server disagree.
import { buildAutomaton, scanAutomaton, fold, keyVariants, normalizeOrthography, ORTHO_FAMILIES, addMessageHits } from './automaton.mjs';
export { buildAutomaton, scanAutomaton, fold, keyVariants, normalizeOrthography, ORTHO_FAMILIES, addMessageHits };

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
            const f = s.slice(i + 1).match(new RegExp(`^[${REGEX_FLAGS}]*(?=[\\s()|&]|::|\\^|$)`));
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
        if (src[0] === ')') {
            src = src.slice(1);
            // `~N` and the weight ride on the RPAREN in either order; lexed as terms of their own they are punctuation that can never match. Digits required: a bare `~` is text.
            let p = src.match(/^~(\d+)/);
            if (p) src = src.slice(p[0].length);
            const w = src.match(/^(?:::|\^)(\d+(?:\.\d+)?)/);
            if (w) src = src.slice(w[0].length);
            if (!p && (p = src.match(/^~(\d+)/))) src = src.slice(p[0].length);
            tokens.push({ type: 'RPAREN', weight: w ? parseFloat(w[1]) : undefined, near: p ? parseInt(p[1], 10) : undefined });
            continue;
        }
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
        let weight = 1.0, near;
        // Weight is `::` or `^N`, never `:`, so `10:30`, `re:code` and URLs need no quoting; a delimiter followed by non-digits stays in the term.
        if (m[2] !== undefined) {
            // `"…"~N` is taken so the validator can refuse it; left in `src` it would be a term that never matches.
            const p = src.match(/^~(\d+)/);
            if (p) { near = parseInt(p[1], 10); src = src.slice(p[0].length); }
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
            ...(near !== undefined && { near }),
        });
    }
    return tokens;
}

// Nesting ceiling: keywords, not programs. parse throws past it and validateSmartKey relays that as `too-deep`,
// so the recursion below never reaches the stack limit (~2200 groups deep on the engine's own stack) and a
// refused key can never abort the scan matching it.
const MAX_DEPTH = 100;
const tooDeep = () => new Error(`a SmartKey nests more than ${MAX_DEPTH} groups or negations deep`);

/** Recursive descent; adjacent primaries get an implicit AND. Precedence: (...) > NOT > AND > OR/XOR. Malformed tails degrade to null (matches nothing). */
export function parse(tokens) {
    let i = 0;
    const peek = () => tokens[i];
    // A binary operator with nothing on one side keeps the side that exists; the validator is what tells the author.
    const bin = (type, left, right) => (left && right ? { type, left, right } : left ?? right);
    const parseOr = d => {
        let left = parseAnd(d);
        while (peek()?.type === 'OR' || peek()?.type === 'XOR') {
            const type = tokens[i++].type;
            left = bin(type, left, parseAnd(d));
        }
        return left;
    };
    const parseAnd = d => {
        let left = parseUnary(d);
        while (peek() && (peek().type === 'AND' || peek().type === 'TERM' || peek().type === 'REGEX' || peek().type === 'LPAREN' || peek().type === 'NOT')) {
            if (peek().type === 'AND') i++;
            left = bin('AND', left, parseUnary(d));
        }
        return left;
    };
    const parseUnary = d => {
        if (peek()?.type === 'NOT') {
            if (d >= MAX_DEPTH) throw tooDeep();
            i++;
            const operand = parseUnary(d + 1);
            // Dangling NOT ("? -") must not become NOT(null) = matches-everything.
            return operand ? { type: 'NOT', operand } : null;
        }
        return parsePrimary(d);
    };
    const parsePrimary = d => {
        // A binary operator in prefix position is Lucene's per-term marker (`+fire`): skipped, not a missing left operand.
        while (peek() && (peek().type === 'AND' || peek().type === 'OR' || peek().type === 'XOR')) i++;
        const t = tokens[i++];
        if (!t) return null;
        if (t.type === 'LPAREN') {
            if (d >= MAX_DEPTH) throw tooDeep();
            const node = parseOr(d + 1);
            let w, near;
            if (peek()?.type === 'RPAREN') { ({ weight: w, near } = tokens[i]); i++; }
            // `groupWeight`, never `weight`: a TERM already multiplies its own into wsum, and `(fire::2)::3` is both.
            if (node && w !== undefined) node.groupWeight = (node.groupWeight ?? 1) * w;
            // `??=`: in `((a b)~2)~3` the inner clusters are the outer's one conjunct, so the inner slack is the one that binds.
            if (node && near !== undefined) node.near ??= near;
            return node;
        }
        return t.type === 'TERM' || t.type === 'REGEX' ? t : null; // stray RPAREN — drop
    };
    return parseOr(0);
}

/** Whether any term is reachable without passing through an odd number of NOTs — evaluate() gives NOT no score. */
const hasPositiveTerm = (node, negated = false) => {
    if (!node) return false;
    if (node.type === 'TERM' || node.type === 'REGEX') return !negated;
    if (node.type === 'NOT') return hasPositiveTerm(node.operand, !negated);
    return hasPositiveTerm(node.left, negated) || hasPositiveTerm(node.right, negated);
};

/** Structural problems in a key: `error` cannot do what the author meant under any text, `warn` is legal and probably a typo. Structure only; whether a term ever occurs is the audit's df question. */
/** A pattern body NFC composes away: countRegexKey normalises the haystack, so that sequence meets a composed text and
 *  never matches. A warn, not an error — the decomposed run may sit in an optional group the rest of the pattern survives. */
const decomposedFinding = raw => {
    const m = String(raw).match(REGEX_KEY_RE);
    if (!m) return null;
    const nfc = m[1].normalize('NFC');
    if (nfc === m[1]) return null;
    return {
        severity: 'warn', code: 'regex-decomposed',
        message: `The pattern “${raw}” holds a decomposed character — a letter written as a base plus a combining mark. WA composes the text before matching, so that sequence can never match. Written composed it is “/${nfc}/${m[2]}”.`,
    };
};

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
            const decomposed = decomposedFinding(bare);
            if (decomposed) out.push(decomposed);
        }
        if (isRegexKey(bare) && !coreReadsAsRegex(bare)) {
            const hatch = bare.includes('"') ? '' : ` If you meant the literal string, use ? "${bare}".`;
            out.push({
                severity: 'warn', code: 'regex-core-refuses',
                message: `WA runs “${bare}” as a pattern. SillyTavern's own matcher refuses it — it takes neither an unescaped “/” inside the body nor a flag newer than its list — so without WA the key matches only where that exact delimited string appears in the text.${hatch}`,
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

    let ast = null;
    try {
        ast = parse(tokens);
    } catch {
        out.push({
            severity: 'error', code: 'too-deep',
            message: `The key nests deeper than ${MAX_DEPTH} groups or negations, which is past what a keyword needs. Flatten some of the “(” levels — or split it into two keys.`,
        });
        return out;   // a key refused at parse needs no second opinion
    }
    if (!hasPositiveTerm(ast)) {
        out.push({
            severity: 'error', code: 'negation-only',
            message: 'Every term is negated, so this matches whenever they are absent — which is almost always. Add a term that must be present.',
        });
    }

    // A weight lexes as a term only when it followed neither a term nor a group, so it cannot be anything but misplaced.
    // `^N` is the other spelling and lexes differently: `^` is the case flag, leaving a case-sensitive number, and a
    // number has no case for the flag to mean anything by.
    for (const t of terms) {
        if (t.type !== 'TERM' || t.quoted) continue;
        const v = String(t.value);
        const bare = /^(?:::|\^)\d+(?:\.\d+)?$/.test(v);
        const flagged = t.isCaseSensitive && /^\d+(?:\.\d+)?$/.test(v);
        if (!bare && !flagged) continue;
        out.push({
            severity: 'error', code: 'stray-weight',
            message: flagged
                ? `“^${v}” reads as a case-sensitive search for “${v}”, since “^” at the start of a term is the case flag. A weight goes straight after the term or the group it weights, with no space: “fire^${v}”, “(copper pipe)^${v}”.`
                : `The weight ${JSON.stringify(v)} is not attached to anything. A weight goes straight after the term or the group it weights, with no space: “fire::3”, “(copper pipe)::3”.`,
        });
    }

    // The same for `~N`, which the lexer absorbs onto the group: one left over is a second the group cannot take.
    // After a RPAREN only — a bare `~5` elsewhere is ordinary text ("~5 minutes"), and quoting keeps it that way.
    for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type !== 'TERM' || t.quoted || tokens[i - 1].type !== 'RPAREN') continue;
        const v = String(t.value);
        if (!/^~\d+$/.test(v)) continue;
        out.push({
            severity: 'error', code: 'stray-proximity',
            message: `“${v}” is not attached to anything: a group takes one “~N” and this is a second, so it is being searched for as text. Keep the one that applies — “(copper pipe)~3” — or quote it as "${v}" to search for it.`,
        });
    }

    // Quoting is the one construct that carries order, so proximity has nothing to say about a phrase.
    for (const t of terms) {
        // `quoted`, not just `near`: parse() stamps `near` on the lone term of a one-term group, which is the supported spelling.
        if (t.type !== 'TERM' || t.near === undefined || !t.quoted) continue;
        out.push({
            severity: 'error', code: 'proximity-on-phrase',
            message: `“~${t.near}” after a quoted phrase means nothing: the phrase is already its words adjacent and in order. To allow words between, group the terms instead: (${t.value})~${t.near}.`,
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
        const decomposed = decomposedFinding(val);
        if (decomposed) out.push(decomposed);
        if (!coreReadsAsRegex(val)) {
            const hatch = val.includes('"') ? '' : ` If you meant the literal string, quote the term: "${val}".`;
            out.push({
                severity: 'warn', code: 'regex-core-refuses',
                message: `WA runs “${val}” as a pattern. SillyTavern's own matcher refuses it — it takes neither an unescaped “/” inside the body nor a flag newer than its list — so without WA the key matches only where that exact delimited string appears in the text.${hatch}`,
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
    // variantIdx: raw key -> its variants' pattern indices, filled once every variant is interned; the hot path is then a map read.
    return { termIndex: new Map(), patterns: [], automaton: null, dirty: false, scans: new Map(), scanMax: SCAN_CACHE_MAX, astCache: new Map(), variantIdx: new Map(), typedIdx: new Map(), keysByIdx: null };
}

const defaultScope = createScanScope();

function internLiteral(scope, folded) {
    let idx = scope.termIndex.get(folded);
    if (idx === undefined) {
        idx = scope.patterns.length;
        scope.patterns.push(folded);
        scope.termIndex.set(folded, idx);
        scope.dirty = true;
        scope.keysByIdx = null;   // the reverse map is over the interned set, which just grew
    }
    return idx;
}

function registerTerms(scope, node) {
    if (!node) return;
    if (node.type === 'REGEX') {
        // No acIndex: a pattern is not a literal, so it skips pass 1.
    } else if (node.type === 'TERM') {
        // One index per variant: a single one would make the pass-1 zero authoritative for the typed form alone.
        node.acIndex = keyVariants(node.value).map(v => internLiteral(scope, fold(v)));
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
        // Masked, as foldedHay masks: the prescan and the walk have to agree on what the haystack is.
        counts = scanAutomaton(scope.automaton, fold(maskMarkup(text)));
    } else {
        // A hit moves to the newest position: eviction is by insertion order, and a segment two entries share — a
        // repeated header — would otherwise evict under the second entry's pass while it is still being read.
        scope.scans.delete(text);
    }
    scope.scans.set(text, counts);
    while (scope.scans.size > scope.scanMax) scope.scans.delete(scope.scans.keys().next().value);
    return counts;
}

/** A scoring unit: `n` occurrences carrying `wsum` = weight x count. AND's operands are separate units, OR's pool into one; a condition yields none, as does weight 0. `id` is the interned node. */
const unit = (id, wsum, n) => (wsum > 0 && n > 0 ? [{ id, wsum, n }] : []);
// `parts` is the pooled children, for display only: wsum and n stay the alternation's, so boostOf is unchanged.
const pool = (id, units) => (units.length
    ? unit(id, units.reduce((a, u) => a + u.wsum, 0), units.reduce((a, u) => a + u.n, 0)).map(u => ({ ...u, parts: units }))
    : []);
/** Σ weighted occurrences — the same scalar under every operator, so countKey's contract is unaffected by the unit split. */
const boostOf = units => units.reduce((a, u) => a + u.wsum, 0);

/** A TERM's compiled pattern, cached on the node: the forms and the escape do not change, and compiling per evaluation
 *  was the cost countKey's own wholeWordRe removes. Keyed by boundary mode, which setBoundaryMode can move under us. */
const termRegex = node => {
    const mode = `${node.isExact ? boundaryBefore() : ''}`;
    if (node._reMode !== mode) {
        const forms = keyVariants(node.value).map(v => node.isCaseSensitive ? normalizeOrthography(v) : fold(v));
        let pattern = forms.length > 1 ? `(?:${forms.map(escapeRegex).join('|')})` : escapeRegex(forms[0]);
        if (node.isExact) pattern = `${boundaryBefore()}${pattern}${boundaryAfter()}`;
        node._re = new RegExp(pattern, 'gu');
        node._reMode = mode;
    }
    node._re.lastIndex = 0;
    return node._re;
};

/** Evaluates an AST against a text; `acHits` is pass-1 counts for this text, omitted for the pure regex path. An unmatched node
 *  must carry scoreBoost 0: parents sum child boosts without re-checking matched. */
export function evaluate(node, text, acHits) {
    const r = node?.near !== undefined ? evaluateNear(node, text, acHits) : evaluateNode(node, text, acHits);
    const w = node?.groupWeight;
    // `undefined`, not falsy: weight 0 is the documented free gate, and `!w` let `(a b)::0` score its full unweighted boost.
    if (w === undefined || w === 1 || !r.units.length) return r;
    // wsum only: the weight multiplies the thing, and `n` is what the saturation curve reads.
    const units = r.units.map(u => ({ ...u, wsum: u.wsum * w }));
    return { ...r, scoreBoost: boostOf(units), units };
}

function evaluateNode(node, text, acHits) {
    if (!node) return { matched: false, scoreBoost: 0, units: [] };
    switch (node.type) {
        case 'TERM': {
            if (acHits && Array.isArray(node.acIndex)) {
                // No folded-substring hit means no match under any flags; an unflagged term is exactly what pass 1 proved.
                let n = 0;
                for (const i of node.acIndex) n += acHits.get(i) ?? 0;
                if (!n) return { matched: false, scoreBoost: 0, units: [] };
                if (!node.isExact && !node.isCaseSensitive) return { matched: true, scoreBoost: node.weight * n, units: unit(node, node.weight * n, n) };
            }
            // Fold both sides and use the same lookaround as countKey's naive walk — two boundary definitions is two matchers.
            const hay = foldedHay(text, node.isCaseSensitive);
            const n = (hay.match(termRegex(node)) ?? []).length;
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

const wordRuns = () => new RegExp(`${wordChar()}+`, 'gu');
const wordsIn = s => (s.match(wordRuns()) ?? []).length;
const byAt = (a, b) => a.at - b.at || a.to - b.to;
/** Words strictly between two spans; 0 when they touch or overlap. */
const between = (src, a, b) => { if (a.at > b.at) [a, b] = [b, a]; return b.at > a.to ? wordsIn(src.slice(a.to, b.at)) : 0; };

const leaves = (node, out = []) => {
    if (!node) return out;
    if (node.type === 'TERM' || node.type === 'REGEX') out.push(node);
    else if (node.type !== 'NOT') { leaves(node.left, out); leaves(node.right, out); }
    return out;
};

/** A leaf's occurrences as `{at, to}` in the NFC text, none when pass 1 says it is absent. */
function leafSpans(node, text, acHits) {
    if (!evaluateNode(node, text, acHits).matched) return [];
    const isRegex = node.type === 'REGEX';
    return keyExcerpts(String(node.value), text, !isRegex && !!node.isCaseSensitive, !isRegex && !!node.isExact, 0, Infinity).map(e => ({ at: e.at, to: e.to }));
}

/** The ways a group can be satisfied, each `{ reqs, vetoes }`: one span list per conjunct — an alternation of leaves pools into one,
 *  a nested `~N` group is its clusters — and the NOT operands, whose occurrences must be out of reach. */
function alternatives(node, text, acHits, top = false) {
    if (!node) return [];
    if (!top && node.near !== undefined) return [{ reqs: [clusters(node, text, acHits)], vetoes: [] }];
    if (node.type === 'TERM' || node.type === 'REGEX') return [{ reqs: [leafSpans(node, text, acHits)], vetoes: [] }];
    if (node.type === 'NOT') return [{ reqs: [], vetoes: [node.operand] }];
    if (node.type === 'XOR') {
        // `(a XOR b)` is `(a -b) | (b -a)`, the negations being the group's own veto: a cluster through either side unless the other is within reach.
        const side = (a, b) => ({ type: 'AND', left: a, right: { type: 'NOT', operand: b } });
        return alternatives({ type: 'OR', left: side(node.left, node.right), right: side(node.right, node.left) }, text, acHits);
    }
    const l = alternatives(node.left, text, acHits), r = alternatives(node.right, text, acHits);
    if (node.type === 'AND') return l.flatMap(a => r.map(b => ({ reqs: [...a.reqs, ...b.reqs], vetoes: [...a.vetoes, ...b.vetoes] })));
    const both = [...l, ...r];
    return both.every(a => a.reqs.length === 1 && !a.vetoes.length)
        ? [{ reqs: [both.flatMap(a => a.reqs[0]).sort(byAt)], vetoes: [] }]
        : both;
}

/** Leftmost minimal windows over every alternative's spans at once: a window counts when some alternative has one span per conjunct
 *  in it with at most `slack` words between neighbours, is shrunk to what that alternative needs, and is consumed as found; a
 *  `vetoed` one consumes nothing, the sweep moving on from its first span. */
function sweep(alts, slack, src, vetoed) {
    const live = alts.filter(a => a.reqs.length && a.reqs.every(r => r.length));
    if (!live.length) return [];
    // Widened to the words it sits in, so a substring hit is as near as its word and the tail of a word is not a word between.
    const isWord = new RegExp(wordChar(), 'u');
    const snap = ({ at, to }) => {
        while (at > 0 && isWord.test(src[at - 1])) at--;
        while (to < src.length && isWord.test(src[to])) to++;
        return { at, to };
    };
    // One span per extent, carrying every [alternative, conjunct] it serves: a leaf two alternatives share is one occurrence.
    const byExtent = new Map();
    live.forEach((a, ai) => a.reqs.forEach((r, ri) => r.forEach(raw => {
        const { at, to } = snap(raw);
        let sp = byExtent.get(`${at}:${to}`);
        if (!sp) byExtent.set(`${at}:${to}`, sp = { at, to, in: [] });
        sp.in.push([ai, ri]);
    })));
    const spans = [...byExtent.values()].sort(byAt);
    const count = live.map(() => new Map()), have = live.map(() => 0);
    const add = i => { for (const [a, r] of spans[i].in) { const n = (count[a].get(r) ?? 0) + 1; count[a].set(r, n); if (n === 1) have[a]++; } };
    const drop = i => { for (const [a, r] of spans[i].in) { const n = count[a].get(r) - 1; count[a].set(r, n); if (n === 0) have[a]--; } };
    const covered = () => live.findIndex((a, i) => have[i] === a.reqs.length);
    const needed = (a, i) => spans[i].in.some(([ai, r]) => ai === a && count[a].get(r) === 1);
    const out = [];
    let s = 0;
    const reset = i => { s = i; count.forEach(m => m.clear()); have.fill(0); };
    for (let e = 0; e < spans.length; e++) {
        if (e > s && between(src, spans[e - 1], spans[e]) > slack) reset(e);
        add(e);
        for (let a = covered(); a >= 0; a = covered()) {
            while (!needed(a, s)) drop(s++);
            const win = { at: spans[s].at, to: Math.max(...spans.slice(s, e + 1).map(x => x.to)) };
            if (!vetoed(live[a].vetoes, win)) { out.push(win); reset(e + 1); break; }
            drop(s++);
        }
    }
    return out;
}

/** Clusters of a `~N` group, in text order and disjoint. A cluster stands only if no negated operand holds within reach of it:
 *  a leaf or a `~N` group holds by an occurrence at most `near` words away, however far it extends; a compound by its operator
 *  over its sides. */
function clusters(node, text, acHits) {
    const src = String(text).normalize('NFC');
    const occ = new Map();
    // A leaf's occurrences are its matches, snapped as the sweep snaps them: one conjunct at unbounded slack is exactly that.
    const occurrences = v => { let o = occ.get(v); if (!o) occ.set(v, o = clusters(v.near !== undefined ? v : { ...v, near: Infinity }, text, acHits)); return o; };
    const inReach = (v, c) => {
        if (!v) return false;
        if (v.near !== undefined || v.type === 'TERM' || v.type === 'REGEX') return occurrences(v).some(o => between(src, c, o) <= node.near);
        if (v.type === 'NOT') return !inReach(v.operand, c);
        const l = inReach(v.left, c), r = inReach(v.right, c);
        return v.type === 'AND' ? l && r : v.type === 'OR' ? l || r : l !== r;
    };
    return sweep(alternatives(node, text, acHits, true), node.near, src, (vetoes, c) => vetoes.some(v => inReach(v, c)));
}

/** A `~N` group is one thing, seen once per cluster: leaf weights are not read, the group's own applies in evaluate(). `parts` carries
 *  the leaves' units so an excerpt has a term to show. */
function evaluateNear(node, text, acHits) {
    const n = clusters(node, text, acHits).length;
    if (!n) return { matched: false, scoreBoost: 0, units: [] };
    const parts = leaves(node).flatMap(l => evaluateNode(l, text, acHits).units);
    return { matched: true, scoreBoost: n, units: [{ id: node, wsum: n, n, parts }] };
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
            // Fed raw stashes too, not only usableKeys' output: a key the grammar refuses is skipped here, and countKey answers 0 for it.
            try {
                ensureAst(scope, raw, () => parse(tokenize(raw)));
            } catch {
                // Refused at parse — validateSmartKey is the author's answer.
            }
        } else {
            for (const v of keyVariants(raw)) internLiteral(scope, fold(v));
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

/** The literal keys among `literals` whose variants the primed scan of `text` found — the automaton's own answer to which
 *  keys a segment can possibly count, so a caller need run countKey for those alone. The reverse map (pattern index -> keys) is built once per interned set and per `literals` list, by identity. */
export function hitLiterals(scope, text, literals) {
    // Primed here if it is not: the caller means this text to be scanned, and "every literal" is a guess, not an answer.
    const hit = ensureScan(scope, text);
    if (!scope.keysByIdx || scope.keysByIdx.over !== literals) {
        const map = new Map();
        for (const key of literals) {
            for (const v of keyVariants(key)) {
                const i = scope.termIndex.get(fold(v));
                if (i === undefined) continue;
                let list = map.get(i);
                if (!list) map.set(i, list = []);
                list.push(key);
            }
        }
        scope.keysByIdx = { over: literals, map };
    }
    const out = new Set();
    for (const [i, n] of hit) if (n) for (const key of scope.keysByIdx.map.get(i) ?? []) out.add(key);
    return out;
}

/** A plain key's count from a primed scan, or undefined when the cache cannot answer (unscanned text, unregistered key, pending
 *  rebuild). A 0 is authoritative under any flags: no folded-substring hit means no case-sensitive or whole-word hit. */
export function cachedCount(raw, text, scope = defaultScope, expand = true) {
    if (scope.dirty || scope.automaton === null) return undefined;
    const counts = scope.scans.get(text);
    if (counts === undefined) return undefined;
    // The indices are folded and looked up once per key per scope: this runs once per key per segment per entry, and the
    // fold is the audit's whole cost when it runs here (R7 is scan cost; this was the rest).
    const memo = expand ? scope.variantIdx : scope.typedIdx;
    let idx = memo?.get(raw);
    if (idx === undefined) {
        idx = [];
        for (const v of (expand ? keyVariants(raw) : [normalizeOrthography(raw)])) {
            const i = scope.termIndex.get(fold(v));
            if (i === undefined) return undefined;
            idx.push(i);
        }
        memo?.set(raw, idx);
    }
    let total = 0;
    for (const i of idx) total += counts.get(i) ?? 0;
    return total;
}

/** Drops every registered key, cached AST and scan; called on chat switch so the automaton tracks the active books' vocabulary. */
export function resetSmartKeys(scope = defaultScope) {
    scope.termIndex.clear();
    scope.variantIdx?.clear();
    scope.typedIdx?.clear();
    scope.keysByIdx = null;
    scope.patterns.length = 0;
    scope.astCache.clear();
    scope.scans.clear();
    scope.scanMax = SCAN_CACHE_MAX;
    scope.automaton = null;
    scope.dirty = false;
}
