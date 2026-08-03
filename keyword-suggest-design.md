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
is a form people use, but a synonym is a different word with its own frequency.

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

**Seed count is unbounded** — whatever passes the gates. Not a quota, and not the same quantity as the
number of candidates offered, which `cap` governs as a display budget.

### Two axes, and only one of them gates

- **Referent persistence** — does the thing keep mattering.
- **Discourse recurrence** — do people type the words.

Both are continua, not tests. The Grove sits high on both; the Cloud sofa lower on the second but not
at zero, since it is a named object people do occasionally mention; the mudroom's slate-look tile at
zero, present only so the floor does not change every turn. **Only discourse recurrence gates seeds**,
and what it gates on is whether the thing has a form people use to refer to it — which is why an
entry's descriptive material is not key material even when its subject is. Referent persistence enters
as evidence about *where* the seed is: a cluster of persistent-but-undiscussed detail is the signature
of a continuity entry, and its seed is the container that owns the detail — the Grove, not the tile.
Foxbridge's "witch levels" has the same shape (thesis projects, five disciplines, none of them keys)
and all eight of its human keys are container terms: witch, wizard, mage, magician, sorceror,
practitioner, qualification, specialty.

An entry low on both — scene-bounded detail — yields few or no seeds. That is the honest version
of what the texture/skip machinery in `entry-vocabulary.md` was groping at: not "this entry should not
exist", but "this entry's content is mostly things nobody will name".

**Entry content and key material are different questions.** The tile belongs in the entry, because it
is what stops the mudroom floor changing on every generation. It is simply not a key. Collapsing the
two is how a realizability judgement gets mistaken for an argument about what an entry should contain.

### Realizability evidence: retrospective and frontier

Most entries are not at the frontier. In a 286-entry memory book, entry 3 has 283 entries' worth of
subsequent chat, so whether a term recurred is a lookup rather than a prediction. The first-mention
problem bites only at the newest entries and on a new book.

**Retrospective** — posterior chat exists:

- Occurrence in chat after the entry's own scene. Not a proxy for recurrence; it is recurrence.

A memory entry's own source span must not supply its own evidence, or every piece of scene furniture
passes. **Masking the span is not how that gets handled, and nothing replaces it** — the problem stops
mattering once the test is a count rather than a presence check. A source span is a few dozen messages
against a chat of thousands, so subtracting it changes no verdict for a term appearing several times
across the book. Masking is only load-bearing under a binary "does it appear at all" test, and that
test is wrong on its own terms.

Separately, and not as a gate: a term whose occurrences all sit in one contiguous stretch has located
its own source scene, without the metadata. That is useful for knowing *where* the scene is. It does
not distinguish scene furniture from a memorable one-off, which look identical by any count.

If anything ever does read `STMB_start`/`STMB_end`: they are per-chat indices, and **a range shared by
dozens of entries is a sentinel, not data** — offline editing drops the metadata and something backfills
it.

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

Annotate all the forms denoting the seed's material — that is a fact about language and does not move.
The **required forms** are the subset the matcher will not reach from the seed on its own, and they are
derived rather than annotated: under substring matching, does the seed occur in the variant; under
whole-word, does it occur as a word. `wolf` does not occur in `wolves`, so `wolves` is required; `rut`
occurs in `ruts`, so `ruts` is not. Deriving rather than storing is what lets the gold survive a regime
change or a SmartKeys decision.

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

**Exclusivity fails as hypernymy** — the key names a superordinate of the entry's subject. "dog" on a
hellhound entry, "magic" for thaumaturgy. The relation is entry-relative, so no property of the string
alone implements it; the Zipf gate is the proxy, and it works because a hypernym is usually the commoner
word. It breaks where the entry's subject *is* the superordinate — a dog entry keyed "dog" — since
there the two signals come apart.

The other way a string can carry meaning outside the entry is **propriolization**: a common noun's
plural or possessive coinciding with an established proper name, `chili` → `Chili's`,
`rolling stone` → `Rolling Stones`. No signal but capitalisation, and `stems()` does not strip `'s`,
so it is not reached by anything above. Rare, and unhandled.

Embedding-based drift detection was tried and does not work: seed-variant cosine reads surface overlap
about twice as strongly as it reads meaning — 1.71x by standardised coefficient over 45 term pairs on
bge-m3, where synonyms carrying no surface overlap average 0.61 and orthographic neighbours sharing no
meaning average 0.68, so no threshold separates a real variant from a collision. The distributional
version is dead a priori — it needs contexts for a variant that by definition is not attested yet.

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

### Truncations are candidates too

Curated keys are sometimes over-specified — `Julian Vargas` where the chat says `Julian`,
`Pera Palace Hotel` where it says `Pera Palace` — so a seed's truncations are candidates alongside its
variants, gated the same way.

**A truncation is only valid when the shorter form still names the same referent.** `Bourdain` names the
man; `Sur` does not name Big Sur, it is a fragment that belongs to other places entirely. That is a
semantic judgement, not a mechanical one, so this is *not* a purely local operation — the gates catch
only the truncations that also collide orthographically (`Sur` inside *sure*), and would pass the rest
under whole-word matching. The same limit applies to compounds that are not names at all:
`Human Disinterest` → `Disinterest` clears every gate while being half of a coined concept.

The verdict is per case rather than a rule: bare `Joe` loses to `Joe Pagliani` while `Julian Vargas`
loses to `Julian`.

Evidence is thin, and the count depends on where attestation is read: 9 of the 9 zero-attestation gold
keys in Richard have a live shorter form against the chat, 8 of 11 against the entries' own text.
Either way zero attestation reads as a form-error signal rather than a frontier signal there. One book.
Both worth re-testing against the public books, which need no chat.

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

The expander's output shape follows: a seed plus its forms, each tagged with its collision
measurement. Rendering as literal, whole-word, SmartKey or a mix is a downstream formatting pass, and
that pass is where portability policy is applied rather than baked in.

**Measure against the text runtime actually searches.** Entries can opt into scanning the persona
description, character description, personality, depth prompt, scenario or creator notes, so when a flag
is set that text joins the search text — and a rate computed over it correctly reports "fires always",
which is how you discover an entry that wanted `constant`. Hidden messages (`is_system`) are not in the
prompt, so no key can fire on them; they stay evidence for realizability, which asks a different
question of the same file.

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
- **`generated()` (`keyword-core.mjs:298`) tests field *presence*** — `stmemorybooks`, `STMB_start`,
  `stmbArc` — and is used only in `defChecked` (`:300`), the pre-tick state in the prune popup. It does
  not affect scanning; scope is `inScope` (`:109-113`), which knows nothing about STMB. Since
  `severityOf` returns `''` for `unattested`, that clause is the only route by which a dead key arrives
  pre-ticked, so a miss costs manual ticking and nothing else.
- **`is_system` means hidden from the prompt, not "not story"** — the messages are ordinary narrative
  prose, and a chat can be mostly them. Filtering them as noise silently discards most of a chat.
- **Chat header identity fields are deprecated** — newer files write a literal `"unused"`. The
  per-message `name` on `is_user` turns is authoritative in both formats.
- **`matchPersonaDescription` and its siblings join that text to the search text** when set. Nothing on
  disk sets one, which is why nothing handles them yet.

## Populations

**Reference entries in general match the chat less than memory entries do, and the reason is
structural.** A memory entry is derived from the chat — a summarizer read those messages and wrote it —
so it shares vocabulary by construction. A reference entry is authored independently, usually before
the chat exists, in an expository register the chat never uses. Overlap there is incidental rather than
guaranteed.

Measured on the pair that isolates it — `grounded omegaverse` against `Sommers_Pack__v22`'s memory
entries, same story and chat: bge-m3 cosine of entry text to chat messages 0.53 against 0.62, share of
Zipf-admitted terms recurring three or more times 9% against 18%. Foxbridge, Albion and Gladiator fall
in the same band. Counting presence rather than recurrence, or comparing chats of different lengths,
reverses it.

**They are not a distinct class for keying.** Checked against Foxbridge (human-curated, reference-only)
and Sommers' reference minority: characters, concepts and places are all keyed the same way — the
subject's canonical name, its morphological variants, and the common noun people say instead of it.

    necromancy                  necromancy, necromancer, demiurge, medium
    Arnold Atkins               Arnold, Atkins, sherriff, police, cop
    Miss Roberta's Boarding House   boarding house, Miss Roberta, guest rooms

Same shape three times, and the key counts of the two populations overlap completely — Foxbridge runs
0–10 end to end, and both extremes are characters and concepts respectively (`Max's Parents` 10,
`witch levels` 8), so neither class brackets the other.

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

The 40 books on disk are 25 book lines — versions of one book match on entry titles, not on entry
text, since re-summarizing rewrites every entry and keeps the scene list. Every book over 100 entries
is 85–93% STMemoryBooks entries, so reference entries are a 7–15% minority living *inside* memory
books; but those 12 books are 3 stories, 9 of them snapshots of one, so this has the same n as the
rates below and not the corpus's. Any memory/reference branch must therefore be per entry, as the
pruner's `generated()` split already is. Book size does not identify a population: pure-reference
books here run 0–75 entries, and the three public ones run 106–261.

**That figure is a `generated()` count, and `generated()` under-detects**, because offline editing —
dropping a lorebook into a model chat to clean it up, which anyone invested enough to run STMB will
eventually do — strips the metadata. Books that have been through that carry scene summaries with no
STMB fields at all, and they read as reference.

The fallback is self-calibrating and needs no format assumption: read the numbering pattern off the
book's *own* tagged entries, and treat an untagged entry as generated if its title continues the series.
STMB's serial-number prefix is a default that can be toggled off, and where it is off there is no series
to continue, so the heuristic degrades to silence rather than to a wrong answer. Requiring
*continuation* rather than merely *looking numbered* biases it toward misses, which is the right
direction: a false positive pre-ticks the deliberate aliases on a hand-written entry, a false negative
costs a few clicks. Gaps in the merged series are deleted entries, free.

**Do not compare key counts across populations.** Reference entries carry far fewer keys than memory
entries, but that is who *wrote* the keys, not what the entries are — memory keys are LLM-generated,
reference keys usually hand-written, and the same split appears *within* a single book. Genuine
entry-type differences are the ones that survive regardless of key authorship: register,
`entryText ⊂ chatText` for memory and possibly disjoint for reference, titles that name the subject
versus editorial labels, source spans existing at all, and sibling density.

**The player persona is never a key.** ST injects the Persona Description every turn, so the persona
has no lorebook entry — but its name still turns up as a candidate on episodic entries (`Alex Nichols`
was removed by hand from Richard; `Richard Ryder` went too, but that is the character, and it belongs
with the ubiquity bracket below). Hard exclusion, no threshold: collect the
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

**An unkeyed entry is not a negative example**, and the causes are mechanically separable:

- **`constant`** — always injected, so keys are inert. Authoring scaffolding and arcs. Out of scope for
  suggestion, and adding keys here buys nothing measurable.
- **`vectorized`** — activates by embedding. That keys help anyway is **asserted, not measured**, and
  the two routes are not interchangeable: `suppressVectorKeys: false` lets core activate on the keys and
  so can add an entry nothing else reaches, while `scoreVectorKeys` only re-ranks candidates already
  retrieved — and is dead whenever the first is off. **These are the suggestion targets.**
- **neither** — cannot activate at all. A **free diagnostic with no false positives**, and the Studio
  should say so. Rare in practice, so oversights are not a meaningful ceiling on the superset standard.

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

**549 labelled negatives** come with it, recovered from the pre-edit book preserved inside the
`richard-syn-*` grade bundles. Three cautions on consuming them. They are **(entry, key) pairs, not bad
strings** — the same term is a negative on one entry and a positive on nine others, because the
judgement is about the entry. Some are **form corrections rather than rejections** (`TMZ leak` → `TMZ`),
and separating those from true rejections has not been attempted. And the keys on the one deleted entry
are excluded and unlabelled.

Anything a suggester proposes that is in neither set is unjudged, so this measures superset recall and
known-junk precision, not precision generally. And **provenance decays**: a key vetted before these
definitions existed was vetted against a different standard, so "already approved" is not a shortcut
for the anchor pass.

Foxbridge carries **six chat lineages** with no shared prefixes — but continuation, separate story and
ephemeral repeat all look alike from a zero-length prefix, so that is not the same as independence.
Only the **lorebook binding** distinguishes same-story from separate-story, and it has three sources:
`chat_metadata.world_info` per chat, the character card, and — rarely —
`settings.json` → `world_info_settings.world_info.charLore`.

### Numbers so far, and what they are worth

**The activation ceiling, bracketed.** Whole-word rates over assistant turns, personas excluded,
against your own verdicts: Dylan 21.8% kept ("grew, never crested"), Arthur 35.1% undecided (still
being tagged), Liam 53.4% crossed ("good until he wasn't"), Richard 94.5% long gone. Giselle 18.3% kept
on eight entries. The most informative point is Arthur, because the threshold sits where a human cannot
call it either. Gold positives in Richard top out at **10.9% of all messages** with p99 at 4.6% and a
median of 0.1%, so nothing human-approved lives high in the range.

**This is n=1 curator.** The genre spread is wide, which controls vocabulary and entry structure, but
only a handful of books carry memory entries and the bracket came from two of them. ST mechanics
travel; rates do not, until shown otherwise. The public books are the available control for form-level
findings — none has a chat, so activation cannot be checked against them at all.

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

**Closed.** *Does a drift table need to exist* — no. Table membership is the unigram cut, and every
lexicalised plural's base noun is in `ZIPF_EN`, so the plural can only come from a seed the gate already
killed. Coinages are unaffected. Propriolization is untouched by this and stays unhandled.

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
- **Span masking** — not replaced; the problem it solved does not arise under a count test.
- **Embedding drift detection** — reads surface overlap rather than meaning.
- **Breadth by co-occurrence** — the Zipf gate is the proxy instead.

## Related

`.claude/agents/entry-vocabulary.md` is a first attempt at the LLM half, committed as a revert point
rather than a settled design — at ~190 lines it is over-engineered for the task, and its entry-kind
branch prose predates the scope boundary above. Its texture/skip machinery is superseded by "an entry
with neither axis yields few or no seeds", and it should shrink to the referring-expression question,
an instruction to emit base forms, the no-frequency-judgement rule, and the output shape. Ask the model
for terms and let the expander dedupe redundant forms mechanically, rather than asking it to reason
about which forms English morphology will already reach — that is the instruction a small model will
half-follow.
