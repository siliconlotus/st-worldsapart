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

## Two subcomponents

1. **Seeder** — identify the seeds: the terms that denote the entry.
2. **Expander** — produce each seed's variants (morphological and synonymous).

Realizability is carried entirely by the seed, so the expander never has to estimate whether anyone
will type a term; it only has to be right about morphology and sense, both of which have high
inter-annotator agreement. That makes the expander specifiable and measurable **while the seeder's
definition is still open**, which is the reason for the split.

Synonym expansion is the only piece with no local fallback: statistical seeding exists today,
morphological expansion is rule-work, but synonymy in the entry's sense needs world knowledge. That is
where an LLM is load-bearing rather than merely better.

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

Character sheets are a third class, not a kind of reference entry: near-zero lexical overlap with the
chat, pure generation context, semantics closer to "constant when present or referred to". Their keys
degenerate to a name plus nicknames, and they are heading toward a sticky flag with different rules.

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

1. **Seeder definition** — what makes a good seed. The whole definitional problem now lives here.
2. **Expansion correctness** — the morphological closure rule, and what "synonym" means when it must
   be synonymy *in this entry's sense*. Writable now; does not block on the seeder.
3. **"Little else" as a degree.** The reading is settled; how the degree gets measured is not.

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
   nothing about it either way.

## Related

`.claude/agents/entry-vocabulary.md` is a first attempt at the LLM half, committed as a revert point
rather than a settled design — at ~190 lines it is over-engineered for the task, and its entry-kind
branch prose predates the scope boundary above.
