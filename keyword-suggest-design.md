# Keyword suggestion — what is being built and how it will be judged

Status: **live, unsettled.** Started 2026-08-01. The definition work for a rebuilt keyword suggester,
written before any measurement, because every previous attempt to tune `buildKeySuggest` was scored
against something that did not bear the weight. Nothing here is implemented; *Open* is the state of
play. Vocabulary and claim discipline: `CLAUDE.md`. The matcher's half: `matcher-design.md`. Claim
IDs: `eval/eval-data/measured-claims.md`.

## The goal

Keys selective enough not to over-trigger and flood the injection context, and common enough to fire
when characters refer to the entry's material.

## Scope: two systems, one boundary

- **Keys that reliably represent their entry material** — this system.
- **Relevant entries being associated with the generation** — the ranker.

The per-window relevance predicate `J(entry, window)` and everything built on it belong to the
ranker's evaluation; if it reappears in a discussion of keys, the boundary has been crossed.

## The primitive

    R(key k, entry E, chat C) — does k reliably represent E's material AND LITTLE ELSE,
                               and is it likely to be present in C?

Three components: **denotation**, **exclusivity**, **realizability**. Keys optimize precision; the
ranker optimizes recall — a priority, not an exclusivity. A key denoting many sibling entries ("rut"
across forty memory entries) is outranked, not disqualified; "little else" means material outside the
entry's subject, not sibling entries on the same subject.

### Precision splits in two

- **Semantic** — the term denotes material broader than the entry. Needs judgment.
- **Orthographic** — the term is a substring of unrelated words ("rut" inside "truth"). Mechanical.

### Ubiquity is not vagueness

"Kyle" is a bad key because the protagonist is on stage in nearly every window, not because the name
is imprecise: a proper noun is a good key when it names a specific entity and a bad one when it names
an ever-present principal.

### Realizability is prospective

"Likely to appear in C" is not "appeared in C": a location the story has not reached and an alias
people will use later both read as zero occurrences and are realizable, so any metric built on
observed firing counts is biased against them, including the dead band in `eval/suggest-firing.mjs`.
It is measurable through anchors: variants and synonyms of a known-good seed **inherit its
realizability**, so anchors need only be *some* defensible keys per entry, never complete sets.

## Three stages

1. **Seeder** — things → seeds. Denotation and realizability. Indifferent to form.
2. **Expander** — seed → family. Morphological forms plus synonyms in the entry's sense.
3. **Renderer** — family + collision statistics + portability policy → keys.

Realizability is inherited across morphology and **not** across synonymy: a synonym is a different
word with its own frequency. Synonymy in the entry's sense needs world knowledge, so it is the one
piece with no local fallback and where an LLM is load-bearing rather than merely better.

The two arms are **independent tracks**, not stages of one pipeline: "Suggest terms" (lexical, local)
and "Suggest terms LLM" (a local small model or a paid API), neither assuming the other has run. The
expander runs over whichever produced the seeds, and the renderer over the expander's output.

The renderer runs the backoff: the longest collision-free common substring of the family as one
literal where one exists (`thaumaturg` covers thaumaturgy, thaumaturge, thaumaturges);
exact-plus-enumeration or a SmartKey mix where that substring collides (`rut`); separate keys where
the family shares nothing usable (scry, scried). So the expander's output is not the keyset. Where a
word-form and a stem are equally good, the renderer prefers the word-form: a stem is not a word, and a
reviewer may not recognise it as a good key.

### Allowing patterns changes the metric

A stem string-matches none of the curated keys it covers, so the superset standard is **behavioural**:
for each curated key, does the produced keyset fire where that key fires — `countKey` against the same
text. A broad key cannot game it, because coverage is only the recall half.

## What makes a seed

A seed is a term that:

1. **The entry carries information about, rather than merely naming.** Topicality is the wrong test:
   it excludes the Porsche bought during a scene about something else, though that entry is where the
   Porsche comes from, and admits a discipline an entry only lists among a dozen others.
2. **Is not defeated by orthographic collision.** Mechanical, and regime-dependent.
3. **Has affirmative reason to be typed.** Presence in the chat confirms; absence does not disqualify.

**Seed count is unbounded** — whatever passes the gates. It is not the number of candidates offered,
which `cap` governs as a display budget.

### Two axes, and only one of them gates

- **Referent persistence** — does the thing keep mattering.
- **Discourse recurrence** — do people type the words.

Both are continua. **Only discourse recurrence gates seeds**, on whether the thing has a form people
use to refer to it — so an entry's descriptive material is not key material even when its subject is.
Referent persistence says *where* the seed is: a cluster of persistent-but-undiscussed detail is the
signature of a continuity entry, whose seed is the container that owns the detail — the Grove, not its
tile. Foxbridge's "witch levels" has that shape and all of its human keys are container terms (S17).
An entry low on both — scene-bounded detail — yields few or no seeds. **Entry content and key material
are different questions**: the tile belongs in the entry, because it stops the floor changing every
generation, and it is not a key.

### Realizability evidence: retrospective and frontier

Most entries are not at the frontier: whether an early entry's term recurred is a lookup. The
first-mention problem bites only at the newest entries and on a new book.

**Retrospective** — occurrence in chat after the entry's own scene. Not a proxy for recurrence; it is
recurrence. A memory entry's own source span must not supply its own evidence, or every piece of
scene furniture passes — and **masking the span is not how that is handled, and nothing replaces it**:
under a count test a span of a few dozen messages against a chat of thousands changes no verdict. A
term whose occurrences all sit in one contiguous stretch has located its own source scene, which does
not distinguish scene furniture from a memorable one-off. If anything reads `STMB_start`/`STMB_end`:
they are per-chat indices, and **a range shared by dozens of entries is a sentinel, not data**.

**Frontier** — priors only, strongest first: proper-nounhood (names attach to things that persist);
rarity *combined with* entity-ness (rarity alone fails — "olfactory" is rare and is not a thing);
within-entry re-mention (weak, and mostly what TF already picks up). Measuring against the same chat
that informs the ranking is not circular; `eval/suggest-firing.mjs` takes that position deliberately.

**Consequence for the two arms.** The LLM's advantage is concentrated at the frontier and on new books;
on a mature book with a long chat the lexical arm has direct evidence of recurrence. Testable, and it
says where the paid arm earns its cost.

## Expansion correctness

Annotate all the forms denoting the seed's material. The **required forms** are the subset the matcher
will not reach from the seed on its own, derived rather than annotated: under substring matching, does
the seed occur in the variant; under whole-word, does it occur as a word. `wolf` does not occur in
`wolves`, so `wolves` is required; `rut` occurs in `ruts`, so `ruts` is not. Deriving is what lets the
gold survive a regime change or a SmartKeys decision. Core's boundary is `(?<!\w)…(?!\w)`
(`extension/matcher.mjs`), so hyphens do not block: `rut` reaches `pre-rut` under both regimes and
`ruts` only under substring. Suffixed forms are the regime-sensitive ones.

**Verbs are out of scope.** Verbs make poor keys, so tense is not expanded, and every inflection
homograph (rise→rose, find→found) is a verb form, so that problem goes with them.

### What each class is gated on

Each class is tested on exactly what it does not inherit.

| | denotation | exclusivity | orthographic collision | realizability |
|---|---|---|---|---|
| **seed** | gate | gate | gate | gate |
| **morphological variant** | inherited | gate | gate | inherited |
| **synonym** | gate | gate | gate | see below |

Morphology inherits meaning and re-earns the string; synonymy inherits reference and re-earns the
meaning. Neither inherits the string.

**Exclusivity fails as hypernymy** — the key names a superordinate of the entry's subject ("dog" on a
hellhound entry). The relation is entry-relative, so no property of the string implements it; the Zipf
gate is the proxy, because a hypernym is usually the commoner word, and it breaks where the entry's
subject *is* the superordinate. **Propriolization** is the other way a string carries meaning outside
the entry: a common noun's plural or possessive coinciding with a proper name (`chili` → `Chili's`).
No signal but capitalisation, and `stems()` does not strip `'s`. Rare, and unhandled. Embedding drift
detection does not work: seed-variant cosine reads surface overlap about twice as strongly as meaning,
so no threshold separates a variant from a collision (S15).

**Realizability for synonyms** is not gated: a lorebook is upstream of its chat, and the entry is a
sample of prose about its subject, so occurrence in it confirms and absence from one short sample
proves nearly nothing. The cut is `countKey(k, entryText) > 0` — weak for a memory entry (a lossy
summary), possibly empty for a reference entry (which can share no vocabulary with the chat). The
set-level predicate `any(countKey(k, entryText) > 0 for k in candidates)` is the useful one:
hallucination detection for the LLM arm, vacuous for the lexical arm, whose candidates come from that text.

**Denotation has no test.** For a synonym it is an unchecked assertion by whatever produced the term.

### Truncations are candidates too

Curated keys are sometimes over-specified (`Julian Vargas` where the chat says `Julian`), so a seed's
truncations are candidates alongside its variants, gated the same way. **A truncation is only valid
when the shorter form still names the same referent** — `Bourdain` does, `Sur` does not name Big Sur —
so truncation is *not* a purely local operation: the gates catch only the truncations that also
collide orthographically and pass the rest under whole-word matching. The same limit applies to
compounds that are not names (`Human Disinterest` → `Disinterest`).

**Referent recurrence decides truncation.** A recurring subject earns its short form; a disposable one
keeps the full name. Two vetoes sit above it: the player persona is excluded outright, and orthographic
collision changes the *rendering* rather than the verdict (`Sara` beside `Sarah Olusanmokun` renders
as `? =^Sara`). The finished Sommers curation applies it throughout; Richard predates it and is
over-specified against it, and there nearly every zero-attestation gold key has a live shorter form,
so zero attestation reads as a form-error signal rather than a frontier one (S13). One book; worth
re-testing against the public books, which need no chat.

## Matching mechanics that constrain the design

**Morphology is matcher-relative.** Under substring matching `rut` already catches `ruts` and
`rutting`, and only stem-changing forms need enumerating; whole-word matching inverts this — collisions
vanish and every variant must be spelled out. No key needs both workstreams.

**`matchWholeWords` is per entry** (`extension/keyword-audit.mjs`), but **SmartKeys make matching
semantics per key**: `=` is word-boundary, `^` case-sensitive, combinable, per term
(`extension/smartkeys.mjs`), so `? =rut` and a loose `thaumaturg` can coexist on one entry.

**SmartKeys should degrade, not fuse.** `? =rut|=ruts` as one key plus a plain literal `rutting` as
another beats a single `? =rut OR =ruts OR =rutting`: an un-extended core drops the SmartKey and still
fires on the literal, and the surviving literals are the non-colliding ones — **degradation loses
recall and preserves precision**. So the expander emits a seed plus its forms, each tagged with its
collision measurement; rendering as literal, whole-word, SmartKey or a mix is a downstream pass, where
portability policy is applied.

**Measure against the text runtime actually searches.** An entry can opt into scanning the persona
description, character description, personality, depth prompt, scenario or creator notes, and that
text then joins the search text — a rate over it correctly reports "fires always". Nothing on disk
sets one (S21), so nothing handles them yet. Hidden messages (`is_system`) are not in the prompt, so
no key fires on them; they are ordinary narrative prose and stay evidence for realizability.

## Code facts established while working this out

- The Aho-Corasick trie is flag-blind: it yields the folded substring count, and exact is computed
  afterward on the primed path only; unprimed whole-word goes to a lookaround regex with no substring
  count (`matcher.mjs`). Production always primes.
- The exact/substring ratio exists: `keyword-audit.mjs` computes `strictClean` against
  `scan(k, cs, false).total`, read by `severityOf` for short keys only. Generalizing it is caller-side.
- SmartKeys return a weight and no counts, regex a raw match count (`matcher.mjs`) — what makes
  SmartKeys unmeasurable, and the case for a `(exactCount, substringCount, weight)` signature.
- `eval/suggest-firing.mjs` uses the real matcher on the unprimed branch, which production never takes.
  Fixing it is a loop inversion (register the key universe once, prime per message) and a prerequisite
  for trusting any collision number it reports.
- The Explorer is the primary curation surface and Cleanup the once-per-book sweep. Both read the same
  classifier over the whole book and differ only in presentation and checkbox state — any other
  divergence is a bug — so anything the audit learns must reach the classifier (`classifyEntry`,
  `reasonOf`/`severityOf`) or it is invisible where the work happens; a finding about `defChecked`, the
  pre-tick, is about the secondary screen.
- `generated()` (`keyword-audit.mjs`) tests STMB field presence and is used only in `defChecked`; scope
  is `inScope`. A miss costs manual ticking on Cleanup and nothing else.
- Chat header identity fields are deprecated; the per-message `name` on `is_user` turns is
  authoritative.

## Populations

**Reference entries match the chat less than memory entries do** — a memory entry is derived from the
chat, a reference entry authored independently in a register the chat never uses. On the matched pair
(`grounded omegaverse` against Sommers' memory entries) reference sits below memory on both
entry-to-chat cosine and term recurrence; counting presence rather than recurrence, or comparing chats
of different lengths, reverses it (S16).

**They are not a distinct class for keying.** Characters, concepts and places are all keyed the same
way — the subject's canonical name, its morphological variants, and the common noun people say instead
of it — and the key counts of the two populations overlap completely (S17). What varies is **subject
ubiquity**, a continuum: peripheral NPCs earn role nouns, principals get a bare first name and nothing
else. Degeneracy to a name tracks how central the subject is, not that it is a person; its
consequence, an entry whose only good key fires in nearly every window, is an activation and
precedence question and the ranker's side of the boundary. For a reference entry the **title is a
first-class seed source**, because it names its subject; a memory entry's title is a generated
editorial label ("003 - Post-Rut Domesticity") and weaker. Asserted, not measured.

Reference entries are a small minority living *inside* memory books, and those books are a handful of
stories (S17), so any memory/reference branch must be per entry, as the pruner's `generated()` split
is. Book size does not identify a population. **`generated()` under-detects**, because offline editing
strips the STMB metadata. The fallback: read the numbering pattern off the book's *own* tagged entries
and treat an untagged entry as generated if its title continues the series. Where STMB's serial
prefix is off there is no series, so it degrades to silence; requiring *continuation* rather than
*looking numbered* biases it toward misses, the right direction — a false positive pre-ticks
deliberate aliases on a hand-written entry, a false negative costs a few clicks on Cleanup.

**Do not compare key counts across populations.** Reference entries carry far fewer keys, but that is
who *wrote* them — memory keys LLM-generated, reference keys hand-written, the same split within one
book. Genuine entry-type differences survive regardless of key authorship: register, `entryText ⊂
chatText` for memory and possibly disjoint for reference, titles that name versus label, source spans
existing at all, sibling density.

**The player persona is never a key.** Hard exclusion, no threshold: collect the distinct `name`
values on `is_user` turns and reject those strings and their tokens. Per chat, not global; token-level
rejection also kills a shared surname (`Kyle Sommers` → `Sommers`), which is probably desirable.
Persona names also stay out of any threshold calibration, because their rate measures POV rather than
salience: second-person Sommers scores `Kyle` at a modest share of assistant turns while present in
essentially every scene (S14).

## The books are not an eval set

The lorebooks on disk are a blend of human curation and weaker-LLM generation whose mixture varies per
book, so agreement with their keys is not a score. Nothing may use them as a denominator until anchor
provenance (below) establishes which subset is trustworthy. **An unkeyed entry is not a negative
example**, and the causes are mechanically separable:

- **`constant`** — always injected, so keys are inert. Out of scope for suggestion.
- **`vectorized`** — activates by embedding. That keys help anyway is asserted, not measured. **These
  are the suggestion targets.**
- **neither** — cannot activate at all. A free diagnostic with no false positives, and the Studio
  should say so. Rare.

### The gold sets

Three curated books (S18): **Foxbridge** — hand-authored end to end, pure reference, several chats
attached under character-card binding; **Richard** — curated by hand through the Explorer;
**Sommers** — by far the largest, the first gold set carrying memory entries and a chat long enough to
measure firing against.

Richard and Sommers were curated **entry-grounded**: judged against entry text (Sommers supplemented
by author memory), not the chat, so both are largely silent on realizability by construction — except
where synonyms were added (`VSOE` beside the full name), which is a realizability claim. Author memory
is an input the entry text does not carry, so superset recall against Sommers has a ceiling below
100% that is not a suggester defect. Both carry **labelled negatives** (S18), recovered from the
pre-edit books inside the `richard-syn-*` and `sommers-syn-*` grade bundles. Three cautions: they are
**(entry, key) pairs, not bad strings**; some are **form corrections rather than rejections**
(`TMZ leak` → `TMZ`), not yet separated; keys on deleted entries are unlabelled.

Anything a suggester proposes that is in neither set is unjudged, so this measures superset recall and
known-junk precision, not precision generally. **Provenance decays**: a key vetted before these
definitions existed was vetted against a different standard, so "already approved" is not a shortcut
for the anchor pass.

Foxbridge carries **several chat lineages** with no shared prefixes (S18), which is not independence.
Only the **lorebook binding** distinguishes same-story from separate-story, from three sources:
`chat_metadata.world_info` per chat, the character card, and — rarely — `settings.json` →
`world_info_settings.world_info.charLore`.

### Findings so far, and what they are worth

**All of it is n=1 curator.** ST mechanics travel; rates do not, until shown otherwise. The public
books are the control for form-level findings, and none has a chat.

- **The activation ceiling is bracketed** by the curator's own verdicts — whole-word rates over
  assistant turns, personas excluded — and Richard's gold positives top out far below the bracket (S14).
- **The suggester does not beat curated keys**: against the pre-curation book, candidates and the
  book's keys are level on dead rate; curation roughly halves the book's rate while the candidates'
  stays put (S11). A bound, not a score — `cap: 30` offers rows at a multiple of the book's key count.
- **The Sommers curation diff**, replicated on Richard (S12). Kept keys are mostly capitalized and at
  one or two words, removals lowercase and phrase-heavy — the proper-noun prior, twice. Scene furniture
  (lowercase multiword one-off props and actions, quote fragments) is the dominant removal class —
  discourse-recurrence gating, observed in gold. The player character is keyed nowhere. Truncation ran
  one way, shortening over-specified keys ("Mr. Sterling" → "Sterling"). Attestation was not required:
  a sizeable share of kept keys never fire in the frozen chat, and many of the curator's own additions
  are unattested in the entry text. Collision was always rescued, never fatal: every SmartKey
  post-dates the curation, and most carry no plain-literal fallback, against the degradation principle
  — unresolved. Variants and aliases were enumerated by hand — the expander's job. Nested bare+full
  name pairs are deliberate and systematic, so the collapse diagnostic stays advisory (open item 0).
  Title-case is not proper-nounhood: LLM-capitalized generics were removed, and one-scene proper nouns
  fail recurrence despite the capital.

## Why a key over-fires — four classes, four remedies

Measured against the standard chat corpus (`eval/eval-data/README.md`). Only one class means "delete
this key"; the other three mean the entry is configured wrong, and it has to be said on the
**Explorer's key chips**, where curation happens.

| diagnostic | class | remedy |
|---|---|---|
| high rate, **collapses** under whole-word | matches inside other words | set Match Whole Words |
| high rate, survives, entry names a person | the subject is on stage constantly | sticky sheet — usually already right |
| high rate, survives, entry is premise-level | the concept is always relevant | `constant` |
| moderate rate, survives, word denotes nothing | actually a bad key | remove |

**The collapse ratio is the sharp instrument**, threshold-free: colliding keys collapse to near zero
under whole-word while merely frequent keys do not move, it catches the moderate-rate cases a safe
rate band misses, and random high-Zipf words used as keys fire at real rates yet almost never
collapse, so the class is separable (K15). The usual cause is a **short form nesting inside its own
long form** (`Kim` ⊂ `Kimberly`), so the diagnostic is per entry — "this entry has a key inside
another of its keys" — and the fix is one checkbox.

**A firing-rate band is not the sharp instrument, and nearly everything it catches is legitimate**:
much of what it flags sits on vectorized entries or is main-cast names on sticky sheets, Sommers'
high band has a zero removal rate against a substantial curation baseline, and every key curation
removed fired below the band (K16). That zero is by design — the band was retained as a hold-out —
and it measured flat, paired (F41): neither removing the band, uniform cast placement, nor both is
distinguishable from baseline, so the band stays retained because nothing argues for moving it. Two
limits: the graded samples embed the pre-curation book, and the contrast ran on memory-tier
re-ranking while the band's keys sit mostly on reference entries — the two-score work in
`matcher-design.md` is what would let it be asked of the ranking that arbitrates.

**Three signals, and none supersedes another.** `COMMON_WORD` says the word denotes nothing in
particular and needs no chat (roughly half the books have none); chat firing rate says how much a key
matches; the collapse ratio says it matches the wrong thing. The overlap between the first two is
nearly empty — of what the Zipf gate kills, chat rate would catch 1–4% and most of the rest fires at a
moderate rate (S22) — and where `COMMON_WORD` is wrong is proper nouns that collide with common words
(`River`, `Paris`) — most of the high-Zipf population in real books — where chat rate is right (K16).

**The table is fiction prose** (`build-zipf.py`: Google Books eng-fiction 1-grams, 1980 on), because the
prior's job is to say what is ordinary in the register the chat is written in, and a suggester
over-filtering costs the user one typed key where under-filtering costs a list of `shoulder` and
`thrall`. Genre-common words are ordinary here by design (S24). The POS sets come off the same
corpus's dominant tag, on words wordfreq knows, which is also the vocabulary gate. Values are stored to
0.1, so a threshold is only meaningful to a decile: the phrase ceiling is exclusive at 5.5 and the rare
line is absence from the table, which begins at 3.0 after rounding. wordfreq alone measured within
noise of the SUBTLEX blend it replaced (S23) and is what any other language would build from.

**Every language is one pack shape.** `build-zipf.py` writes the bundled English module and every
fetched `zipf-<lang>.json` as the same object: the packed deciles, the three POS sets, the common
list and a hash. `lang.mjs` holds whichever is current; the suggester and the audit read it at the
top of each build. A wordfreq-only pack has no POS sets and no name subtraction on its common list.

**Ruled: `chat common` raises its own flag.** Chat rate was confirm-only (it could redden
`common word` and never speak alone), so a key that floods the chat without being a common English
word or frequent in the book's own prose went unflagged — `magic` on a Foxbridge entry. The flag
claims something about the key against this chat, not about the entry's wiring, and that decides the
exemptions: **exempt `constant` and `sticky`**, author declarations that the entry is meant to be
ubiquitous (the audit's own sticky exemptions are deleted, so this stands alone); **not exempt
vectorized**, and therefore not the memory tier — revisit if the volume drowns the flags worth acting
on. **Advisory: it colours, it never pre-ticks**, as `KEY_DUPE_MIN` does; its remedies are `constant`
or a narrower key, so it does not belong in a tick-to-remove list. **Open: the threshold.**
`KEY_CHAT_COMMON` is 20%, set loose for the confirm role; it wants re-reading against what the flag
actually surfaces.

## Open

Blocking the definition:

0. **Nested short forms are sometimes deliberate** — `Kim` beside `Kimberly` to weight the term, not
   to match a nickname — so the per-entry collapse diagnostic is an advisory, never a fix applied for
   the author. Whether an explicit weight serves term weighting better is its own experiment.
1. **The renderer's two thresholds.** *How clean is clean enough*: the quantity is
   `strictClean(k) / scan(k, cs, false).total`, banded by `severityOf` at 1.0 / ⅓ for short keys;
   whether a stem reuses those bands or earns its own is settled by running the backoff over the gold
   families. *How short is too short*: the floor interacts with `KEY_MIN_LENGTH` (4) and probably
   wants stating as a collision bound rather than a length bound, which folds it into the first.

**Closed.** A drift table does not need to exist: table membership is the unigram cut and every
lexicalised plural's base noun is in `ZIPF_EN`, so the plural can only come from a seed the gate
already killed. Propriolization stays unhandled.

Blocking measurement:

2. **Anchor provenance** for books beyond the gold sets; "already approved" is not a decision.
3. **LLM-as-proxy validation** — model-generated keys must clear Foxbridge and Richard before standing
   in for human keys elsewhere. The lexical arm's unique value cannot be measured against one
   badly-configured LLM arm, so pool across several and treat the residue as a lower bound, as
   `/wa-super-grade` pools retrieval arms.
4. **Harness priming** — the code fact above.

Accepted as follow-on:

5. **SmartKeys emission.** Portability policy is a judgement call, and the quality gates exempt `?`
   keys entirely (`keyword-audit.mjs`), so they would enter where nothing can see them.
6. **`countKey` signature change.**
7. **`generated()` fallback** — the numbering-series heuristic in *Populations*. Low stakes, so
   "fairly safe" is the proportionate standard.
8. **The surviving hypothesis**: reference entries may be reachable by lexical-statistical means on
   the entry plus a chat backstop, while memory entries need more. Untested. *Populations* cuts both
   ways: reference bodies overlap the chat least, so the backstop supplies least there, but a
   reference entry's subject usually sits in its title.
9. **Chat corpus assembly** — union a book's bound chats and dedupe shared branch prefixes, without
   classifying branch semantics, since only the corrupting case is the detectable one.

Wanting a labelled set beyond Richard's:

10. **The collapse diagnostic.** Ship "this entry has a key matching inside other words" as a
    per-entry advisory on the Explorer chips. Missing is precision and recall against human judgement;
    a finished curation's removed set is a clean negative label. Advises, never repairs (item 0).
11. **Whether the pre-tick is calibrated well enough to be the default.** A pre-tick is a
    recommendation; the measurement is the override rate over a finished pass — high means recalibrate
    or drop the default, low means it stays (it is not redundant with Select all, which ticks the
    yellow band too). The bar sits higher than for a reversible action, because an un-vetted removal is
    silent where an un-vetted retention reappears next audit. Governs Cleanup, so nothing is blocked.

Retired, recorded so they are not re-derived: **key-set overlap as the score** (superseded by the
behavioural standard); **`J(entry, window)` and its apparatus** (ranker-side); **span masking** (not
replaced; the problem does not arise under a count test); **embedding drift detection** (reads
surface overlap rather than meaning, S15); **hypernymy by co-occurrence** (the Zipf gate is the proxy).

## Related

`.claude/agents/entry-vocabulary.md` is a first attempt at the LLM half, committed as a revert point
rather than a settled design; its entry-kind prose predates the scope boundary and its texture/skip
machinery is superseded by "an entry with neither axis yields few or no seeds". It should shrink to
the referring-expression question, an instruction to emit base forms, the no-frequency-judgement
rule, and the output shape — ask the model for terms and let the expander dedupe forms mechanically.
