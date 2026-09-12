// keyword-suggest.mjs — the key suggester: what to propose for an entry, from its own text (the TF-IDF ranker) and
// from a model (the prompt, parser and post-filter). ST-free; keyword-suggest-design.md carries the definition work.
import { COMMON_WORDS } from '../plugin/commonwords.js';
import { ZIPF_EN, POS_VA, POS_VA_STRICT, POS_ADJ } from './zipf-en.js';
import { buildAutomaton, scanAutomaton } from './smartkeys.mjs';
import { FUNCTION_WORDS } from './keyword-audit.mjs';

// Curly apostrophes to straight for a ZIPF_EN lookup only (K14); the term keeps what it was written with.
const tblKey = w => w.includes('’') ? w.replace(/’/g, "'") : w;

// Few-shot examples, invented and absent from every lorebook, so the post-filter can drop an echo unconditionally.
const KEY_GOOD_EXAMPLES = ['Thaddeus Wexler', 'Marrowford almshouse', 'illinois homesteaders', 'Quillfeather accord', 'brass orrery'];
const KEY_BAD_EXAMPLES = ['kyle confesses', 'makes him feel', 'when kyle reveals', 'the meeting', 'feelings'];

/** The trigger-keyword extraction prompt for one entry; `avoid` is the book's most-ubiquitous terms. */
export function buildKeyPrompt(entryText, avoid) {
    return [
        'You extract World Info trigger keywords for a roleplay lorebook.',
        'A keyword ACTIVATES this entry when the chat text contains it, so a good keyword is what a user or character would actually type when this entry becomes relevant: a referential NOUN PHRASE — a name, place, object, event, or concept.',
        '',
        'Rules:',
        // A self-selecting count, not a range (S2).
        '- Output as many keywords as you are confident about, each 1 to 4 words, lowercase unless a proper noun or acronym.',
        '- Prefer concrete nouns and named entities. Include the obvious paraphrase a reader would reach for even if those exact words are not in the text.',
        '- NEVER output a full sentence, clause, or verb phrase (bad: "kyle confesses", "makes him feel").',
        '- NEVER output generic filler or a bare ubiquitous name.',
        avoid.length ? `- These appear in almost every entry and are USELESS as keywords — never use them: ${avoid.join(', ')}.` : '',
        '',
        `Good examples: ${KEY_GOOD_EXAMPLES.join(', ')}.`,
        `Bad examples: ${KEY_BAD_EXAMPLES.join(', ')}.`,
        '',
        'Output ONLY the suggested keywords, one per line, no numbering and no commentary.',
        '',
        'ENTRY:',
        entryText,
    ].filter(Boolean).join('\n');
}

/** Tolerant parse of a model's keyword list; never throws. */
export function parseKeyList(raw) {
    return String(raw ?? '')
        .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')   // small models emit curly quotes; fold/canon expect straight
        .split(/[\n,]+/)
        .map(line => line.replace(/^[\s\-*•\d.)\]]+/, '').replace(/["'`.;:]+$/, '').trim())
        .filter(t => t && t.split(/\s+/).length <= 6);
}

// A 4-digit year, a numeric date, or a month name with an adjacent digit: "may day gala" stays, "may 1" goes.
const MONTH_RE = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/;
function isDateLike(term) {
    const t = String(term).toLowerCase();
    if (/\b(?:19|20)\d{2}\b/.test(t)) return true;                     // a 4-digit year
    if (/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/.test(t)) return true;    // numeric date 8/1/2024
    return MONTH_RE.test(t) && /\d/.test(t);                          // month name + a digit
}

/** The one filter for a raw model candidate, shared by the ✨ reroll and the Studio's bulk merge. `reason`: null keeps;
 *  'dupe'; 'echo' (a few-shot example, or a word of one the entry's own text does not use); else 'junk'. `isDupe(term, canon)` is the caller's. */
export function classifyLlmCand(cand, { canon, exampleCanon, exampleWords, entryText = '', dfSubstr, N, dfCeil, excludeDates = true, isDupe }) {
    const term = cand.replace(/^["'`]+|["'`]+$/g, '').trim();
    const c = canon(term) || term.toLowerCase();
    if (!term || term.length > 60) return { term, canon: c, reason: 'junk' };
    if (isDupe(term, c)) return { term, canon: c, reason: 'dupe' };
    if (exampleCanon.has(c)) return { term, canon: c, reason: 'echo' };     // pure prompt echo
    if (exampleWords?.size) {
        const body = String(entryText).toLowerCase();
        if (c.split(' ').some(w => exampleWords.has(w) && !body.includes(w))) return { term, canon: c, reason: 'echo' };
    }
    if (!c.includes(' ') && COMMON_WORDS.has(c)) return { term, canon: c, reason: 'junk' };   // generic single word
    if (excludeDates && isDateLike(term)) return { term, canon: c, reason: 'junk' };
    const df = dfSubstr(term);
    if (df / N > dfCeil) return { term, canon: c, reason: 'junk' };
    return { term, canon: c, df, reason: null };
}

/** Corpus name evidence: `wordSeq(text)` observes a text and returns the suggester's token sequence; `isName(w)` reads it — mid-sentence
 *  capitals at >= NAME_CAP_RATIO, acronyms exempt, "I" excluded, a never-lowercase word absent from ZIPF_EN accepted. The one properness test. */
export function nameEvidence() {
    const fold = w => { w = w.replace(/^['’-]+|['’-]+$/g, ''); return /['’]s$/i.test(w) ? w.slice(0, -2) : w; };
    // A token seen only in all-caps is an acronym; capitals count only mid-sentence.
    const capsSeen = new Set(), mixedSeen = new Set(), lowerCount = new Map(), capMidCount = new Map();
    const isAcr = t => t.length <= 6 && capsSeen.has(t) && !mixedSeen.has(t);
    // Sentence enders emit a '.' sentinel, which ngramsOf never bridges; a possessive gets one on both sides.
    const wordSeq = text => {
        let atStart = true;   // sentence-initial for CAPITALISATION only; a possessive's sentinels don't reset it
        // `[\p{L}'’-]*`, not `+`: single-letter words must tokenise for fDet/bSubj. Openers and closing quotes reset atStart without a sentinel.
        return (String(text ?? '').match(/[\p{L}][\p{L}'’-]*|[.!?…;\n]|["“”‘’(\[{*_:—–«»]/gu) ?? []).flatMap(w => {
            if (/^[.!?…;\n]$/.test(w)) { atStart = true; return ['.']; }
            if (!/\p{L}/u.test(w)) { atStart = true; return []; }
            const core = fold(w), lc = core.toLowerCase();
            (/^[A-Z]{2,}$/.test(core) ? capsSeen : mixedSeen).add(lc);
            if (/^[\p{Ll}]/u.test(core)) lowerCount.set(lc, (lowerCount.get(lc) ?? 0) + 1);
            else if (!atStart && /^[\p{Lu}]/u.test(core)) capMidCount.set(lc, (capMidCount.get(lc) ?? 0) + 1);
            atStart = false;
            return /['’]s$/i.test(w.replace(/^['’-]+|['’-]+$/g, '')) ? ['.', lc, '.'] : [lc];
        });
    };
    // ponytail: 0.95 sits in a wide empty gap (S3); retune only if a real name lands under it.
    const NAME_CAP_RATIO = 0.95;
    const isName = w => {
        if (isAcr(w)) return true;
        if (w === 'i' || /^i['’]/.test(w)) return false;
        const up = capMidCount.get(w) ?? 0, lo = lowerCount.get(w) ?? 0;
        if (up > 0 && up / (up + lo) >= NAME_CAP_RATIO) return true;
        return lo === 0 && (capsSeen.has(w) || mixedSeen.has(w)) && !ZIPF_EN.has(tblKey(w));
    };
    return { fold, wordSeq, isName, isAcr };
}

/**
 * Whole-book TF-IDF keyword suggestion for one loaded lorebook: each entry's own terms ranked by tf x idf across the
 * book plus `bgDocs` (pseudo-documents pooled into the idf denominator). One ranker for the suggest popup and the Studio.
 * @returns {{entries:object[], N:number, perEntry:object[], canon:Function, dfSubstr:Function, avoid:string[], exampleCanon:Set<string>, exampleWords:Set<string>}}
 */
export function buildKeySuggest(data, opts) {
    const { dfCeil, maxN, excludeDates, excludeShort, onlyActive, cap, bgDocs = [], englishGate = true } = opts;
    const STOP = FUNCTION_WORDS;
    const { fold, wordSeq, isName, isAcr } = nameEvidence();
    const canon = k => (String(k).match(/[\p{L}][\p{L}'’-]+/gu) ?? []).map(w => fold(w).toLowerCase()).join(' ');

    const entries = Object.values(data.entries).filter(e => !(onlyActive && e.disable));
    const N = entries.length;

    const seqs = entries.map(e => wordSeq(e.content));
    const uDF = new Map(), uCF = new Map();
    for (const s of seqs) { for (const t of new Set(s)) uDF.set(t, (uDF.get(t) ?? 0) + 1); for (const t of s) uCF.set(t, (uCF.get(t) ?? 0) + 1); }
    // A name is never a function word, however ubiquitous (S3).
    const isFunc = t => STOP.has(t) || ((uDF.get(t) ?? 0) / N > 0.3 && (uCF.get(t) ?? 0) / (uDF.get(t) || 1) < 6 && !isName(t));
    const satEntity = t => (uDF.get(t) ?? 0) / N > 0.85;
    const DET = new Set('the a an this that his her its their my your our los la el whole each every some'.split(' '));
    const PRON = new Set('he she they i we you it who'.split(' '));
    const bAll = new Map(), bDet = new Map(), bSubj = new Map(), fAll = new Map(), fDet = new Map();
    for (const s of seqs) for (let i = 1; i < s.length; i++) {
        const t = s[i], p = s[i - 1];
        bAll.set(t, (bAll.get(t) ?? 0) + 1);
        if (DET.has(p)) bDet.set(t, (bDet.get(t) ?? 0) + 1);
        if (PRON.has(p) || satEntity(p)) bSubj.set(t, (bSubj.get(t) ?? 0) + 1);
        fAll.set(p, (fAll.get(p) ?? 0) + 1);
        if (DET.has(t)) fDet.set(p, (fDet.get(p) ?? 0) + 1);
    }
    const isVerbHead = t => { const tot = bAll.get(t) ?? 0; return tot >= 5 && (bSubj.get(t) ?? 0) / tot > 0.4 && (bDet.get(t) ?? 0) / tot < 0.1; };
    // Verb tests: the table's dominant-POS sets (POS_VA for heads, POS_VA_STRICT anywhere), -ily/-ingly/-edly adverbs off the table, the book's own syntax (takesObj); names outrank all of them.
    const inSetOrStem = (set, w) => set.has(tblKey(w)) || stems(w).some(s => set.has(tblKey(s)));
    const notName = w => !isName(w);
    const posBad = (set, w) => inSetOrStem(set, w) && notName(w);
    const advLy = h => h.length >= 6 && /(?:ily|ingly|edly)$/.test(h) && !ZIPF_EN.has(tblKey(h)) && notName(h);
    const takesObj = t => { const tot = fAll.get(t) ?? 0; return tot >= 2 && (fDet.get(t) ?? 0) / tot > 0.5 && notName(t); };
    const CLITIC = /(?:n['’]t|['’](?:ve|ll|re|d|m|s))$/;
    const headBad = term => {
        const h = term.slice(term.lastIndexOf(' ') + 1);
        if (satEntity(h) || isVerbHead(h) || posBad(POS_VA, h) || takesObj(h) || advLy(h) || CLITIC.test(h)) return true;
        return term.includes(' ') && term.split(' ').some(w => posBad(POS_VA_STRICT, w) || CLITIC.test(w));
    };
    // Linkers may sit inside a gram; a particle may also lead ("de la Cruz"), an English linker may not; nothing trails. Broader than the books on disk use (S4).
    const PARTICLES = new Set('de del da di du la las le les los el van von der den bin ibn al af av dos das'.split(' '));
    const ENG_LINKERS = new Set(['of', 'the']);
    // Elision before a vowel only ("d'Orléans"), so "D'Vorah" stays a name; mute h ("l'homme") is excluded on purpose.
    const ELIDED = /^(?:d|l|dell|dall|nell|sull|all|qu)['’]([aeiouyàáâäæèéêëìíîïòóôöœùúûü].*)$/i;
    const LINKERS = new Set([...PARTICLES, ...ENG_LINKERS]);
    const linkerPosOk = (t, j, n) => PARTICLES.has(t) ? j < n - 1 : (j > 0 && j < n - 1);
    const edgeIllegal = ws => [0, ws.length - 1].some(j => LINKERS.has(ws[j]) && !linkerPosOk(ws[j], j, ws.length));
    // maxN counts content words: a linker neither spends the budget nor earns the length bonus.
    const contentLen = term => { let n = 0; for (const w of term.split(' ')) if (!LINKERS.has(w)) n++; return n; };
    // Successor variety, recorded on the df sweep only: '' once two different tokens have followed the gram; '.' is a successor.
    const SUCC = new Map();
    const ngramsOf = (seq, record = false) => {
        const out = [];
        const blocked = t => t.length < 2 || isFunc(t);
        for (let i = 0; i < seq.length; i++) {
            if (blocked(seq[i]) && !PARTICLES.has(seq[i])) continue;   // only a particle may lead
            let content = 0;
            for (let j = i; j < seq.length; j++) {
                const t = seq[j], link = LINKERS.has(t);
                if (blocked(t) && !link) break;        // nothing longer can be valid either
                if (!link) content++;
                if (content > maxN) break;
                if (link) continue;                    // never emit a gram ending on a linker
                const gram = seq.slice(i, j + 1).join(' ');
                if (record) {
                    const nxt = seq[j + 1] ?? '.', rec = SUCC.get(gram);
                    if (rec === undefined) SUCC.set(gram, { s: nxt, n: 1 });
                    else { rec.n++; if (rec.s !== nxt) rec.s = ''; }
                }
                out.push(gram);
            }
        }
        return out;
    };
    const DF = new Map();
    for (const s of seqs) for (const t of new Set(ngramsOf(s, true))) DF.set(t, (DF.get(t) ?? 0) + 1);

    // Substring df, as countKey sees a key. dfCache is filled by the automaton warm-up below; the scan-on-miss path serves the ✨ path's terms.
    const contentsLc = entries.map(e => String(e.content ?? '').toLowerCase());
    const dfCache = new Map();
    const dfSubstr = t => {
        const q = String(t).toLowerCase();
        let m = dfCache.get(q);
        if (m === undefined) {
            m = 0;
            for (const c of contentsLc) if (c.includes(q)) m++;
            dfCache.set(q, m);
        }
        return m;
    };

    const tfOf = seq => { const tf = new Map(); for (const t of ngramsOf(seq)) tf.set(t, (tf.get(t) ?? 0) + 1); return tf; };
    const tfs = seqs.map(tfOf);   // computed once; the warm-up below and suggestForEntry both read it

    // Display casing: the form the text uses most, voting only where the capital is not positional; a tie goes to the quieter form.
    const SENT_END = /[.!?…;:\n]/, SKIP_BACK = /[ \t"'“”‘’(\[{*_#>-]/;
    const SHOUTED = /[A-Z]{3,}/;
    const tallyForms = (idx, term, voting, all) => {
        const lc = contentsLc[idx], raw = String(entries[idx].content ?? '');
        const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
        for (let p = lc.indexOf(term); p >= 0; p = lc.indexOf(term, p + 1)) {
            const form = raw.slice(p, p + term.length);
            bump(all, form);
            let j = p - 1;
            while (j >= 0 && SKIP_BACK.test(raw[j])) j--;
            if (j >= 0 && !SENT_END.test(raw[j])) bump(voting, form);
        }
    };
    const pickForm = (voting, all) => [...(voting.size ? voting : all)]
        .sort((a, b) => (b[1] - a[1]) || (SHOUTED.test(a[0]) ? 1 : 0) - (SHOUTED.test(b[0]) ? 1 : 0))[0]?.[0] ?? null;
    const wideCache = new Map();
    const wideForm = term => {
        let s = wideCache.get(term);
        if (s === undefined) {
            const voting = new Map(), all = new Map();
            for (let k = 0; k < entries.length; k++) tallyForms(k, term, voting, all);
            wideCache.set(term, s = pickForm(voting, all));
        }
        return s;
    };
    const displayOf = (term, idx) => {
        const voting = new Map(), all = new Map();
        tallyForms(idx, term, voting, all);
        const s = pickForm(voting, all);
        return ((s == null || SHOUTED.test(s)) ? wideForm(term) : s) ?? term;
    };

    // English-frequency gate (zipf-en.js): names z 0; a unigram in the table is cut; a phrase rides its rarest word on a ramp (full at
    // z<=2.5, gone at z>=3.8) and is cut if any non-linker, non-name word is top-500 English (S5). A lowercase -ing word inherits a junk-band pseudo-z.
    // ponytail: constants eyeballed off one book's junk band; retune there.
    const isGer = w => w.length >= 6 && w.endsWith('ing');
    // Naive de-inflection for the table lookup, consulted on a miss only.
    const stems = w => {
        const out = [], undouble = b => (b.length > 2 && b.at(-1) === b.at(-2)) ? b.slice(0, -1) : null;
        const vb = b => { out.push(b, b + 'e'); const u = undouble(b); if (u) out.push(u); };
        if (w.length >= 6 && w.endsWith('ing')) vb(w.slice(0, -3));
        else if (w.length >= 5 && w.endsWith('ed')) vb(w.slice(0, -2));
        else if (w.length >= 5 && w.endsWith('ies')) out.push(w.slice(0, -3) + 'y');
        else if (w.length >= 4 && w.endsWith('s') && !w.endsWith('ss')) { out.push(w.slice(0, -1)); if (w.endsWith('es')) out.push(w.slice(0, -2)); }
        return out;
    };
    const tblZ = w => { let z = ZIPF_EN.get(tblKey(w)); if (z === undefined) { z = 0; for (const s of stems(w)) z = Math.max(z, ZIPF_EN.get(tblKey(s)) ?? 0); } return z; };
    const zEff = w => isName(w) ? 0 : Math.max(tblZ(w), isGer(w) ? 3.8 : 0);
    // Exclusive on the table's 0.1 grid, so a word stored AT the ceiling passes ("order" is 5.5 on wordfreq's scale).
    const PHRASE_WORD_CEIL = 5.5;
    const engMultOf = term => {
        if (!englishGate) return 1;   // the diagnostic's switch: every term passes at full weight
        const words = term.split(' ');
        let minZ = Infinity;
        for (const w of words) {
            minZ = Math.min(minZ, zEff(w));
            if (words.length > 1 && !LINKERS.has(w) && !isName(w) && tblZ(w) > PHRASE_WORD_CEIL) return 0;
        }
        return (words.length === 1 && minZ >= 3.0) ? 0 : Math.min(1, Math.max(0, (3.8 - minZ) / 1.3));
    };
    // An f=1 term is admitted only when every word independently looks name-like: nothing corroborates it.
    const TITLES = new Set('mr mrs ms mx dr st jr sr prof rev sgt capt lt col gen'.split(' '));
    const admit = (term, f) => {
        if (f >= 2) return true;
        const ws = term.split(' ');
        return ws.every((w, i) => (LINKERS.has(w) && linkerPosOk(w, i, ws.length)) || isName(w) || (tblZ(w) < 3.0 && !isGer(w)));
    };

    // Warm dfCache in ONE automaton pass per document (S10); bgDocs pool into the idf denominator.
    const bgLc = bgDocs.map(d => String(d).toLowerCase());
    const M = bgLc.length;
    const bgDF = new Map();
    {
        const wanted = new Set();
        for (const tf of tfs) {
            for (const [term, f] of tf) {
                if (!admit(term, f)) continue;
                if ((DF.get(term) ?? 1) / N > dfCeil) continue;   // the cheap gate that precedes it
                wanted.add(term.toLowerCase());
            }
        }
        if (wanted.size) {
            const terms = [...wanted];
            const aut = buildAutomaton(terms);
            const hits = new Int32Array(terms.length);
            for (const c of contentsLc) for (const idx of scanAutomaton(aut, c).keys()) hits[idx]++;
            terms.forEach((t, i) => dfCache.set(t, hits[i]));
            if (M) {
                const bg = new Int32Array(terms.length);
                for (const c of bgLc) for (const idx of scanAutomaton(aut, c).keys()) bg[idx]++;
                terms.forEach((t, i) => bgDF.set(t, bg[i]));
            }
        }
    }

    // Cohesion: the gram against its leading and trailing bigram, 0.5 when the parts never appear apart and toward 0 when they do (S6).
    // ponytail: validated at n=3..4; a longer gram compares only its shoulders, which errs toward keeping it.
    const bgCache = new Map();
    const bgCount = t => {
        const q = t.toLowerCase();
        let v = bgCache.get(q);
        if (v === undefined) { v = 0; for (const c of bgLc) if (c.includes(q)) v++; bgCache.set(q, v); }
        return v;
    };
    const cohCache = new Map();
    const cohesion = term => {
        let v = cohCache.get(term);
        if (v !== undefined) return v;
        const w = term.split(' ');
        const docs = t => dfSubstr(t) + bgCount(t);
        const parts = [w.slice(0, 2), w.slice(-2)].filter(p => !edgeIllegal(p)).map(p => docs(p.join(' ')));
        const best = Math.max(0, ...parts);
        cohCache.set(term, v = best ? Math.max(1, docs(term)) / (2 * best) : 1);
        return v;
    };
    // Subsumption at equal frequency: a cohesive long gram swallows contained phrases but never a bare word (S7); a particle form gives way to a
    // distinctive bare name; an incohesive one gives way only to its shoulder.
    // ponytail: measured on n>=3 only; bigram-over-unigram keeps the old rule.
    const SUBSUME_COHESION = 0.4;
    const subsume = list => list.filter(r => !list.some(o => {
        if (o === r || o.f !== r.f) return false;
        const [lng, srt] = o.n > r.n ? [o, r] : [r, o];
        if (lng.n === srt.n || !` ${lng.term} `.includes(` ${srt.term} `)) return false;
        if (lng.n < 3 || cohesion(lng.term) >= SUBSUME_COHESION) {
            const lw = lng.term.split(' ');
            let k = 0; while (k < lw.length && PARTICLES.has(lw[k])) k++;
            if (k > 0 && lw.length - k === 1 && srt.term === lw[k] && !ZIPF_EN.has(tblKey(lw[k]))) return r === lng;
            if (srt.n === 1) return false;
            return r === srt;
        }
        const w = lng.term.split(' ');
        const isShoulder = srt.term === w.slice(0, 2).join(' ') || srt.term === w.slice(-2).join(' ');
        return isShoulder && r === lng;
    }));
    const suggestForEntry = (entry, tf, idx) => {
        const existing = new Set((entry.key ?? []).map(canon));
        const rows = [];
        for (const [term, f] of tf) {
            if (!admit(term, f)) continue;
            const ws = term.split(' ');
            if (edgeIllegal(ws)) continue;
            const df = DF.get(term) ?? 1;
            if (df / N > dfCeil) continue;
            // Zero substring hits means the joined gram never occurs literally (folding bridged punctuation).
            if (!dfSubstr(term)) continue;
            const n = term.split(' ').length;
            if (excludeShort && n === 1 && term.length <= 3 && !isAcr(term)) continue;
            if (!isAcr(term) && headBad(term)) continue;
            // An adjective over-fires detached from its noun, so POS_ADJ applies to unigrams only.
            if (n === 1 && posBad(POS_ADJ, term)) continue;
            const el = n === 1 ? term.match(ELIDED) : null;
            if (el && !ZIPF_EN.has(tblKey(el[1])) && tf.has(el[1])) continue;
            if (n === 1 && /^[ivxlcdm]{2,}$/.test(term)) continue;
            if (n === 1 && TITLES.has(term)) continue;
            if (excludeDates && isDateLike(term)) continue;
            const engMult = engMultOf(term);   // the three-class English gate — see engMultOf
            if (!engMult) continue;
            // A gram with exactly one possible successor, seen twice, is the front of a longer name.
            const rec = SUCC.get(term);
            if (n > 1 && rec && rec.n >= 2 && rec.s && rec.s !== '.') continue;
            rows.push({ term, display: displayOf(term, idx), present: existing.has(term), df, f, n,
                score: f * engMult * Math.log((N + M + 1) / (df + (bgDF.get(term) ?? 0) + 0.5)) * (1 + 0.5 * (contentLen(term) - 1)) });
        }
        rows.sort((a, b) => b.score - a.score);
        // A plural adds nothing a substring key can use, so the singular stands alone.
        const have = new Set(rows.map(r => r.term));
        const plural = t => /(?:ies|es|s)$/.test(t) &&
            [t.replace(/ies$/, 'y'), t.replace(/es$/, ''), t.replace(/s$/, '')].find(x => x !== t && have.has(x));
        const kept = subsume(rows.filter(r => !plural(r.term)));
        return { existing, newRows: kept.filter(r => !r.present).slice(0, cap), keyedRows: kept.filter(r => r.present) };
    };

    const perEntry = entries.map((entry, i) => ({ entry, ...suggestForEntry(entry, tfs[i], i) })).filter(pe => pe.newRows.length);

    const avoid = [...uDF].filter(([t, c]) => t.length > 2 && !STOP.has(t) && c / N > 0.5).sort((a, b) => b[1] - a[1]).slice(0, 20).map(x => x[0]);
    const exampleCanon = new Set([...KEY_GOOD_EXAMPLES, ...KEY_BAD_EXAMPLES].map(canon));   // drop few-shot echoes
    const exampleWords = new Set([...exampleCanon].flatMap(x => x.split(' ')));   // ...and mangled/partial ones

    return { entries, N, perEntry, canon, dfSubstr, avoid, exampleCanon, exampleWords };
}

/** dfCeil is the share of entries a candidate may appear in (S8); cap is a display budget, above the per-entry p75 (S9). */
export const STUDIO_SUGGEST_OPTS = { dfCeil: 0.35, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: false, cap: 30, llmChunk: 5000 };

