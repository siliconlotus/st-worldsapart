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

In SillyTavern: **Extensions → Install extension**, and paste

```
https://github.com/siliconlotus/st-worldsapart
```

The box will also ask you which branch you want; we use the same branch names as ST:
- Release (default) is the stable version, updated when we're sure everything works
- Staging gets new features and fixes first, but may have some instability.

Updates stay on the channel you chose. SillyTavern checks at startup and tells you when one is waiting; it installs
updates by itself only when SillyTavern's own version changes.

### Server plugin
> [!IMPORTANT]
> **WorldsApart ships with a plugin.** SillyTavern loads extensions and server plugins separately, so after installing the extension you will need to deploy the plugin using your system's command line terminal. It is not strictly *necessary* to install the plugin, but it is ***very highly recommended***. Without the plugin, WA falls back to SillyTavern's stock vector search. Entries still get retrieved by similarity, but ST's endpoint doesn't return the similarity scores, so relevance is predicted from text, proper nouns and density alone — technically still better than ST alone, but noticeably worse than with the plugin (about four points of F2 across all entries, concentrated on vectorized entries).

From your SillyTavern root folder, run:
```bash
node public/scripts/extensions/third-party/st-worldsapart/deploy-plugin.mjs
```

This does two things:
- It copies the plugin files from the extension install into the plugins/ directory
- It edits your config.yaml to set `enableServerPlugins: true`, because plugins are off by default.
(If you would like to verify that that's true, see [deploy-plugin.mjs](deploy-plugin.mjs))

Then restart SillyTavern.

On restart the server console prints `[WorldsApart] server plugin ready`, and WA settings show
**✓ Server plugin active** — with a copyable redeploy command that's now a full absolute path (the
running plugin reports the SillyTavern root, so you can run it from any terminal, not just the ST
folder).

**After changing anything in `plugin/`**, re-run the deploy command and restart — no version to bump.
The extension fingerprints its source copies of those files and the running plugin fingerprints its
deployed copies (`/ping`); if they differ, WA settings
shows **⚠ Server plugin out of date — redeploy**. The check fires only when those files actually
changed, so unrelated extension updates never trigger it.

---

### Languages

WA has UI internationalization in English and French, and offers text corpus statistics to improve retrieval in several languages (see WA settings or https://github.com/siliconlotus/st-worldsapart-lang for the current list.)

### Contributing

Branch from `staging`, PR against `staging`, run `test/`. [CONTRIBUTING.md](CONTRIBUTING.md) has the rest.

### Data sources and licenses

The code is MIT. Two generated data files carry their own terms, stated in their headers:

- `extension/wa-pack-en.js` — the bundled English pack: word frequencies and part-of-speech sets from the
  [Google Books Ngram](https://books.google.com/ngrams/) eng-fiction corpus, version 20200217, licensed under
  [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), and a common-word list derived from
  [wordfreq](https://github.com/rspeer/wordfreq) by Robyn Speer, whose data is
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), so the file is too. wordfreq's own sources include
  Google Books Ngrams, Wikipedia, OPUS OpenSubtitles 2018, ParaCrawl, the Leeds Internet Corpus, and the SUBTLEX word
  lists by Marc Brysbaert et al., which are freely available data and are credited here as wordfreq requires.

[^1]: Unless the sum of constant entries exceeds the entire budget