# Keyword suggestion — what is being built and how it will be judged

Status: **live, unsettled.** Started 2026-08-01. This is the definition work for a rebuilt keyword
suggester, written down before any measurement exists, because every previous attempt to tune
`buildKeySuggest` was scored against something that turned out not to bear the weight.

Nothing here is implemented. The "Open" section at the bottom is the actual state of play.

## The goal

Keys that are selective enough not to over-trigger and flood the injection context, and common enough
to fire when characters refer to the entry's material.

## Scope: two systems, one boundary

- **Keys that reliably represent their entry material** — this system.
- **Relevant entries being associated with the generation** — the ranker.

Drawing this line retired an entire apparatus that had been assembled first: a per-window relevance
predicate `J(entry, window)`, scan windows, firings-as-definition, want-sets, judgment pooling, and a
retrievability flag. Those all belong to the ranker's evaluation and were imported into the wrong
problem. If they reappear in a discussion of *keys*, the boundary has been crossed again.

## The primitive

    R(key k, entry E, chat C) — does k reliably represent E's material AND LITTLE ELSE,
                               and is it likely to be present in C?

Three components: **denotation**, **exclusivity**, **realizability**.

Keys optimize precision; the ranker optimizes recall. Both matter to both — it is a priority, not an
exclusivity. A key like "rut" that denotes forty sibling memory entries is therefore *outranked*, not
disqualified: choosing among the forty is the ranker's job. "Little else" means material outside the
entry's subject ("maintenance" also denoting car maintenance), not sibling entries covering the same
subject.

### Precision splits in two

- **Semantic** — the term denotes material broader than the entry. Needs judgment.
- **Orthographic** — the term is a substring of unrelated words ("rut" inside "truth", "brutal").
  Mechanical, computable, no annotation required.

Treating these as one thing is what made precision look wholly subjective. It isn't.

### Ubiquity is not vagueness

"Kyle" is a bad key because the protagonist is on stage in nearly every window, not because the name
is imprecise. So the proper-noun prior needs qualifying: a proper noun is a good key when it names a
specific entity and a bad one when it names an ever-present principal.

### Realizability is prospective

"Likely to appear in C" is not "appeared in C". A location sheet for somewhere the story has not
reached, and the alias people will use once they stop being formal, both read as zero occurrences and
are both realizable. Any metric built on observed firing counts is biased against exactly the keys
that are absent-but-coming — including the dead band in `eval/suggest-firing.mjs`.

This is measurable anyway, by grounding it in anchors: variants and synonyms of a known-good seed
**inherit its realizability**. Nothing has to be scored against an imaginary set of all possible good
keys. A useful consequence is that anchors need only be *some* defensible keys per entry, never
complete sets — a far thinner vetting pass than curating a book.

## Three stages

1. **Seeder** — things → seeds. Denotation and realizability. Indifferent to form.
2. **Expander** — seed → family. Morphological forms plus synonyms in the entry's sense.
3. **Renderer** — family + collision statistics + portability policy → keys.

Realizability is inherited across morphology and **not** across synonymy — a form of a word people use
is a form people use, but a synonym is a different word with its own frequency. An earlier draft said
the expander never estimates realizability because the seed carries it; that reached the right
conclusion by the wrong route, and would have broken as soon as the synonym half was built. The
correct reason is in the gate table below.

Synonym expansion is the only piece with no local fallback: statistical seeding exists today,
morphological expansion is rule-work, but synonymy in the entry's sense needs world knowledge. That is
where an LLM is load-bearing rather than merely better.

The two arms are **independent tracks**, not stages of one pipeline — the UI offers "Suggest terms"
(lexical, local by definition) or "Suggest terms LLM" (a local small model or a paid API), and neither
assumes the other has run. The expander runs over whichever produced the seeds; an LLM-emitted synonym
still needs its plural, and that plural still goes to the renderer for collapse.

The renderer runs the backoff: the longest collision-free common substring of the family as a single
literal where one exists ("thaumaturg" covers thaumaturgy, thaumaturge and thaumaturges, portably and
with no enumeration); exact-plus-enumeration or a SmartKey mix where that substring collides ("rut");
separate keys where the family shares nothing usable (scry and scried share only "scr"). So stage 3
can collapse a whole family back into one key, which is why the expander's output is not the keyset.

Where a word-form and a stem are equally good, the renderer prefers the word-form. A stem is not a
word, and a user reviewing suggestions may not recognise it as a good key even when it is. That is an
acceptance cost rather than a correctness one, and this is the cheapest place to pay it.

### Allowing patterns changes the metric

A stem string-matches none of the curated keys it covers, so the superset standard has to be
**behavioural**: for each curated key, does the produced keyset fire where that key fires? That is
`countKey` against the same text — the existing one-matcher doctrine, no judgement and no new
machinery. It also repairs a defect the string comparison had anyway, which would have scored case and
whole-word differences as misses. Breadth cannot game it, because coverage is only the recall half: a
maximally broad key dies on the orthographic side, which is mechanical.

## What makes a seed

A seed is a term that:

1. **The entry carries information about, rather than merely naming.** Topicality is the wrong test.
   "What the entry is about" wrongly excludes the Porsche bought during a scene whose subject is
   something else — that entry is still where the Porsche comes from. The same test excludes
   "thaumaturgy" from Foxbridge's "specialty" entry, which names it in a list of a dozen disciplines
   and says nothing about it.
2. **Is not defeated by orthographic collision.** Mechanical, and regime-dependent.
3. **Has affirmative reason to be typed.** The evidence is asymmetric: presence in the chat confirms,
   absence does not disqualify. That is what "prospective" means operationally.

**Count is unbounded.** An earlier draft carried "one seed per distinct thing the entry is about",
which was a quota wearing a definition's clothes; it is deleted rather than repaired. Seed count is
whatever passes the gates — the same position on caps, one level down.

### Two axes, and only one of them gates

- **Referent persistence** — does the thing keep mattering. The Grove's sectional: yes. The specific
  meal, the one-off restaurant's bathroom: no.
- **Discourse recurrence** — do people type the words. The Porsche: yes. The sectional: no.

The Porsche has both, the sectional only the first, the meal neither. **Only discourse recurrence gates
seeds.** Referent persistence enters as evidence about *where* the seed is: a cluster of
persistent-but-undiscussed detail is the signature of a continuity entry, and its seed is the container
that owns the detail — the Grove, not the sectional. Foxbridge's "witch levels" has the same shape
(thesis projects, five disciplines, none of them keys) and its human keys are all container terms:
witch, practitioner, qualification, specialty.

An entry with neither axis — scene-bounded detail — yields few or no seeds. That is the honest version
of what the texture/skip machinery in `entry-vocabulary.md` was groping at: not "this entry should not
exist", but "this entry's content is mostly things nobody will name".

**Entry content and key material are different questions.** The sectional belongs in the entry, because
it is what stops the sofa changing on every generation. It is simply not a key. Collapsing the two is
how a realizability judgement gets mistaken for an argument about what an entry should contain.

### Realizability evidence: retrospective and frontier

Most entries are not at the frontier. In a 286-entry memory book, entry 3 has 283 entries' worth of
subsequent chat, so whether a term recurred is a lookup rather than a prediction. The first-mention
problem bites only at the newest entries and on a new book.

**Retrospective** — posterior chat exists:

- Occurrence in chat after the entry's own scene. Not a proxy for recurrence; it is recurrence.
- Cross-entry recurrence in the book, which **inverts the current dfCeil reading**. High df is treated
  as junk today, but mid-band df is positive evidence that a thing keeps coming up: parabolic rather
  than monotonic, the same shape as the firing bands. One entry is furniture, eight is a fixture, two
  hundred is wallpaper.

A memory entry's own source span must not supply its own evidence, or every piece of scene furniture
passes. **Dispersion replaces masking, and the span metadata should not be used for it.** A term whose
occurrences all fall in one contiguous stretch is furniture and that stretch *is* the source scene —
the data localises it without being told, which works uniformly on entries whose spans are missing,
sentinel or wrong, and on reference entries that never had one. Same judgement, derived rather than
trusted, and no population branch.

It also stops mattering much once the test is a count rather than a presence check: a source span is
~50 messages against Richard's 2878, so subtracting it changes no verdict for a term appearing five
times across the book. Masking is only load-bearing under a binary "does it appear at all" test, and
that test is wrong for other reasons.

Recorded because something else may read those fields: `STMB_start`/`STMB_end` are per-chat indices and
mostly well-formed, but **a range shared by dozens of entries is a sentinel, not data** — Time Whore has
43 entries all carrying `0-172`, an artifact of offline LLM editing that drops the metadata and
backfills it. Sommers mixes 50-message auto-slices with manual scene spans and carries one `null-null`.
Richard is clean fixed-window slicing, and its `chat_metadata.STMemoryBooks.highestMemoryProcessed`
equals its last span end exactly, which is a cheap correspondence test for whether a book's spans index
the chat you are measuring against.

**Frontier** — priors only, strongest first:

- Proper-nounhood. Names attach to things that persist.
- Rarity *combined with* entity-ness. Rarity alone fails — "olfactory" is rare and is not a thing — so
  it needs the PoS side that the Zipf work already has.
- Within-entry re-mention. A thing referred to more than once is being tracked rather than passed over.
  Weak, and mostly what TF already picks up.

Measuring against the same chat that informs the ranking is not circular; it is the position
`eval/suggest-firing.mjs` already takes deliberately.

**Consequence for the two arms.** The LLM's advantage is concentrated at the frontier and on new books.
On a mature book with a long chat the lexical arm has direct evidence of recurrence, and the gap should
be at its narrowest there. That is testable, and it says where the paid arm earns its cost rather than
assuming it wins everywhere.

## Expansion correctness

Two objects, and conflating them is what would waste the annotation:

- **The linguistic closure** — every surface form denoting the same material as the seed. A fact about
  language and this book's world, and regime-independent.
- **The required subset** — the forms the matcher will not already reach. Mechanically derived: under
  substring matching, is the seed a substring of the variant; under whole-word, does it appear as one.

Annotate the first, derive the second, and the gold survives a regime change or a SmartKeys decision.
Core's boundary is `(?<!\w)…(?!\w)` (`extension/ranking.mjs:323`), so hyphens do not block: "rut"
reaches "pre-rut" under *both* regimes and reaches "ruts" only under substring. Prefixed and hyphenated
compounds are free almost everywhere; suffixed forms are the regime-sensitive ones.

**Verbs are out of scope.** Verbs make poor keys, so tense is not expanded — and that removes the whole
inflection-homograph problem with them, since every instance of it is a verb form (rise→rose, see→saw,
find→found, grind→ground, fall→fell, leave→left, speak→spoke, wind→wound). It was an artifact of
expanding verbs, not a class needing machinery.

### What each class is gated on

Each class is tested on exactly what it does not inherit.

| | denotation | exclusivity | orthographic collision | realizability |
|---|---|---|---|---|
| **seed** | gate | gate | gate | gate |
| **morphological variant** | inherited | gate | gate | inherited |
| **synonym** | gate | gate | gate | see below |

Morphology inherits meaning and re-earns the string; synonymy inherits reference and re-earns the
meaning. Neither inherits the string — "rut" and "ruts" have identical denotation and wildly different
collision profiles.

**Exclusivity is two things**, and they want different instruments. *Breadth* is one sense that properly
contains the entry's material with a lot left over — "dog" for a hellhound entry, "magic" for
thaumaturgy — and it is entry-relative, so no property of the string alone implements it; the Zipf gate
is the cheap proxy and will misjudge entries whose subject genuinely is a common thing. *Competing
sense* is a string carrying an unrelated established meaning. With verbs gone that reduces to
lexicalised plurals (greens, arms, glasses, customs, quarters, goods) — and **that class needs no
machinery at all**, measured rather than assumed. All 14 have their base noun in `ZIPF_EN`, and table
membership *is* the unigram cut, so none survives as a seed; every plural is independently in the table
as well, so both routes reject. A plural can only be generated from a seed the gate already killed.
Coinages are unaffected: thaumaturge, minotaur and orrery are absent from the table and survive.

Proper-name capture (chili → Chili's, rolling stone → Rolling Stones) is the residual and has no signal
but capitalisation. It is not covered by the above — a possessive is not a plural, and `stems()` does
not strip `'s`.

Embedding-based drift detection was **tested and rejected**: bge-m3 over 44 pairs crossing drift with
surface overlap gave `corr(sim, prefix-share) = 0.51` against `corr(sim, drift) = -0.21`, and *zero*
discrimination in the cell that motivated it (high-overlap clean 0.868, drifted 0.873 — damage/damages
and quarter/quarters sit beside walk/walked). Best single threshold 64% against a 55% base rate, and its
worst false positive was `scry/scried` at 0.583, an in-world coinage. The distributional version is dead
a priori: it needs contexts for a variant that by definition is not attested yet. Drift is lexical
knowledge, not a distributional statistic.

**Realizability for synonyms** is not gated, and the reason is not inheritance. A lorebook is upstream
of its chat: an injected entry supplies vocabulary the model then writes, so a term the entry declares
is realizable in a way an inferred one is not. More directly, **the entry is a sample of prose about
its subject** — the only one that exists before the chat does — so occurrence in it is a real frequency
observation, and absence from one short sample proves nearly nothing. That is why presence confirms and
absence does not disqualify. The cut is mechanical: `countKey(k, entryText) > 0`.

Two limits on that. For a memory entry the entry text is a lossy summary of chat the term came from, so
the observation is weak; for a reference entry the entry may share no vocabulary with the chat at all
(Foxbridge's expository register). And **the set-level predicate is the useful one**:
`any(countKey(k, entryText) > 0 for k in candidates)` asks whether the candidate set is grounded in the
entry at all, which is hallucination detection for the LLM arm rather than evidence about any one term.
It is vacuous for the lexical arm, whose candidates are extracted from that text by construction.

**Denotation has no test.** For a synonym it is an unchecked assertion by whatever produced the term;
the gates above catch particular ways it can be wrong, not the claim itself.

### Contraction, not expansion, is where the measured defect is

Of the 11 gold keys in Richard with zero chat attestation, **nine have a live shorter form**:

    Pera Palace Hotel  0 -> Pera Palace (8)      Anthony Bourdain 0 -> Bourdain (7)
    Action Hero persona 0 -> action hero (80)    Big Sur Cabin    0 -> Big Sur (18)
    Alex's Bungalow    0 -> bungalow (20)        bus commute      0 -> commute (28)

Only `Dallas Buyers' Club` and `home search` are genuinely absent, so the frontier residue in that book
is ~1%, not the 6.5% a raw dead-count suggests. **Zero attestation is a form-error detector, not a
frontier detector**, on any book with a long chat behind it — and it found four outright defects in a
hand-curated gold set (`Vienna` for Venice Simplon-Orient-Express, `Human Disinteret`, `ms klein` for
Ms. Klein, `Anthony Bourdain`).

Every case examined points the same way: `Julian Vargas` (1 hit) → `Julian` (101). `ms klein` (0) →
`Ms. Klein` (8), and bare `klein` (12) beats both. So the highest-value expander operation on real
curated keys is **truncation**, searched as a lattice and gated the same way as anything else —
`Pera Palace` (8) is right and `Pera` (269) is wrong, `weaver` (4) is right and `rug` (144) is wrong.
It is entirely local, and the renderer's backoff already *is* this search, run over a morphological
family instead of one key's truncations.

Name decomposition is the same operation on people and needs one extra admission test: the compound
must be a **name**. `Human Disinterest` → "Disinterest" scores 82 hits and passes every gate while
being a coined concept, not a person. Across 38 two-token capitalised gold keys the failures are
exactly the existing gates — stopword heads (`The Squad` → "The", 2470), substring collisions
(`Big Sur` → "Sur", 759, inside *sure*), and ubiquity (`Joe`, 271) — and the wins are real (`Julian`
101, `Maria` 193, `Stern` 153 against `Marty Stern`'s 3). The verdict is per name, not a rule: bare
`Joe` was dropped for `Joe Pagliani` while `Julian Vargas` wants the opposite.

## Matching mechanics that constrain the design

**Morphology is matcher-relative.** With substring matching, "rut" already catches "ruts" and
"rutting" — no variant needed. Only stem-changing forms must be enumerated (thaumaturgy → thaumaturge,
scry → scried). Whole-word matching inverts this: collisions vanish, and every variant must be spelled
out. It is one knob with two faces, and no key needs both workstreams.

**`matchWholeWords` is per entry** (`extension/keyword-core.mjs:202-203`), so a keyset would have to be
internally coherent under one regime — except that **SmartKeys make matching semantics per key**: `=`
is word-boundary, `^` is case-sensitive, combinable, per term (`extension/smartkeys.mjs:70`). So
`? =rut` and a loose `thaumaturg` can coexist on one entry.

**SmartKeys should degrade, not fuse.** `? =rut|=ruts` as one key plus a plain literal `rutting` as
another beats a single `? =rut OR =ruts OR =rutting`: an un-extended ST core silently drops the
SmartKey and still fires on the literal. The split is decided by substring-vs-exact statistics, which
means the surviving literals are exactly the non-colliding ones — so **degradation loses recall and
preserves precision**, which is the right failure direction.

The expander's output shape follows: a seed plus its closure, each variant tagged with its collision
measurement. Rendering as literal, whole-word, SmartKey or a mix is a downstream formatting pass, and
that pass is where portability policy is applied rather than baked in.

**The measurement's haystack must be the runtime's haystack.** One rule, and it settles three separate
questions. Entries can opt into scanning the persona description, character description, personality,
depth prompt, scenario or creator notes — so when a flag is set, that text belongs in the haystack, and
the resulting rate correctly reports "fires always", which is how you discover an entry wanted
`constant`. Hidden messages (`is_system`) are *not* in the prompt, so no key can fire on them and they
are out — though they remain evidence for realizability, which asks a different question of the same
file. And activation is per **scan window**, not per message: at depth 2 a term in 22% of messages fires
in roughly 39% of windows, saturating near the top of the range, so a message-rate ceiling reads
differently once applied to windows. Fix which one is being quoted before any threshold is written down.

Same principle as harness priming below: a measurement that diverges from runtime is measuring a system
nobody runs.

## Code facts established while working this out

- The Aho-Corasick trie is flag-blind: it always yields the folded substring count, and exact is
  computed afterward only where the flags demand it — **on the primed path**. Unprimed *and* whole-word
  goes straight to a lookaround regex (`ranking.mjs:323`) that produces no substring count at all.
- Production always primes (`ranking.mjs:365`, `keyword-core.mjs:143,154`). `cachedCount`'s three
  undefined branches are for out-of-band callers, never live matching.
- The exact/substring ratio already exists: `keyword-core.mjs:225` computes `strictClean` against
  `scan(k, cs, false).total`, read by `severityOf` — currently gated to short keys only. Generalizing
  it is caller-side work, no `countKey` surgery.
- The case for changing `countKey`'s signature to `(exactCount, substringCount, weight)` is uniformity
  across key *types*, not the ratio: SmartKeys return a weight and no counts (`ranking.mjs:286`), regex
  returns a raw match count (`:295`). That is the blind spot that makes SmartKeys unmeasurable.
- `eval/suggest-firing.mjs` uses the real matcher but enters on the unprimed branch, which production
  never takes. Same function, different branch — the "countKey is the only matcher" rule catches the
  first kind of drift and is silent about the second. Fixing it needs a loop inversion (register the key
  universe once, prime per message), and it is a prerequisite for trusting any collision number the
  harness reports.
- **`generated()` (`keyword-core.mjs:298`) is a field-*presence* test** against three keys STMB writes:
  `stmemorybooks` (2674 entries, always literal `true`), `STMB_start` (2404; a number, `null` twice) and
  `stmbArc` (261, always `true`). `STMB_end` and `disabledByArcId` go untested and cost nothing — zero
  entries carry either without one of the three. It is used in exactly one place, `defChecked`
  (`:300`), which sets the *pre-tick* state in the prune popup; it does not affect scanning at all.
  Scope is `inScope` (`:109-113`) — `disable` / `constant` / `vectorized` / keyword — with no STMB in it.
  Since `severityOf` returns `''` for `unattested`, that clause is the only route by which a dead key
  arrives pre-ticked, so a miss costs manual ticking and nothing else.
- **No entry on disk enables any of** `matchPersonaDescription`, `matchCharacterDescription`,
  `matchCharacterPersonality`, `matchCharacterDepthPrompt`, `matchScenario`, `matchCreatorNotes`. Chat
  is the complete activation haystack for this corpus, not an approximation of it.
- **`is_system` means hidden from the prompt, not "not story"**. Richard's chat is 65% `is_system` and
  those messages are ordinary narrative prose averaging 969 chars. Sommers has 7. Filtering them as
  noise silently discards two thirds of a chat.
- **Chat header identity fields are deprecated.** 111 of 192 chat files carry a real `user_name` *and*
  `create_date`; the other 81 carry the literal string `"unused"` and no `create_date`, with zero
  crossover — two format generations. The per-message `name` on `is_user` turns is authoritative in both.

## Populations

**Reference entries in general match the chat less than memory entries do, and the reason is
structural.** A memory entry is derived from the chat — a summarizer read those messages and wrote it —
so it shares vocabulary by construction. A reference entry is authored independently, usually before
the chat exists, in an expository register the chat never uses. Overlap there is incidental rather than
guaranteed.

Character sheets sit at the far end of that gradient — historical, psychological and dispositional
prose describes how someone behaves rather than naming things anyone says aloud — but that is a matter
of degree.

**They are not a distinct class for keying.** Checked against Foxbridge (human-curated, reference-only)
and Sommers' reference minority: characters, concepts and places are all keyed the same way — the
subject's canonical name, its morphological variants, and the common noun people say instead of it.

    necromancy                  necromancy, necromancer, demiurge, medium
    Arnold Atkins               Arnold, Atkins, sherriff, police, cop
    Miss Roberta's Boarding House   boarding house, Miss Roberta, guest rooms

Same shape three times, and the key counts of the two populations overlap completely (Foxbridge
characters 0–6, concepts 0–8).

What varies is **subject ubiquity**, which is a continuum rather than a class. Foxbridge's peripheral
NPCs earn role nouns; Sommers' principals get a bare first name and nothing else — Jeffrey Sommers
`[Jeffrey]`, Shane Sommers `[Shane]`, Micah Henry `[Micah]`. Degeneracy to a name tracks how central
the subject is, not that it is a person, which is the "Kyle" observation appearing in curated data. Its
consequence — an entry whose only good key fires in nearly every window, so the entry is *effectively*
constant — is an activation and precedence question, and therefore the ranker's side of the boundary,
not this system's.

A consequence for seeding: for a reference entry the **title is a first-class seed source**, because a
reference title names its subject (Foxbridge: "witch levels", "thaumaturgy", "scrying"). A memory
entry's title is a generated editorial label — "003 - Post-Rut Domesticity" — which describes rather
than names, and is correspondingly weaker.

Asserted, not measured.

Across 39 books on disk, every book over 100 entries is 85–96% STMemoryBooks entries, so reference
entries are a 5–15% minority living *inside* memory books. Any memory/reference branch must therefore
be per entry, as the pruner's `generated()` split already is. Pure-reference books are small (10–75
entries).

**That figure is a `generated()` count, and `generated()` under-detects.** Offline editing — dropping a
lorebook into a model chat to clean it up, which anyone invested enough to run STMB will eventually do
— strips the metadata. In Richard 12 of 22 apparently-reference entries are numbered scene summaries
carrying no STMB fields at all, so the real split is 49 memory / 8 constant scaffolding / 1 reference,
not 37/22. Sommers and Time Whore are *not* affected: zero of their untagged entries carry a scene
number, so their counts stand as recorded.

The fallback is self-calibrating and needs no format assumption: read the numbering pattern off the
book's *own* tagged entries, then treat an untagged entry as generated if its title continues that
series. Richard's tagged entries run 11–51 and its untagged numbered ones are 1–10 plus 32 and 33 —
the head of the same series and two interior holes. That catches 12 of 12 in Richard and 0 in Sommers
and Time Whore. STMB's serial-number prefix is a default that can be toggled off, so where it is off
there is no series to continue and the heuristic degrades to silence rather than to a wrong answer.
Requiring *continuation* rather than merely *looking numbered* also biases it toward misses, which is
the right direction: a false positive pre-ticks the deliberate aliases on a hand-written entry, and a
false negative costs a few clicks. Gaps in the merged series are deleted entries, free (Richard 21 and
43, Sommers 86 and 89).

**Do not compare key counts across populations.** Median keys per entry differ enormously — reference
1–9 against memory 10–30 — but that is who *wrote* the keys, not what the entries are. Memory keys are
LLM-generated and reference keys usually hand-written, and Richard shows the same split *within one
book* (16.6 against 4.5 before curation). The same confound probably explains the in-text rate of
existing keys, since an extractive generator produces in-text keys by construction while a human adds
aliases. Genuine entry-type differences are the ones that survive regardless of key authorship:
register, `entryText ⊂ chatText` for memory and possibly disjoint for reference, titles that name the
subject versus editorial labels, source spans existing at all, and sibling density.

**The player persona is never a key.** ST injects the Persona Description every turn, so the persona
has no lorebook entry — but its name still turns up as a candidate on episodic entries (`Alex Nichols`,
`Richard Ryder` were both removed by hand from Richard). Hard exclusion, no threshold: collect the
distinct `name` values on `is_user` turns and reject those strings and their tokens. Note it is
per-chat, not global — the same user runs `Kyle Parsons` on one book and `Niall` on another — and that
token-level rejection also kills a shared surname (`Kyle Sommers` → `Sommers`, shared with Jeffrey and
Shane), which is probably desirable but arrives by accident.

Persona names must also be kept out of any threshold calibration, because their rate measures POV
rather than salience. Sommers is narrated in second person, so `Kyle` appears only in dialogue and
scores 35.1% of assistant turns while being present in essentially every scene; a third-person chat
would score the identical persona two or three times higher.

## The books are not an eval set

The lorebooks on disk are a blend of human curation and weaker-LLM generation whose mixture varies per
book, so agreement with their keys is not a score. Nothing may use them as a denominator until anchor
provenance (below) establishes which subset is trustworthy.

**An unkeyed entry is not a negative example** — but the causes are mechanically separable, which an
earlier draft of this section denied:

- **`constant`** — always injected, so keys are inert. Authoring scaffolding and arcs: Sommers'
  `Design Note:` and `Story Arc:`, Richard's `ACT I`–`ACT VI`, `Dramatis Personae`, `Richard's Lenses`.
  Out of scope for suggestion, and adding keys here buys nothing measurable.
- **`vectorized`** — activates by embedding. Keys are optional and worth having anyway, since vector
  plus keys measurably improves recall. **These are the suggestion targets.**
- **neither** — cannot activate at all. A genuine oversight, and rare: 1 of 38 in Foxbridge, 0 of 60 in
  Richard. That row is a **free diagnostic with no false positives** and the Studio should say so.

The doc previously listed Foxbridge's `weave theory`, `mudra`, `asana` and `Kiki Chavez` as four
oversights. Three are `vectorized` and activate fine; only `Kiki Chavez` was dead — and it has since
been keyed. So oversights are roughly one entry per book, not a meaningful ceiling on the superset
standard.

### The gold sets

Two books are now curated and usable. **Foxbridge** — 38 entries, 123 keys, hand-authored end to end
with no LLM involvement, pure reference, several chats attached under character-card binding.
**Richard** — 59 entries, 311 keys, curated by hand through the Explorer.

Richard's provenance matters and should travel with any number derived from it. Curation was
**entry-grounded**: judged against entry text, not against the chat, which matches the scope boundary
above rather than smuggling the ranker's question into the gold. It is therefore largely silent on
realizability by construction — except where synonyms were added (`VSOE` beside the full name), which
is a realizability claim. Two acknowledged uses of outside knowledge: `Joe` → Joe Pagliani, `Mr. Stern`
→ Marty Stern.

**550 labelled negatives** exist as a byproduct, recoverable because the pre-edit book survives inside
the `richard-syn-*` grade bundles: of 737 original keys, 163 survived and 148 were newly written, so
48% of the finished gold is human-authored and the machine-generated original retained 22%. Three
cautions on consuming them. They are **(entry, key) pairs, not bad strings** — `Giselle` is a negative
on entries 001 and 050 and a positive on nine others, because the judgement is about the entry, not the
term. Some are **form corrections rather than rejections** (`TMZ leak` → `TMZ`, `Pappy 23 bourbon` →
`Pappy Van Winkle`), separable by head-overlap with a key added to the same entry. And the 24 keys on
the deleted entry `043 - Istanbul Arrival` are excluded and unlabelled — it was a duplicate that later
summaries covered better.

Anything a suggester proposes that is in neither set is unjudged, so this measures superset recall and
known-junk precision, not precision generally. And **provenance decays**: a key vetted before these
definitions existed was vetted against a different standard, so "already approved" is not a shortcut
for the anchor pass.

Foxbridge additionally carries **six independent chat lineages** (421, 416, 173, 113, 77, 47 messages;
~1250 total), verified by prefix comparison — but see the caveat that continuation, separate story and
ephemeral repeat all look alike from a zero-length shared prefix, and only the **lorebook binding**
distinguishes same-story from separate-story. Chat binding has three sources: `chat_metadata.world_info`
when set per chat (Richard), the character card (Foxbridge), and — rarely, but it exists —
`settings.json` → `world_info_settings.world_info.charLore`, which on this install attaches `ERP` to
Ragnar and Gilbert and `main_Succubus Tattoos_world_info` to Alastor. `globalSelect` is empty.

### Numbers so far, and what they are worth

**The activation ceiling, bracketed.** Whole-word rates over assistant turns, personas excluded,
against your own verdicts: Dylan 21.8% kept ("grew, never crested"), Arthur 35.1% undecided (still
being tagged), Liam 53.4% crossed ("good until he wasn't"), Richard 94.5% long gone. Giselle 18.3% kept
on nine entries. The most informative point is Arthur, because the threshold sits where a human cannot
call it either. Gold positives in Richard top out at **10.9% of all messages** with p99 at 4.6% and a
median of 0.1%, so nothing human-approved lives high in the range.

**This is n=1 author.** The lorebooks span 19 lineages and genuinely wide genres, which controls
vocabulary, entry structure and name morphology — but only six carry memory entries, two of those are
one story, and the bracket above came from two. Findings sort roughly: ST mechanics travel, structural
mechanisms probably travel with unknown magnitudes, and every rate is local until shown otherwise. The
public books (Deltarune, Cyberpunk 2077, Adolion, Red Dead, Succubus Tattoos) are the available control
for form-level findings; none has a chat, so activation cannot be checked against them at all.

## Open

Blocking the definition:

1. **The renderer's two thresholds.** The backoff picks "the longest collision-free common substring
   of the family", and neither word in that phrase has a number yet.
   - *How clean is clean enough.* The quantity exists: `strictClean(k) / scan(k, cs, false).total`,
     already computed at `keyword-core.mjs:225` and banded by `severityOf` at 1.0 / ⅓ for short keys.
     The open question is whether a stem reuses those bands or earns its own, since a stem is
     deliberately not a word and will never score 1.0 the way a short key can. Settled by running the
     backoff over the gold families and reading the cases where it picks a stem you would reject.
   - *How short is too short.* "scry" and "scried" share only "scr", which is unusable; `thaumaturg`
     at nine characters is fine. The floor interacts with `KEY_MIN_LENGTH` (4) and probably should not
     be a raw character count, since three characters of a rare coinage collide less than five of a
     common word — so it likely wants stating as a collision bound rather than a length bound, which
     folds it into the previous item. Same run answers both.

**Closed.** *Does the drift table need to exist* — no. Measured against `ZIPF_EN`: all 14 lexicalised
plurals have their base noun in the table (green 4.9, arm 4.8, glass 4.8, custom 3.8, quarter 4.4,
spirit 4.7, good 6.4, letter 4.9, manner 4.1, paper 5.0, look 6.3, damage 4.5, content 4.4, brain 4.9),
and table membership *is* the unigram cut, so none survives as a seed. Every plural is independently in
the table as well, so both routes reject. Controls behave — thaumaturge, minotaur and orrery are absent
from the table and survive. A plural can only be generated from a seed the gate already killed, so
there is no case for a table to catch. Proper-name capture (chili → Chili's) is untouched by this: it
is a possessive, `stems()` does not strip `'s`, and whether `chili` itself clears the table is a
separate lookup that has not been run.

Blocking measurement:

2. **Anchor provenance** for books beyond the two gold sets — and it cannot read "already approved" as
   a decision, since provenance decays against a moving standard.
3. **LLM-as-proxy validation** — model-generated keys must clear Foxbridge and Richard before standing
   in for human keys anywhere else. Note the ordering problem: the lexical generator's unique value
   cannot be measured against a badly-configured LLM arm, because "lexical-only" would then mean
   "unreached by a cheap prompt". Pool across several LLM configurations and treat the residue as a
   lower bound, exactly as `/wa-super-grade` pools retrieval arms.
4. **Harness priming** — see the code facts above.

Accepted as follow-on:

5. **SmartKeys emission.** Portability policy is a judgement call, and the quality gates exempt `?`
   keys entirely (`keyword-core.mjs:211`), so they would enter precisely where nothing can see them.
6. **`countKey` signature change.**
7. **`generated()` fallback** — the numbering-series heuristic in Populations. Low stakes (a checkbox
    default), so "fairly safe" is the proportionate standard.
8. **The surviving hypothesis**: reference entries may be reachable by lexical-statistical means on the
    entry plus a chat backstop, while memory entries need more. Untested — and the flat probes above say
    nothing about it either way. The Populations note cuts against it in one direction and for it in
    another: if reference bodies overlap the chat least, the backstop supplies least exactly there — but
    a reference entry's subject is usually sitting in its title, so the seed may not need the body at all.
9. **Chat corpus assembly** — union a book's bound chats and dedupe shared branch prefixes. Correct for
    every branch semantics (continuation, separate story, true fork, ephemeral repeat) without needing
    to classify them, since only the case that would corrupt it is the detectable one.

Retired, recorded so they are not re-derived:

- **Key-set overlap as the score.** Superseded by the behavioural standard — for each curated key, does
  the produced keyset fire where it fires.
- **`J(entry, window)` and its apparatus** — scan windows, want-sets, pooling, an identifiability flag.
  All ranker-side; relevance of an entry to a window was never this system's question.
- **Span masking**, **embedding drift detection**, and **breadth by co-occurrence** — each replaced
  above by something cheaper that works.

## Related

`.claude/agents/entry-vocabulary.md` is a first attempt at the LLM half, committed as a revert point
rather than a settled design — at ~190 lines it is over-engineered for the task, and its entry-kind
branch prose predates the scope boundary above. Its texture/skip machinery is superseded by "an entry
with neither axis yields few or no seeds", and it should shrink to the referring-expression question,
an instruction to emit base forms, the no-frequency-judgement rule, and the output shape. Ask the model
for terms and let the expander dedupe redundant forms mechanically, rather than asking it to reason
about which forms English morphology will already reach — that is the instruction a small model will
half-follow.
