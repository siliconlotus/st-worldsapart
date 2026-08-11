---
title: Extend the sentinel fixture with an inclusion group for the deletion path
date: 2026-08-10
priority: high
---

Bucket 1.5's deletion direction is untestable against real data: 0 of 2,112 enabled entries are in an
inclusion group. The sentinel fixture (`eval/fixtures/`, installed by `eval/install-sentinel.mjs`)
needs a group before deletion can ship — matcher-design.md rules the fixture a prerequisite for
deletion either way.

The group must contain:

- **A false winner**: `matchWholeWords` on, an ASCII-ending key whose adjacent text character is
  non-ASCII — e.g. key `caf` with fixture text containing "café". Core's `\W` reads `é` as a word
  boundary and matches (upstream-st.md #1); WA's `WORD_CHAR` rejects. Note the direction: the
  non-ASCII character is in the *text* adjacent to the match, not in the key — `café` against
  "cafés" is correctly rejected by core and is not a divergence.
- **A clean loser**: a plain key both matchers accept, lower group priority than the false winner.

What it certifies: WA deletes the false winner at `WORLDINFO_SCAN_DONE`, and the group goes **empty**
for that turn — the clean loser is not promoted. That is the ruled bucket 1.5 behaviour (no group
guard, no loser promotion), transient until bucket 2's matcher-before-group-filter ordering lets the
loser win naturally. The fixture's written verdicts should record the empty group as expected, so the
same fixture flips to expecting the loser once bucket 2 lands.
