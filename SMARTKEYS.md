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

**Weights** are a postfix: `term::2`, `term::0.5`, or the Lucene spelling `term^2`. A term's
`weight × occurrences` is what its **thing** is counted by, and the weight then multiplies what that
thing is worth.

Weight `0` is legal and means "must be present, but do not rank on it" — a condition rather than
evidence. Put another way: the conjunct does not make the key worth more than the bare term. It earns
its keep as a **disambiguator**: `? mercury AND planet::0` needs the word *planet* nearby, so the
entry does not fire on the element or the god, and still scores exactly what `? mercury` alone would.
Without the `::0` the qualifier counts as a second thing the passage is about, so a page mentioning
both outranks a page that is actually about mercury.

It is also how a **secondary** key opts out of scoring. Secondary keys score like any other term, so
`? planet::0` in the secondary box gates without contributing anything of its own.

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
- **A `/…/` term reads exactly as the same string reads as a whole key.** `? /home/user/lux/` is the
  pattern `home/user/lux`, and `? /home/user/file` is the literal text, because that is what each of
  them is without the `?`. Two patterns in one key stay two: `? /a/ /b/` is two terms.
- **A slash inside the pattern is fine.** WA runs `/(home/user|~/user)/file/` as the pattern it looks
  like, whole key or term. See the portability note below if the book will travel.
- **A term that follows a pattern needs a space.** `? /[/]/ x`, not `? /[/]/x`. If you wanted the two
  adjacent, put them in the pattern: `? /\/x/`.
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

### Porting a pattern to a non-WA SillyTavern

If you write a regex containing unescaped slashes and plan to port it to a non-WA system, you must
escape the slashes for vanilla SillyTavern to evaluate it. Its matcher refuses any pattern with an
unescaped `/` inside — the reason given in its source is portability to other regex engines — and
looks for the whole delimited string as literal text instead, so the pattern never runs there.

```
/(home/user|~/user)/file/         WA: pattern.   vanilla ST: the literal 25 characters.
/(home\/user|~\/user)\/file/      both: pattern. Identical matches; `\/` is just `/` to a regex.
```

Escaping costs nothing under WA — `\/` and `/` are the same character to a pattern — so a book that
may be shared is worth writing the escaped way. The Studio warns on any key in the first row's shape,
and says nothing about the second. This applies to a bare `/regex/` key and to a `/…/` term alike.

**Scoring.** A key's score is the sum over the things it is **about**. `AND` joins two different
things, so each is scored separately and the scores add: `? moon AND rocket` is worth two. `OR` names
one thing more than one way, so its mentions pool and count as one thing seen more often — `? (glasses
OR spectacles)` counts every mention of the concept however it was spelled, and scores exactly what the
bare key `glasses` would on the same number of mentions. `XOR` takes the winning side. A branch that
did not match contributes nothing, and neither does a negation: `? fire -water` is one thing, not two.

**What one thing is worth.** Being present at all is worth its weight. Further mentions add less and
less — the second is worth much more than the tenth — and the total keeps climbing without ever
running away. A key present once scores 1; one mentioned ten times scores about 3, not 10.

**Weight multiplies the thing, not the mentions.** `? (everest OR kailash::2)` scores 1 on a page about
Everest and 2 on a page about Kailash: `::2` means twice as important, not "as if mentioned twice".

A key built **only** from negation — `? -water`, with no positive term — is refused as a key of its
own. It would match nearly every message, which is not a trigger; the validator calls it an error and
the matcher drops it before scoring. It is legal in exactly one place, as a **secondary** key, where
the primary decides activation and a negation can only narrow what the primary already matched — see
*Secondary keys*. Even there, `AND_ANY` refuses it, because an `OR` branch satisfied by absence never
gates.

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

## Secondary keys

SillyTavern's *Secondary Keywords* box, with its AND_ANY / AND_ALL / NOT_ANY / NOT_ALL dropdown, is a
second way to write a condition, and WA reads it exactly as SillyTavern does — a book you did not write
behaves the way its author tested it. It is worth knowing what the two boxes can and cannot say.

**They say one thing: every primary against every secondary, under one operator.** Keys
`astronaut, cosmonaut, taikonaut` with secondaries `Gagarin, Armstrong, "Yang Liwei"` under AND_ANY is
nine pairs, and it fires on all nine:

| text | two boxes | what you probably meant |
|---|---|---|
| the astronaut Armstrong stepped down | fires | fires |
| the cosmonaut Gagarin orbited | fires | fires |
| the taikonaut **Gagarin** waved | fires | — |
| the astronaut waited | — | — |

That third row is the cross product. It is a legitimate thing to want — any of these words alongside any
of those names — and the boxes give you no way to say otherwise. Written out, they are:

```
? (astronaut OR cosmonaut OR taikonaut) AND (Gagarin OR Armstrong OR "Yang Liwei")
```

If you meant the pairs, write the pairs:

```
? (astronaut AND Armstrong) OR (cosmonaut AND Gagarin) OR (taikonaut AND "Yang Liwei")
```

No arrangement of the two boxes writes the second one. Grouping is what they are missing, and grouping
is most of what a SmartKey is.

**One dropdown means one operator for the whole list**, which is a problem the moment two secondaries
are the same thing spelled differently. `Yang Liwei` and `Liwei Yang` are one person and belong in an
OR; a name you actually require belongs in an AND. Under AND_ALL a pair of spellings means "both
spellings must appear", which nothing will satisfy. Grouped, it just works:

```
? taikonaut AND ("Yang Liwei" OR "Liwei Yang")
```

**A secondary scores like any other term.** It is not a free condition: on `the mercury in the planet
core`, keys `mercury` with secondary `planet` scores 2 — one for each. If you want the qualifier to
gate without ranking, weight it `0`: `? planet::0` in the secondary box scores 1 and still refuses text
that omits *planet*.

**And the score scales with how many primary keys you have.** The gate is applied to each primary
separately, so on `astronaut cosmonaut taikonaut Gagarin` — where *Gagarin* appears once — three
primaries with a `Gagarin` secondary score 6, where the three primaries alone score 3, and a single
primary with the same secondary scores 2. That is the same arithmetic as writing three keys that each
mention *Gagarin*, which is what the two boxes are shorthand for.

**Negation-only keys are legal here, and only here.** `? -gagarin` is refused as a key of its own, but
as a secondary the primary decides activation and the negation can only narrow what it already matched:
`astronaut` with `["cosmonaut", "? -gagarin"]` under AND_ALL is "both crews, but not Gagarin's". Two
cautions. Under AND_ANY it is refused, because an OR branch satisfied by absence never gates. Under the
NOT operators the dropdown negates it a second time, so `? -gagarin` there means *requires* Gagarin —
the Studio warns you when you switch.

**OFF is the fifth position in the Studio's operator control**, and it is not a fifth logic: it sets the
entry's `selective` flag off, which SillyTavern reads as "ignore this list". The keys stay written down
and stop gating, which is the only way to park a gate without deleting the keys that express it.
Character cards can arrive this way; nothing you author will unless you ask for it.

## What the Studio will tell you

Saving a `?` key runs a structural check. It reads the SmartKey's shape only — never a guess at what you
meant, because every check that guessed produced false positives on real titles. The last row applies to
a bare `/regex/` key as well, which is the one thing the Studio has to say about a key with no `?`.

| | |
|---|---|
| **error** | no search terms at all |
| **error** | every term negated — that matches whenever they are absent, which is nearly always |
| **error** | an unclosed quote |
| **error** | a `/pattern/` JavaScript cannot compile |
| **warn** | a punctuation-only term (usually a second `?`: only the first one is the sentinel) |
| **warn** | unbalanced parens — it still parses, but probably not the way you grouped it |
| **warn** | when all terms in an expression are weighted 0, the key ranks on nothing. In the secondary box that is a deliberate gate; as a key of its own it still counts as one thing present |
| **warn** | a `/pattern/` with an unescaped `/` inside — vanilla SillyTavern will not run it (above) |

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
