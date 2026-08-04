# External Integrations

**Analysis Date:** 2026-08-04

## APIs & External Services

**Vector Embedding Backends:**
- Ollama (`ollama`) - Supported by plugin via `getOllamaVector` from ST core; configured with API URL and model name
  - SDK/Client: `getOllamaVector` from `../../src/vectors/ollama-vectors.js` (SillyTavern internals)
  - Settings: `v.ollama_model`, `v.ollama_keep`, API URL from textgen settings
  - Used in: `plugin/server.js`, `worldsapart.js`

- Transformers (`transformers`) - Default vector source; delegated to SillyTavern's vector API
  - Settings: Model derived from `transformers_model` setting
  - Used in: `worldsapart.js` vectorRequestBody()

- VLLM (`vllm`) - Vector language model service
  - Settings: `v.vllm_model`, API URL from textgen settings
  - Used in: `worldsapart.js` vectorRequestBody()

- Llamacpp (`llamacpp`) - Local inference engine
  - Settings: API URL from textgen settings
  - Used in: `worldsapart.js` vectorRequestBody()

- Google Palm/MakerSuite (`palm`) - Cloud embedding service
  - Settings: `v.google_model`
  - API key from: Extension settings
  - Used in: `worldsapart.js` vectorRequestBody()

- Extras (`extras`) - Alternative inference endpoint
  - Settings: `extension_settings.apiUrl`, `extension_settings.apiKey`
  - Used in: `worldsapart.js` vectorRequestBody()

## Vector Storage & Indexing

**SillyTavern Vector Storage Integration:**
- HTTP API endpoints (from `worldsapart.js` lines 134-141):
  - `/api/vector/insert` - Insert embeddings into vector collections (called by SillyTavern core)
  - `/api/vector/query` - Query vector collections
  - Borrowing Vector Storage provider configuration from `extension_settings.vectors`

**Worlds Apart Server Plugin - Mean-Centered Vector Search:**
- Location: `plugin/server.js` (deployed to `/plugins/worlds-apart/index.js`)
- Endpoint: `/api/plugins/worlds-apart/query-multi` - Custom retrieval with mean-centered cosine similarity
- Architecture: Mounts on Express router injected by SillyTavern server
- Vestor indexing: Uses `vectra` LocalIndex (`plugin/server.js`, line 34) for on-disk index access
- Features:
  - Loads vector index from disk (matching ST's directory layout: `vectors/<source>/<collectionId>/<model>/`)
  - Computes corpus mean vector (measured: norm ~0.71 in real lorebooks, removing ~70% common direction)
  - Subtracts mean before cosine similarity to improve discriminative power
  - Caches mean and lexical index per collection (invalidates on file mtime/size change)
  - Implements BM25 lexical fallback via `plugin/lexical.mjs`
  - Pools and ranks results via `plugin/scoring.mjs`

**Health Check Endpoint:**
- `/api/plugins/worlds-apart/ping` - Reports plugin status and fingerprint
  - Returns ST root path, plugin version, deployed fingerprint
  - Client compares against source fingerprints to detect out-of-date deployments

## Data Storage

**Databases:**
- No external database
- Vector indexes stored on SillyTavern's filesystem (path: `data/default-user/vectors/`)
  - Index format: JSON files managed by vectra LocalIndex
  - Per-collection caching with mtime validation (`plugin/server.js`, lines 116-122)

**File Storage:**
- SillyTavern filesystem only
- Plugin index location resolved via: `path.join(directories.vectors, source, collectionId, model)`
- File sanitization: `sanitize-filename` applied to source, collectionId, and model name

**State Persistence:**
- Settings saved to SillyTavern's extension storage (via `saveSettingsDebounced`)
- Grading data and samples saved as JSON in `eval/` during development/testing
- Lorebook metadata stored in SillyTavern's world info entries

## SillyTavern Host Application Integration

**Core Hooks (Extension Points):**
1. `WORLDINFO_ENTRIES_LOADED` - `worldsapart.js` suppresses keyword matching on vectorized entries
2. `generate_interceptor` (`worldsApart_intercept`) - Chunked vector retrieval, force-activate ranked winners
3. `WORLDINFO_SCAN_DONE` - Rank everything activated, apply budget constraints, rewrite `entry.order` (ORDER_BASE = 99000)

**Data Structures Imported/Modified:**
- `world_info` - Full lorebook data
- `world_names`, `world_info_include_names` - World/book selection
- `world_info_depth`, `world_info_min_activations`, `world_info_match_whole_words`, `world_info_case_sensitive` - Retrieval settings
- `selected_world_info` - Active world
- `METADATA_KEY` - ST's metadata storage key for world info entries

**Functions from SillyTavern Core:**
- `eventSource`, `event_types` - Extension event system
- `getRequestHeaders()` - Auth headers for API calls
- `getMaxPromptTokens()` - Token budget calculation
- `generateRaw()` - LLM generation (used by grading UI)
- `saveSettingsDebounced()` - Settings persistence
- `substituteParams()` - Variable substitution in queries
- `getExtensionPromptByName()` - Extension template access
- `getSortedEntries()`, `getWorldInfoPrompt()`, `loadWorldInfo()`, `saveWorldInfo()`, `reloadEditor()` - World Info API
- `getTokenCountAsync()` - Tokenization for budget calculations
- `getStringHash()`, `escapeHtml()`, `getCharaFilename()`, `download()` - Utility functions
- `getContext()` - Current chat/character context
- `power_user` - User settings object
- `extension_settings` - Extension configuration storage
- `SlashCommandParser`, `SlashCommand`, `ARGUMENT_TYPE`, `SlashCommandArgument`, `SlashCommandNamedArgument` - Slash command system
- `ConnectionManagerRequestService` - Connection management utilities
- `textgenerationwebui_settings`, `textgen_types` - Text generation backend settings
- `oai_settings` - OpenAI API integration settings
- `Popup`, `POPUP_TYPE`, `POPUP_RESULT` - UI popup system

## Authentication & Identity

**Auth Provider:**
- SillyTavern built-in (depends on ST's authentication scheme)
- Request headers passed via `getRequestHeaders()` for all API calls

**Plugin Authentication:**
- Uses SillyTavern's request context (user directories available to plugin)
- No separate auth mechanism; relies on SillyTavern server security

## Monitoring & Observability

**Logging:**
- Console.log statements in plugin (e.g., `plugin/server.js` line 142):
  - Index loading events with statistics (chunk count, mean vector norm, lexical stats)
- No external logging service
- Extension silently logs to browser console

**Error Handling:**
- Graceful fallback: Client falls back to SillyTavern's stock vector search if plugin unavailable
- Plugin version mismatch detected via fingerprinting (extension warns user: "⚠ Server plugin out of date — redeploy")

## CI/CD & Deployment

**Hosting:**
- SillyTavern server (self-hosted in user's environment)

**Deployment Process:**
- Extension: Installed to `public/scripts/extensions/third-party/WorldsApart/`
- Plugin deployment: Manual run of `node deploy-plugin.mjs`
  - Script copies from `plugin/` to `/plugins/worlds-apart/`
  - Generates `package.json` with ES module type
  - Enables `enableServerPlugins: true` in `config.yaml`
  - Requires SillyTavern restart
- No automated CI/CD; manual deployment required after changes

**Version Control:**
- Extension and plugin source stay in one repo
- Plugin fingerprinting ensures deployed copy matches source

## Environment Configuration

**Required Environment / Settings:**
- SillyTavern Vector Storage extension must be installed and configured
- At least one vector embedding backend configured (Ollama recommended for mean-centered search)
- For server plugin: `enableServerPlugins: true` in `config.yaml`

**Optional Integrations:**
- Grading/evaluation mode (development): Ollama for offline embedding in eval scripts
- Chat-based measurements: Standard test corpus in `eval/eval-data/` (gitignored)

## Webhooks & Callbacks

**Incoming:**
- `/api/plugins/worlds-apart/ping` - Health check (POST)
- `/api/plugins/worlds-apart/query-multi` - Vector query (POST with JSON body)

**Outgoing:**
- None; plugin only responds to requests from client

## Plugin Architecture

**Pure vs ST-Coupled Split (per CLAUDE.md):**

Pure (ST-free, Node-importable):
- `extension/ranking.mjs` - Query building, keyword scoring, RRF fusion
- `extension/keyword-core.mjs` - Keyword extraction and pruning
- `extension/selection.mjs` - Selection logic
- `extension/smartkeys.mjs` - SmartKeys grammar and evaluation
- `extension/sort.mjs` - Sort and tier logic
- `plugin/scoring.mjs` - BM25 and centered cosine scoring
- `plugin/lexical.mjs` - Lexical indexing
- `plugin/vector.mjs` - Vector operations (norm, corpus mean)
- `plugin/automaton.mjs` - Aho-Corasick matching
- `plugin/commonwords.js` - Stop word list

ST-Coupled (DOM, event system, settings):
- `worldsapart.js` - Main extension file
- `extension/studio.mjs` - Lorebook Studio UI
- `extension/keyword-tools.mjs` - UI for keyword operations
- `extension/ui-widgets.mjs` - UI components
- `plugin/server.js` - Server plugin (depends on ST file layout)

This split allows pure modules to be used in Node.js evaluation harnesses without loading SillyTavern.

---

*Integration audit: 2026-08-04*
