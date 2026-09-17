# Keyword suggestion and audit — reference

Two modules. `keyword-suggest.mjs` proposes keys for an entry from its own text and from a model;
`keyword-audit.mjs` judges the keys an entry has. Both are ST-free; `keyword-tools.mjs` and `studio.mjs`
drive them. Matching itself is `matching-architecture.md`; vocabulary is `CLAUDE.md`. A measured claim cites its register
entry by ID and anything else is an assertion. `measured-claims.md` holds the claims reproducible
without the author's lorebooks; the rest share its ID space but stay private.

## What a key is for

A key is selective enough not to over-match and flood the injection context, and common enough to match
when characters refer to the entry's material. Three properties: **denotation** (it names the entry's
material), **exclusivity** (and little else — material outside the entry's subject, not sibling entries
on the same subject), **realizability** (it is likely to be typed). Keys optimise precision and the ranker
recall; a key denoting many sibling entries is outranked, not disqualified.

- **Ubiquity is not vagueness.** A proper noun is a good key when it names a specific entity and a bad
  one when it names an ever-present principal.
- **Only discourse recurrence gates.** An entry's descriptive material is not key material even when its
  subject is: the seed is the container people refer to, not the detail it owns.
- **Verbs are out.** They make poor keys, so tense is never expanded and inflection homographs never
  arise.
- **Realizability is prospective.** Absence from the chat does not disqualify: a location the story has
  not reached reads as zero occurrences and is a fine key. The suggester reads the entry's text; the
  chat enters only as background documents for the idf denominator.
- **Precision splits in two.** Semantic (the term denotes more than the entry) needs judgment;
  orthographic (the term is a substring of unrelated words) is mechanical, and is the audit's.

## The lexical arm — `buildKeySuggest`

One ranker for the suggest popup and the Studio: each entry's own terms, scored by tf x idf over the book
plus `bgDocs`, the open chat's messages pooled into the idf denominator — one
Aho-Corasick pass, 254ms for 497 keys over 5473 messages, and independent of the key count (P2). The language table is read
once per build.

**Tokens** (`nameEvidence().wordSeq`): letter runs with internal apostrophes and hyphens; a sentence
ender emits a `.` sentinel that no gram bridges, and a possessive gets one on both sides. The same pass
gathers name evidence, and `isName` is the one properness test: a word capitalised mid-sentence at
>= 0.95 of its occurrences (S3), an acronym (<= 6 letters, only ever seen in caps), or a never-lowercase
word absent from the table; `I` is excluded.

**Candidates** are grams of one to `maxN` content words. A function word blocks a gram: the fixed list,
or a token in more than 30% of entries at fewer than six occurrences per entry that is not a name. A
linker may sit inside a gram; a name particle (`de`, `van`, `al` …) may also lead, an English linker
(`of`, `the`) may not, and nothing trails. Ten particles occur across 38 books: `de la los el van
del du da der le` (S4). Linkers neither spend `maxN` nor earn the length bonus.

**Gates**, in the order tested; a candidate must clear all of them:

- Admission: frequency >= 2 in the entry, or every word independently name-like (a name, a linker in a
  legal position, or rare and not a lowercase `-ing` form).
- Book share: document frequency over the book at most `dfCeil`, which sits above the share a
  recurring cast occupies — a book about a story names its people in most of its entries, and those
  are keys worth having.
- Literal occurrence: the joined gram occurs as a substring somewhere, since folding bridges punctuation.
- Short: a unigram of three characters or fewer is cut unless it is an acronym (`excludeShort`).
- Head: the last word is not a saturated entity (in > 85% of entries), a verb head by the book's own
  syntax (follows a pronoun or saturated entity in > 40% of its uses and a determiner in < 10%), in the
  table's verb-or-adverb set, a word that takes a determiner after it, a `-ily`/`-ingly`/`-edly` adverb
  off the table, or a clitic; and no word of a phrase is in the strict verb set. Names outrank all of
  these.
- Adjectives: a unigram in the table's adjective set is cut; inside a phrase an adjective stays.
- Shape: an elided form (`d'Orléans`) whose head the entry also uses bare, a roman numeral, a title
  (`mr`, `dr` …), and — with `excludeDates` — a year, a numeric date or a month with a digit.
- Frequency: names read as z 0; a unigram in the table (z >= 3.0) is cut; a phrase rides its rarest
  word on a ramp, full weight at z <= 2.5 and gone at z >= 3.8, and is cut outright if any non-linker,
  non-name word sits above z 5.5; a lowercase `-ing` word reads as 3.8. The ramp is coarse because
frequency does not encode key quality, so no finer cut separates a good unigram from a junk one. The ceiling is exclusive on
  the table's 0.1 grid.
- Successor: a phrase seen twice or more with exactly one possible next token is the front of a longer
  name and is dropped.

**Score** is `f x engMult x log((N + M + 1) / (df + bgDF + 0.5)) x (1 + 0.5 x (contentLen - 1))`, `N`
entries and `M` background documents.

**After scoring:** a plural is dropped when its singular is present, since a substring key already
reaches it; at equal frequency a cohesive longer gram swallows the phrases it contains but never a
bare word, a particle form gives way to a distinctive bare name, and an incohesive gram gives way only
to its shoulder bigram (S7). Cohesion is the gram's document count against its leading and trailing
bigrams' best, 0.5 when the parts never appear apart (S6); the threshold is 0.4. Then `cap` rows, a
display budget (S9).

**Display form** is the casing the entry uses most, voting only where the capital is not
sentence-initial; a tie goes to the quieter form, a shouted form defers to the book-wide vote.

**Options** (`STUDIO_SUGGEST_OPTS`): `dfCeil` 0.35, `maxN` 4, `cap` 30, `excludeDates`, `excludeShort`,
`onlyActive` (skip disabled entries), `llmChunk` 5000 characters. `englishGate: false` is the
diagnostic's switch: every term passes the frequency gate at full weight.

Warm-up: every admitted term's substring df over the book and the background documents is counted in
one automaton pass per document, not one scan per term: term-by-term df was 97% of build runtime on
a 327-entry book (S10).

## The LLM arm

`buildKeyPrompt(entryText, avoid)` asks for referential noun phrases of one to four words, as many as the
model is confident of (S2), never a sentence, clause, verb phrase, filler or bare ubiquitous name.
`avoid` is the book's twenty most ubiquitous terms, those in more than half its entries. The few-shot
examples are invented and absent from every lorebook, so an echo can be dropped unconditionally.
`keyword-tools.mjs` splits an entry at `llmChunk` characters and sends each chunk as its own call;
`parseKeyList` reads the reply tolerantly, one term per line or comma, at most six words each.

`classifyLlmCand` is the one post-filter, shared by the single reroll and the Studio's bulk merge.
`reason` is `dupe` (the caller's test), `echo` (a few-shot example, or a word of one the entry's own
text does not use), `junk` (over 60 characters; a single word on the pack's common list; a date, with
`excludeDates`; or a book share over `dfCeil`), or null to keep.

## The language table

Every language is one pack shape, and `lang.mjs` holds whichever is current: `zipf` (word -> Zipf
frequency, stored to 0.1 and packed by decile), `posVAStrict` and `posVA` (verb-or-adverb sets at 95%
and 85% dominant tag), `posAdj` (adjectives at 85%), `common` (the audit's common-word list) and a
`hash`. English is bundled (`wa-pack-en.js`); any other language is fetched once from the data index
and kept in the user's files, refetched when the index's hash moves, and a failed fetch stands down to a
table where every word reads rare and every filter is a no-op. The suggester and the audit read the table
at the top of each build, so a switch takes effect on the next.

`build-zipf.py` writes the packs. English comes from Google Books eng-fiction 1-grams, 1980 on, with
wordfreq gating the vocabulary and supplying the POS sets from the dominant tag at 1,000 or more tagged
occurrences; any other language is wordfreq alone, with no POS sets, so the verb and adjective filters
do nothing there. The corpus is fiction prose because the prior's job is to say what is ordinary in the
register the chat is written in; genre-common words are ordinary by design: against wordfreq, genre and
narrative vocabulary rises 0.3–0.7 in Zipf (sword 4.4 → 4.8) (S24). The table begins at
z 3.0, so absence from it is the rare line, and the phrase ceiling is exclusive at 5.5.

## The audit — `buildKeyPruneScan`

One pass over the book: each entry's content is segmented as the match window segments it, every
segment goes through the automaton once, literal keys are counted only in the segments a variant of
them was found in, and `?` and regex keys in every segment. Each key is counted under its entries' own
flag combinations, and a whole-word entry's key under the substring combination too. df counts entries,
not segments — literal keys are slice-invariant, and eight segments against one join measured 1.01× (K5). A key edited since the pass is judged on demand through a private scope.

A chat scan, when one was run, supplies per key the share of units holding it (message, paragraph or
scan window, as the match window defines the unit), the share holding it as typed, and two kinds of
probe: for a literal key over the chat-common gate, the key whole-word and — where it has a capital —
case-sensitive; for a SmartKey, each path through its AST.

**Scope.** Disabled entries with `includeInactive`; `constant`, `vectorized` and keyword entries by their
own switches. df is over the whole book regardless.

**Flags**, tested in `FLAG_PRIORITY` order, the first hit winning. Every remedy is said on the
Explorer's key chips, where curation happens; only one flag means "delete this key".

| flag | condition | severity | says |
|---|---|---|---|
| `unusable` | the validator refuses the key | severe | the validator's code; a correction, not a deletion |
| `substring` | a literal key over the chat-common share whose whole-word probe share is <= 1/3, or whose case-sensitive probe share is <= 1/3 where the key has a capital; only a flag the entry lacks is suggested | moderate | `consider ? =k` / `? ^k` |
| `chat common` | in >= `KEY_CHAT_COMMON` (20%) of units; not on a `constant` or sticky entry, the author having declared it ubiquitous | severe at >= `KEY_CHAT_SEVERE` (50%, an assertion), else moderate | the rate, and for a SmartKey the path that matches most; remedies are `constant` or a narrower key |
| `book common` | no chat scanned; content df >= `KEY_BOOK_COMMON` (45%, an assertion) of a book of at least `KEY_MIN_SHARED_ENTRIES` (10) | moderate | the share |
| `book shared` | listed as a key by more than 3/4 of `bookShared` (0.75) of the entries | severe at >= `bookShared`, else moderate | the share |
| `regex orthography` | a pattern that cannot reach a quote or dash form the chat, or failing that the book, uses more than the form it matches | minor | the form, and the class to write |
| `common word` | no chat scanned; a single literal word on the pack's common list, or a SmartKey with a path made entirely of them | moderate | the word or path |
| `fragment` | a multi-word literal holding a function word, unless it is a capitalised frame with a name-particle interior, or the book holds its title-cased form case-sensitively | severe | `phrase fragment` |
| `short` | a literal under `KEY_MIN_LENGTH` (4) on a non-whole-word entry, with hits | minor at every hit clean, severe at <= 1/3, else moderate | `clean/total exact`, and `consider ? =k` at <= 1/3 |
| `unattested` | df 0 and no chat rate; a proper-looking literal is exempt under `ignoreProper` | none | `unattested` for a literal, `never matches` for a `?` or regex key, naming what was checked |
| `variant only` | a hyphenated literal the chat, or failing that the book, holds only un-hyphenated | minor | which |
| `regex orthography` | a pattern holding one side of a quote family with no evidence either way | minor | `will not match` the other form |

A `short` key's clean count rejects a boundary hit whose surrounding run of digits and currency marks
holds a digit, so `007` is clean in "Agent 007." and not in "$10,007.08".

**The substring and short suggestions are advisory.** A short form nested inside its own long form (`Kim`
beside `Kimberly`) is sometimes deliberate weighting, so the chip suggests `? =k` and nothing applies it.

**With a chat scanned, the chat has answered.** `book common` and `common word` stand in only for a key
no chat was scanned for; over the gate the chat reads `chat common`, under it the list is contradicted
and says nothing. The chat-common flag exempts `constant` and sticky entries and not vectorized ones.

**Near-duplicates** are entries over 200 characters whose rare vocabulary (z < 3.0) has Jaccard
>= `KEY_DUPE_MIN` (0.35); an arc and a scene are not compared. Advisory: it colours (K14).

**Secondary keys** the matcher will not act on are listed separately with the validator's message
(`unusableKeysOf`), by set difference against `secondaryKeys`, so which codes are fatal stays a
`matcher.mjs` rule. A `selective: false` entry lists none.

**The Explorer and Cleanup read one classifier** over the whole book and differ only in presentation and
checkbox state. Anything the audit learns reaches `classifyEntry`, `reasonOf` or `severityOf`, or it is
invisible where the work happens. Severity is a name, never a colour.
