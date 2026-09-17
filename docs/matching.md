# How WorldsApart matches keys

A World Info key in WA can be one of three things:

| Form | Example | What it is |
|---|---|---|
| plain key | `moon mission` | substring match, the SillyTavern default |
| regex | `/co(l\|s)monaut/i` | a regular expression, as core already supports |
| **SmartKey** | `? moon mission -apollo` | a boolean expression — a leading `?` opts in |

One key is one item in the Keywords box (comma-separated in ST, chips in Studio), whichever of those three forms it takes. *Keyword* means the plain form specifically, the one that gets matched as text; ST keys come in two forms: keywords and regexes. SmartKeys divide into *terms*, their operational parts: `? moon AND mission` is one key holding two terms.

This page is about how any key matches. The `?` syntax has its own page: [SmartKeys](smartkeys.md).

---

## Plain keys mostly behave the same

In SillyTavern, a keyword is an exact substring match, so the term `moon` matches `honmoon` unless whole-word matching is enabled for the entry. A plain keyword in WorldsApart (WA) behaves exactly the same way; none of your existing keys will behave differently, with one exception: SillyTavern for some reason skips whole-word matching on multi-word terms (e.g., terms that contain a space like `hot tub`) and applies substring matching, so `hot tub` matches `hot tubs` and `hot tubing`. WA corrects this, so it behaves as intended and does not match.

## In some situations, they may behave differently

### Tags

**HTML and XML tags and comments are blanked out before a literal key is matched.** The keys `size` and `div` will not match `<div style="font-size:13px">` or `<!-- this div's size is too big -->` like it would under ST's own matching system. If you want to match tag contents, use a regex.

### Orthographic Normalization

WA generally tries to match an author's likely intent when matching: "**what you meant, not what you wrote**". A user who writes the key `Cap'n Crunch` probably wants it whether the apostrophe is the straight form from their keyboard or the fancy curly form that displays sometimes, and LLMs frequently emit both on an inconsistent basis. Consequently, WA normalizes a few classes of characters to ensure consistent matching regardless of variant forms being used and to allow easy creation of keys without worrying too much about representation.

| class | written | matches |
|---|---|---|
| Apostrophes, single quotes, and ticks | `'` `’` `‘` `‚` `‛` `ʼ` `ʹ` `′` `´` `` ` `` `‹` `›` | each other |
| Double quotes | `"` `“` `”` `„` `‟` `″` `ʺ` `«` `»` | each other |
| Em dash | `—` | `--` (two hyphens) |
| En dash | `–` | `-` (one hyphen) |
| Ellipsis | `…` | `...` (three periods) |
| Spaces | non-breaking space | ordinary space |
| Accents and combining marks | decomposed `José` (`e` + a combining acute) | composed `José` (NFC, the single letter `é`) |

What this means is that **you don't need to care about any of this** — you can write whatever way is comfortable to you without needing to think about variant keys for whatever the model may be spitting out. If any of your keys use any of these marks, it's very likely that SillyTavern wasn't matching them in some cases where you would have expected it to.

The "what you meant, not what you wrote" principle extends to hyphens; WA expands word-internal hyphens to spaces so that `mother-in-law` also matches `mother in law`, because often the hyphen is a matter of taste or convention. If you specifically want the hyphen, write the key as a regex: `/mother-in-law/`. (The reverse is not true — key `mother in law` will not match `mother-in-law` in the chat, because it would require turning every space in the chat into a hyphen). Leading and trailing hyphens are exempted from the expansion (e.g., `-gate` will only match `bridge-gate`, not `the bridge gate is broken`.)

> [!TIP]
> **Hyphens are a one-way journey**. If you think the hyphenated form might appear in the text, it's best to draft the key with them; if the text doesn't use them, it will still match, but if you write a non-hyphenated key and the model uses hyphens, it won't.

> [!NOTE]
> WA does *not* strip accents like some systems do; `cafe` does not match `café`. Use an OR group to capture accent variants if they might arise: `? =cafe OR café`

---

## Regex keys

A `/pattern/flags` key is matched by JavaScript's own engine on the text, NFC-normalised but otherwise unfolded. Everything here is true of a whole-key regex and of a `/…/` term inside a SmartKey alike.

- Flags supported by JS [dgimsuvy][^1] are allowed: `? /NASA/i` is case-insensitive; note that ST core does not support /d or /v, so if you write a key with them, it will not work on a WA-less install.
- A slash inside the pattern is fine and does not need to be (but can be) escaped. `/(home/user|~/user)/dir/` behaves identically to `/(home\/user|~\/user)\/dir/`. Note that ST core requires the escape, so you might want to use them for portability.
- Regexes are not folded, so `/Cap'n Crunch/` written with only a straight apostrophe will not match `Cap’n Crunch` with a curly one; consider a more robust group like `['‘’]`[^2].
- Whole-word `=` and case-sensitive `^` are not available here. Regexes are case-sensitive without the /i flag and always substring match. If you want to mimic whole-word matching, use a space character or permissive \b:

  | pattern | text | match |
  | --- | --- | --- |
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

Note that JS regex `\w`, `\b` and `\d` are ASCII-only, which can cause unexpected behavior with accented and non-English characters. Additionally, WA normalizes the haystack to composed (NFC) form:

| pattern | text | match | note |
| --- | --- | --- | --- |
| `/André/` | `my friend André and` | true | |
| `/André/` | `my other friend Andréas` | true | |
| `/André/` | `my friend André` | true | both composed: \u00e9 |
| `/André/` | `my friend André` | **false** | Decomposed key e + \u0301, composed text \u00e9 (WA text is always composed); WA will warn you in this case. |
| `/André/` | `my friend André's new` | true | (assuming both composed forms)|
| `/\bAndré\b/` | `my friend André and` | **false** | Fails on a non-ASCII edge; a JS regex span delimited by \b must begin and end with an ASCII character, because \w is `[A-Za-z0-9_]` |
| `/\bAndré\b/` | `my friend André's new` | false |  |
| `/\bAndréas\b/` | `my other friend Andréas and` | true | Only the edge has to be ASCII |
| `/\bAndréas\b/` | `my other friend Andréas's new` | true |  |

This is true even if you force unicode awareness with flags /u and /v. The unicode-aware version of \b is a combined lookahead and lookbehind[^3] `(?<![\p{L}\p{N}\p{M}])` + `(?![\p{L}\p{N}\p{M}])` with the unicode flag /u (e.g., `/(?<![\p{L}\p{N}\p{M}])André(?![\p{L}\p{N}\p{M}])/u`). For this reason, it is recommended to use plain terms if you want to use accented characters and boundary markers, as WA handles this under the hood. Under permissive mode, `? =André` behaves sensibly, matching `my friend André`, `André's new`, and `André-shaped` but not `Andréas`; under strict mode, you must spell out variants like `? (=^André | =^André's | ^André-)`. This also gets you the curly-quotes normalization and normalization to composed form, so typing e + combining acute `André` will match even though the text is always in composed form.

> [!NOTE]
> Regex anchors `^` and `$` are applied against the Match window, not the whole scan. At the default, Paragraph, they anchor once per paragraph (`^` matches at the start of each one); under Message, once per message; under Whole scan window, a bare `^` matches at a single position — the start of the window, however many messages and paragraphs are inside it. Consider `/m`, which anchors at every line break.

Against `/^Dream/`:

`Dream of the Endless is a DC Vertigo character`: Match
`I Have a Dream`: No match
```
Many pieces of once-popular software have since been shuttered.
Dreamweaver, Adobe's once-vaunted web development suite, // No match (segment starts at "Many"; /^Dream/m would have matched)
```

---

## Settings that change matching

**Word boundary**[^3] decides what counts as *inside* a word, for whole-word matching only:

| | inside a word | `Joe` matches |
|---|---|---|
| **Strict** (default) | letters, digits, marks, `-` `'` | *Joe*, not *Joe's* or *Joe-adjacent* |
| **Permissive** | letters, digits, marks | *Joe*, *Joe's* and *Joe-adjacent* |

Neither matches *Joel* — a letter alongside always blocks. `_` is a boundary in both, so `_Joe_` matches: underscore is a word character for programming identifiers, not for prose. **Word boundaries are Unicode-aware**: a word character is any letter, digit or combining mark in any script, so whole-word `caf` does not match `café` and `Мари` does not match `Марию`.

**Match window** is the unit every part of a key must match within — *Paragraph* (the default), *Message*, or *Whole scan window* (SillyTavern's own behaviour). Under *Paragraph*, `? apple banana` needs both words in the same paragraph. A block element's open or close ends a window as a blank line does, so a preset that writes chat bubbles or a tracker panel as `<div>`s gives each one its own; `<b>`, `<em>`, `<span>` and `<br>` do not.

## Known limits

**Scripts without word boundaries.** Chinese, Japanese, Thai, Lao, Khmer and Burmese do not write them, so a whole-word key like `猫` matches where it appears among Latin text or punctuation — a sign name inside an English sentence, or beside `・` `、` `。` — and misses wherever it sits between two characters of running text. Leave the box off for entries keyed in these scripts; the Studio marks the whole-words control on any entry where this applies.

**Markdown.** Chat prose is Markdown and the markup sits in the text being scanned, so emphasis *inside* a word cuts both ways:

```
"*sister*hood"    sisterhood         MISSES  — the asterisks break the substring
"*sister*hood"    sister (=/whole)   MATCHES — the * reads as a word boundary
```

Emphasis around a whole word is fine in every mode; this only bites mid-word. Making `*` a word character would break the case that works, and stripping markup would destroy the asterisk as content.

## Porting to a non-WA SillyTavern

**A book full of SmartKeys loads in a stock SillyTavern**, where the keys never match rather than breaking anything. Core's matcher has no `?` sentinel, so it reads the whole key as literal text that no message contains.

If you write a regex containing unescaped slashes and plan to port it to a non-WA system, escape the slashes: vanilla SillyTavern's matcher refuses any pattern with an unescaped `/` inside and looks for the whole delimited string as literal text instead.

```
/(home/user|~/user)/file/         WA: pattern.   vanilla ST: the literal 25 characters.
/(home\/user|~\/user)\/file/      both: pattern. Identical matches; `\/` is just `/` to a regex.
```

Escaping costs nothing under WA, so a book that may be shared is worth writing the escaped way. The Studio warns on the first row's shape, for a bare `/regex/` key and a `? /re/` term alike.

[^1]: `REGEX_KEY_RE` in `extension/matcher.mjs` is the authority for which flags a key may carry.
      Core's own list is the narrower `CORE_REGEX_KEY_RE` beside it, which is why `/d` and `/v` are WA-only.
[^2]: The full fold class WA uses is ``['‘’‚‛ʼʹ´`′‹›]``. If you need to check it, the authority is `ORTHO_FAMILIES` in `extension/automaton.mjs` — the fold is built from that table, so a character listed here and not there (or the reverse) is this footnote being out of date.
[^3]: `BOUNDARY_CLASSES` in `extension/matcher.mjs` is the authority for both classes: permissive is `[\p{L}\p{N}\p{M}]` and strict adds `-`, `'` and `’`. Neither contains `_`, which is why whole-word `Joe` matches `_Joe_`.
