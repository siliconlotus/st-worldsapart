# WorldsApart for SillyTavern
WorldsApart is set of tools for SillyTavern that allow a user to manage their lorebooks, their entry keywords, and the selection and insertion of lorebook entries into the prompt.

Keys get their own page: **[SmartKeys](docs/smartkeys.md)** — the `?` boolean expression syntax, and how WA
matches every kind of key (substring by default, what the fold normalises, word boundaries, the
Lucene delta).

## Install

In SillyTavern: **Extensions → Install extension**, and paste

```
https://github.com/siliconlotus/st-worldsapart
```

That installs the **release** channel, which is what you want unless you have a reason to want
otherwise. To follow **staging** instead — fixes and features before they are released, and the place to
report a bug you want fixed quickly — pick `staging` in the branch box when installing, or switch later
with the branch control on WA's entry in the extensions list.

Updates stay on the channel you chose. SillyTavern checks at startup and tells you when one is waiting; it installs
updates by itself only when SillyTavern's own version changes.

**Staging users:** when an update changes anything under `plugin/`, re-run the deploy command below and
restart SillyTavern. WA tells you when this is needed — the settings panel shows **⚠ Server plugin out of
date** and a notification that does not dismiss itself.

## Languages

The interface follows SillyTavern's own language setting; French ships in `i18n/fr-fr.json`, and a new locale
is one JSON file declared in `manifest.json`, drafted from `node test/i18n-check.mjs --dump`. The **Language**
setting under *Audit & suggestions* is a different thing: it picks the word-frequency pack the keyword
suggester and audit read (see *Data sources and licences*), so a French speaker can run an English UI over a
French lorebook, or the reverse.

## Server plugin (optional, enables mean-centered search)

The extension works on its own, but its best retrieval mode — **mean-centered vector
search** — runs in a small server plugin that ships inside this repo. SillyTavern loads
extensions and server plugins separately, so after installing the extension you deploy the
plugin once. The plugin's files all live in `plugin/` in this repo so the extension and its
server half stay a single unit; `/plugins/worlds-apart/` is a generated (flattened) copy.

From your SillyTavern folder (one command, works on Windows / macOS / Linux — it copies the
plugin **and** flips `enableServerPlugins: true` in `config.yaml`, which is off by default):

```bash
node public/scripts/extensions/third-party/<this-extension-folder>/deploy-plugin.mjs
```

Then restart SillyTavern.

On restart the server console prints `[Worlds Apart] server plugin ready`, and WA settings show
**✓ Server plugin active** — with a copyable redeploy command that's now a full absolute path (the
running plugin reports the SillyTavern root, so you can run it from any terminal, not just the ST
folder). Without the plugin, WA falls back to SillyTavern's stock vector search — everything still
works, just without mean-centering.

**After changing anything in `plugin/`**, re-run the deploy command and restart — no version to bump.
The extension fingerprints its source copies of those files and the running plugin fingerprints its
deployed copies (`/ping`); if they differ, WA settings
shows **⚠ Server plugin out of date — redeploy**. The check fires only when those files actually
changed, so unrelated extension updates never trigger it.

## Contributing

Branch from `staging`, PR against `staging`, run `test/`. [CONTRIBUTING.md](CONTRIBUTING.md) has the rest.

## Data sources and licences

The code is MIT. Two generated data files carry their own terms, stated in their headers:

- `extension/wa-pack-en.js` — the bundled English pack: word frequencies and part-of-speech sets from the
  [Google Books Ngram](https://books.google.com/ngrams/) eng-fiction corpus, version 20200217, licensed under
  [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), and a common-word list derived from
  [wordfreq](https://github.com/rspeer/wordfreq) by Robyn Speer, whose data is
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), so the file is too. wordfreq's own sources include
  Google Books Ngrams, Wikipedia, OPUS OpenSubtitles 2018, ParaCrawl, the Leeds Internet Corpus, and the SUBTLEX word
  lists by Marc Brysbaert et al., which are freely available data and are credited here as wordfreq requires.

Packs for other languages live in [st-worldsapart-lang](https://github.com/siliconlotus/st-worldsapart-lang), built by
`build-zipf.py` from wordfreq data under the same CC BY-SA 4.0 terms; the extension fetches one on first use.
