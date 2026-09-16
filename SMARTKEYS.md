# SmartKeys, and how WorldsApart matches keys

A World Info key in WA can be one of three things:

| Form | Example | What it is |
|---|---|---|
| plain | `moon mission` | substring match, the SillyTavern default |
| regex | `/co(l|s)monaut/i` | a regular expression, as core already supports |
| **SmartKey** | `? moon mission -apollo` | a boolean expression — a leading `?` opts in |

`/…/` is also a **term** inside a SmartKey: `? /co(l|s)monaut/ landed` mixes a pattern and a word.
The first half of this page is the SmartKeys grammar; the second is how matching works for all three.

## What a SmartKey does today

**SmartKeys activate.** On a generation WA runs, a `?` key pulls its entry into the prompt exactly as
a plain key does, and it sets the **order** entries appear in, the **score** WA reports in `/wa-debug`
and the WI panel, and everything in the **Keyword Studio** — colouring, the audit, the pruner.
Matching uses **WA's** scan depth, not core's *Scan Depth*; a per-entry Scan Depth overrides both.
SillyTavern's own dry runs (prompt token counts, chat load) are not WA generations, so they keep
core's matcher, where a `?` key never matches. That is the portability story: a book full of
SmartKeys loads in a stock SillyTavern, where the keys never match rather than breaking anything.

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
? (copper pipe)~3                 ~N: the group's words within 3 words of each other
```

**Terms.** Anything that is not an operator or a paren, matched as a plain key would be — substring
by default, so `? fir` finds `confirm`.

**Operators.** `AND` `OR` `NOT` `XOR` as words (any case), or `&&` `&` `+` / `||` `|` / `!` `-` as
symbols. Adjacent terms get an implicit `AND`, so `? moon mission` requires both. `-` `!` `+` are
operators only at the *start* of a token, so `sci-fi` and `c++` are single terms; `+` in Lucene's
per-term position (`? +fire +water`) means "required", which the implicit AND already says.
**Precedence:** `(...)` before `NOT` before `AND` before `OR`/`XOR`. When in doubt, use parens.
Groups and negations nest up to **100** deep; a key that nests deeper is refused with an error — a
keyword that deep is a mistake, and the key editor will say so.

**Flags** are prefixes on a single term: `=` whole word (`? =cat` will not match `catalogue`), `^`
case-sensitive (`? ^NASA` will not match `nasa`). They apply per term, and a SmartKey **ignores the
entry's own** *Case-Sensitive* and *Match Whole Words* checkboxes.

**Weights** apply to a group as well as a term: `? (copper pipe)::3` is the conjunction, tripled. A group's
weight multiplies each thing inside it, so it scales the group's total whatever the operator; a term's own
weight and its group's compose (`(fire::2)::3` is 6), and groups nest. A weight attached to nothing —
`? fire ::3`, or `? fire ^2`, where `^` at the start of a term is the case flag — is refused as an error.

**Weights** are a postfix: `term::2`, `term::0.5`, or the Lucene spelling `term^2`. `::` and not `:`,
so a single colon stays ordinary text — `? meeting 10:30`, `? Judges 3:16`, `? re:code` and URLs
work as written; a delimiter followed by anything but digits is part of the term (`fire::abc`).
Weight `0` means "must be present, but do not rank on it" — a **disambiguator**: `? mercury AND
planet::0` needs the word *planet* nearby, so the entry does not match on the element or the god, and
still scores exactly what `? mercury` alone would; without the `::0` the qualifier counts as a second
thing the passage is about.

**Proximity.** `~N` after a group holds its words to a window: `? (copper pipe)~3` matches when *copper*
and *pipe* are within three words of each other, in either order — *pipe of old copper* (two words between)
yes, *copper in the bath beside the pipe* no. `~0` is adjacency, either order. N is the words allowed between
each neighbouring pair, so a group of three can stretch to twice N. An alternation inside takes whichever
branch is nearer: `? ((Arthur | Kyle) Porsche)~3`, and an alternation of longer things is a choice
between them, `? (((john james) | quincy) adams)~1`; an `XOR` takes either branch unless the other is
also within reach: `? ((john XOR quincy) adams)~1` finds *John James Adams* and *Quincy Jefferson
Adams*, and not *John Quincy Adams*. A negation inside vetoes only within reach: `? (fire
-drill)~2` matches a *fire* with no *drill* within two words of it, where `? fire -drill` gives up on the
whole window. The negated part can be anything a key can be. A word, a phrase or a group is within reach when
any part of it is, and a combination is read over what is within reach: `-(drill practice)` vetoes when
both words are, `-(drill practice)~0` when they are adjacent to each other and that pair is. Each cluster counts once, as one thing: the group scores like a single term, and a weight
goes on the group, `? (copper pipe)~3::2` or `? (copper pipe)::2~3`, the two being the same key; a weight on a word inside the group is not read. `~N` goes on a
group only. After a quoted phrase it is refused, since a phrase is already its words adjacent and in order,
and a `~` anywhere else is an ordinary character. What counts as a word is the *Word boundary* setting below.

**Scoring.** A key's score is the sum over the things it is **about**. `AND` joins two different
things, so each is scored separately and the scores add: `? moon AND rocket` is worth two. `OR` names
one thing more than one way, so its mentions pool and count as one thing seen more often: `? (glasses
OR spectacles)` scores exactly what the bare key `glasses` would on the same number of mentions. `XOR`
takes the winning side. A branch that did not match contributes nothing, and neither does a negation:
`? fire -water` is one thing, not two. **What one thing is worth**: being present at all is worth its
weight, and further mentions add less and less — present once scores 1, mentioned ten times about 3.
**Weight multiplies the thing, not the mentions**: `? (everest OR kailash::2)` scores 1 on a page
about Everest and 2 on a page about Kailash — twice as important, not "as if mentioned twice".

A key built **only** from negation — `? -water` — is refused as a key of its own: it would match nearly
every message. It is legal in exactly one place, as a **secondary** key (below).

## The same SmartKey, spelled out

Every row is one SmartKey written three ways; they parse and score identically.

| shorthand | | spelled out |
|---|---|---|
| `? moon mission` | = | `? moon AND mission` |
| `? moon mission -apollo` | = | `? moon AND mission AND NOT apollo` |
| `? +fire +water` | = | `? fire AND water` &nbsp;=&nbsp; `? fire water` |
| `? rain \| snow` | = | `? rain OR snow` &nbsp;=&nbsp; `? rain \|\| snow` |
| `? fire && !water` | = | `? fire AND NOT water` &nbsp;=&nbsp; `? fire -water` |
| `? fire^2` | = | `? fire::2` |
| `apollo mission` *(a plain key)* | = | `? "apollo mission"` |

The two rewrites that *do* change a SmartKey are quoting across a space (`hot tub` vs `"hot tub"`)
and regrouping with parens.

## A regex can be one term

`/pattern/flags` inside a SmartKey is a term like any other: it can sit beside a word, be negated,
and carry a weight.

```
? /co(l|s)monaut/ landed        a pattern AND a word
? -/drill/ fire                 a negated pattern
? /fire/::3                     weighted, like any term
```

- **A `/` opens a pattern only at the start of a token**, as `"` and `-` do. `and/or` and `3/4` are
  ordinary terms.
- **A `/…/` term reads exactly as the same string reads as a whole key.** `? /home/user/lux/` is the
  pattern `home/user/lux`; `? /home/user/file` is literal text. `? /a/ /b/` is two terms.
- **A slash inside the pattern is fine.** `/(home/user|~/user)/file/` runs as the pattern it looks
  like, whole key or term. See *Porting* below if the book will travel.
- **A term that follows a pattern needs a space.** `? /[/]/ x`, not `? /[/]/x`; for the two adjacent,
  put them in the pattern: `? /\/x/`.
- **Flags come after the close, then the weight**: `/fire/gi::2`.
- **`=` and `^` are not available here.** `=` means nothing to a pattern, and a regex is already
  case-sensitive — write `/i` for insensitivity.
- **A pattern is not folded**, exactly as for a whole-key regex: `? /Cap'n/ crunch` has one term that
  sees `’` and one that does not.
- **`^` and `$` anchor within the Match window**, not the whole scan. At the default (paragraph) they
  anchor per paragraph; at *Whole scan window* a bare `^` anchors to one position in the entire
  window. `/m` behaves the same at every setting.

To search for the literal characters, quote the term: `? "/re/"`.

### Porting a pattern to a non-WA SillyTavern

If you write a regex containing unescaped slashes and plan to port it to a non-WA system, escape the
slashes: vanilla SillyTavern's matcher refuses any pattern with an unescaped `/` inside and looks for
the whole delimited string as literal text instead.

```
/(home/user|~/user)/file/         WA: pattern.   vanilla ST: the literal 25 characters.
/(home\/user|~\/user)\/file/      both: pattern. Identical matches; `\/` is just `/` to a regex.
```

Escaping costs nothing under WA, so a book that may be shared is worth writing the escaped way. The
Studio warns on the first row's shape, for a bare `/regex/` key and a `/…/` term alike.

## Quoting is the one escape

Quoting turns off operator, weight and paren interpretation, and marks punctuation as deliberate:
Sigur Rós's `"()"` is a real album title. **Quoting a single term never changes what it matches.**
`"fire"` and `fire` are identical, and flags and weights still compose (`? ="fire"::2`). Quoting
**across a space** is a different SmartKey:

```
? hot tub       two terms, implicit AND — matches a hot bath beside a cold tub
? "hot tub"     one phrase — the words adjacent, in that order
```

A phrase is matched as written, including its single space: `"hot tub"` does not match `hot  tub`.

**A plain multi-word key is already a quoted phrase.** The ordinary key `apollo mission` means exactly
`? "apollo mission"`. Against the message **"The astronauts of the Apollo mission"**:

```
apollo astronauts        plain key    NO MATCH — that exact string never appears
? "apollo astronauts"    identical    NO MATCH
? apollo astronauts      SmartKey     MATCHES  — two terms, either order, anywhere in the window
```

That equivalence is between the two *keys*, not the two entries: neither checkbox reaches inside a
SmartKey. With *Match Whole Words* ticked the plain key `apollo astronauts` checks boundaries and
`? "apollo astronauts"` still does not, so the matching spelling is `? ="apollo astronauts"`;
*Case-Sensitive* is `? ^"apollo astronauts"`.

**Which form to reach for.** If you want the literal string, use a plain key; it takes any character
without ceremony — `6" pipe` is a plain key, quote and all. Reach for a SmartKey for **order
invariance** and **tolerance of words in between**: `? 6" copper pipe` matches on *"that copper pipe is
6" in diameter"*, where the plain key `6" copper pipe` does not.

## Secondary keys

SillyTavern's *Secondary Keywords* box, with its AND_ANY / AND_ALL / NOT_ANY / NOT_ALL dropdown, is a
second way to write a condition, and WA reads it exactly as SillyTavern does. **The two boxes say one
thing: every primary against every secondary, under one operator.** Keys `astronaut, cosmonaut,
taikonaut` with secondaries `Gagarin, Armstrong, "Yang Liwei"` under AND_ANY is nine pairs, and it
matches on all nine:

| text | two boxes | what you probably meant |
|---|---|---|
| the astronaut Armstrong stepped down | matches | matches |
| the cosmonaut Gagarin orbited | matches | matches |
| the taikonaut **Gagarin** waved | matches | — |
| the astronaut waited | — | — |

Written out, the boxes are:

```
? (astronaut OR cosmonaut OR taikonaut) AND (Gagarin OR Armstrong OR "Yang Liwei")
```

If you meant the pairs, write the pairs — no arrangement of the two boxes can:

```
? (astronaut AND Armstrong) OR (cosmonaut AND Gagarin) OR (taikonaut AND "Yang Liwei")
```

**One dropdown means one operator for the whole list.** `Yang Liwei` and `Liwei Yang` are one person
and belong in an OR; a name you require belongs in an AND; under AND_ALL a pair of spellings means
"both spellings must appear". Grouped:

```
? taikonaut AND ("Yang Liwei" OR "Liwei Yang")
```

**A secondary scores like any other term.** On `the mercury in the planet core`, key `mercury` with
secondary `planet` scores 2. To gate without ranking, weight it `0`: `? planet::0` in the secondary
box scores 1 and still refuses text that omits *planet*. **The score scales with how many primary keys
you have**, since the gate is applied to each primary separately: on `astronaut cosmonaut taikonaut
Gagarin`, three primaries with a `Gagarin` secondary score 6, the three primaries alone 3, one primary
with the same secondary 2 — the arithmetic of three keys that each mention *Gagarin*.

**Negation-only keys are legal here, and only here.** As a secondary, the primary decides activation
and the negation can only narrow what it matched: `astronaut` with `["cosmonaut", "? -gagarin"]`
under AND_ALL is "both crews, but not Gagarin's". Under AND_ANY it is refused, because an OR branch
satisfied by absence never gates. Under the NOT operators the dropdown negates it a second time, so
`? -gagarin` there *requires* Gagarin — the Studio warns when you switch.

**OFF is the fifth position in the Studio's operator control**, and not a fifth logic: it sets the
entry's `selective` flag off, which SillyTavern reads as "ignore this list" — the keys stay written
down and stop gating. Character cards can arrive this way; nothing you author will unless you ask.

## What the Studio will tell you

Saving a `?` key runs a structural check on the SmartKey's shape only, never a guess at what you
meant. The last row applies to a bare `/regex/` key as well.

| | |
|---|---|
| **error** | no search terms at all |
| **error** | every term negated — that matches whenever they are absent, which is nearly always |
| **error** | an unclosed quote |
| **error** | a `/pattern/` JavaScript cannot compile |
| **error** | a `::N` or `^N` weight attached to nothing |
| **error** | a second `~N` after a group — a group takes one; quote it to search for the text |
| **error** | `~N` after a quoted phrase — a phrase is already its words adjacent and in order; group them instead |
| **warn** | a punctuation-only term (usually a second `?`: only the first one is the sentinel) |
| **warn** | unbalanced parens — it still parses, but probably not the way you grouped it |
| **warn** | when all terms in an expression are weighted 0, the key ranks on nothing. In the secondary box that is a deliberate gate; as a key of its own it still counts as one thing present |
| **warn** | a `/pattern/` with an unescaped `/` inside — vanilla SillyTavern will not run it (above) |

Whether a term ever occurs in your book is a different question, and the audit answers it. The Studio's
Key Lab answers it against any text you paste or load. It reports keyword hits only — probability,
delay, cooldown, inclusion groups, character and tag filters, `@@activate`/`@@dont_activate`, recursion
and vector retrieval are not applied — so a key that hits there has not necessarily activated its entry.

---

# How matching works

This half applies to plain keys and SmartKey terms alike.

**Substring by default.** `fir` matches `confirm`. Whole-word matching is opt-in — the entry's *Match
Whole Words* checkbox for a plain key, the `=` flag for a SmartKey term. **The checkbox reaches every
key, including multi-word ones.** SillyTavern core skips any key with a space in it, so its checkbox
is a no-op there and `hot tub` goes on matching `hot tubs`. WA applies the label as written: ticked,
`hot tub` matches *hot tub* and not *hot tubs*, and `? ="hot tub"` behaves identically. If you want
the plural too, key it — or leave the box off, which is the default.

**Tags and HTML comments are blanked out before a literal key is matched.** `size` does not match
`<div style="font-size:13px">`, and `div` does not match the tag itself. A `/regex/` key matches the raw
text instead, so `/font-size/` finds the attribute — that is the only way to reach one. SillyTavern core
matches inside tags.

**A block element's open or close ends a match window**, as a blank line does. So at the default
*Paragraph* setting, `? apple banana` needs both terms inside the same `<div>`: a preset that writes chat
bubbles or a tracker panel as `<div>`s gives each one its own window. `<b>`, `<em>`, `<span>` and `<br>`
do not end one.

**What counts as *inside* a word is the Word boundary setting**, in the WA panel:

| | inside a word | so `Joe` matches |
|---|---|---|
| **Strict** (default) | letters, digits, marks, `-` `'` | *Joe*, not *Joe's* or *Joe-adjacent* |
| **Permissive** | letters, digits, marks | *Joe*, *Joe's* and *Joe-adjacent* |

Neither matches *Joel* — a letter alongside always blocks. `_` is a boundary in both, so `_Joe_`
matches: underscore is a word character for programming identifiers, not for prose. A `/regex/` key
written with `\b` gets permissive behaviour for that one key (`\b` is ASCII-only, in WA as in
SillyTavern). **Word boundaries are Unicode-aware**: a word character is any letter, digit or
underscore in any script, so whole-word `caf` does not match `café` and `Мари` does not match `Марию`.

**Known limit — scripts without word boundaries.** Chinese, Japanese, Thai, Lao, Khmer and Burmese do
not write them, so a whole-word key like `猫` matches where it appears among Latin text or punctuation —
a sign name inside an English sentence, or beside `・` `、` `。` — and misses wherever it sits between
two characters of running text. Leave the box off for entries keyed in these scripts; the Studio
marks the whole-words control on any entry where this applies.

**Case-insensitive by default**, opt out with the entry checkbox or `^`.

**Orthography is normalised on both sides.** These are the same character in a different encoding:

| written | matches |
|---|---|
| `'` `’` `‘` `‚` `‛` `ʼ` `ʹ` `′` `´` `` ` `` `‹` `›` | each other |
| `"` `“` `”` `„` `‟` `″` `ʺ` `«` `»` | each other |
| `—` (em dash) | `--` |
| `–` (en dash) | `-` |
| `…` | `...` |
| non-breaking space | ordinary space |
| decomposed `José` | composed `José` (NFC) |

So a key typed `Cap'n Joe` matches against prose written `Cap’n Joe`. Em and en dashes do **not**
collapse together: one separates clauses, the other joins. Nothing that can *carry meaning* is
folded: a fold applies to the text being scanned, so it erases a distinction for every key at once
and no flag can ask for it back — case is the one exception, because `^` exists to opt out. That is
why the CJK brackets `《》` and `「」` are **not** in the table: `《》` marks titles and `「」`
speech, so folding them would throw a distinction away.

**Hyphens are literal, in both directions.** `sci-fi` does not match `sci fi`, and `sci fi` does not
match `sci-fi`. If a compound is written both ways in your chats, key both (`? sci-fi OR "sci fi"`).
**Accents are literal.** `Gerard` does not match `Gérard`; whether stripping an accent is safe depends
on the language (`du` and `dû` are different French words), so key both forms when your model writes
both.

**No wildcards, no fuzzy matching.** `*` is an ordinary character, and so is `~` except as `~N` after a
group (*Proximity*, above): `M*A*S*H` matches `M*A*S*H` and `fire~2` matches `fire~2`.
Substring matching already covers what a leading or trailing `*` would buy you; for anything more,
write a `/regex/` — as the whole key, or as one term inside a SmartKey.

**Regex keys are matched raw.** A `/pattern/` key sees the text unfolded, so `/Cap'n/` will *not* find
`Cap’n`; write the alternation or the class yourself. A regex also ignores the entry's checkboxes — it
is case-sensitive unless you write `/i`, and *Match Whole Words* means nothing to it.

**Known limit — Markdown.** Chat prose is Markdown and the markup sits in the text being scanned, so
emphasis *inside* a word cuts both ways:

```
"*sister*hood"    sisterhood         MISSES  — the asterisks break the substring
"*sister*hood"    sister (=/whole)   MATCHES — the * reads as a word boundary
```

Emphasis around a whole word is fine in every mode; this only bites mid-word. Making `*` a word
character would break the case that works, and stripping markup would destroy the asterisk as content.

---

# Coming from Lucene

Carried over: `AND` `OR` `NOT` `+` `-` `&&` `||` `!`, parentheses, quoted phrases, `^N` boost
(aliased onto `::N`), and `~N` as proximity — on a group, `(a b)~3`, rather than Lucene's phrase slop
`"a b"~3`, which is refused. Not implemented, and matched literally instead: wildcards `*` `?`, fuzzy
`~` on a term, field syntax `field:value`, and ranges — a key that expected one of these will never
match, and the Studio's audit reports it as a dead key. `XOR` and `::` weights are not Lucene at all;
`::` is Midjourney's multi-prompt weight, borrowed because it cannot collide with a time or a ratio.
