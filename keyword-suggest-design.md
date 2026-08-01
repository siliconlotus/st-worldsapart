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

Realizability is carried entirely by the seed, so the expander never has to estimate whether anyone
will type a term; it only has to be right about morphology and sense, both of which have high
inter-annotator agreement. That is why the expander could be specified and measured while the seeder's
definition was still open, and it is the reason for the split.

Synonym expansion is the only piece with no local fallback: statistical seeding exists today,
morphological expansion is rule-work, but synonymy in the entry's sense needs world knowledge. That is
where an LLM is load-bearing rather than merely better.

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

A memory entry needs its own source span masked (`STMB_start`/`STMB_end`), or the messages it
summarizes supply the evidence and every piece of scene furniture passes. A reference entry has no
source span, so plain whole-chat occurrence is already clean. One instrument, one of them with a hole
punched in it.

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

## Code facts established while working this out

- The Aho-Corasick trie is flag-blind: it always yields the folded substring count, and exact is
  computed afterward only where the flags demand it — **on the primed path**. Unprimed *and* whole-word
  goes straight to a lookaround regex (`ranking.mjs:324`) that produces no substring count at all.
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

## Populations

**Reference entries in general match the chat less than memory entries do, and the reason is
structural.** A memory entry is derived from the chat — a summarizer read those messages and wrote it —
so it shares vocabulary by construction. A reference entry is authored independently, usually before
the chat exists, in an expository register the chat never uses. Overlap there is incidental rather than
guaranteed.

Character sheets are the far end of that gradient rather than a separate phenomenon: historical,
psychological and dispositional content, describing how someone tends to behave rather than naming
things anyone says out loud. Almost nothing in the body gets typed, and the name is the only reliable
hook — which is why their keys degenerate to a name plus nicknames. They stay a distinct class for a
different reason, semantics closer to "constant when present or referred to", and are heading toward a
sticky flag with different rules.

A consequence for seeding: for a reference entry the **title is a first-class seed source**, because a
reference title names its subject (Foxbridge: "witch levels", "thaumaturgy", "scrying"). A memory
entry's title is a generated editorial label — "003 - Post-Rut Domesticity" — which describes rather
than names, and is correspondingly weaker.

Asserted, not measured.

Across 39 books on disk, every book over 100 entries is 85–96% STMemoryBooks entries, so reference
entries are a 5–15% minority living *inside* memory books. Any memory/reference branch must therefore
be per entry, as the pruner's `generated()` split already is. Pure-reference books are small (10–75
entries), and median key counts differ by population (reference 1–9, memory 10–30).

## The books are not an eval set

The lorebooks on disk are a blend of human curation and weaker-LLM generation whose mixture varies per
book, so agreement with their keys is not a score. Nothing may use them as a denominator until anchor
provenance (below) establishes which subset is trustworthy.

**No measurements are recorded in this document.** Anything attempted before the definitions above
existed was scored against that denominator, and the measurement is itself what is being designed
here. Numbers start once the open items below are closed.

## Open

Blocking the definition:

1. **Expansion correctness** — the morphological closure rule, and what "synonym" means when it must
   be synonymy *in this entry's sense*. Next up; blocks on nothing.
2. **"Little else" as a degree.** The reading is settled; how the degree gets measured is not.
3. **Renderer backoff thresholds** — how much collision disqualifies a stem, and how short a shared
   substring is too short to use. Mechanical once stated; unstated so far.

Blocking measurement:

4. **Anchor provenance** — where known-good seeds come from, and how thin the vetting pass can be.
5. **LLM-as-proxy validation** — model-generated keys must clear the trusted hand-curated books before
   standing in for human keys anywhere else.
6. **Harness priming** — see the code facts above.

Accepted as follow-on:

7. **SmartKeys emission.** Portability policy is a judgement call, and the quality gates exempt `?`
   keys entirely (`keyword-core.mjs:211`), so they would enter precisely where nothing can see them.
8. **`countKey` signature change.**
9. **The surviving hypothesis**: reference entries may be reachable by lexical-statistical means on the
   entry plus a chat backstop, while memory entries need more. Untested — and the flat probes above say
   nothing about it either way. The Populations note cuts against it in one direction and for it in
   another: if reference bodies overlap the chat least, the backstop supplies least exactly there — but
   a reference entry's subject is usually sitting in its title, so the seed may not need the body at all.

## Related

`.claude/agents/entry-vocabulary.md` is a first attempt at the LLM half, committed as a revert point
rather than a settled design — at ~190 lines it is over-engineered for the task, and its entry-kind
branch prose predates the scope boundary above.
