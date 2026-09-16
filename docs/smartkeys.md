# SmartKeys, and how WorldsApart matches keys

A World Info key in WA can be one of three things:

| Form | Example | What it is |
|---|---|---|
| plain | `moon mission` | substring match, the SillyTavern default |
| regex | `/co(l\|s)monaut/i` | a regular expression, as core already supports |
| **SmartKey** | `? moon mission -apollo` | a boolean expression — a leading `?` opts in |

## Quick reference

```
? moon mission -apollo            implicit AND; a leading - negates
? "moon mission" OR cosmonaut     quoted phrase; AND / OR / NOT / XOR
? =cat                            = whole word
? ^NASA                           ^ case-sensitive
? ^=NASA                          flags combine, in either order
? fire::2.5                       ::N weights the term
? fire^3.5                        ^N is accepted too (Lucene's boost)
? (rain OR snow) -indoors         parentheses group
? /co(l|s)monaut/i landed         /pattern/flags is a term
? (moon mission)~3                 ~N: up to 3 words between moon and mission
```

---

# How matching works

## Plain keys mostly behave the same

In SillyTavern, a keyword is an exact substring match, so the term `moon` matches `honmoon` unless
whole-word matching is enabled for the entry. A plain keyword in WorldsApart (WA) behaves exactly the
same way; none of your existing keys will behave differently, with one exception: SillyTavern for some
reason skips whole-word matching on multi-word terms (e.g., terms that contain a space like `hot tub`)
and applies substring matching, so `hot tub` matches `hot tubs` and `hot tubing`. WA corrects this, so
it behaves as intended and does not match.

## In some situations, they may behave differently

### Tags

**HTML and XML tags and comments are blanked out before a literal key is matched.** The keys `size`
and `div` will not match `<div style="font-size:13px">` or `<!-- this div's size is too big -->` like
it would under ST's own matching system. If you want to match tag contents, use a regex.

### Orthographic Normalization

WA generally tries to model an author's intent when matching. A user who writes the key `Cap'n Crunch` probably wants it
whether the apostrophe is the straight form from their keyboard or the fancy curly form that displays
sometimes, and LLMs frequently emit both on an inconsistent basis. Consequently, WA normalizes a few
classes of characters to ensure consistent matching regardless of variant forms being used.

| class | written | matches |
|---|---|---|
| Apostrophes, single quotes, and ticks | `'` `’` `‘` `‚` `‛` `ʼ` `ʹ` `′` `´` `` ` `` `‹` `›` | each other |
| Double quotes | `"` `“` `”` `„` `‟` `″` `ʺ` `«` `»` | each other |
| Em dash | `—` | `--` (two hyphens) |
| En dash | `–` | `-` (one hyphen) |
| Ellipsis | `…` | `...` (three periods) |
| Spaces | non-breaking space | ordinary space |
| Accents and combining marks | decomposed `José` (`e` + a combining acute) | composed `José` (NFC, the single letter `é`) |

What this means is that you don't need to care about any of this — you can write whatever way is
comfortable to you without needing to provide variant keys for whatever the model may be spitting out.
If any of your keys use any of these marks, it's very likely that SillyTavern wasn't matching them in
some cases where you would have expected it to.

This principle extends to hyphens; WA expands word-internal hyphens to spaces so that `sci-fi` also matches `sci fi`, because often
the hyphen is a matter of taste or convention. If you specifically want the hyphen, write the key as a regex: `/sci-fi/`. (The reverse is not
true — key `sci fi` will not match `sci-fi` in the chat, because it would require turning every space in the chat into a hyphen). Leadng and trailing hyphens are exempted from the expansion (e.g., `-gate` will only match `bridge-gate`, not `the bridge gate is broken`.)

**Note:** WA does *not* remove accents like some systems do; `cafe` does not match `café`, because those are only considered the same thing in English, and WA supports many languages (French `a` and `à` are completely separate words.) Use an OR group to capture accent variants if they might arise (models are usually pretty good about using them consistently). 

---

# SmartKeys

A SmartKey is a key with some (optional) special features. They can be identified with their leading `?`
character[^1]. `astronaut` is a plain keyword; `? astronaut` is a SmartKey (albeit one that behaves
identically).

## Whole-word and Case-Sensitive Flags

The first feature of a SmartKey is the ability to apply whole-word matching or case sensitive matching
to *the single key only*. SillyTavern requires all keys in an entry to have the same behavior;
SmartKeys allow you to get granular.

The `=` flag makes a term (that is, a part of a SmartKey; more on this later) use whole-word matching.
`? cat` matches `catapult`, same as plain keyword `cat`.
`? =cat`, on the other hand, ensures that only the literal word `cat` matches.

The `^` flag makes a term case-sensitive in the same way.
`? NASA` matches `nasal` and `NASA space program` (remember: terms are substring-matched unless you use `=`!)
`? ^NASA` matches `NASA space program` and `NASAL` but not `nasal`.

You can combine them to get very specific: you probably actually want `? =^NASA` for the space agency.
(You can write the flags in any order; `? ^=NASA` and `? =^NASA` are equivalent in every way.)

**Note:** SmartKeys flags (or lack thereof) override the entry's own settings. `? NASA` is always
case-insensitive and substring-matched even if the entry has case sensitivity and whole-word matching
on. This is what allows you to be more granular with your keys, mixing `? =^NASA` and `? astronaut` to
get you "NASA space program" and "Apollo 11 astronauts Neil Armstrong and Buzz Aldrin" (note the
plural!) but not "nasal decongestant".

## Operators

Sometimes you might want a word only when it appears with other words, or only when another word
*isn't* present, or any of several words. SmartKeys uses boolean operators to accomplish this; they
read pretty naturally so they don't require too much explanation:

```
? moon AND mission              both
? apollo OR soyuz               either
? astronaut NOT armstrong       astronaut, where armstrong is absent
? apollo XOR soyuz              one of them, not both (i.e., "exclusive OR")
```

Each of those individual parts is what we call a term, so `? moon AND mission` is a key with two terms
(we count the operator as a separate thing).


You can combine as many terms as you want:

```
? moon AND mission AND astronaut AND Armstrong
? moon OR sun OR mars OR jupiter OR saturn
? moon AND sun OR star AND jupiter OR saturn
```

As you can see, when you begin to combine them, things get a bit hard to work out— is that `moon AND sun` OR `star AND jupiter`, or `moon` AND  `sun OR star`? For these cases, you'll want to use groups to make your intent clear: `? moon AND (sun OR star) AND (jupiter OR saturn)`[^2]. These groups can nest: `? ((orion AND pegasus) OR (saturn AND jupiter)) AND telescope`— you need either stars or planets plus telescope. You can nest groups up to 100 deep; if you need more than that, email the maintainer and beg absolution for your sins. 

**Note:** A key built only on negation (e.g., `? NOT water`) is refused in nearly every case, as it would match basically every message. The only exception to this is the AND_ALL secondary keys operator.

## Operator Spelling

There are a few different ways you write the operators.

`AND` = `and` = `&`
`OR` = `or` = `|`
`NOT` = `not` = `-` (hyphen/minus)
`XOR` = `xor` (it has no symbol representation)

Single and double symbols are the same operator, so write `&` or `&&`, `|` or `||`, whichever you prefer, since you probably have muscle memory from programming.

This means that `? moon AND (sun OR star) AND (jupiter OR saturn)` and `? moon and (sun | star) & (jupiter || saturn)` are perfectly equivalent, if somewhat difficult to read; pick one and stick with it (symbolic is most concise: `? moon & (sun | star) & (jupiter | saturn)`)

You might sometimes want to use a term that contains one of these symbols; `? "AT&T"` gets you the company, where `? AT&T` is a two term expression equivalent to `? at AND t`. This works for just about any symbol in the grammar; `? "()"` gets you a Sigur Rós album, where `? ()` evaluates to nothing and matches nothing; `? "/hello/"` includes literal forward slashes and is not a regex. It's worth noting, however, the exception: quotation marks do *not* escape hyphen expansion. `? "sci-fi convention"` will match `we went to the sci fi convention` so you don't have to think about it; if you want the literal span including hyphen, just use a plain regex `/sci-fi convention/`.  


## Implicit AND and Quote Escaping

Since AND is the most common operator, we assume it whenever an operator is not provided; `? moon mission` is equivalent to `? moon AND mission`. In many cases, this helps expressions read more easily, like `? apollo OR (moon mission)`. This, however, means that multi-word SmartKeys do not behave the same as multi-word plain keywords; `? apollo astronauts` gets you `the astronauts of the Apollo mission` where plain `moon mission` does not. Sometimes this is desirable and sometimes this is not; `? Neil Armstrong` gets you `Neil's Stretch Armstrong toy`. In those cases, you can use quotes for a literal match: `? "Neil Armstrong"`. In the simple case, this is directly equivalent to plain keyword `Neil Armstrong`, so you might consider using that instead. Where it begins to matter is in more complex expressions: `? "Neil Armstrong" astronaut`. 

Quoted phrases can use the whole-word match and case-sensitive flags like any other term:
`? ^"Navy SEAL"` does not match `navy seal`; `? ="cat scan"` matches `get a CAT scan` but not `a new CAT scanner`. 


| expression | equivalent to |
|---|---|---|
| `? moon mission` | `? moon AND mission` |
| `? moon mission -apollo` | `? moon AND mission AND NOT apollo` |
| `? moon mission "Neil Armstrong"` | `? moon AND mission AND "Neil Armstrong"` |


## Key Scores and Weighting

Matches are assigned scores that help determine the relevancy of a lorebook entry. Broadly, the score attempts to capture how many "things" the match is about.

A plain term scores one: `? moon` or its equivalent `moon` are about one thing.

An AND turns two terms into one thing: `? moon mission` is only valid if both of those terms are present.`? moon mission` is more specific than `moon` alone, so we judge it to be more relevant, and assign it a score of two (1 + 1). Likewise, `? apollo astronaut neil armstrong` is four-things-as-one, so when it matches, it gets a score of four.

An OR, on the other hand, is about options. A chat might call them glasses or spectacles, and both are equally good; `? glasses OR spectacles` is therefore only as good as each term separately, and each match is assigned a score of one. 

Sometimes, however, different terms are differently specific or relevant. If a lorebook entry is about the pair of Ray-Bans that a beloved relative bought your character, you might decide that `sunglass` is an okay term, but `Ray-Bans` is much better. In that case, you can weight the score with the double-colon modifier: `? Ray-Ban::5`[^3], saying "Ray-Ban is a much more important term than any other". A term anywhere in an expression can be weighted: `? (sunglass OR Ray-Ban::5)` means that if it matches on `sunglass` or `sunglasses`, it gets a score of one, but if it matches `Ray-Ban`, it gets five. Groups themselves can also be weighted: `? (sunglass OR ray-ban)::5`

| key | text | matches | score |
| `? sunglass OR ray-ban` | `I got new Ray-Bans` | Yes | 1 |
| `? sunglass OR ray-ban` | `I got new sunglasses` | Yes | 1 |
| `? sunglass OR ray-ban::5` | `I got new Ray-Bans`| Yes | 5 |
| `? sunglass OR ray-ban::5` | `I got new sunglasses`| Yes | 1 |
| `? (sunglass OR ray-ban)::5` | `I got new Ray-Bans`| Yes | 5 |
| `? (sunglass OR ray-ban)::5` | `I got new sunglasses`| Yes | 5 |
| `? (sunglass OR ray-ban::5)::5` | `I got new sunglasses`| Yes | 5 |
| `? (sunglass OR ray-ban::5)::5` | `I got new Ray-Bans`| Yes | 25 |
| `? sunglass AND ray-ban` | `I got new Ray-Bans`| No | 0 |
(XOR behaves identically to OR in these examples)

It is possible to assign a score of `::0`; in this case, the term is not scored, but only used as a gate. This can be useful for keys that otherwise might overlap: `? saturn OR venus OR (mercury AND planet::0)`, which allows you to specify the planet instead of the singer or the car without it scoring higher than the other planets.

What about multiple matches?
While you might expect two hits to be worth twice one hit, to prevent keys that have common terms from vastly outweighing keys with less-common terms, we use a saturation curve. On a single unweighted term, one match is worth one. Ten matches is worth about three. OR groups are saturated against all of their terms in any combination; `? sunglass OR ray-ban` may have 2 sunglass hits and 3 Ray-Ban, or five sunglass and no Ray-Ban, but it's still five hits. This can intersect unexpectedly with weights.

Against *"I got new Ray-Ban sunglasses"*:

| key | count | score |
|---|---|
| `? sunglass OR ray-ban` | 2 | 1.4055 |
| `? sunglass OR ray-ban::5` | 2 | 4.2164 |
| `? (sunglass OR ray-ban)::5` | 2 | 7.0273 |
| `? sunglass AND ray-ban` | 1 | 2 |
| `? sunglass::0 AND Ray-Ban` | 1 | 1 |
| `? sunglass XOR ray-ban` | 0 | 0 |

The math is not super important; just know that the scores you're expecting may not line up with the scores actually assigned. 


## A regex can be a term

A regular expression inside a SmartKey is a term like any other: it can take an operator, be negated,
and carry a weight.

```
? /(astro|cosmo)naut/ landed    a pattern AND a word
? /apples?/ /bananas?/          two patterns
? -/drill/ fire                 a negated pattern
? /fire/::3                     weighted, like any term
```
There are a few things to watch out for:
- A term is read as a regex only when it begins and ends with a forward slash; `? /24-7/` is a regex, `? 24/7` is four literal characters, `? /home/user/file` is also literal.
  - Flags supported by JS [dgimsuvy] are allowed: `? /NASA/i` is case-insensitive;  note that ST core does not support /d or /v, so if you write a key with them, it will not work on a WA-less install.
- Regexes can be escaped with quotes; `? "/re/"` is literal four-character `/re/`. 
- Two (or more) regexes expect a space between them; `? /apples?/bananas?/` is one regex that contains apple with optional s, a literal forward slash, and banana with optional s. 
- A slash inside the pattern is fine and does not need to be (but can be) escaped. `/(home/user|~/user)/dir/` behaves identically to `/(home\/user|~\/user)\/dir/`. Note that ST core requires the escape, so you might want to use them for portability.
- Regexes are not folded, so `/Cap'n Crunch/` written with only a straight apostrophe will not match `Cap’n Crunch` with a curly one; consider a more robust group like `['‘’]`[^4].
- Whole-word `=` and case-sensitive `^` are not available here. Regexes are case-sensitive without the /i flag and always substring match. If you want to mimic whole-word matching, use a space character or permissive \b:

  | pattern | text | match |
  | `/Sean/` | `my friend Sean` | true |
  | `/Sean/` | `my friend Seán` | false |
  | `/Sean/` | `my friend sean` | false |
  | `/Sean/i` | `my friend sean` | true |
  | `/Sean/` | `the ASEAN region` | false |
  | `/Sean/i` | `the ASEAN region` | true |
  | `/\bSean\b/` | `my friend Seanan and` | false |
  | `/ Sean /` | `my friend Seanan and` | false |
  | `/ Sean /` | `with my friend Sean and` | true |
  | `/\bSean\b/` | `with my friend Sean and` | true |
  | `/\bSean\b/` | `with my friend Sean. We` | true |
  | `/ Sean /` | `with my friend Sean. We` | false |
  | `/\bSean\b/` | `hey Sean-- are you` | true |
  | `/ Sean /` | `hey Sean-- are you` | false |
  | `/\bSean\b/` | `my friend Sean's new` | true |
  | `/ Sean /` | `my friend Sean's new` | false |
  | `/Sean's/` | `my friend Sean's new` (straight apostrophe) | true |
  | `/Sean's/` | `my friend Sean’s new` (curly apostrophe) | false |
  | `/\bSean\b/` | `my friend Sean's new` (straight apostrophe) | true |
  | `/\bSean\b/` | `my friend Sean’s new` (curly apostrophe) | true |


Note that JS regex \w, \b, and \d, which can cause unexpected behavior with accented and non-English characters. Additionally, WA normalizes the haystack to composed (NFC) form:
| pattern | text | match | note |
| `/André/` | `my friend André and` | true | |
| `/André/` | `my other friend Andréas` | true | |
| `/André/` | `my friend André` | true | both composed: \u00e9 |
| `/André/` | `my friend André` | **false** | Decomposed key e + \u0301, composed text \u00e9 (WA text is always composed); WA will warn you in this case. |
| `/André/` | `my friend André's new` | true | (assuming both composed forms)|
| `/\bAndré\b/` | `my friend André and` | **false** | Fails on a non-ASCII edge; a JS regex span delimited by \b must begin and end with an ASCII character, because \w is [A-Za-z0-9_] |
| `/\bAndré\b/` | `my friend André's new` | false |  |
| `/\bAndréas\b/` | `my other friend Andréas and` | true | Only the edge has to be ASCII |
| `/\bAndréas\b/` | `my other friend Andréas's new` | true |  |

This is true even if you force unicode awareness with flags /u and /v. The unicode-aware version of \b is a combined lookahead and lookbehind `(?<![\p{L}\p{N}\p{M}])` + `(?![\p{L}\p{N}\p{M}])` with the unicode flag /u (e.g., `/(?<![\p{L}\p{N}\p{M}])André(?![\p{L}\p{N}\p{M}])/u`). For this reason, it is recommended to use plain terms if you want to use accented characters and boundary markers, as WA handles this under the hood. Under permissive mode, `? =André` behaves sensibly, matching `my friend André`,  `"André's new`, and `André-shaped` but not `Andréas`; under strict mode, you must spell out  variants like `? (=^André | =^André's | ^André-)`. This also gets you the curly-quotes normalization and normalization to composed form, so typing e + combining acute `André` will match even though the text is always in composed form.

**Note:** Regex anchors `^` and `$` are applied against the Match window, not the whole scan. At the default, Paragraph, they
  anchor once per paragraph (`^` matches at the start of each one); under Message, once per message;
  under Whole scan window, a bare `^` matches at a single position — the start of the window, however
  many messages and paragraphs are inside it. Consider `/m`, which anchors at every line break.

  Against `/^Dream/`:
  
  `Dream of the Endless is a DC Vertigo character`: Match
  `I Have a Dream`: No match
  ```
  Many pieces of once-popular software have since been shuttered.
  Dreamweaver, Adobe's once-vaunted web development suite, // No match (segment starts at "Many"; /^Dream/m would have matched)
  ```

## Proximity

Sometimes a group words is only useful when they're close to each other. Consider `? copper pipe`. This gets you `a copper pipe` and `a pipe made of copper`, but it also gets you `Pipes are made of PVC, and come in several stylish colors including white, black, silver, copper, and gold.`. In these cases, you might consider a proximity match. (This section gets complicated, so it might take a couple of reads— highly recommend trying things in the Lab to see how they work.)

You need two things for a proximity match: a group of things delimited by parenths, and a slack value, delimited by a tilde (`~`) character[^5].
`? (mission mars)~2` means "both of these words, with at most 2 words in between them", or "mars within 2 words of mission".
`a mars mission`: Match
`the mission to Mars`: Match (1 word in between; order doesn't matter)
`Missions have slowed in recent years, and Mars seems unlikely` No match (6 words in between)

`~0` is a useful case because it means "the words can be in either order as long as they're next to each other": `? (Akira Kurosawa)~0` gets you both Western style `Akira Kurosawa`, family name last, and Eastern style `Kurosawa Akira`, family name first. Note that this only applies to *words*, not punctuation: `Born in Kurosawa, Akira had two brothers` matches. For strict phrasal order invariance, use an OR group: `? ("Akira Kurosawa" OR "Kurosawa Akira")`.

Groups can be used as proximity terms; proximity is counted from whatever hits. `? ((Neil OR Yuri) Porsche)~3` matches `Neil and his husband Yuri bought a Porsche` because `Yuri` is separated from `Porsche` by 2 words. Note that the proximity operator is distributive: `? ( (john james) adams)~0` gets you `John James Adams` and not `John and his big brother James Adams`, but could also get you `John Adams Jameson`. To insist that the inner group stay together, you can assign slack there as well: `? ((john james)~0 adams)~0` gets you `John James Adams`, `James John Adams`, but not `John Adams Jameson`. XOR behaves as expected: `? ((john XOR quincy) adams)~1` gets you `John James Adams` and `Quincy Adams` but not `John Quincy Adams` (which the simpler `? ((john OR quincy) adams)~1` would match on).

Negation works in just the same way. `? (fire -drill)~1` means "any use of the word `fire` as long as `drill` is not within 1 word". So `there was a great fire` matches, `we had a fire drill` does not, and `Home Depot sells drills, saws and fire extinguishers` matches because there are two words in between where the simpler `? fire -drill` would exclude it even though it's not discussing fire drills. An entire group can likewise be negated: `? (fire -(drill today))~2` is "any use of fire UNLESS both drill and today are within 2 words". So `We had a fire drill today` does *not* match (`drill` and `today` are both within 2 of `fire`), but `Today we had a fire drill` *does* match, because only `drill` is within 2 of `fire` while `today` is 3 away. Again: Highly recommend to use the Lab to verify that these keys are doing what you want.

---

## Secondary keys

SillyTavern's only way of writing a boolean condition is the *Secondary Keywords* box, with its AND_ANY / AND_ALL / NOT_ANY / NOT_ALL dropdown. WA reads it exactly as SillyTavern does, so nothing you have already built will behave differently. The problem with this system is that the two boxes only ever say one thing: every primary paired with every secondary, under a single
operator, applied with the same case-sensitivity and whole-word criteria.

Say you have an entry about Sally Ride's missions. In ST, you might write that as ["Ash", "Ketchum"] AND_ANY ["Pikachu", "Bulbasaur", "Charmander"].

That can be written boolean-style as `(Ash OR Ketchum) AND (Pikachu OR Bulbasaur OR Charmander)`. The problem is that ST case-sensitivity and whole-word matching is equally applied to all keys in an entry; if you turn whole-word on so `Ash` doesn't match `Rapidash`, then `Pikachu` no longer matches `Pickachus` and you have to spell it out. Likewise, if you turn on case-sensitivity so that `Ash` doesn't match `the campfire burned to ash`, you miss out on `PIKACHU! I CHOOSE YOU!`. WA, by contrast, allows you to have it all quite simply:
`? (=^Ash OR =^Ash's OR Ketchum OR Satoshi) AND (pikachu OR bulbasaur OR charmander)` gets you everything at the cost of having to spell out `Ash's`. 

It also allows you to easily express things that ST simply does not allow:
`? (=^Ash AND pikachu -=^Oak) OR (=^Misty AND squirtle -cerulean)`

**WARNING:** WorldsApart supports secondary keys because one of our goals is that a book performs essentially identically under WA as under ST core. That means that if you have pre-existing secondary keys, they will be applied. So if you have an entry with keys ["Ash", "Ketchum"] AND_ANY ["Pikachu", "Bulbasaur"], if you then add key `? =^Ash AND ^Misty`, the text must contain Ash, Misty, *and* Pikachu or Bulbasaur. You can't exempt keys from this; it's all or nothing. Either you leave the secondary keys and accept that, or you rewrite the conditions as a SmartKey: `? (=^Ash OR ^Ketchum) AND (pikachu OR bulbasaur)`. It's not necessary to delete the secondary keys if you rewrite them— you can simply set them to OFF in case you ever need to port to a non-WA system where the SmartKeys won't work.


## Settings that change matching

**Word boundary** decides what counts as *inside* a word, for whole-word matching only:

| | inside a word | so `Joe` matches |
|---|---|---|
| **Strict** (default) | letters, digits, marks, `-` `'` | *Joe*, not *Joe's* or *Joe-adjacent* |
| **Permissive** | letters, digits, marks | *Joe*, *Joe's* and *Joe-adjacent* |

Neither matches *Joel* — a letter alongside always blocks. `_` is a boundary in both, so `_Joe_`
matches: underscore is a word character for programming identifiers, not for prose. **Word boundaries
are Unicode-aware**: a word character is any letter, digit or underscore in any script, so whole-word
`caf` does not match `café` and `Мари` does not match `Марию`.

**Match window** is the unit every part of a key must match within — *Paragraph* (the default),
*Message*, or *Whole scan window* (SillyTavern's own behaviour). Under *Paragraph*, `? apple banana`
needs both words in the same paragraph. A block element's open or close ends a window as a blank line
does, so a preset that writes chat bubbles or a tracker panel as `<div>`s gives each one its own;
`<b>`, `<em>`, `<span>` and `<br>` do not.

## Known limits

**Scripts without word boundaries.** Chinese, Japanese, Thai, Lao, Khmer and Burmese do not write them,
so a whole-word key like `猫` matches where it appears among Latin text or punctuation — a sign name
inside an English sentence, or beside `・` `、` `。` — and misses wherever it sits between two
characters of running text. Leave the box off for entries keyed in these scripts; the Studio marks the
whole-words control on any entry where this applies.

**Markdown.** Chat prose is Markdown and the markup sits in the text being scanned, so emphasis
*inside* a word cuts both ways:

```
"*sister*hood"    sisterhood         MISSES  — the asterisks break the substring
"*sister*hood"    sister (=/whole)   MATCHES — the * reads as a word boundary
```

Emphasis around a whole word is fine in every mode; this only bites mid-word. Making `*` a word
character would break the case that works, and stripping markup would destroy the asterisk as content.

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
| **warn** | a `/pattern/` with an unescaped `/` inside — vanilla SillyTavern will not run it (below) |

Whether a term ever occurs in your book is a different question, and the audit answers it. The Studio's
Key Lab answers it against any text you paste or load. It reports keyword hits only — probability,
delay, cooldown, inclusion groups, character and tag filters, decorators, recursion
and vector retrieval are not applied — so a key that hits there has not necessarily activated its entry.

## Porting to a non-WA SillyTavern

**A book full of SmartKeys loads in a stock SillyTavern**, where the keys never match rather than
breaking anything. Core's matcher has no `?` sentinel, so it reads the whole key as literal text that
no message contains. The same is true inside WA for SillyTavern's own dry runs — prompt token counts,
chat load — which are not WA generations and so keep core's matcher.

If you write a regex containing unescaped slashes and plan to port it to a non-WA system, escape the
slashes: vanilla SillyTavern's matcher refuses any pattern with an unescaped `/` inside and looks for
the whole delimited string as literal text instead.

```
/(home/user|~/user)/file/         WA: pattern.   vanilla ST: the literal 25 characters.
/(home\/user|~\/user)\/file/      both: pattern. Identical matches; `\/` is just `/` to a regex.
```

Escaping costs nothing under WA, so a book that may be shared is worth writing the escaped way. The
Studio warns on the first row's shape, for a bare `/regex/` key and a `/…/` term alike.

[^1]: **Q:** Why a question mark?
      **A:** Because it's easy to see at a glance, easy to parse, and fails as a string match. `? (moon OR planet) AND mission` will never appear in a text, so you'll never get a false positive. 
      **Q:** Couldn't it just be plain?
      **A:** That would silently change the semantics of existing keys like `Law and Order` or `Florence & the Machine`.
[^2]: If you don't use parentheses, they're evaluated in this order: NOT, AND, OR/XOR. `? moon AND sun NOT saturn OR jupiter` becomes `? (moon AND (sun NOT saturn)) OR jupiter` when you probably wanted `? (moon AND sun) NOT (saturn OR jupiter)`
[^3]: Lucene `^` syntax is also supported: `? term^3`. Note that there cannot be a space between the term and the carat; `? term ^3` is invalid, as it's impossible to determine if it should be a weight or a literal.
[^4]: The full fold class WA uses is ['‘’‚‛ʼʹ´′‹›]
[^5]: Lucene `^` is also accepted: `? (copper pipe)^3`