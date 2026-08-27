// smartkeys.mjs — boolean query engine for `?`-prefixed World Info keys.
//
// A key starting with `?` opts into expression syntax instead of substring matching:
//   ? moon mission -apollo          implicit AND, prefix - negates
//   ? =cat                          = word boundary, ^ case-sensitive (combinable: ^=NASA)
//   ? "moon mission" OR cosmonaut   quoted phrases, AND/OR/NOT/XOR, &&/||/!/-/+, (...) grouping
//   ? fire::2.5                     ::weight scales the key's BM25 contribution (Midjourney's form)
//   ? fire^2.5                      ^N is accepted as an alias — Lucene/Elasticsearch/Solr boost
//   ? meeting 10:30                 a SINGLE colon is ordinary text -- times, verse refs, re:code and
//                                   URLs need no quoting. Only :: introduces a weight.
//   ? +fire +water                  Lucene's per-term required-marker; absorbed, since AND is implicit
//   ? /co(l|s)monaut/i landed       /pattern/flags is a TERM — negatable, weightable, not folded
//   ? M*A*S*H   ? ~5                 * and ~ are LITERALS, not wildcards or fuzzy matching. Substring is
//                                    the default, so "fir" already finds "confirm" without help; a
//                                    /regex/ term is the only pattern syntax, and "/re/" is its literal.
//
// WHEN IN DOUBT, QUOTE IT. Quoting is the one escape in this syntax: it turns off operator, weight,
// paren and wildcard interpretation, and marks a punctuation-only term as deliberate rather than a
// typo. Quoting a SINGLE term never changes what it matches — "fire" and fire are identical, flags
// and weights compose either way — so there is no cost to quoting when unsure.
//
// The exception is quoting ACROSS A SPACE, which is a different SmartKey rather than a safer one:
//   ? hot tub       two terms, implicit AND — matches a hot bath beside a cold tub
//   ? "hot tub"     one phrase — matches the words adjacent, in that order
// Sigur Rós's "()" and its 142-character successor are both single quoted terms; unquoted they parse
// as parens and a conjunction of punctuation.

// Un-extended ST cores see the raw string "? moon ..." and silently never match it — that
// degradation is the compatibility story, so lorebooks stay portable.
//
// Isomorphic like matcher.mjs: no DOM, no ST imports. Entry point is evaluateSmartKey();
// countKey() in matcher.mjs routes `?` keys here.

import { coreReadsAsRegex, countRegexKey, escapeRegex, foldedHay, isRegexKey, REGEX_KEY_RE, boundaryAfter, boundaryBefore, wordChar } from './matcher.mjs';
// The literal matcher and its text fold live under plugin/ so the server can use them too — one copy, or
// the browser and the server would silently disagree about what a key matches. Re-exported because
// matcher.mjs, keyword-tools.mjs and studio.mjs all import them from here.
import { buildAutomaton, scanAutomaton, fold, normalizeOrthography, addMessageHits } from '../plugin/automaton.mjs';
export { buildAutomaton, scanAutomaton, fold, normalizeOrthography, addMessageHits };

const OPS = {
    '&&': 'AND', '&': 'AND', '+': 'AND', 'AND': 'AND',
    '||': 'OR', '|': 'OR', 'OR': 'OR',
    '!': 'NOT', '-': 'NOT', 'NOT': 'NOT',
    'XOR': 'XOR',
};

/**
 * The regex literal opening at position 0, or null when the token is not one.
 *
 * LEFTMOST QUALIFYING CLOSE, not merely the leftmost close. A candidate delimiter is accepted only
 * when the body it delimits COMPILES and its flag run ENDS AT A TOKEN BOUNDARY; otherwise the scan
 * keeps going. Delimiter hunting alone is not enough, because `/` is both this grammar's delimiter
 * and an ordinary character inside a pattern.
 *
 * WHY THIS AND NOT A TOKEN BOUNDARY FIRST. `(`, `)` and `|` are simultaneously SmartKey syntax and
 * regex syntax, so no boundary set can be drawn before the scan: splitting on them breaks
 * `? /(rain|snow)/`, and splitting on whitespace alone breaks `? (/a/|/b/) x`. Scanning with regex
 * literal rules and letting the surviving candidate decide needs neither classification up front.
 *
 * WHAT IT BUYS: a term reads exactly as the same string reads as a WHOLE KEY. The plain-key rule is
 * "the entire string is `/…/flags`" (REGEX_KEY_RE), and when a term is the entire key this rule's
 * accept test is that same test — so `/home/user/lux/` is one pattern in both, `/home/user/file` is
 * a literal in both, and `countKey is the only matcher` finally holds for the `?` path too.
 *
 * `\` escapes the next character and `[`…`]` is a class the delimiter cannot close inside, both as
 * ECMA-262's RegularExpressionLiteral has them. `\/` writes a literal slash and is what core
 * requires for portability, so escaping also collapses the WA/core divergence (regex-core-refuses).
 *
 * The compile is the one semantic step in the lexer. Bounded: only tokens opening with `/` reach it
 * and ASTs are cached per key. Exposure, not justification — the rule stands on one syntax having one
 * reading, and the books on disk hold 2 regex keys in 46,226, so they cannot speak to it either way.
 *
 * @param {string} s A string whose first character is `/`
 * @returns {{value: string, rest: string}|null} The `/pattern/flags` token and what follows
 */
function regexLiteral(s) {
    let inClass = false;
    for (let i = 1; i < s.length; i++) {
        const c = s[i];
        if (c === '\\') { i++; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
            const body = s.slice(1, i);
            // An empty body is not a pattern, exactly as REGEX_KEY_RE's `.+` says of a whole key.
            if (!body) continue;
            // Flags run to a token boundary or there are none — an unbounded run eats the next token
            // (`? /home/user/file` once took `us` out of "user"), and a run that cannot end cleanly
            // means this delimiter was not the close.
            const f = s.slice(i + 1).match(/^[gimsuy]*(?=[\s()|&]|::|\^|$)/);
            if (!f) continue;
            try { new RegExp(body, f[0]); } catch { continue; }
            return { value: `/${body}/${f[0]}`, rest: s.slice(i + 1 + f[0].length) };
        }
    }
    return null;
}

/**
 * Lexes a SmartKey (leading `?` already meaningful but tolerated) into tokens.
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
        // REGEX TERM. A `/re/` key is evaluated as a pattern everywhere else it appears — core's
        // matchKeys and countKey both branch on it — and the literal reading survived in exactly one
        // place, in here, where tokenize handed evaluate a bare word. Nobody chose that; it fell out
        // of a lexer that did not know regexes exist. So this closes a divergence rather than adding
        // a feature, and the literal stays reachable through the escape already there: `? "/re/"`.
        //
        // Only at TOKEN START, the rule `"` and `-`/`!`/`+` already follow, so `and/or` and `3/4` are
        // untouched. After the operator match, so `? -/re/` negates a pattern.
        if (src[0] === '/') {
            // Not a pattern falls through to the term lexer, which is core's own answer for a regex
            // it refuses and the plain key's answer for `/home/user/file`. Nothing here reports a
            // fault, because there is no longer a fault to report: the string simply is a literal.
            // A token that fails to compile is still a REGEX when the WHOLE remaining source is a
            // well-formed `/…/flags`, because that is precisely the plain-key test and the two must
            // agree: `? /(/` has to be the dead pattern `/(/` is as a bare key, not the literal three
            // characters. Only the SHAPE being absent — `/re`, `//`, `/home/user/file` — makes it a
            // literal, and those are literals as bare keys too.
            const re = regexLiteral(src) ?? (REGEX_KEY_RE.test(src) ? { value: src, rest: '' } : null);
            if (re) {
                const w = re.rest.match(/^(?:::|\^)(\d+(?:\.\d+)?)/);
                src = w ? re.rest.slice(w[0].length) : re.rest;
                tokens.push({ type: 'REGEX', value: re.value, weight: w ? parseFloat(w[1]) : 1.0 });
                continue;
            }
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
        return t.type === 'TERM' || t.type === 'REGEX' ? t : null; // stray RPAREN — drop
    };
    return parseOr();
}

/**
 * Whether any TERM contributes POSITIVELY — reachable without passing through an odd number of NOTs.
 * Mirrors how evaluate() accumulates: NOT yields no score and discards its subtree's, so a SmartKey with
 * no positive term matches on absence alone.
 */
const hasPositiveTerm = (node, negated = false) => {
    if (!node) return false;
    if (node.type === 'TERM' || node.type === 'REGEX') return !negated;
    if (node.type === 'NOT') return hasPositiveTerm(node.operand, !negated);
    return hasPositiveTerm(node.left, negated) || hasPositiveTerm(node.right, negated);
};

/**
 * Structural problems in a key, for the Studio's save check and the audit — one definition, so the
 * two surfaces cannot disagree about what is valid. Almost everything here is about a `?` SmartKey;
 * the one exception is a bare `/re/` key core and WA read differently, which is checked and returned
 * before the SmartKey body because it is the same question — will this key do what it looks like.
 *
 * STRUCTURE ONLY. Whether a term ever occurs is a question about a book's text, and belongs to the
 * audit's df machinery rather than here; this needs nothing but the string.
 *
 * Severity is the split that matters. `error` is a SmartKey that cannot do what its author meant under
 * any text. `warn` is legal and probably a typo. Nothing here is fatal at match time — the matcher's
 * job is to fire, and telling an author their key is malformed is this function's job instead.
 *
 * @param {string} raw The key, with or without its leading `?`
 * @returns {Array<{severity: 'error'|'warn', code: string, message: string}>} empty when clean
 */
export function validateSmartKey(raw) {
    const out = [];
    const src = String(raw ?? '');
    if (!src.trim().startsWith('?')) {
        // A BARE regex key the two implementations read differently: core refuses a pattern whose
        // delimiter appears unescaped inside it and matches the whole delimited string as literal
        // text, where WA runs it as a pattern. Neither reading is dead — core's fires wherever the
        // delimited form itself appears — so this says what each side does and leaves what was meant
        // to the author. WARN, not error: the matcher's reading is unchanged.
        //
        // The literal hatch is `? "…"`, NOT `"…"`. Quoting is a SmartKey term rule; a bare key keeps
        // the quotes as characters and then matches neither reading.
        //
        // The term goes in RAW, in typographic quotes. JSON.stringify renders a JSON view of it —
        // `/a\/b/c/` came back as `/a\\/b/c/` — so the hatch instructed the author to type a string
        // that was not their key. A key already containing a `"` has no hatch at all, because the
        // quote would close the term early, so that sentence is dropped rather than made wrong.
        const bare = src.trim();
        // A bare pattern `new RegExp` refuses, checked here for the same reason the SmartKey body checks
        // its REGEX terms: it is a fact about the string, and countRegexKey's catch turns it into a key
        // that silently counts 0 forever. Nobody depends on a broken pattern to never match — the literal
        // is one rewrite away — so this is an ERROR and usableKeys bars it, in either key position.
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
    // A REGEX counts as a term for no-terms, for hasPositiveTerm and for all-zero-weights. Without
    // that, `? /re/` reported no-terms and `? /re/ -drill` reported negation-only — both fatal, and
    // usableKeys would bar a key that matches perfectly well. The checks that read a term's
    // VALUE still skip it below: a pattern is punctuation by nature, so punctuation-term and
    // stray-quote would fire on every one.
    const terms = tokens.filter(t => t.type === 'TERM' || t.type === 'REGEX');

    if (!terms.length) {
        out.push({ severity: 'error', code: 'no-terms', message: 'No search terms — this key can never match.' });
        return out;   // everything below reads the terms; no point compounding the report
    }

    // A SmartKey that only says what must be ABSENT matches on nearly every scan. Core forbids the shape
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
    // leaves `?` behind as a literal term and the SmartKey quietly matches any text containing one.
    for (const t of terms) {
        if (t.type !== 'TERM') continue;
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

    // An UNCLOSED quote, which is the only shape the lexer can produce from one: the quoted
    // alternative needs a closing `"`, so `? "moon` falls through to the bare-word branch and keeps
    // the quote as the first character of the value. Anywhere else a `"` is ordinary text —
    // `? 6" copper pipe` is three terms that score 3 against *that copper pipe is 6" in diameter*,
    // and flagging its VALUE (which is what this did) made a working key fatal, so `usableKeys`
    // barred it from activating while countKey went on scoring it. Reads structure, not intent.
    for (const t of terms) {
        if (t.type === 'TERM' && !t.quoted && String(t.value).startsWith('"')) {
            out.push({
                severity: 'error', code: 'stray-quote',
                message: 'Unclosed quote — close the phrase, or remove the quote.',
            });
        }
    }

    // A REGEX token now only exists where the SHAPE exists, so the two shape faults are gone:
    // `? /re` and `? //` are literal terms, exactly as the bare keys `/re` and `//` are literal.
    // What survives is the pattern that is well-formed and will not compile — a fact about the
    // string, the same bar the other checks clear — plus core's refusal, which is about the reading
    // rather than the string and so warns instead.
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
        // Reachable from a TERM only since the term rule became the whole-key rule; before that the
        // scan split a slash-bearing pattern before anything could ask what core made of it.
        if (!coreReadsAsRegex(val)) {
            // WA FIRST, because WA is the side that runs it. Four things an author can have meant, and
            // only one of them wants anything done: written for core as a pattern, core was silently
            // dead and WA repairs it; meant to evaluate under WA, it already does; meant as the
            // literal delimited string, the hatch is here. Leading with core's reading framed WA as
            // the deviant in three cases out of four.
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



// Cache floor for scanned buffers, per scope; insertion-ordered, oldest evicted first. primeScan
// raises it to fit a segmented window (see there).
const SCAN_CACHE_MAX = 8;

/**
 * One key as one node, by the same three-way split countKey makes — so the synthesis inherits
 * "entry flags reach plain keys only" rather than restating it.
 *
 *   `? …`      parses and splices in as a SUBTREE, carrying its own per-term flags and weights.
 *   `/re/`     a REGEX node, which carries its own case sensitivity in its flags.
 *   anything   a TERM carrying the ENTRY's flags. No escaping and no quoting: a node holds arbitrary
 *              text verbatim, which is why a key containing a double quote needs no escape here.
 */
const keyNode = (raw, { caseSensitive = false, wholeWords = false } = {}, weight = 1) => {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    if (s.startsWith('?')) return parse(tokenize(s));
    if (isRegexKey(s)) return { type: 'REGEX', value: s, weight };
    return { type: 'TERM', value: s, isExact: !!wholeWords, isCaseSensitive: !!caseSensitive, quoted: true, weight };
};

/**
 * Rewrites core's `(key, keysecondary, selectiveLogic)` as ONE expression AST — the route by which
 * WA's own matcher answers core's selective logic, so that stays one question with one answer.
 *
 * One expression PER PRIMARY KEY, not one for the whole entry. Collapsing the primaries into an
 * alternation would work for activation and lose the per-key granularity keywordScore's saturation
 * wants: an entry keyed on three names that all appear should not score as one term.
 *
 *   AND_ANY   p and at least one secondary   AND(p, OR(s1, s2))
 *   AND_ALL   p and all of them              AND(p, AND(s1, s2))
 *   NOT_ANY   p and none of them             AND(AND(p, NOT(s1)), NOT(s2))
 *   NOT_ALL   p and not all of them          AND(p, NOT(AND(s1, s2)))
 *
 * AN AST, NOT A STRING, and that is the whole of why this has no refusals. Every one the string route
 * had was an artifact of emitting a `?` string the lexer then had to read back: a key containing a
 * double quote had no escape in the grammar, and a `?` or `/re/` key could not survive being quoted
 * as a term. A node carries its value verbatim and nothing lexes it.
 *
 * SECONDARY NODES CARRY WEIGHT 1, like any other term, so this converts the two-list form into the
 * expression an author would have written by hand and the two score alike. They used to be zeroed,
 * on the reasoning that a gate contributing anything would inflate the primary's count — true while
 * AND and OR summed into ONE count, and dissolved by scoring units: a secondary is now its own unit
 * and inflates nothing. What was left was a policy that the same logic scored differently depending
 * on which of WA's two syntaxes wrote it, which is the disagreement synthesizeSecondary exists to
 * prevent.
 *
 * THE NOT LOGICS ARE UNAFFECTED either way, which is why the zeroing looked more principled than it
 * was: NOT yields no unit whatever its operand weighs, so the weight only ever reached AND_ANY and
 * AND_ALL — where the secondary is a positive term the author required, not a condition.
 *
 * A non-blank secondary that parses to nothing stays in the list as a null child rather than being
 * dropped — evaluate reads null as "did not match", which is core's answer for a key that cannot
 * fire, where dropping it would make AND_ALL pass on a gate core fails.
 *
 * @param {string} primary One of the entry's primary keys
 * @param {string[]} secondaries entry.keysecondary
 * @param {number} logic entry.selectiveLogic (WI_LOGIC)
 * @param {{caseSensitive?: boolean, wholeWords?: boolean}} flags The entry's resolved match flags
 * @returns {object|null} An AST node, or null when the primary is blank
 */
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
    return { termIndex: new Map(), patterns: [], automaton: null, dirty: false, scans: new Map(), scanMax: SCAN_CACHE_MAX, astCache: new Map() };
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
    if (node.type === 'REGEX') {
        // No acIndex: a pattern is not a literal, so it cannot be a trie candidate and skips pass 1.
    } else if (node.type === 'TERM') {
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
        // Raised by primeScan to fit a segmented window; SCAN_CACHE_MAX is the floor, not the cap.
        while (scope.scans.size > scope.scanMax) scope.scans.delete(scope.scans.keys().next().value);
    }
    return counts;
}

/**
 * Evaluates an AST against a text buffer.
 * @param {Map<number, number>} [acHits] Pass-1 counts for this text; omitted = pure regex path.
 * @returns {{matched: boolean, scoreBoost: number}}
 */
/**
 * A SCORING UNIT: one thing the expression is about, with the occurrences it was seen by and the
 * weight those occurrences carried. `n` is a count and `wsum` is weight x count, so the unit's mean
 * weight is `wsum/n` — which is how a mixed group (`? (everest OR kailash::2)`) reports 2 when only
 * the weighted alternative fired and 1 when only the plain one did.
 *
 * WHY UNITS AND NOT ONE NUMBER. Saturation has to be applied per unit, and a single accumulated
 * count cannot say how many units it came from: `? moon AND rocket` and `? moon` on a text holding
 * both reach 2 and 1 the old way, so the STRICTER expression scored higher. AND joins distinct
 * things, so its operands are separate units and their scores add; OR names one thing several ways,
 * so its operands POOL into one unit and their occurrences share a single saturation. Everything
 * else in the tree is a condition, not a thing, and yields no unit.
 *
 * `id` is the AST node heading the unit. Nodes are interned per (cache id, scope), so the same unit
 * is the same object across every segment of a window — which is what lets keywordScore pool a
 * unit's occurrences across segments and saturate it once, as it always has for a plain key.
 *
 * WEIGHT 0 YIELDS NO UNIT. That is the whole meaning of a zero weight: a condition, never evidence.
 * `? a AND b::0` is how an author says it by hand. Excluded from the unit entirely rather than
 * averaged in at 0, or a zero-weight member of an OR group would drag its mean down and quietly
 * discount the term the author did mean.
 */
const unit = (id, wsum, n) => (wsum > 0 && n > 0 ? [{ id, wsum, n }] : []);
/** Pool units into one — OR's rule: the same thing, spelled more than one way. */
const pool = (id, units) => (units.length
    ? unit(id, units.reduce((a, u) => a + u.wsum, 0), units.reduce((a, u) => a + u.n, 0))
    : []);
/** Σ weighted occurrences — EXACTLY the scalar evaluate returned before units existed, under every
 *  operator (AND concatenates and OR pools, and both sum the same wsums). Kept so countKey's contract
 *  and every caller reading a count are untouched by the unit split. */
const boostOf = units => units.reduce((a, u) => a + u.wsum, 0);

export function evaluate(node, text, acHits) {
    if (!node) return { matched: false, scoreBoost: 0, units: [] };
    switch (node.type) {
        // A TERM's contribution is weight x OCCURRENCES, not weight alone. Scoring on presence made a
        // SmartKey blind to recurrence: "? (glasses | spectacles)" returned the same number whether the
        // concept appeared once or nine times, so it scored WORSE than the bare key `glasses` the moment
        // the word repeated — being thorough about spelling was penalised. The counts were already
        // computed and cached: the automaton's scan returns a per-term occurrence map, and this function
        // was handed it and called .has() on it.
        case 'TERM': {
            if (acHits && node.acIndex !== undefined) {
                // Candidate filter: no folded-substring hit means no match under any flags.
                const n = acHits.get(node.acIndex);
                if (!n) return { matched: false, scoreBoost: 0, units: [] };
                // Unflagged term = case-insensitive substring, which is exactly what Pass 1 proved.
                if (!node.isExact && !node.isCaseSensitive) return { matched: true, scoreBoost: node.weight * n, units: unit(node, node.weight * n, n) };
            }
            // Fold BOTH sides, exactly as countKey's naive walk does. Pass 1 proved the term present in
            // FOLDED text, so verifying the flags against raw text asks a different question than the
            // filter that got here: `? =Cap'n` passed the automaton against "Cap’n" and then failed its
            // own regex, where the plain whole-word key `Cap'n` matched. Case is handled by lowercasing
            // rather than the `i` flag, again like countKey, so the two paths cannot drift.
            const hay = foldedHay(text, node.isCaseSensitive);
            let pattern = escapeRegex(node.isCaseSensitive ? normalizeOrthography(node.value) : fold(node.value));
            // Same lookaround boundary as countKey's whole-word path — \b would make punctuation-edged
            // terms like =c++ unmatchable. Shares wordChar() with countKey rather than restating it:
            // two boundary definitions is two matchers, which is exactly what CLAUDE.md forbids.
            if (node.isExact) pattern = `${boundaryBefore()}${pattern}${boundaryAfter()}`;
            // Counted, not tested: same walk of the text either way, and a flagged term has as much
            // right to recurrence as an unflagged one.
            const n = (hay.match(new RegExp(pattern, 'gu')) ?? []).length;
            return { matched: n > 0, scoreBoost: node.weight * n, units: unit(node, node.weight * n, n) };
        }
        // Structurally a TERM that never uses the candidate filter. It shares countRegexKey with
        // countKey, so "countKey is the only matcher" holds across the regex path too — and, like a
        // whole-key regex, it is CASE-SENSITIVE and FOLD-EXEMPT: countKey branches before foldedHay,
        // so a pattern runs on raw text. Inside a SmartKey that means mixed folding, and `/i` is how
        // insensitivity is written.
        case 'REGEX': {
            const n = countRegexKey(node.value, text);
            return { matched: n > 0, scoreBoost: node.weight * n, units: unit(node, node.weight * n, n) };
        }
        // A negation is a CONDITION: it narrows what matched and is never itself a thing the text is
        // about, so it yields no unit and no boost however its operand scored.
        case 'NOT': {
            const r = evaluate(node.operand, text, acHits);
            return { matched: !r.matched, scoreBoost: 0, units: [] };
        }
        // Invariant: an unmatched node carries scoreBoost 0. Parents read child boosts without
        // re-checking child.matched (AND and OR both sum), so a failed branch that kept a
        // boost would leak it upward — e.g. "? (fire:3 XOR flood:3) OR water:0.5" with both fire
        // and flood present must score 0.5, not 3.
        // AND joins DISTINCT things, so each side keeps its own units and their scores will add. This
        // is why a conjunction no longer outscores its own left operand: `? moon AND rocket` is two
        // units of one occurrence each, not one unit of two.
        // SHORT-CIRCUITS, alone among the operators, because it is the only one that throws its operands
        // away on failure: an unmatched AND contributes no units, so a right operand evaluated after a
        // failed left cannot affect the result. Worth nothing for a plain term, which the automaton has
        // already reduced to a map lookup — the saving is a REGEX operand or a flagged term (`=`, `^`),
        // both of which fall through to a regex over the folded haystack that no candidate filter can
        // spare them.
        //
        // OR and XOR must still visit both: OR pools the two sides into one unit and sums them, and XOR
        // needs both verdicts to know whether exactly one held.
        case 'AND': {
            const l = evaluate(node.left, text, acHits);
            if (!l.matched) return { matched: false, scoreBoost: 0, units: [] };
            const r = evaluate(node.right, text, acHits);
            const units = r.matched ? [...l.units, ...r.units] : [];
            return { matched: r.matched, scoreBoost: boostOf(units), units };
        }
        // OR SUMS, like AND. max() was only ever right because it coincided with the sum whenever a
        // single branch matched — unmatched branches carry 0 — and it diverged exactly where a synonym
        // group needs the total: "(glasses | spectacles)" is one concept, and its mentions are its
        // mentions however they were spelled. Summing is also what keywordScore already does across
        // keys, and saturation caps the result, so a wide alternation cannot run away.
        // OR names ONE thing several ways, so its operands pool into a single unit: the mentions are
        // the concept's mentions however they were spelled, and they share one saturation. That is what
        // makes `? (glasses OR spectacles)` score exactly as the bare key does on equal evidence,
        // instead of collecting a separate saturation budget per synonym.
        case 'OR': {
            const l = evaluate(node.left, text, acHits), r = evaluate(node.right, text, acHits);
            const units = pool(node, [...l.units, ...r.units]);
            return { matched: l.matched || r.matched, scoreBoost: boostOf(units), units };
        }
        // XOR is an alternation like OR — one thing, exclusively one of two spellings — so the side
        // that matched supplies the unit and the other contributes nothing.
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

/**
 * Full pipeline for one AST against one text buffer:
 * Pass 1 candidate scan (Aho-Corasick, cached per text) -> Pass 2 build (cached per id) -> evaluate.
 *
 * The id is what interns the tree, and it must therefore capture everything the tree depends on —
 * registerTerms stamps a scope-local pattern index onto each TERM, so a cache hit reuses those and a
 * mis-keyed hit would evaluate the wrong expression. A raw `?` key IS its own id; a synthesised
 * expression needs its inputs joined (see countKey's selective path).
 *
 * @param {string} id Cache key for the built tree
 * @param {() => object|null} build Builds the tree; called once per id per scope
 * @param {string} text Scan text
 * @param {object} [scope] Matching context (default: the shared retrieval scope)
 * @returns {{matched: boolean, scoreBoost: number}}
 */
export function evaluateAst(id, build, text, scope = defaultScope) {
    const ast = ensureAst(scope, id, build);
    return evaluate(ast, text, ensureScan(scope, text));
}

/**
 * Full pipeline for one `?` key against one text buffer.
 * @param {string} rawKey Key string including the leading `?`
 * @param {string} text Scan text
 * @param {object} [scope] Matching context (default: the shared retrieval scope)
 * @returns {{matched: boolean, scoreBoost: number}}
 */
export function evaluateSmartKey(rawKey, text, scope = defaultScope) {
    return evaluateAst(rawKey, () => parse(tokenize(rawKey)), text, scope);
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
            ensureAst(scope, raw, () => parse(tokenize(raw)));
        } else {
            internLiteral(scope, fold(raw));
        }
    }
}

/**
 * Batch-registers a key list and scans the text once, so subsequent countKey calls against
 * the same text answer from the automaton instead of walking the buffer per key.
 *
 * Accepts a segmented window (see ranking.scanSegments). Every segment is primed in one call so the
 * automaton is built once, and the cache is raised to hold all of them — evicting a segment mid-pass
 * would send the next entry back to the naive walk for a buffer that was just scanned. Segments key
 * BY VALUE, so two entries segmenting the same window share every scan and an entry that appends
 * match sources pays only for the appended text.
 *
 * @param {string[]} rawKeys
 * @param {string|string[]} text One text, or the window's segments
 * @param {object} [scope]
 */
export function primeScan(rawKeys, text, scope = defaultScope) {
    registerKeys(rawKeys, scope);
    const segments = Array.isArray(text) ? text : [text];
    scope.scanMax = Math.max(scope.scanMax, segments.length + SCAN_CACHE_MAX);
    for (const segment of segments) ensureScan(scope, segment);
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
    scope.scanMax = SCAN_CACHE_MAX;
    scope.automaton = null;
    scope.dirty = false;
}
