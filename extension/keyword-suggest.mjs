// keyword-suggest.mjs — the KEY SUGGESTER: what to propose for an entry, from its own text (the
// TF-IDF ranker) and from a model (the LLM candidate prompt, parser and post-filter). Whether an
// existing key WORKS is keyword-audit.mjs, which this file reads rather than restates: a suggestion
// must not be a term the audit would immediately flag.
//
// ST-free and node-importable (the matcher.mjs pattern); keyword-tools.mjs layers the ST plumbing on
// top. keyword-suggest-design.md carries the live definition work behind it.
import { COMMON_WORDS } from '../plugin/commonwords.js';
import { ZIPF_EN, POS_VA, POS_VA_STRICT, POS_ADJ } from './zipf-en.js';
import { countKey } from './matcher.mjs';
import { buildAutomaton, scanAutomaton, parse } from './smartkeys.mjs';
// ONE JUNK VOCABULARY, and one too-common line, so the two tools cannot disagree about what to refuse.
import { FUNCTION_WORDS, KEY_BOOK_COMMON } from './keyword-audit.mjs';

// Curly apostrophes are folded to straight ones before a ZIPF_EN lookup: the table is keyed straight,
// and "isn’t" missing it scored as maximally rare — the exact inverse of the truth.
const tblKey = w => w.includes('’') ? w.replace(/’/g, "'") : w;

// Few-shot examples, shared so the LLM post-filter can drop them unconditionally: a cold small model
// sometimes regurgitates them verbatim instead of reading the entry. The good ones are deliberately
// invented, maximally-specific SEMAPHORES (a name, place, group, event, object — spanning the target
// categories) verified absent from every lorebook, so echoing even ONE is unmistakable — no real
// entry coincidentally yields "quillfeather accord". That's why filtering them can be unconditional.
const KEY_GOOD_EXAMPLES = ['Thaddeus Wexler', 'Marrowford almshouse', 'illinois homesteaders', 'Quillfeather accord', 'brass orrery'];
const KEY_BAD_EXAMPLES = ['kyle confesses', 'makes him feel', 'when kyle reveals', 'the meeting', 'feelings'];

/**
 * Prompt for World Info trigger-keyword extraction from one entry. Framed as the retrieval job the
 * keys actually do (fire when chat text contains them): demands referential noun phrases, bans
 * clauses/verbs/generic words, and few-shots good vs bad with the cases we validated. `avoid` is the
 * book's most-ubiquitous terms — worthless as discriminators — so the model doesn't waste picks.
 */
export function buildKeyPrompt(entryText, avoid) {
    return [
        'You extract World Info trigger keywords for a roleplay lorebook.',
        'A keyword ACTIVATES this entry when the chat text contains it, so a good keyword is what a user or character would actually type when this entry becomes relevant: a referential NOUN PHRASE — a name, place, object, event, or concept.',
        '',
        'Rules:',
        // SELF-SELECTING COUNT, not a range. Was "5 to 10". A fixed count is the wrong instrument
        // because entries differ in how much key material they hold: any floor is too high for a
        // sparse entry, where the model pads rather than stops, and too low for a rich one.
        // Chosen on WORST-CASE F across wordings and model configurations, not on any single cell,
        // and the choice holds across the beta spread — it does not depend on where recall is
        // weighted against precision (S2).
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

/**
 * Tolerant parse of a small model's keyword list: splits on newlines/commas, strips bullets, numbers,
 * quotes and trailing punctuation, drops blanks and anything sentence-length. Never throws.
 */
export function parseKeyList(raw) {
    return String(raw ?? '')
        .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')   // small models emit curly quotes; fold/canon expect straight
        .split(/[\n,]+/)
        .map(line => line.replace(/^[\s\-*•\d.)\]]+/, '').replace(/["'`.;:]+$/, '').trim())
        .filter(t => t && t.split(/\s+/).length <= 6);
}

// A date is a poor trigger keyword (near-zero recall whole, substring-collides split — "august 1"
// also fires "august 10–19"), even though it earns its place in the entry body for chronology. The
// month-name test requires an adjacent digit so a month word alone survives — "may day gala" stays,
// "may 1" goes. Spelled-out days ("december twenty five") slip through; rare enough to ignore.
const MONTH_RE = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/;
export function isDateLike(term) {
    const t = String(term).toLowerCase();
    if (/\b(?:19|20)\d{2}\b/.test(t)) return true;                     // a 4-digit year
    if (/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/.test(t)) return true;    // numeric date 8/1/2024
    return MONTH_RE.test(t) && /\d/.test(t);                          // month name + a digit
}

/**
 * One filter for a raw model key candidate — the suggest popup's ✨ reroll and the Studio's bulk
 * merge must agree on what counts as junk. Cleans the candidate and returns { term, canon, df,
 * reason }: reason null = keep; 'dupe' and 'echo' are distinguished so callers can report them
 * (already-keyed isn't garbage, a prompt echo warrants a reroll hint), everything else is 'junk'.
 * `isDupe(term, canon)` is caller-supplied — each surface tracks its own already-shown set.
 */
export function classifyLlmCand(cand, { canon, exampleCanon, exampleWords, entryText = '', dfSubstr, N, dfCeil, excludeDates = true, isDupe }) {
    const term = cand.replace(/^["'`]+|["'`]+$/g, '').trim();
    const c = canon(term) || term.toLowerCase();
    if (!term || term.length > 60) return { term, canon: c, reason: 'junk' };
    if (isDupe(term, c)) return { term, canon: c, reason: 'dupe' };
    if (exampleCanon.has(c)) return { term, canon: c, reason: 'echo' };     // pure prompt echo
    // A model rarely copies a few-shot cleanly: it mangles it ("Marrowford almshouse" ->
    // "marlowford almshouse") or lifts half of one, and either walks straight past the exact-phrase
    // test above. So reject on any WORD of an example — unless the entry's own text uses that word,
    // which makes it the entry's rather than the prompt's ("brass orrery" is a fine key for an entry
    // that has one). The invented sentinels never survive that hatch; real English words do.
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

/**
 * Whole-book TF-IDF keyword suggestion for one loaded lorebook. Ranks each entry's own terms by
 * (term frequency in the entry) x (inverse document frequency across the book): terms that recur
 * in this entry but are rare across the corpus float up as discriminators. Extracted from keywordSuggestReport
 * so the suggest popup and Lorebook Studio share one ranker. capsSeen/mixedSeen (acronym detection)
 * scope per call here — resetting per book, which is more correct than the old function-lifetime set
 * that leaked across a Back-to-a-different-book. Returns canon/dfSubstr/avoid/exampleCanon too, which
 * the ✨ local-model path and inline chip edits need.
 *
 * @param {object} data   loaded world-info object (from loadWorldInfo)
 * @param {object} opts    { dfCeil, maxN, excludeDates, excludeShort, onlyActive, cap, bgDocs }
 * @returns {{entries:object[], N:number, perEntry:object[], canon:Function, dfSubstr:Function, avoid:string[], exampleCanon:Set<string>, exampleWords:Set<string>}}
 */
/**
 * Corpus name evidence: how a body of text capitalises each word, and the name test built on it.
 *
 * ONE properness test for everything that asks whether a word is a name — the suggester's gates and any
 * harness arm measuring the same question call this rather than re-deriving it. `wordSeq(text)` observes
 * a text (and returns the suggester's token sequence); `isName(w)` reads the accumulated evidence: a
 * RATIO of mid-sentence capitals at >= 0.95, with acronyms exempt, "I" and its contractions excluded,
 * and a never-lowercase word absent from ZIPF_EN accepted on that weaker evidence.
 */
export function nameEvidence() {
    const fold = w => { w = w.replace(/^['’-]+|['’-]+$/g, ''); return /['’]s$/i.test(w) ? w.slice(0, -2) : w; };
    // Acronym casing (see notes): a token seen only in ALL-CAPS (SDG) is an acronym, exempt from the
    // short-word cut and shown uppercase; one ever seen lowercase isn't. The counts below feed the
    // same trick for proper nouns (isName): capitals are only counted MID-sentence, since a
    // sentence-initial one proves nothing — "Nobody" would be a name in a small book. Proper nouns are
    // exempt from the suggester's English-frequency gate ("Jeffrey" is a common word by z but the right
    // key).
    const capsSeen = new Set(), mixedSeen = new Set(), lowerCount = new Map(), capMidCount = new Map();
    const isAcr = t => t.length <= 6 && capsSeen.has(t) && !mixedSeen.has(t);
    // Sentence enders surface as a one-char '.' sentinel: ngramsOf skips any gram holding a token
    // shorter than 2 chars, so no suggested phrase ever bridges a sentence ("…by comparison. Micah
    // frowned…" must not yield "comparison micah"). Newlines and semicolons count as boundaries too.
    // A possessive is the same kind of boundary on BOTH sides: fold strips its 's, so any phrase
    // through it reads ungrammatical and can't literally match the text ("steal Teddy's bronze
    // minotaur" must yield "teddy" + "bronze minotaur", never "steal teddy" — which sneaks past the
    // attestation check as a prefix of "steal teddy's"). Sentinels around the possessor let its
    // unigram survive while no gram may contain it.
    const wordSeq = text => {
        let atStart = true;   // sentence-initial for CAPITALISATION only; a possessive's sentinels don't reset it
        // The word alternative is STAR, not plus: single-letter words must tokenise or the
        // determiner "a" and pronoun "I" are invisible to the syntax tests below (fDet/bSubj) —
        // "Kyle exchanges a look" read as "kyle exchanges look" and the object-side verb test
        // never saw the determiner. Single-letter tokens are still gram-blocked by ngramsOf's
        // length filter, so they act as boundaries in phrases, never as members.
        // Openers (quotes, brackets, dashes, colons, markdown emphasis) reset atStart WITHOUT emitting
        // a sentinel: a capital after one is the start of something quoted or parenthetical, not
        // evidence of a name, but it is not a phrase boundary either. Roleplay prose is mostly
        // dialogue, so without this every «"What…"» and «"Because…"» counted as evidence that those
        // are proper nouns — which then admitted "Kyle what" / "Arthur because" at f=1 and exempted
        // them from the English gate, since a proper anchor zeroes the phrase's z.
        // ponytail: closing quotes reset it too ("Hi," Marjorie said), costing one observation;
        // properness is a ratio over many, so a real name is unharmed by losing a few.
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
    // ONE properness test, used by every gate that exempts names, and a RATIO rather than "never
    // seen lowercase". That boolean was brittle in exactly one direction: "Marches" is overwhelmingly
    // capitalised, and a couple of lowercase "he marches" were enough to strip its name status.
    // Measured, the classes separate cleanly, with "lord" the nearest miss, correctly below the
    // bar (S3). Sentence-initial capitals are not counted at all: they are punctuation, not spelling.
    // ponytail: 0.95 sits in a wide empty gap; retune only if a real name lands under it.
    const NAME_CAP_RATIO = 0.95;
    const isName = w => {
        if (isAcr(w)) return true;
        // English capitalises exactly one word for grammar rather than properness, and it is the
        // one word the ratio below cannot survive: "I" is never written lowercase, so "I've" scores
        // a perfect 1.0 properness, counts as maximally rare, and rode every gate into a book's
        // suggestions. Contractions of it are the whole exception — "it's" and "hasn't" appear
        // lowercase constantly and are scored on their real frequency.
        if (w === 'i' || /^i['’]/.test(w)) return false;
        const up = capMidCount.get(w) ?? 0, lo = lowerCount.get(w) ?? 0;
        if (up > 0 && up / (up + lo) >= NAME_CAP_RATIO) return true;
        // Weaker evidence for a narrow case: a word NEVER written lowercase, that English has no
        // word for, is a name even without a mid-sentence capital to prove it. Bullet-led entries
        // ("- Tenzing arrives at camp") put a name at the start of every line, and "Tenzing" is
        // seven letters ending in -ing, so the gerund rule ate it outright. Requiring absence from
        // the frequency table is what keeps ordinary sentence-openers ("Nothing", "Rain") out:
        // they are common words, and they appear lowercase elsewhere anyway.
        return lo === 0 && (capsSeen.has(w) || mixedSeen.has(w)) && !ZIPF_EN.has(tblKey(w));
    };
    return { fold, wordSeq, isName, isAcr };
}

export function buildKeySuggest(data, opts) {
    const { dfCeil, maxN, excludeDates, excludeShort, onlyActive, cap, bgDocs = [] } = opts;
    const STOP = FUNCTION_WORDS;
    const { fold, wordSeq, isName, isAcr } = nameEvidence();
    const canon = k => (String(k).match(/[\p{L}][\p{L}'’-]+/gu) ?? []).map(w => fold(w).toLowerCase()).join(' ');

    const entries = Object.values(data.entries).filter(e => !(onlyActive && e.disable));
    const N = entries.length;

    // Corpus pre-pass (once): word sequences + derived function words + distributional head-POS.
    const seqs = entries.map(e => wordSeq(e.content));
    const uDF = new Map(), uCF = new Map();
    for (const s of seqs) { for (const t of new Set(s)) uDF.set(t, (uDF.get(t) ?? 0) + 1); for (const t of s) uCF.set(t, (uCF.get(t) ?? 0) + 1); }
    // A name is never a function word, however ubiquitous. The distributional test looks for
    // domain stopwords — common across entries, rarely repeated within one — and a place name that
    // half the book mentions has exactly that shape: "marches" was being blocked from every n-gram,
    // so "Governor of the Verenthian Marches" could not form at all, and "aldric" escaped the same
    // fate only by a hair (S3).
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
        // forward counts: what follows each token (for the object-side verb test below)
        fAll.set(p, (fAll.get(p) ?? 0) + 1);
        if (DET.has(t)) fDet.set(p, (fDet.get(p) ?? 0) + 1);
    }
    const isVerbHead = t => { const tot = bAll.get(t) ?? 0; return tot >= 5 && (bSubj.get(t) ?? 0) / tot > 0.4 && (bDet.get(t) ?? 0) / tot < 0.1; };
    // Verb/adverb tests, three sources, proper nouns and acronyms outranking all of them:
    //  - SUBTLEX dominant-POS: the head takes the >=85% set ("frowned"/"accepts"/"unfolds" at
    //    ~1.0, killing "Jeffrey accepts"-class fragments; noun-ambiguous "hunt"/"mark"/"drew"
    //    fall under the bar). EVERY word takes the >=95% pure-verb set — a pure verb leading or
    //    inside a phrase marks a clause fragment ("watched jeffrey", "jeffrey watched teddy") —
    //    strict enough to spare participle-adjectives leading real noun phrases ("fallen angel",
    //    fallen at .89). Applies to unigrams (the head is the word itself), closing the rare-verb
    //    leak ("reeked") the frequency table can't see.
    //  - Adverb morphology: an out-of-table word in -ily/-ingly/-edly is an adverb SUBTLEX never
    //    saw ("sulkily", "self-deprecatingly", "comfortingly"), bad as head or alone. Suffixes
    //    chosen for precision: plain -ly would kill -ly ADJECTIVES ("gravelly command" leads
    //    with one, and "gravelly" alone is a plausible key); family/lily are in-table, Emily is
    //    proper.
    //  - The book's own syntax: a word consistently FOLLOWED by a determiner takes objects, i.e.
    //    is a transitive verb in this corpus ("exchanges a look" — SUBTLEX tags "exchanges" Noun
    //    1.00, dialogue never verbs it, so only local evidence can). Object-side mirror of
    //    isVerbHead, precise enough to act from 2 observations where subject-side needs 5.
    const inSetOrStem = (set, w) => set.has(tblKey(w)) || stems(w).some(s => set.has(tblKey(s)));
    const notName = w => !isName(w);
    const posBad = (set, w) => inSetOrStem(set, w) && notName(w);
    const advLy = h => h.length >= 6 && /(?:ily|ingly|edly)$/.test(h) && !ZIPF_EN.has(tblKey(h)) && notName(h);
    const takesObj = t => { const tot = fAll.get(t) ?? 0; return tot >= 2 && (fDet.get(t) ?? 0) / tot > 0.5 && notName(t); };
    //  - Shape, for contractions, because nothing else can see them. SUBTLEX gives no dominant PoS
    //    for a single one ("hasn't", "isn't", "don't", "can't", "won't", "didn't", "wasn't" all miss
    //    POS_VA), and the corpus-side test is actively misled: "hasn't" scored 0.50 on the subject
    //    side in one book — correctly a verb — and was then vetoed by three relative-clause "that"s
    //    counting as determiners, which is how "Boulder hasn't" became a candidate. A clitic is a
    //    closed set and needs no evidence. Never key material in ANY position, so it joins the
    //    interior test too: a contraction anywhere means the gram is a clause, not a name.
    const CLITIC = /(?:n['’]t|['’](?:ve|ll|re|d|m|s))$/;
    const headBad = term => {
        const h = term.slice(term.lastIndexOf(' ') + 1);
        if (satEntity(h) || isVerbHead(h) || posBad(POS_VA, h) || takesObj(h) || advLy(h) || CLITIC.test(h)) return true;
        return term.includes(' ') && term.split(' ').some(w => posBad(POS_VA_STRICT, w) || CLITIC.test(w));
    };
    // Name linkers, and the one rule for where they may sit. Both classes may sit INSIDE a gram —
    // without that, "Duke of Thornhaven" and "Dia de los Muertos" could never form, since a
    // function word disqualifies a gram outright. They differ at the EDGES, which is a fact about
    // naming conventions rather than a heuristic: a nobiliary or toponymic particle binds to what
    // follows it and the pair is a name in its own right ("de Morcaster", "de la Cruz", "ibn
    // Suleiman", "von Furstenheim", "La Marzocco", "Los Angeles"), so a particle may also LEAD.
    // English "of X" is a locative that cannot stand without its title — "of Edinburgh" is not a
    // name, "Duke of Edinburgh" is — so English linkers stay interior. Nothing may TRAIL either
    // way: "Marquis de" and "Art of" are windowing accidents in any language.
    //
    // Every other function word still breaks phrases everywhere. The flood of ordinary of-phrases
    // this admits ("glass of wine") is handled downstream: common-anchored phrases gate to zero.
    // Deliberately broader than the particles the books on disk actually use (S4), because a missing
    // particle fails SILENTLY — the name fragments into junk and the good key is never offered — so
    // the cheap side of the trade is coverage.
    const PARTICLES = new Set('de del da di du la las le les los el van von der den bin ibn al af av dos das'.split(' '));
    const ENG_LINKERS = new Set(['of', 'the']);
    // French/Italian elision writes the particle onto the name — "d'Orléans", "dell'Arte" — so the
    // tokeniser sees a single word and the particle rules above never get a look at it.
    //
    // Elision happens ONLY before a vowel, which is what separates it from a name that merely
    // contains an apostrophe: "d'Orléans", "d'Artagnan", "l'École" elide, while "D'Vorah" and
    // "K'tharr" cannot — a consonant follows, so no French or Italian particle produced them.
    // Mute h ("l'homme") is deliberately excluded: in a lorebook "D'Hara" is likelier than a
    // French noun, and treating it as a name only costs a redundant row.
    const ELIDED = /^(?:d|l|dell|dall|nell|sull|all|qu)['’]([aeiouyàáâäæèéêëìíîïòóôöœùúûü].*)$/i;
    const LINKERS = new Set([...PARTICLES, ...ENG_LINKERS]);
    const linkerPosOk = (t, j, n) => PARTICLES.has(t) ? j < n - 1 : (j > 0 && j < n - 1);
    const edgeIllegal = ws => [0, ws.length - 1].some(j => LINKERS.has(ws[j]) && !linkerPosOk(ws[j], j, ws.length));
    // maxN counts CONTENT words: linkers are grammar, not meaning, so they neither consume the
    // phrase budget nor earn the length bonus in the score. "Island of the Dome of the Slate" is
    // seven tokens of which three mean anything, and a budget spent on "of the of the" is how a
    // name like that ends up represented by a window across its middle.
    const contentLen = term => { let n = 0; for (const w of term.split(' ')) if (!LINKERS.has(w)) n++; return n; };
    // Accessor variety, recorded while the grams are enumerated: '' once two different tokens have
    // followed this gram. A gram left holding a single successor is a prefix of something longer,
    // not a unit — "order of the unconquered" is only ever followed by "sun". The '.' sentinel
    // counts as a successor, since a phrase that can end a sentence is complete.
    // Recorded on ONE pass (the df sweep below passes record=true) — the tf pass re-enumerates the
    // same grams, and double counting would make a single occurrence look like corroboration.
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

    // Substring doc-frequency — how ST's countKey sees a key by default, and what the pruner's
    // too-common check counts. Defined here so suggestForEntry can gate on it; reused by the ✨ path.
    //
    // dfCache is the table the automaton warm-up below fills, NOT a memo of this linear scan: every
    // call from suggestForEntry is a guaranteed hit, because the warm-up collects exactly the terms
    // that reach this gate. The scan-on-miss path survives for terms the warm-up never saw — the ✨
    // path hands classifyLlmCand this same function for model-proposed candidates, and answering 0 for
    // those would quietly switch off their too-common filter.
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

    // Display casing comes from the TEXT, not from per-word evidence: corpus-global properness
    // cased "Queen Winnifred" as "queen Winnifred" whenever "queen" also appeared lowercase
    // somewhere else in the book. Every surviving candidate is attested as a literal substring, so
    // its own surface span exists — take it verbatim (which also renders "McTavish", "HR" and
    // interior linkers right, for free).
    //
    // Take the form the text uses MOST, not the first one found. Machine-written entries open with
    // a shouted markdown header, so "# THE OFFERING-FISH" was beating the dozen lowercase
    // "offering-fish" in the prose below it purely by being first. Occurrences whose capital is
    // POSITIONAL don't get a vote — after a sentence end or a label colon the capital is
    // punctuation rather than spelling — unless they are all there is.
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
    // Most-used form wins; an exact tie goes to the quieter one, because a term that appears once
    // in a header and once in prose ("LIBERTINE ECONOMY" / "Libertine economy") is a term whose
    // header is shouting, not a term that is spelled in capitals.
    const pickForm = (voting, all) => [...(voting.size ? voting : all)]
        .sort((a, b) => (b[1] - a[1]) || (SHOUTED.test(a[0]) ? 1 : 0) - (SHOUTED.test(b[0]) ? 1 : 0))[0]?.[0] ?? null;
    // The book-wide tally is the union over every entry, so it does not depend on which entry asked
    // — worth caching, since an acronym is shouted by definition and would otherwise re-scan the
    // corpus once per entry that suggests it.
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
        // Widen when this entry has nothing, and when what it has is SHOUTED: a header is a single
        // occurrence, and the prose that spells the term normally is often in OTHER entries —
        // "elemental scales" runs 16 times lowercase across the book against one "# ELEMENTAL
        // SCALES" in the entry that produced the candidate.
        return ((s == null || SHOUTED.test(s)) ? wideForm(term) : s) ?? term;
    };

    // English-frequency gate (zipf-en.js): a word common in general English is a poor key even
    // when locally rare — inside a small book "tub" IS unique, and no corpus-internal statistic
    // (df over entries, the chat pool) can know it's mundane; only the language-wide frequency
    // can. Human-curated keys fall into three classes, and each has its own test: PROPER NOUNS
    // (Jeffrey, Rolex — often common words by z) are exempt via isName, scoring 0;
    // UNCOMMON UNIGRAMS (minotaur, orrery) are any word NOT in the table (its floor is z 3.0, so
    // membership itself is the unigram cut — measured, good unigrams overlap junk in Zipf, so no
    // finer unigram ramp is honest (S5)); CONCRETE PHRASES ride on their
    // rarest anchor word ("brass orrery" on "orrery"), gated on a looser ramp — full weight at
    // z<=2.5, dropped at z>=3.8 — because a phrase can't fire more often than its rarest word,
    // yet is worth more than that word alone (the length boost in the score).
    // ponytail: constants eyeballed off one book's junk band + the class examples; retune there.
    // Gerund budge: a lowercase non-proper -ing word is almost always a verb form ("solidifying",
    // rare by z yet a junk key), so it inherits a junk-band pseudo-z instead of its own. Legit
    // -ing keys are capitalised in prose ("the Reckoning") and exempted before this fires.
    // ponytail: suffix test, no stemming; rare lowercase -ing NOUNS ("bloodletting") are casualties.
    const isGer = w => w.length >= 6 && w.endsWith('ing');
    // Naive de-inflection for the table lookup: "unfolds"/"frowned" are out-of-table while their
    // stems are common — an inflection is as mundane as its stem, so an out-of-table word tries
    // the obvious strippings (-s/-es/-ied, -ing/-ed with e-restore and un-doubling) and inherits
    // the best stem hit. Only consulted on a table miss, so irregulars and real rare words
    // ("olusanmokun") are untouched; rare stems ("reeked" -> reek) still slip through.
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
    // Linkers are legal by POSITION (see linkerPosOk above ngramsOf), which is what lets the f=1
    // test admit "Dia de los Muertos" and "de la Cruz" whole instead of killing them and stranding
    // a capitalised anchor ("Muertos" alone).
    // A phrase rides its RAREST word, and a name counts as maximally rare — which is right for
    // "Kyle's Diner" and wrong for "Arthur because", where the name's 0 lets anything ride along.
    // So a phrase also has a ceiling: no word of it may be top-500 English ("because" 6.0, "what"
    // 7.0, "away" 5.9), because those pair with a name only in clause fragments. Names and linkers
    // are exempt — a linker IS a top-500 word, and killing them would take "Duke of Thornhaven" too.
    // ponytail: 5.5 clears the measured junk while sparing content words that key legitimately
    // ("coffee" 5.2 in "Trinity Coffee", "small" 5.1); retune if a real key lands the wrong side.
    const PHRASE_WORD_CEIL = 5.5;
    const engMultOf = term => {
        const words = term.split(' ');
        let minZ = Infinity;
        for (const w of words) {
            minZ = Math.min(minZ, zEff(w));
            if (words.length > 1 && !LINKERS.has(w) && !isName(w) && tblZ(w) >= PHRASE_WORD_CEIL) return 0;
        }
        return (words.length === 1 && minZ >= 3.0) ? 0 : Math.min(1, Math.max(0, (3.8 - minZ) / 1.3));
    };
    // TF is a repetition signal, and a summary-style entry mentions each entity exactly once — on
    // those, f>=2 rejects everything good ("Olusanmokun", "Mobius Industries") before any other
    // gate runs. It predates the English gate and was doing junk control the gate now does better,
    // so single-mention terms are admitted — under a STRICTER test than the f>=2 gate: with no
    // repetition to corroborate, every word must independently look name-like — capitalised
    // mid-sentence ("Corporation" in "Stearns Corporation", even if lowercase elsewhere), an
    // acronym, or absent from the English table. Min-anchor is not enough at f=1: it would let
    // any tail glue onto a rare anchor ("sarah olusanmokun arrived") and then subsume the clean
    // name, since at f=1 every adjacent pair co-occurs trivially.
    const TITLES = new Set('mr mrs ms mx dr st jr sr prof rev sgt capt lt col gen'.split(' '));
    const admit = (term, f) => {
        if (f >= 2) return true;
        const ws = term.split(' ');
        return ws.every((w, i) => (LINKERS.has(w) && linkerPosOk(w, i, ws.length)) || isName(w) || (tblZ(w) < 3.0 && !isGer(w)));
    };

    // Warm dfCache for every term that will reach the substring gate, in ONE pass per document.
    //
    // dfSubstr is the gate on every candidate, and answering it term-by-term means re-reading the whole
    // corpus per term — nearly the whole of this function's runtime on a large book (S10), and still
    // the bulk of it once memoized, because most terms are distinct. Aho-Corasick inverts the loop: build one automaton over
    // all candidates, then each document reports every term it contains in a single walk, so the cost is
    // (corpus + patterns) instead of (terms x corpus). Same numbers, just not recomputed per term.
    // Background pseudo-documents (the open chat's messages, injected by the caller so this stays
    // ST-free) pooled into the IDF denominator. On a small book nearly every candidate has df 1, the
    // IDF is flat, and the ranking degenerates to raw term frequency — which is how "tub, rut,
    // leaking" top a short entry. A few thousand chat messages restore resolution: a term common in
    // ordinary chat prose is demoted (it would over-fire as a trigger anyway), a term genuinely
    // unique to the entry keeps a large IDF. Empty bgDocs = the old book-only behaviour.
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

    // Cohesion: cover the gram with its LEADING and TRAILING bigram and ask whether those live
    // independently of it. For a trigram the two overlap on the middle word (ABC -> AB + BC), for a
    // tetragram they tile it exactly (ABCD -> AB + CD); either way each covers one occurrence of the
    // whole, so the ratio pins at 0.5 when the parts never appear apart and collapses toward 0 when
    // they do. Counted over the entries AND the chat, because a name's real independence shows up in
    // conversation, not in a 300-entry book. Splitting a trigram down the middle instead (A | BC)
    // measured far worse — a bare leading word is common on its own for reasons that say nothing
    // about the phrase, and the bands muddy where the bigram pair separates cleanly (S6).
    // ponytail: validated at n=3..4; a longer gram compares only its shoulders, which errs toward
    // keeping it. Revisit if maxN above 4 becomes a real setting rather than a knob.
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
        // Only parts that could THEMSELVES be offered count as alternatives. Measured, a real share
        // of the grams this rule dropped were being counted against an illegal part ("Bishop of",
        // "de Montclair" before particles were allowed to lead) and so vanished with nothing put in
        // their place (S6). A gram no legal part can replace is indivisible: keep it,
        // which is precisely the "Bishop of Queensgrace" / "Duke of Edinburgh" case.
        const parts = [w.slice(0, 2), w.slice(-2)].filter(p => !edgeIllegal(p)).map(p => docs(p.join(' ')));
        // Against the BEST alternative, doubled so the ceiling stays 0.5 however many parts qualify:
        // a part that never occurs without the whole counts once per occurrence of it.
        const best = Math.max(0, ...parts);
        cohCache.set(term, v = best ? Math.max(1, docs(term)) / (2 * best) : 1);
        return v;
    };
    // Per-entry TF-IDF: distinctive terms, ranked, subsumed, split into new vs already-keyed.
    //
    // Subsumption used to be "at equal frequency the longer gram wins", on the assumption that longer
    // is more specific. Specificity is worthless if the string never appears: measured against a
    // real chat, a half of an INCOHESIVE tetragram almost always out-fires the whole (rarely when
    // cohesive), so that rule was trading live keys for dead ones — "arthur baxter" discarded in
    // favour of the never-firing "Kyle FaceTimed Arthur Baxter" (S7). The longer gram now
    // has to earn the swap by being a unit; otherwise the contained gram wins and IT swallows the
    // long one, so the pair still collapses to a single row.
    // ponytail: measured on n>=3 only, so bigram-over-unigram subsumption keeps the old rule —
    // "Arthur Baxter" beating bare "Arthur" is a call this ratio was never tested on.
    const SUBSUME_COHESION = 0.4;
    const subsume = list => list.filter(r => !list.some(o => {
        if (o === r || o.f !== r.f) return false;
        const [lng, srt] = o.n > r.n ? [o, r] : [r, o];
        if (lng.n === srt.n || !` ${lng.term} `.includes(` ${srt.term} `)) return false;
        if (lng.n < 3 || cohesion(lng.term) >= SUBSUME_COHESION) {
            // A LEADING particle carries almost no meaning, and as a substring key the bare form
            // matches every occurrence of the particle form anyway — "Sacres" catches "de Sacres"
            // and "Marguerite de Sacres" alike. So the particle form gives way to the bare one,
            // but ONLY when what remains is a single distinctive word. "de la Cruz" -> "Cruz" is a
            // bad trade and the frequency table says why: cruz 3.5, santos 3.6, pen 4.4, angeles
            // 4.5 are all common enough to be listed, while sacres, furstenberg, morcaster, vallon
            // and gogh are absent from it entirely. Strip a particle off a name, not off a word.
            const lw = lng.term.split(' ');
            let k = 0; while (k < lw.length && PARTICLES.has(lw[k])) k++;
            if (k > 0 && lw.length - k === 1 && srt.term === lw[k] && !ZIPF_EN.has(tblKey(lw[k]))) return r === lng;
            // Otherwise a unit swallows contained PHRASES, but never a bare word: that word is a
            // different instrument rather than a worse version of the same one — broader, and often
            // the form the chat actually reaches for. Measured, "Ashworth" far out-fires "Evelyn
            // Ashworth" and "Raleigh" out-fires "Raleigh atrium", and a meaningful share of swallowed
            // unigrams sat in that band (S7). Both are offered; the choice is the user's.
            if (srt.n === 1) return false;
            return r === srt;
        }
        // Otherwise the long form is an assembly — but only the SHOULDER it decomposes into may
        // take its place. Cohesion judged "chairman of the grain commission" against "grain
        // commission"; the row that displaced it was bare "chairman", which merely happened to
        // share its frequency, and the entry was left with a title reduced to a job word. Anything
        // else contained in it keeps its own row and the pair is offered together, which is what
        // you want from "Governor of the Verenthian Marches" and "Verenthian Marches".
        const w = lng.term.split(' ');
        const isShoulder = srt.term === w.slice(0, 2).join(' ') || srt.term === w.slice(-2).join(' ');
        return isShoulder && r === lng;
    }));
    const suggestForEntry = (entry, tf, idx) => {
        const existing = new Set((entry.key ?? []).map(canon));
        const rows = [];
        for (const [term, f] of tf) {
            if (!admit(term, f)) continue;
            // Edge legality (see PARTICLES/ENG_LINKERS): "marquis de" is a windowing accident either
            // way, "of Edengard" needs its title back, but "de Vallon" is how you actually refer to
            // the man. Whether the full form or the particle form is the better key is then left to
            // the cohesion tiebreak below, on evidence, instead of to a blanket ban.
            const ws = term.split(' ');
            if (edgeIllegal(ws)) continue;
            const df = DF.get(term) ?? 1;
            if (df / N > dfCeil) continue;
            // Pruner cross-checks on the substring df (the metric countKey uses): never suggest a
            // term the pruner would then flag. ZERO hits means the joined gram never occurs
            // literally — token folding bridged punctuation the matcher can't ("Teddy's bronze
            // minotaur" is not the substring "teddy bronze minotaur"), so the key could never fire
            // even on its own source text and would be flagged unattested. Dropping it here also
            // unfolds the recommendation: with the fold-broken long gram gone before subsumption,
            // its legitimate parts ("bronze minotaur", "teddy") surface instead of being swallowed.
            // The high side is the pruner's too-common danger threshold, as before.
            const ds = dfSubstr(term);
            if (!ds || ds / N > KEY_BOOK_COMMON * 0.75) continue;
            const n = term.split(' ').length;
            if (excludeShort && n === 1 && term.length <= 3 && !isAcr(term)) continue;
            if (!isAcr(term) && headBad(term)) continue;
            // Bare adjectives: attributive words over-fire detached from their noun — "voracious"
            // is a poor key while "voracious reader" is fine, so the adjective test applies to
            // unigrams only. Same dominance bar and properness override as the verb sets.
            if (n === 1 && posBad(POS_ADJ, term)) continue;
            // An elided particle gets the same trade as a written one, on the same terms: the bare
            // name matches every elided occurrence as a substring, so prefer it — but only when it
            // is distinctive AND stands on its own IN THIS ENTRY. "d'Orléans" yields to "Orléans"
            // where the entry writes both; "d'Art" keeps its particle because "art" is a common
            // word; "d'Artagnan" keeps it wherever the entry never writes the bare name, since the
            // elided form is a different token and no replacement would appear in its place.
            const el = n === 1 ? term.match(ELIDED) : null;
            if (el && !ZIPF_EN.has(tblKey(el[1])) && tf.has(el[1])) continue;
            // A bare roman numeral is a number, not a name — it reaches here only because an
            // all-caps token looks like an acronym. "Louis XIII" keeps it; "XIII" alone is noise.
            if (n === 1 && /^[ivxlcdm]{2,}$/.test(term)) continue;
            // Bare honorifics: "Mr" passes every capitalisation test (always capitalised, never
            // lowercase — a perfect fake proper noun) yet is junk alone; fine inside "Mr Lansing".
            if (n === 1 && TITLES.has(term)) continue;
            if (excludeDates && isDateLike(term)) continue;
            const engMult = engMultOf(term);   // the three-class English gate — see engMultOf
            if (!engMult) continue;
            // Truncations: a gram with exactly one possible next word is the front of a longer
            // name. Without this the window across a title's middle beats the title — and beats it
            // twice over, because a truncation's shoulders are linker-edged, so cohesion reads it
            // as indivisible while the complete name looks decomposable. Needs two occurrences to
            // say anything: a phrase seen once trivially has one successor, which is how a
            // single-mention name ("Sarah Olusanmokun from Stearns") reads as a truncation.
            const rec = SUCC.get(term);
            if (n > 1 && rec && rec.n >= 2 && rec.s && rec.s !== '.') continue;
            // Un-fold the display (and thus the committed key) from the term's own surface span in
            // the text — see displayOf. Cosmetic under ST's default case-insensitive matching, and
            // matches how humans write keys.
            rows.push({ term, display: displayOf(term, idx), present: existing.has(term), df, f, n,
                score: f * engMult * Math.log((N + M + 1) / (df + (bgDF.get(term) ?? 0) + 0.5)) * (1 + 0.5 * (contentLen(term) - 1)) });
        }
        rows.sort((a, b) => b.score - a.score);
        // A plural adds nothing a substring key can use — "stone-singer" already matches every
        // "stone-singers" — so when both are candidates the singular stands alone. Same shape of
        // argument as the particle rule: prefer the form that matches a superset of the text.
        const have = new Set(rows.map(r => r.term));
        const plural = t => /(?:ies|es|s)$/.test(t) &&
            [t.replace(/ies$/, 'y'), t.replace(/es$/, ''), t.replace(/s$/, '')].find(x => x !== t && have.has(x));
        const kept = subsume(rows.filter(r => !plural(r.term)));
        // Batch triage: cap the per-entry paragraph to the strongest few so it stays scannable
        // (a focused entry can pull more via ✨). Score-sorted, so the cut only sheds the weak tail.
        // Gated-out entries return nothing on purpose. A demoted-rejects fallback used to run here,
        // on the theory that an empty paragraph helps nobody; measured, it almost never fired and
        // offered junk when it did — the gate was right, and the real emptiness cure was admitting
        // f=1 names, which covers nearly every entry (S9).
        return { existing, newRows: kept.filter(r => !r.present).slice(0, cap), keyedRows: kept.filter(r => r.present) };
    };

    const perEntry = entries.map((entry, i) => ({ entry, ...suggestForEntry(entry, tfs[i], i) })).filter(pe => pe.newRows.length);

    // For the ✨ per-entry local-model path (lazy: only fires on click).
    const avoid = [...uDF].filter(([t, c]) => t.length > 2 && !STOP.has(t) && c / N > 0.5).sort((a, b) => b[1] - a[1]).slice(0, 20).map(x => x[0]);
    const exampleCanon = new Set([...KEY_GOOD_EXAMPLES, ...KEY_BAD_EXAMPLES].map(canon));   // drop few-shot echoes
    const exampleWords = new Set([...exampleCanon].flatMap(x => x.split(' ')));   // ...and mangled/partial ones

    return { entries, N, perEntry, canon, dfSubstr, avoid, exampleCanon, exampleWords };
}

// dfCeil sits just under the pruner's too-common danger line (KEY_BOOK_COMMON * 0.75 = 0.375): the
// suggester must not pre-reject a term the pruner itself considers fine. It was 0.15 when
// cross-entry df was the only junk signal; the Zipf gate now owns English junk, and 0.15 was
// silently cutting a book's recurring cast and setting names ("Stearns") (S8).
// cap is a display budget, not a quality line. Measured uncapped, per-entry yield is near-linear in
// content length rather than tailing off, and what the old cap of 8 discarded was not junk (S9).
// 30 sits just above the per-entry p75, so most entries return everything they have and only the
// largest are trimmed.
export const STUDIO_SUGGEST_OPTS = { dfCeil: 0.35, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: false, cap: 30, llmChunk: 5000 };

