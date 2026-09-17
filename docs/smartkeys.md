# SmartKeys

A SmartKey is a key with some (optional) special features. They can be identified with their leading `?` character[^1]. `astronaut` is a plain keyword; `? astronaut` is a SmartKey (albeit one that behaves identically).

For how a key matches in general— substring, word boundaries, orthography, regex behaviour — see [How WorldsApart matches keys](matching.md).

## Quick reference

> [!TIP]
> ```
> ? moon mission -apollo            implicit AND; a leading - negates
> ? "moon mission" OR cosmonaut     quoted phrase; AND / OR / NOT / XOR
> ? =cat                            = whole word
> ? ^NASA                           ^ case-sensitive
> ? ^=NASA                          flags combine, in either order
> ? fire::2.5                       ::N weights the term
> ? (rain OR snow) -indoors         parentheses group
> ? /co(l|s)monaut/i landed         /pattern/flags is a term
> ? (moon mission)~3                ~N: up to 3 words between moon and mission
> ```

---

## Whole-word and Case-Sensitive Flags

The first feature of a SmartKey is the ability to apply whole-word matching or case sensitive matching to *the single key only*. SillyTavern requires all keys in an entry to have the same behavior; SmartKeys allow you to get granular.

The `=` flag makes a term (that is, a part of a SmartKey; more on this later) use whole-word matching.
`? cat` matches `catapult`, same as plain keyword `cat`.
`? =cat`, on the other hand, ensures that only the literal word `cat` matches.

The `^` flag makes a term case-sensitive in the same way.
`? NASA` matches `nasal` and `NASA space program` (remember: terms are substring-matched unless you use `=`!)
`? ^NASA` matches `NASA space program` and `NASAL` but not `nasal`.

You can combine them to get very specific: you probably actually want `? =^NASA` for the space agency. (You can write the flags in any order; `? ^=NASA` and `? =^NASA` are equivalent in every way.)

> [!NOTE]
> SmartKeys flags (or lack thereof) take precedence over the entry's own settings. `? NASA` is always case-insensitive and substring-matched even if the entry has case sensitivity and whole-word matching on. This is what allows you to be more granular with your keys, mixing `? =^NASA` and `? astronaut` to get you "NASA space program" and "Apollo 11 astronauts Neil Armstrong and Buzz Aldrin" (note the plural!) but not "nasal decongestant".

## Operators

Sometimes you might want a word only when it appears with other words, or only when another word *isn't* present, or any of several words. SmartKeys uses boolean operators to accomplish this; they read pretty naturally so they don't require too much explanation:

```
? moon AND mission              both
? apollo OR soyuz               either
? astronaut NOT armstrong       astronaut, where armstrong is absent
? apollo XOR soyuz              one of them, not both (i.e., "exclusive OR")
```

Each of those individual parts is a **term**. `? moon AND mission` is one key with two terms; the operator doesn't count as one.

You can combine as many terms as you want:

```
? moon AND mission AND astronaut AND Armstrong
? moon OR sun OR mars OR jupiter OR saturn
? moon AND sun OR star AND jupiter OR saturn
```

As you can see, when you begin to combine them, things get a bit hard to work out— is that `moon AND sun` OR `star AND jupiter`, or `moon` AND  `sun OR star`? For these cases, you'll want to use groups to make your intent clear: `? moon AND (sun OR star) AND (jupiter OR saturn)`[^2]. These groups can nest: `? ((orion AND pegasus) OR (saturn AND jupiter)) AND telescope`— you need either stars or planets plus telescope. You can nest groups up to 100 deep; if you need more than that, email the maintainer and beg absolution for your sins.

> [!NOTE]
> A key built only on negation (e.g., `? NOT water`) is refused in nearly every case, as it would match basically every message. It is only usable as a secondary key, where AND_ALL reads it as written and the NOT operators invert it (i.e., `NOT(NOT water)`, which is the same as requiring `water`). AND_ANY drops it entirely because it negates the entire gate.

## Operator Spelling

There are a few different ways you write the operators.

`AND` = `and` = `&`
`OR` = `or` = `|`
`NOT` = `not` = `-` (hyphen/minus) = `!`
`XOR` = `xor` (it has no symbol representation)

This means that `? moon AND (sun OR star) AND (jupiter OR saturn)` and `? moon and (sun | star) & (jupiter || saturn)` are perfectly equivalent, if somewhat difficult to read; pick one and stick with it (symbolic is most concise: `? moon & (sun | star) & (jupiter | saturn)`)

You might sometimes want to use a term that contains one of these symbols; `? "AT&T"` gets you the company, where `? AT&T` is a two term expression equivalent to `? at AND t`. This works for just about any symbol in the grammar; `? "()"` gets you a Sigur Rós album, where `? ()` evaluates to nothing and matches nothing; `? "/hello/"` includes literal forward slashes and is not a regex. It's worth noting, however, the exception: quotation marks do *not* escape hyphen expansion. `? "sci-fi convention"` will match `we went to the sci fi convention` so you don't have to think about it; if you want the literal span including hyphen, just use a plain regex `/sci-fi convention/`.

> [!TIP]
> Single and double ampersand and pipe are the same operator, so write `&` or `&&`, `|` or `||`, whichever you prefer.

## Implicit AND and Quote Escaping

Since AND is the most common operator, we assume it whenever an operator is not provided; `? moon mission` is equivalent to `? moon AND mission`. In many cases, this helps expressions read more easily, like `? apollo OR (moon mission)`. This, however, means that multi-word SmartKeys do not behave the same as multi-word plain keywords; `? apollo astronauts` gets you `the astronauts of the Apollo mission` where plain `apollo astronauts` does not. Sometimes this is desirable and sometimes this is not; `? Neil Armstrong` gets you `Neil's Stretch Armstrong toy`. In those cases, you can use quotes for a literal match: `? "Neil Armstrong"`. In the simple case, this is directly equivalent to plain keyword `Neil Armstrong`, so you might consider using that instead. Where it begins to matter is in more complex expressions: `? "Neil Armstrong" astronaut`.

Quoted phrases can use the whole-word match and case-sensitive flags like any other term:
`? ^"Navy SEAL"` does not match `navy seal`; `? ="cat scan"` matches `get a CAT scan` but not `a new CAT scanner`.

| expression | equivalent to |
|---|---|
| `? moon mission` | `? moon AND mission` |
| `? moon mission -apollo` | `? moon AND mission AND NOT apollo` |
| `? moon mission "Neil Armstrong"` | `? moon AND mission AND "Neil Armstrong"` |

## Key Scores and Weighting

Matches are assigned scores that help determine the relevancy of a lorebook entry. Broadly, the score attempts to capture how many "things" the match is about.

A plain term scores one: `? moon` or its equivalent `moon` are about one thing.

An AND turns two terms into one thing: `? moon mission` is only valid if both of those terms are present. `? moon mission` is more specific than `moon` alone, so we judge it to be more relevant, and assign it a score of two (1 + 1). Likewise, `? apollo astronaut neil armstrong` is four-things-as-one, so when it matches, it gets a score of four.

An OR, on the other hand, is about options. A chat might call them glasses or spectacles, and both are equally good; `? glasses OR spectacles` is therefore only as good as each term separately, and each match is assigned a score of one.

Sometimes, however, different terms are differently specific or relevant. If a lorebook entry is about the pair of Ray-Bans that a beloved relative bought your character, you might decide that `sunglass` is an okay term, but `Ray-Bans` is much better. In that case, you can weight the score with the double-colon modifier: `? Ray-Ban::5`[^3], saying "Ray-Ban is a much more important term than any other". A term anywhere in an expression can be weighted: `? (sunglass OR Ray-Ban::5)` means that if it matches on `sunglass` or `sunglasses`, it gets a score of one, but if it matches `Ray-Ban`, it gets five. Groups themselves can also be weighted: `? (sunglass OR ray-ban)::5`

| key | text | matches | score |
|---|---|---|---|
| `? sunglass OR ray-ban` | `I got new Ray-Bans` | Yes | 1 |
| `? sunglass OR ray-ban` | `I got new sunglasses` | Yes | 1 |
| `? sunglass OR ray-ban::5` | `I got new Ray-Bans`| Yes | 5 |
| `? sunglass OR ray-ban::5` | `I got new sunglasses`| Yes | 1 |
| `? (sunglass OR ray-ban)::5` | `I got new Ray-Bans`| Yes | 5 |
| `? (sunglass OR ray-ban)::5` | `I got new sunglasses`| Yes | 5 |
| `? (sunglass OR ray-ban::5)::5` | `I got new sunglasses`| Yes | 5 |
| `? (sunglass OR ray-ban::5)::5` | `I got new Ray-Bans`| Yes | 25 |
| `? sunglass AND ray-ban` | `I got new Ray-Bans`| No | 0 |

<sub>(XOR behaves identically to OR in these examples)</sub>

It is possible to assign a score of `::0`; in this case, the term is not scored, but only used as a gate. This can be useful for keys that otherwise might overlap: `? saturn OR venus OR (mercury AND planet::0)`, which allows you to specify the planet instead of the singer or the car without it scoring higher than the other planets.

### What about multiple matches?
While you might expect two hits to be worth twice one hit, to prevent keys that have common terms from vastly outweighing keys with less-common terms, we use a saturation curve. On a single unweighted term, one match is worth one. Ten matches is worth about three. OR groups are saturated against all of their terms in any combination; `? sunglass OR ray-ban` may have 2 sunglass hits and 3 Ray-Ban, or five sunglass and no Ray-Ban, but it's still five hits. This can intersect unexpectedly with weights.

Against *"I got new Ray-Ban sunglasses"*:

| key | count | score |
|---|---|---|
| `? sunglass OR ray-ban` | 2 | 1.6061 |
| `? sunglass OR ray-ban::5` | 2 | 4.8184 |
| `? (sunglass OR ray-ban)::5` | 2 | 8.0307 |
| `? sunglass XOR ray-ban` | 0 | 0 |
| `? sunglass AND ray-ban` | 2 | 2 |
| `? sunglass::0 AND Ray-Ban` | 1 | 1 |

The math is not super important; just know that the scores you're expecting may not line up exactly with the scores actually assigned.

## Regex Terms

A regular expression inside a SmartKey is a term like any other: it can take an operator, be negated, and carry a weight.

```
? /(astro|cosmo)naut/ landed    a pattern AND a word
? /apples?/ /bananas?/          two patterns
? -/drill/ fire                 a negated pattern
? /fire/::3                     weighted, like any term
```

There are a few things to watch out for:
- A term is read as a regex only when it begins and ends with a forward slash; `? /24-7/` is a regex, `? 24/7` is four literal characters, `? /home/user/file` is also literal.
- Regexes can be escaped with quotes; `? "/re/"` is literal four-character `/re/`.
- Two (or more) regexes expect a space between them; `? /apples?/bananas?/` is one regex that contains apple with optional s, a literal forward slash, and banana with optional s.

For more on how a pattern itself matches — flags, folding, `\b`, anchors — see the [matching documentation](matching.md#regex-keys).

## Proximity

Sometimes a group of words is only useful when they're close to each other. Consider `? copper pipe`. This gets you `a copper pipe` and `a pipe made of copper`, but it also gets you `Pipes are made of PVC, and come in several stylish colors including white, black, silver, copper, and gold.`. In these cases, you might consider a proximity match. (This section gets complicated, so it might take a couple of reads— highly recommend trying things in the Lab to see how they work.)

You need two things for a proximity match: a group of things delimited by parenths, and a slack value, delimited by a tilde (`~`) character. `? (mission mars)~2` means "both of these words, with at most 2 words in between them", or "mars within 2 words of mission".

> `a mars mission`: Match
> `the mission to Mars`: Match (1 word in between; order doesn't matter)
> `Missions have slowed in recent years, and Mars seems unlikely`: No match (6 words in between)

`~0` is a useful case because it means "the words can be in either order as long as they're next to each other": `? (Akira Kurosawa)~0` gets you both Western style `Akira Kurosawa`, family name last, and Eastern style `Kurosawa Akira`, family name first. Note that this only applies to *words*, not punctuation: `Born in Kurosawa, Akira had two brothers` matches. For strict phrasal order invariance, use an OR group: `? ("Akira Kurosawa" OR "Kurosawa Akira")`.

Groups can be used as proximity terms; proximity is counted from whatever hits. `? ((Neil OR Yuri) Porsche)~3` matches `Neil and his husband Yuri bought a Porsche` because `Yuri` is separated from `Porsche` by 2 words. Note that the proximity operator is distributive: `? ( (john james) adams)~0` gets you `John James Adams` and not `John and his big brother James Adams`, but could also get you `John Adams Jameson`. To insist that the inner group stay together, you can assign slack there as well: `? ((john james)~0 adams)~0` gets you `John James Adams`, `James John Adams`, but not `John Adams Jameson`. XOR behaves as expected: `? ((john XOR quincy) adams)~1` gets you `John James Adams` and `Quincy Adams` but not `John Quincy Adams` (which the simpler `? ((john OR quincy) adams)~1` would match on).

Negation works in just the same way. `? (fire -drill)~1` means "any use of the word `fire` as long as `drill` is not within 1 word". So `there was a great fire` matches, `we had a fire drill` does not, and `Home Depot sells drills, saws and fire extinguishers` matches because there are two words in between where the simpler `? fire -drill` would exclude it even though it's not discussing fire drills. An entire group can likewise be negated: `? (fire -(drill today))~2` is "any use of fire UNLESS both drill and today are within 2 words". So `We had a fire drill today` does *not* match (`drill` and `today` are both within 2 of `fire`), but `Today we had a fire drill` *does* match, because only `drill` is within 2 of `fire` while `today` is 3 away. Again: Highly recommend to use the Lab to verify that these keys are doing what you want.

---

## Secondary keys

SillyTavern's only way of writing a boolean condition is the *Secondary Keywords* box, with its AND_ANY / AND_ALL / NOT_ANY / NOT_ALL dropdown. WA reads it exactly as SillyTavern does, so nothing you have already built will behave differently. The problem with this system is that the two boxes only ever say one thing: every primary paired with every secondary, under a single operator, applied with the same case-sensitivity and whole-word criteria.

Say you have an entry about Ash Ketchum's relationship with his Pokémon. In ST, you might write that as ["Ash", "Ketchum"] AND_ANY ["Pikachu", "Bulbasaur", "Charmander"].

That can be written boolean-style as `(Ash OR Ketchum) AND (Pikachu OR Bulbasaur OR Charmander)`. The problem is that ST case-sensitivity and whole-word matching is equally applied to all keys in an entry; if you turn whole-word on so `Ash` doesn't match `Rapidash`, then `Pikachu` no longer matches `Pikachus` and you have to spell it out. Likewise, if you turn on case-sensitivity so that `Ash` doesn't match `the campfire burned to ash`, you miss out on `PIKACHU! I CHOOSE YOU!`. WA, by contrast, allows you to have it all quite simply:
`? (=^Ash OR =^Ash's OR Ketchum OR Satoshi) AND (pikachu OR bulbasaur OR charmander)` gets you everything at the cost of having to spell out `Ash's`.

It also allows you to easily express things that ST simply does not allow:
`? (=^Ash AND pikachu -=^Oak) OR (=^Misty AND squirtle -cerulean)`

> [!WARNING]
> **Secondary keys always apply.** WorldsApart supports secondary keys because one of our goals is that a book performs essentially identically under WA as under ST core. That means that if you have pre-existing secondary keys, they will be applied. So if you have an entry with keys ["Ash", "Ketchum"] AND_ANY ["Pikachu", "Bulbasaur"], if you then add key `? =^Ash AND ^Misty`, the text must contain Ash, Misty, *and* Pikachu or Bulbasaur. You can't exempt keys from this; it's all or nothing. Either you leave the secondary keys and accept that, or you rewrite the conditions as a SmartKey: `? (=^Ash OR ^Ketchum) AND (pikachu OR bulbasaur)`. It's not necessary to delete the secondary keys if you rewrite them— you can simply set them to OFF in case you ever need to port to a non-WA system where the SmartKeys won't work.

---

## Lucene Compatibility

SmartKeys syntax is not meant to be compatible with Lucene. Nonetheless, it has been designed to avoid breaking muscle memory when possible (and boost and proximity syntax were inspired by Lucene). A few things that Lucene users should note:
- SmartKeys uses implicit AND rather than implicit OR— `? apple banana` requires both, not one.
- As a result, the semantics of shared symbols `+` and `!` are slightly different. A fully-marked Lucene query like `? +apple +banana !coconut` parses and means what Lucene means by it, but `? apple +banana` is plain AND — not Lucene's "banana required, apple optional".
- Keys are implicitly substring matched, so wildcards don't exist; consequently `astro*` is always read as a literal asterisk, and a question mark anywhere but the leading position is always literal. If you want an internal wildcard, use regex.
- Fuzzy matching `star~2` does not exist; maybe in a future version.
- Lucene-style quoted proximity `"apple banana"~2` is rejected; you must use a parenth group `(apple banana)~2`.

[^1]: Why a question mark? Because it's easy to see at a glance, easy to parse, and fails as a string match. `? (moon OR planet) AND mission` will never appear in a text, so you'll never get a false positive. Leaving them plain would silently change the semantics of existing keys like `Law and Order` or `Florence & the Machine`.
[^2]: If you don't use parentheses, they're evaluated in this order: NOT, AND, OR/XOR. `? moon AND sun NOT saturn OR jupiter` becomes `? (moon AND (sun NOT saturn)) OR jupiter` when you probably wanted `? (moon AND sun) NOT (saturn OR jupiter)`
[^3]: Lucene `^` syntax is also supported: `? term^3`. Note that there cannot be a space between the term and the caret; `? term ^3` is invalid, as it's impossible to determine if it should be a weight or a literal.