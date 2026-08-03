# Matcher and activation — decisions and open work

Companion to `keyword-suggest-design.md`, which owns the *suggester*. This owns the *matcher*: how a
key is matched, the SmartKeys grammar, and the plan for WA taking over activation.

Rules and open items only. The arguments that produced them are in the commit messages and the module
headers; do not restate them here.

---

## Principles

These decided most of the individual calls below, and are worth applying before re-deriving anything.

**The haystack is where distinctions die.** A fold applied to the scan text erases a distinction for
every key at once, and no flag can ask for it back. So the fold carries *orthography only* — the same
character in a different encoding, which nobody means anything different by. Anything that can carry
meaning (hyphen vs space, case, accents) belongs on the key side or not at all. Case gets away with
being in the fold only because `^` exists to opt out.

**Correctness that depends on knowing the language belongs in the reviewed layer.** The matcher is
silent, so it must be language-neutral. The suggester is reviewed by a human before anything is
accepted, so it is where a judgement like "is stripping this accent safe" can live. Hyphens pass that
test (a compound is a compound in any language that hyphenates); accents do not (`du`/`dû`).

**Quoting is the single escape.** It suppresses operator, weight, paren and wildcard interpretation and
marks a punctuation-only term as deliberate. One rule to learn, not four. Quoting a single term never
changes what it matches; quoting *across a space* does, turning a conjunction into a phrase.

**Validator checks read structure, not intent.** Every check that guessed at what an author meant
produced false positives on legitimate literals — `"()"` is a real album, `M*A*S*H` is a real title.
The checks that survive are facts about the query: no terms, no positive term, an unclosed quote,
unbalanced parens. A key that expected a feature WA lacks is dead, and the audit reports it as dead
from the evidence.

**Divergence from core is free where WA owns activation, and costly where core owns it.** While core
activates, every matcher difference makes the Studio's audit report on rules that are not what fires.

---

## Status

**Bucket 1 — matcher and SmartKeys: done except the docs.** Parser bugs, the `::` weight delimiter,
the validator, the Studio save gate, the audit change, `weight × count` scoring, the Lucene aliases.

**Remaining in bucket 1:** `SMARTKEYS.md` does not exist. It needs both halves — the grammar, and the
matching behaviour that has no user-facing home anywhere: substring by default, hyphens literal in both
directions, what the fold normalises, Unicode word boundaries, and the Lucene delta.

**Bucket 2 — WA owns activation: not started.** All the design questions below are settled; it is
implementation.

---

## Bucket 2 — the plan

Core keeps the gates, the timers, recursion control and prompt assembly. WA replaces exactly one
question: *did a key match*.

**The seam.** `getExternallyActivated` is checked inside core's scan loop, after `@@dont_activate` and
before constant/sticky/key-matching. Every other gate — disable, triggers, character and tag filters,
delay, cooldown, `delayUntilRecursion`, `excludeRecursion`, decorators — runs *before* it, so
force-activation inherits all of them rather than bypassing them. `WORLDINFO_FORCE_ACTIVATE` is the
supported way in, and WA already emits it for vector winners.

**Recursion is solved, not blocked.** `WORLDINFO_SCAN_DONE` fires after *each* scan loop, not once at
the end. Its args carry `activated.text` (the accumulated recursion buffer) and a **writable**
`state.next` that core reads back immediately. So WA evaluates against chat + recursion text, emits
`WORLDINFO_FORCE_ACTIVATE` for anything newly matched, and sets `state.next` to run another pass. Two
things to get right: only request another pass when something was genuinely newly activated, or WA and
core trade passes forever; and do not evaluate entries core will reject this pass, or the
"newly matched" test never settles.

**`keysecondary` needs no separate implementation.** `(key, keysecondary, selectiveLogic)` maps onto a
SmartKey expression — verified against core's own evaluation over 16,000 random comparisons, all four
logic modes. Distribute rather than collapse: **one SmartKey per primary key**, each `primary +
<secondary expression>`, so scoring keeps the per-key granularity that `keywordScore`'s saturation
wants. `AND_ANY` → `(secondaries)`, `AND_ALL` → juxtaposition, `NOT_ANY` → `-a -b`, `NOT_ALL` → `-(a b)`.

**Guard the empty-primary case explicitly.** Core skips an entry with no primary keys *before* reading
its secondaries. Synthesised from an empty `key`, the expression is just the secondary condition, and
`NOT_ANY` over it fires on almost every scan. That guard must be written, not left to fall out.

**Mirror `coreChat`'s window.** WA's `scanWindow` takes raw `x.mes`; core's buffer is built from
`coreChat`, which applies `getRegexedString` per message and `appendFileContent`, adds titles and media,
and pops the last message on a swipe. Under bucket 2 WA's window *becomes* what fires, so the
difference stops being a scoring nuance and becomes a correctness requirement.

**Then the key-side variant expansion** that bucket 1 deferred, since it is only safe once WA's rules
are what fires: hyphen ↔ space (compounds are written both ways, and prose picks per term, not per
book), and wildcards if they ever earn it. Quoting suppresses generation.

**`C17` dissolves here** rather than being fixed. The matcher already diverges from core on
orthography, NFC and Unicode word boundaries; while core activates, that means the audit reports on
rules that are not what fires. Once WA activates, WA's rules *are* what fires.

---

## Elsewhere

**Suggester i18n, none of it started.** `ZIPF_EN` scores non-English function words as maximally rare
(`avec`, `toujours`, `siempre`, `porque`, `immer` all absent → z=0), so the gate designed to reject
common words would propose them as prime keys; a few are present with meaningless values (`der` 3.6,
`war` 5.2 as the English noun), which is worse than absent. `stems()` knows English inflections only,
so `tblZ`'s fallback cannot rescue them. Same blindness hits hyphenated compounds — `well-known` is
absent from the table and scores maximally rare.

**The suggester should know when its priors do not apply.** If a large share of an entry's tokens are
absent from `ZIPF_EN`, the book is probably not English and the frequency gate should stand down and
say so rather than invert.

**Accent variants belong here, not in the matcher** — `Gérard`/`Gerard` is a real miss (the model
writes both, and in one corpus the unaccented form more often), but whether stripping is safe depends
on the language, so it wants a human in the loop. Suggest the stripped form as a candidate key.

---

## Standing caveats

- **`plugin/` changes need `node deploy-plugin.mjs` and an ST restart.** The fold lives in
  `plugin/automaton.mjs`, so orthography and NFC are not live on the server half until then.
- **`eq()` in `eval/metrics.mjs` prints `FAIL` but exits 0.** Checking the suite by exit code alone
  misses assertion failures. Grep for `^FAIL`.
- **`sort.mjs` is now genuinely ST-free** and node-importable; it was not, and CLAUDE.md said it was.
- **Nothing here has been verified in a browser** beyond what was tested by hand during the session.
