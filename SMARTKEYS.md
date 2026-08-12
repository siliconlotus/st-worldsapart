# SmartKeys, and how WorldsApart matches keys

A World Info key in WA can be one of three things:

| Form | Example | What it is |
|---|---|---|
| plain | `moon mission` | substring match, the SillyTavern default |
| regex | `/co(l|s)monaut/i` | a regular expression, as core already supports |
| **SmartKey** | `? moon mission -apollo` | a boolean expression — a leading `?` opts in |

A regex is not only a whole-key form: `/…/` is also a **term** inside a SmartKey, so
`? /co(l|s)monaut/ landed` mixes a pattern and a word in one key.

The first half of this page is the SmartKeys grammar. The second half is how matching works for *all
three*, which is worth reading even if you never write a `?` key.

## What a SmartKey does today

**SmartKeys activate.** On a generation WA runs, WA answers "did a key match" for every entry, so a `?`
key pulls its entry into the prompt exactly as a plain key does. It also sets:

- the **order** entries appear in,
- the **score** WA reports in `/wa-debug` and the WI panel,
- everything in the **Keyword Studio** — colouring, the audit, the pruner.

Two consequences worth knowing. Matching uses **WA's** scan depth, not core's *Scan Depth* — a
per-entry Scan Depth still overrides both. And SillyTavern's own dry runs (prompt token counts, chat
load) are not WA generations, so they keep core's matcher, where a `?` key never matches.

That inertness is the portability story: a book full of SmartKeys still loads in a stock SillyTavern,
where the keys simply never fire rather than breaking anything.

---

# The grammar

```
? moon mission -apollo            implicit AND; a leading - negates
? "moon mission" OR cosmonaut     quoted phrase; AND / OR / NOT / XOR
? =cat                            = whole word
? ^NASA                           ^ case-sensitive
? ^=NASA                          flags combine, in either order
? fire::2.5                       ::N weights the term
? fire^2.5                        ^N is accepted too (Lucene's boost)
? (rain OR snow) -indoors         parentheses group
? /co(l|s)monaut/i landed         /pattern/flags is a term
```

**Terms.** Anything that is not an operator or a paren. A term is matched exactly as a plain key would
be — substring by default — so `? fir` finds `confirm`.

**Operators.** `AND` `OR` `NOT` `XOR` as words (any case), or `&&` `&` `+` / `||` `|` / `!` `-` as
symbols. Adjacent terms get an implicit `AND`, so `? moon mission` requires both.

`-` `!` `+` are operators only at the *start* of a token, which is why `sci-fi` and `c++` are single
terms and need no escaping.

`+` in Lucene's per-term position (`? +fire +water`) is absorbed: it means "required", which is what
the implicit AND already says.

## The same SmartKey, spelled out

Every row below is one SmartKey written three ways. They parse identically and score identically — the
short forms are shorthand, not a different feature.

| shorthand | | spelled out |
|---|---|---|
| `? moon mission` | = | `? moon AND mission` |
| `? moon mission -apollo` | = | `? moon AND mission AND NOT apollo` |
| `? +fire +water` | = | `? fire AND water` &nbsp;=&nbsp; `? fire water` |
| `? rain \| snow` | = | `? rain OR snow` &nbsp;=&nbsp; `? rain \|\| snow` |
| `? fire && !water` | = | `? fire AND NOT water` &nbsp;=&nbsp; `? fire -water` |
| `? fire^2` | = | `? fire::2` |
| `apollo mission` *(a plain key)* | = | `? "apollo mission"` |

If a SmartKey is hard to read, the spelled-out form is always available and always means the same thing.
The two places where a rewrite *does* change the SmartKey are quoting across a space (`hot tub` vs
`"hot tub"`) and regrouping with parens.

**Precedence:** `(...)` before `NOT` before `AND` before `OR`/`XOR`. When in doubt, use parens.

**Flags** are prefixes on a single term:

- `=` whole word — `? =cat` will not match `catalogue`.
- `^` case-sensitive — `? ^NASA` will not match `nasa`.

Flags apply per term, and a SmartKey **ignores the entry's own** *Case-Sensitive* and *Match Whole
Words* checkboxes. A `?` key says what it wants, term by term.

**Weights** are a postfix: `term::2`, `term::0.5`, or the Lucene spelling `term^2`. A term contributes
`weight × occurrences` to the key's score. Weight `0` is legal and means "must be present, but do not
rank on it".

`::` and not `:`, so a single colon stays ordinary text — `? meeting 10:30`, `? Judges 3:16`, `? re:code`
and URLs all work as written. A delimiter followed by anything but digits is part of the term
(`fire::abc` is one term).

## A regex can be one term

`/pattern/flags` inside a SmartKey is a term like any other, so a pattern can sit beside a word, be
negated, and carry a weight:

```
? /co(l|s)monaut/ landed        a pattern AND a word
? -/drill/ fire                 a negated pattern
? /fire/::3                     weighted, like any term
```

The rules are the ones the rest of the grammar already follows:

- **A `/` opens a pattern only at the start of a token**, as `"` and `-` do. `and/or` and `3/4` are
  ordinary terms.
- **The pattern ends at the first unescaped `/` outside a character class.** `\/` writes a literal
  slash, and `/[/]/` is a class holding one. Two patterns in one key stay two.
- **Flags come after the close, then the weight**: `/fire/gi::2`, the same order a quoted term uses.
- **`=` and `^` are not available here.** `=` means nothing to a pattern, and `^` would be a no-op —
  a regex is already case-sensitive. Write `/i` for insensitivity.
- **A pattern is not folded.** Curly quotes, dashes and NFC are normalised for plain terms and left
  alone for a pattern, exactly as for a whole-key regex — so `? /Cap'n/ crunch` has one term that sees
  `’` and one that does not.
- **`^` and `$` anchor within the Match window**, not the whole scan. At the default (paragraph) they
  anchor per paragraph; at *Whole scan window* a bare `^` anchors to exactly one position in the entire
  window. `/m` behaves the same at every setting, which is usually what you want.

To search for the literal characters, quote the term: `? "/re/"`.

**Scoring.** A term scores `weight × occurrences`. `AND` and `OR` both **sum** — `? (glasses OR
spectacles)` counts every mention of the concept however it was spelled — and a branch that did not
match contributes nothing. `XOR` takes the winning side. A key built only from negation scores 1 when
it matches, since there is nothing to count.

## Quoting is the one escape

Quoting turns off operator, weight and paren interpretation, and marks punctuation as deliberate:
Sigur Rós's `"()"` is a real album title.

**Quoting a single term never changes what it matches.** `"fire"` and `fire` are identical, and flags
and weights still compose (`? ="fire"::2`). So there is no cost to quoting when unsure.

The one exception is quoting **across a space**, which is a different SmartKey rather than a safer one:

```
? hot tub       two terms, implicit AND — matches a hot bath beside a cold tub
? "hot tub"     one phrase — the words adjacent, in that order
```

A phrase is matched as written, including its single space: `"hot tub"` does not match `hot  tub`.

**A plain multi-word key is already a quoted phrase.** The ordinary key `apollo mission` means exactly
`? "apollo mission"` — one literal string, space included. So the quoted form is the familiar
behaviour, and the *unquoted* SmartKey is the one doing something new.

Against the message **"The astronauts of the Apollo mission"**:

```
apollo astronauts        plain key    NO MATCH — that exact string never appears
? "apollo astronauts"    identical    NO MATCH
? apollo astronauts      SmartKey     MATCHES  — two terms, either order, anywhere in the window
```

The plain key wants the words adjacent and in that order. The unquoted SmartKey wants both words
present, and does not care that the message separated them or wrote them the other way round.

That equivalence is between the two *keys*, not between the two entries: neither checkbox reaches
inside a SmartKey. With *Match Whole Words* ticked the plain key `apollo astronauts` checks boundaries
and `? "apollo astronauts"` still does not, so the matching spelling is `? ="apollo astronauts"`.
*Case-Sensitive* works the same way, and its spelling is `? ^"apollo astronauts"`.

**Which form to reach for.** If you want the literal string, use a plain key. That is what it is for, and
it takes any character without ceremony — `6" pipe` is a plain key, quote and all. Reach for a SmartKey
when you want the two things a literal cannot give you: **order invariance**, and **tolerance of words in
between**. `? 6" copper pipe` fires on *"that copper pipe is 6" in diameter"*, where the plain key
`6" copper pipe` does not.

## What the Studio will tell you

Saving a `?` key runs a structural check. It reads the SmartKey's shape only — never a guess at what you
meant, because every check that guessed produced false positives on real titles.

| | |
|---|---|
| **error** | no search terms at all |
| **error** | every term negated — that matches whenever they are absent, which is nearly always |
| **error** | an unclosed quote |
| **error** | a `/pattern/` with no closing `/` |
| **error** | a `/pattern/` JavaScript cannot compile |
| **warn** | a punctuation-only term (usually a second `?`: only the first one is the sentinel) |
| **warn** | unbalanced parens — it still parses, but probably not the way you grouped it |
| **warn** | every term weighted 0, so the key gates without scoring |

Whether a term ever actually occurs in your book is a different question, and the audit answers it.

---

# How matching works

This half applies to plain keys and SmartKey terms alike.

**Substring by default.** `fir` matches `confirm`. Whole-word matching is opt-in — the entry's *Match
Whole Words* checkbox for a plain key, the `=` flag for a SmartKey term.

**The checkbox reaches every key, including multi-word ones.** SillyTavern core skips any key with a
space in it, so its own checkbox is silently a no-op there and `hot tub` goes on matching `hot tubs`.
WA applies the label as written: with the box ticked, `hot tub` matches *hot tub* and not *hot tubs*.
The `=` flag behaves identically, so `? ="hot tub"` and the plain key now agree. If you want the
plural too, key it — or leave the box off, which is the default.

**What counts as *inside* a word is the Word boundary setting**, in the WA panel, because both
readings of "word" are defensible:

| | inside a word | so `Joe` matches |
|---|---|---|
| **Strict** (default) | letters, digits, marks, `-` `'` | *Joe*, not *Joe's* or *Joe-adjacent* |
| **Permissive** | letters, digits, marks | *Joe*, *Joe's* and *Joe-adjacent* |

Neither matches *Joel* — a letter alongside always blocks. `_` is a boundary in both, so `_Joe_`
matches: underscore is a word character for programming identifiers, not for prose, and presets that
ask for underscore emphasis wrap whole words with it exactly as asterisks do.

Strict is the default because it is the cheap one to leave: a `/regex/` key written with `\b` gets
permissive behaviour back for that one key, and there is no equally short way to go the other
direction. (`\b` is ASCII-only, in WA as in SillyTavern.)

**Known limit — scripts without word boundaries.** Whole-word matching needs boundaries, and Chinese,
Japanese, Thai, Lao, Khmer and Burmese do not write them. A key like `猫` still fires where it appears
among Latin text or punctuation — a sign name or a tattoo inside an English sentence, or beside `・`
`、` `。` — but it misses the key wherever it sits between two characters of running text. Leave the
box off for entries keyed in these scripts; SillyTavern advises the same, and the Studio marks the
whole-words control on any entry where this applies.

**Case-insensitive by default**, opt out with the entry checkbox or `^`.

**Orthography is normalised on both sides.** These are the same character in a different encoding, and
nobody means anything different by them:

| written | matches |
|---|---|
| `'` `’` `‘` `‚` `‛` `ʼ` `ʹ` `′` `´` `` ` `` `‹` `›` | each other |
| `"` `“` `”` `„` `‟` `″` `ʺ` `«` `»` | each other |
| `—` (em dash) | `--` |
| `–` (en dash) | `-` |
| `…` | `...` |
| non-breaking space | ordinary space |
| decomposed `José` | composed `José` (NFC) |

This is why a key typed `Cap'n Joe` fires against prose written `Cap’n Joe` — which it would not in
stock SillyTavern. Em and en dashes deliberately do **not** collapse together: one separates clauses,
the other joins.

Nothing that can *carry meaning* is folded. A fold applies to the text being scanned, so it erases a
distinction for every key at once and no flag can ask for it back. Case is the one exception, and only
because `^` exists to opt out. That is also why the CJK brackets `《》` and `「」` are **not** in the
table above: they are not a typeset `"`, they split the job of one — `《》` for titles, `「」` for
speech — so folding them would throw a distinction away rather than recover one.

**Hyphens are literal, in both directions.** `sci-fi` does not match `sci fi`, and `sci fi` does not
match `sci-fi`. Prose picks per phrase, so if a compound is written both ways in your chats, key both
(`? sci-fi OR "sci fi"`).

**Accents are literal.** `Gerard` does not match `Gérard`. Whether stripping an accent is safe depends
on the language — `du` and `dû` are different French words — so it is a judgement for you, not for a
silent matcher. Key both forms when your model writes both.

**No wildcards, no fuzzy matching.** `*` and `~` are ordinary characters: `M*A*S*H` matches `M*A*S*H`.
Substring matching already covers what a leading or trailing `*` would buy you. For anything more, write
a `/regex/` — as the whole key, or as one term inside a SmartKey.

**Word boundaries are Unicode-aware.** A "word character" here is any letter, digit or underscore in
any script, so whole-word `caf` does not match `café` and `Мари` does not match `Марию`. In scripts
written without spaces (CJK) there is no boundary to find, and a whole-word key will match only in
isolation — leave whole-word off for those.

**Regex keys are matched raw.** A `/pattern/` key sees the text unfolded, so `/Cap'n/` will *not* find
`Cap’n`. Write the alternation, or the class, yourself. A regex also ignores the entry's checkboxes —
it is case-sensitive unless you write `/i`, and *Match Whole Words* means nothing to it. Like a
SmartKey, a regex key says what it wants and the entry does not override it.

**Known limit — Markdown.** Chat prose is Markdown and the markup sits in the text being scanned, so
emphasis *inside* a word cuts both ways:

```
"*sister*hood"    sisterhood         MISSES  — the asterisks break the substring
"*sister*hood"    sister (=/whole)   MATCHES — the * reads as a word boundary
```

Emphasis around a whole word is fine in every mode; this only bites mid-word. Every available fix is
worse than the bug — making `*` a word character breaks the case that currently works, and stripping
markup would destroy the asterisk as content.

---

# Coming from Lucene

Carried over, so muscle memory works: `AND` `OR` `NOT` `+` `-` `&&` `||` `!`, parentheses, quoted
phrases, and `^N` boost (aliased onto `::N`).

Not implemented, and matched literally instead: wildcards `*` `?`, fuzzy and proximity `~`, field
syntax `field:value`, and ranges. A key that expected one of these will simply never fire, and the
Studio's audit reports it as a dead key — from the evidence, rather than from a guess about what you
meant.

`XOR` and `::` weights are not Lucene at all. `::` is Midjourney's multi-prompt weight, borrowed
because it cannot collide with a time or a ratio.
