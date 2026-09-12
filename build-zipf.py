#!/usr/bin/env python3
# Builds the packed Zipf table for extension/zipf-<lang>.js from wordfreq (CC BY-SA); needs `pip install wordfreq`.
# Usage: python3 build-zipf.py [--lang en] [--out extension/zipf-en.js]
# Rewrites only the PACKED line of an existing file, so the POS sets beside it are kept; a new file gets empty POS sets.
import argparse, re, sys
import wordfreq

FLOOR = 3.0   # the suggester's rare line: absence from the table means z < 3.0
ap = argparse.ArgumentParser()
ap.add_argument('--lang', default='en')
ap.add_argument('--out', default=None)
a = ap.parse_args()
out = a.out or f'extension/zipf-{a.lang}.js'
lists = wordfreq.available_languages('large')
size = 'large' if a.lang in lists else 'best'
if a.lang not in wordfreq.available_languages('best'):
    sys.exit(f'wordfreq has no list for "{a.lang}"; it has: {" ".join(sorted(wordfreq.available_languages("best")))}')
bands = {}
for w in wordfreq.iter_wordlist(a.lang, size):          # descending frequency
    dz = int(round(wordfreq.zipf_frequency(w, a.lang, size) * 10))   # the decile IS the value: floor and readers must agree on it
    if dz < FLOOR * 10:
        break
    if not re.fullmatch(r"[^\W\d_](?:[^\W\d_]|')*", w):   # a word, not a number or a mark
        continue
    bands.setdefault(dz, []).append(w)
packed = ';'.join(f"{dz}:{' '.join(ws)}" for dz, ws in sorted(bands.items(), reverse=True))
line = f"const PACKED = `{packed}`;"
try:
    src = open(out, encoding='utf-8').read()
    new, n = re.subn(r"^const PACKED = `[^`]*`;", lambda _: line, src, count=1, flags=re.M)
    if n != 1:
        sys.exit(f'{out} has no PACKED line to replace')
except FileNotFoundError:
    new = (f"{line}\nconst VA95 = ``;\nconst VA85 = ``;\nconst ADJ85 = ``;\n"
           f"// {a.lang} Zipf table from wordfreq {size}; z >= {FLOOR} only, quantised to 0.1 and packed as `decizipf:words`. POS sets: none for this language.\n"
           f"export const ZIPF_{a.lang.upper()} = (() => {{ const m = new Map(); for (const row of PACKED.split(';')) {{ const i = row.indexOf(':'), z = Number(row.slice(0, i)) / 10; for (const w of row.slice(i + 1).split(' ')) m.set(w, z); }} return m; }})();\n"
           f"export const POS_VA_STRICT = new Set(), POS_VA = new Set(), POS_ADJ = new Set();\n")
open(out, 'w', encoding='utf-8').write(new)
print(f'{out}: {sum(len(v) for v in bands.values())} words at z >= {FLOOR}, wordfreq {size} "{a.lang}"')
