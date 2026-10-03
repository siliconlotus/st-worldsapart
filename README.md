![WorldsApart — the lorebooks you deserve](docs/banner.svg)

# WorldsApart for SillyTavern

WorldsApart is a set of tools for SillyTavern that allow a user to manage their lorebooks, their entry keywords, and the selection and insertion of lorebook entries into the prompt. At a high level, it accomplishes three tasks:

## Entry Selection
SillyTavern fills lorebook token budgets through a convoluted process that is similar to (but not actually) the entries' `order` values. This means that often, high-relevancy entries are pushed out of the budget by low-relevancy entries, and some things that you might expect (a constant entry is always in the budget) are not true by construction.

WorldsApart takes over the entry selection and uses relevancy to determine where the budget starts cutting, ensuring that your least-relevant entries are the ones cut. It also shores up some of ST's behavior by making guarantees that constant and sticky entries will always be included[^1], while additionally providing for the promotion of entries that are important but not constant— things like character sheets that you definitely want in the prompt over memories.

## Matcher improvements and SmartKeys
WorldsApart draws from best practices in natural language processing and information retrieval to ensure the system behaves as humanely and efficiently as possible.
- WA handles apostrophe and quote normalization and combining diacritics at the backend, so **you never have to worry about how the model is encoding text** (for more details, see [Matching](docs/matching.md)). If any of your keys use an apostrophe or an accent mark, this was probably affecting you and you didn't even realize it!
- The entire matching system was redesigned to **make matching blazingly fast** (roughly 7x speedup on average as of launch).
- And the most exciting part, **SmartKeys**, a fully-featured boolean match system that allows you to finally decide whether to use case-sensitive and whole-word matching on a **per term** basis instead of the entry as a whole, plus a *lot* more (see [SmartKeys](docs/smartkeys.md))

## Lorebook Studio
WorldsApart includes the Lorebook Studio, an interface designed from the ground up to make managing your lorebooks and entries as easy and pleasant as possible.
- The Explorer tab is like ST's own World Info editor, only much less annoying, and with a wide variety of tools to make bulk editing easier.
- The Bulk Cleanup tab is a way to rapidly identify which of your keys aren't performing and fix or remove them.
- The Key Lab allows you to test your keys against your own chats or any text so you can see how they actually perform live— particularly helpful for those thorny regexes and SmartKeys.

---

## Install

WorldsApart needs SillyTavern 1.17.0 or later.

In SillyTavern: **Extensions → Install extension**, and paste

```
https://github.com/siliconlotus/st-worldsapart
```

The box will also ask you which branch you want; we use the same branch names as ST:
- Release (default) is the stable version, updated when we're sure everything works
- Staging gets new features and fixes first, but may have some instability.

Updates stay on the channel you chose. SillyTavern checks at startup and tells you when one is waiting; it installs updates by itself only when SillyTavern's own version changes.

**In multi-user setups, we strongly recommend installing for all users.** This prevents version drift weirdness for everyone, and also prevents a security issue if you install the plugin [(see below)](#multi-user-warning).

### Server plugin bootstrap
> [!IMPORTANT]
> **WorldsApart ships with a plugin.** SillyTavern loads extensions and server plugins separately, so after installing the extension you will need to deploy the plugin using your system's command line terminal. It is not strictly *necessary* to install the plugin, but it is ***very highly recommended***. Without the plugin, WA falls back to SillyTavern's stock vector search. Entries still get retrieved by similarity, but ST's endpoint doesn't return the similarity scores, so relevance is predicted from text, proper nouns and density alone — technically still better than ST alone, but noticeably worse than with the plugin (about four points of F2 across all entries, concentrated on vectorized entries).

**If you installed WorldsApart for all users:**

From your SillyTavern root folder, run:
```bash
node public/scripts/extensions/third-party/st-worldsapart/deploy-plugin.mjs
```

**If you installed WorldsApart for one user:**

From your SillyTavern root folder, run:
```bash
node data/default-user/extensions/st-worldsapart/deploy-plugin.mjs
```
<sub>(If you installed WA into only the user account of a different user, replace `default-user` with the user handle.)</sub>

<a id="multi-user-warning"></a>

> [!WARNING]
> **The server runs the plugin from whichever install you deploy it from.** If that is a user's local copy in a multi-user setup, that user could replace it and execute arbitrary code on the server (i.e., a substitution attack). Deploying from the all-users install means the admin-controlled copy is the one the server runs.

Then restart SillyTavern.

The script does two things:
- It puts a small loader in the plugins/ directory, which loads the plugin straight from the WorldsApart install you ran it from
- It edits your config.yaml to set `enableServerPlugins: true`, because plugins are off by default.

(If you would like to verify these claims, see [deploy-plugin.mjs](deploy-plugin.mjs))

On restart the server console prints `[WorldsApart] server plugin ready`, and WA settings show **✓ Server plugin active**, with the WorldsApart install it loads.

After installing the plugin the first time, subsequent updates will be automatic and require only a server restart.

---

### Languages

WA has UI internationalization in English and French, and offers text corpus statistics to improve retrieval in several languages (see WA settings or https://github.com/siliconlotus/st-worldsapart-lang for the current list.)

### Contributing

Branch from `staging`, PR against `staging`, run `test/`. [CONTRIBUTING.md](CONTRIBUTING.md) has the rest.

### Credits and licenses

WorldsApart ships with an English language pack, `extension/wa-pack-en.js`, which is indebted to several open language resources, some of which carry their own licenses.

- **[wordfreq](https://github.com/rspeer/wordfreq)** by Robyn Speer: the pack's vocabulary and common-word list. wordfreq's data is licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), and so the pack is too.
- **[SUBTLEX-US](https://www.ugent.be/pp/experimentele-psychologie/en/research/documents/subtlexus)** by Brysbaert & New and **[SUBTLEX-UK](https://shiny.psychology.nottingham.ac.uk/lpzwjv/SUBTLEX-UK/)** by van Heuven, Mandera, Keuleers & Brysbaert: freely available subtitle word frequencies for English, which reach us through wordfreq.
- **[Google Books Ngram](https://books.google.com/ngrams/)**: the eng-fiction corpus (version 20200217) behind the pack's word frequencies and part-of-speech sets. [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).

wordfreq also draws on [Wikipedia](https://wikipedia.org), [OPUS OpenSubtitles](https://opus.nlpl.eu/datasets/OpenSubtitles) 2018, ParaCrawl and the Leeds Internet Corpus.

Other language packs are fetched on demand and built from various sources that might use their own licenses; see [the st-worldsapart-lang repo](https://github.com/siliconlotus/st-worldsapart-lang) for details.

WorldsApart's own code is MIT.

[^1]: Unless the sum of constant entries exceeds the entire budget
