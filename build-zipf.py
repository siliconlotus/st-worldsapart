#!/usr/bin/env python3
# Builds extension/zipf-<lang>.js: the packed Zipf table and, for the ngrams source, the POS sets. Needs `pip install wordfreq`.
# English ships from Google Books eng-fiction 1-grams (CC BY 3.0), years >= 1980, with wordfreq (CC BY-SA) gating the vocabulary:
#   curl -O http://storage.googleapis.com/books/ngrams/books/20200217/eng-fiction/1-00000-of-00001.gz
#   curl -O http://storage.googleapis.com/books/ngrams/books/20200217/eng-fiction/totalcounts-1
#   python3 build-zipf.py --ngrams 1-00000-of-00001.gz --totals totalcounts-1
# Any other language comes from wordfreq alone, with no POS sets:  python3 build-zipf.py --lang de
# Rewrites the PACKED / VA95 / VA85 / ADJ85 lines of an existing file, so everything else in it is kept.
# Every output carries the licence line the README's 'Data sources and licences' section explains; keep the two in step.
# With --ngrams it also rewrites plugin/commonwords.js: wordfreq's top 2000, alpha and length >= 2, minus words fiction
# capitalises >= 95% of the time (the name test); that file deploys into the plugin, so redeploy after.
import argparse, gzip, json, math, re, sys
import wordfreq

FLOOR = 3.0          # the suggester's rare line: absence from the table means z < 3.0 after rounding to 0.1
Y0 = 1980            # the ngrams year window; fiction volume before this is a different register
POS_MIN = 1000       # tagged occurrences before a word's dominant POS is trusted (OCR junk sits below it)
TAGS = {'NOUN', 'VERB', 'ADJ', 'ADV', 'PRON', 'DET', 'ADP', 'NUM', 'CONJ', 'PRT', 'X', '.'}
WORD = re.compile(r"[^\W\d_](?:[^\W\d_]|')*")

ap = argparse.ArgumentParser()
ap.add_argument('--lang', default='en')
ap.add_argument('--out', default=None)
ap.add_argument('--ngrams', help='Google Books 1-gram file (.gz) for --lang; wordfreq alone without it')
ap.add_argument('--totals', help='the matching totalcounts-1 file')
a = ap.parse_args()
out = a.out or f'extension/zipf-{a.lang}.js'
if a.lang not in wordfreq.available_languages('best'):
    sys.exit(f'wordfreq has no list for "{a.lang}"; it has: {" ".join(sorted(wordfreq.available_languages("best")))}')
size = 'large' if a.lang in wordfreq.available_languages('large') else 'best'

def decile(z): return int(round(z * 10))
bands, pos = {}, None
if a.ngrams:
    if not a.totals: sys.exit('--ngrams needs --totals')
    total = sum(int(c.split(',')[1]) for c in open(a.totals).read().split() if c.strip() and int(c.split(',')[0]) >= Y0)
    known = set(wordfreq.iter_wordlist(a.lang, size))
    count, tags, capped = {}, {}, {}   # capped: occurrences of the word with a capital initial, folded key
    with gzip.open(a.ngrams, 'rt', encoding='utf-8', errors='replace') as f:
        for line in f:
            tok, _, rest = line.partition('\t')
            tag = None
            i = tok.rfind('_')
            if i > 0 and tok[i + 1:] in TAGS: tag, tok = tok[i + 1:], tok[:i]
            if not WORD.fullmatch(tok): continue
            c = 0
            for cell in rest.rstrip('\n').split('\t')[::-1]:   # years ascend, so walk back until the window ends
                y, m, _v = cell.split(',')
                if int(y) < Y0: break
                c += int(m)
            if not c: continue
            w = tok.lower()
            if tag is None:
                count[w] = count.get(w, 0) + c
                if tok[0].isupper(): capped[w] = capped.get(w, 0) + c
            else: tags.setdefault(w, {})[tag] = tags.get(w, {}).get(tag, 0) + c
    for w, c in count.items():
        dz = decile(math.log10(c / total * 1e9))
        if dz >= FLOOR * 10: bands.setdefault(dz, []).append(w)
    pos = {'VA95': [], 'VA85': [], 'ADJ85': []}
    for w, t in tags.items():
        tot = sum(t.values())
        if w not in known or tot < POS_MIN: continue
        top = max(t, key=t.get); share = t[top] / tot
        if top in ('VERB', 'ADV'):
            if share >= 0.95: pos['VA95'].append(w)
            elif share >= 0.85: pos['VA85'].append(w)
        elif top == 'ADJ' and share >= 0.85: pos['ADJ85'].append(w)
    if a.lang == 'en':
        NAME_SHARE = 0.95
        common = [w for w in wordfreq.top_n_list('en', 2000, wordlist=size)
                  if w.isalpha() and len(w) >= 2 and capped.get(w, 0) / max(1, count.get(w, 0)) < NAME_SHARE]
        cw = 'plugin/commonwords.js'
        open(cw, 'w', encoding='utf-8').write(
            "// Data: derived from wordfreq (Robyn Speer), CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/) — see README, Data sources and licences.\n"
            "// Top-2000 English words from wordfreq, alpha and length >= 2, minus words Google Books fiction capitalises >= 95% of the\n"
            "// time (names). Rebuild: build-zipf.py --ngrams (see its header); deploys into the plugin.\n"
            f"export const COMMON_WORDS = new Set(`{' '.join(common)}`.split(' '));\n")
        print(f'{cw}: {len(common)} words')
else:
    for w in wordfreq.iter_wordlist(a.lang, size):          # descending frequency
        dz = decile(wordfreq.zipf_frequency(w, a.lang, size))
        if dz < FLOOR * 10: break
        if WORD.fullmatch(w): bands.setdefault(dz, []).append(w)

packed = ';'.join(f"{dz}:{' '.join(sorted(ws))}" for dz, ws in sorted(bands.items(), reverse=True))
lines = {'PACKED': packed, **({k: ' '.join(sorted(v)) for k, v in pos.items()} if pos else {})}
try:
    src = open(out, encoding='utf-8').read()
    for name, body in lines.items():
        src, n = re.subn(rf"^const {name} = `[^`]*`;", lambda _: f"const {name} = `{body}`;", src, count=1, flags=re.M)
        if n != 1: sys.exit(f'{out} has no {name} line to replace')
except FileNotFoundError:
    src = ''.join(f"const {k} = `{lines.get(k, '')}`;\n" for k in ('PACKED', 'VA95', 'VA85', 'ADJ85'))
    src += (f"// {a.lang} Zipf table; z >= {FLOOR} only, quantised to 0.1 and packed as `decizipf:words`. Built by build-zipf.py.\n"
            f"export const ZIPF_{a.lang.upper()} = (() => {{ const m = new Map(); for (const row of PACKED.split(';')) {{ const i = row.indexOf(':'), z = Number(row.slice(0, i)) / 10; for (const w of row.slice(i + 1).split(' ')) m.set(w, z); }} return m; }})();\n"
            f"export const POS_VA_STRICT = new Set(VA95.split(' ').filter(Boolean));\nexport const POS_VA = new Set([...POS_VA_STRICT, ...VA85.split(' ').filter(Boolean)]);\nexport const POS_ADJ = new Set(ADJ85.split(' ').filter(Boolean));\n")
open(out, 'w', encoding='utf-8').write(src)
print(f'{out}: {sum(len(v) for v in bands.values())} words at z >= {FLOOR}' + (f"; POS sets {', '.join(f'{k} {len(v)}' for k, v in pos.items())}" if pos else '') + f' ({"ngrams" if a.ngrams else "wordfreq " + size})')
