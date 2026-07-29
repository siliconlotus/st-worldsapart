# WorldsApart for SillyTavern
WorldsApart is set of tools for SillyTavern that allow a user to manage their lorebooks, their entry keywords, and the selection and insertion of lorebook entries into the prompt.

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
