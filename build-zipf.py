#!/usr/bin/env python3
# Builds one language pack — the Zipf table, POS sets and common list — as extension/zipf-en.js (English, bundled) or
# wa-pack-<lang>.json (fetched). Needs `pip install wordfreq`.
# English, from Google Books eng-fiction 1-grams (CC BY 3.0) with wordfreq (CC BY-SA) gating the vocabulary:
#   curl -O http://storage.googleapis.com/books/ngrams/books/20200217/eng-fiction/1-00000-of-00001.gz
#   curl -O http://storage.googleapis.com/books/ngrams/books/20200217/eng-fiction/totalcounts-1
#   python3 build-zipf.py --ngrams 1-00000-of-00001.gz --totals totalcounts-1
# Any other language, from wordfreq alone (no POS sets):  python3 build-zipf.py --lang de --out wa-pack-de.json --index packs.json
# Every output carries the licence line the README's 'Data sources and licences' section explains; keep the two in step.
import argparse, gzip, hashlib, importlib.metadata, json, math, os, re, sys
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
ap.add_argument('--index', help="packs.json to add or replace this pack's entry in")
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
else:
    for w in wordfreq.iter_wordlist(a.lang, size):          # descending frequency
        dz = decile(wordfreq.zipf_frequency(w, a.lang, size))
        if dz < FLOOR * 10: break
        if WORD.fullmatch(w): bands.setdefault(dz, []).append(w)

packed = ';'.join(f"{dz}:{' '.join(sorted(ws))}" for dz, ws in sorted(bands.items(), reverse=True))
fields = {k: ' '.join(sorted(v)) for k, v in (pos or {'VA95': [], 'VA85': [], 'ADJ85': []}).items()}
# common: top 2000 alpha words of length >= 2; for the ngrams source, minus words fiction capitalises >= 95% of the time (names)
NAME_SHARE = 0.95
common = [w for w in wordfreq.top_n_list(a.lang, 2000, wordlist=size)
          if w.isalpha() and len(w) >= 2 and (not a.ngrams or capped.get(w, 0) / max(1, count.get(w, 0)) < NAME_SHARE)]
LABELS = {'en': 'English', 'fr': 'Français', 'es': 'Español', 'pt': 'Português', 'ru': 'Русский', 'pl': 'Polski', 'de': 'Deutsch'}
pack = {
    'lang': a.lang, 'label': LABELS.get(a.lang, a.lang),
    'source': (f'Google Books eng-fiction 20200217 (years >= {Y0}) + ' if a.ngrams else '') + f'wordfreq {importlib.metadata.version("wordfreq")} {size}',
    'license': 'CC BY 3.0 (Google Books Ngram) / CC BY-SA 4.0 (wordfreq)' if a.ngrams else 'CC BY-SA 4.0 (wordfreq)',
    'packed': packed, 'va95': fields['VA95'], 'va85': fields['VA85'], 'adj85': fields['ADJ85'],
    'common': ' '.join(common),
}
pack['hash'] = hashlib.sha256('|'.join(pack[k] for k in ('packed', 'va95', 'va85', 'adj85', 'common')).encode('utf-8')).hexdigest()
body = json.dumps(pack, ensure_ascii=False, separators=(',', ':'))
if out.endswith('.js'):
    header = ('// Data: Google Books Ngram eng-fiction 20200217, CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/); vocabulary, common list\n'
              '// and every other language from wordfreq (Robyn Speer), CC BY-SA 4.0 — see README, Data sources and licences.\n'
              '// The bundled English pack: the same object every fetched wa-pack-<lang>.json carries (lang.mjs usePack). Rebuild: build-zipf.py.\n'
              '// packed: `decizipf:words` bands, z >= 3.0 only, so absence means rare; va95/va85/adj85: dominant-POS sets; common: top 2000.\n')
    open(out, 'w', encoding='utf-8').write(header + f'export const PACK = {body};\n')
else:
    open(out, 'w', encoding='utf-8').write(body + '\n')
if a.index:
    try: index = json.load(open(a.index, encoding='utf-8'))
    except FileNotFoundError: index = {}
    index[a.lang] = {'label': pack['label'], 'bytes': len(body.encode('utf-8')) + 1, 'hash': pack['hash']}   # the file is wa-pack-<lang>.json by convention
    open(a.index, 'w', encoding='utf-8').write(json.dumps(dict(sorted(index.items())), ensure_ascii=False, indent=1) + '\n')
print(f"{out}: {sum(len(v) for v in bands.values())} words at z >= {FLOOR}; POS {len(pos['VA95']) if pos else 0}/{len(pos['VA85']) if pos else 0}/{len(pos['ADJ85']) if pos else 0}; common {len(common)}; hash {pack['hash'][:8]}")
