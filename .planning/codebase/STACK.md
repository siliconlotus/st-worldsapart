# Technology Stack

**Analysis Date:** 2026-08-04

## Languages

**Primary:**
- JavaScript (ES6 modules) - SillyTavern extension client code in `worldsapart.js` and `extension/` modules
- JavaScript/Node.js - Server plugin code in `plugin/server.js` and related modules

**Secondary:**
- Markdown - Design documentation (`keyword-suggest-design.md`, `matcher-design.md`)

## Runtime

**Environment:**
- Browser runtime (client-side) - Modern ES6 module support required
- Node.js (server plugin) - For the optional server-side component at `/plugins/worlds-apart/`

**Package Manager:**
- No package.json in extension root; server plugin generates one at deploy time
- Plugin deployment via `deploy-plugin.mjs` script

## Frameworks

**Core:**
- SillyTavern extension framework - Integrates via `manifest.json` and hooks into three extension points: `WORLDINFO_ENTRIES_LOADED`, `generate_interceptor`, `WORLDINFO_SCAN_DONE`

**Server:**
- Express.js (indirectly) - Plugin mounts at `/api/plugins/worlds-apart` via Express router injected by SillyTavern server

## Key Dependencies

**Critical (Production):**
- `vectra` - Vector indexing library used by plugin (`plugin/server.js`, line 34) for `LocalIndex`
- `sanitize-filename` - Filename sanitization for vector index paths (`plugin/server.js`, line 33)

**Built-in Node.js Modules:**
- `path` - File path resolution
- `fs` - File system operations (index reading, caching)
- `readline` - Line reading for file operations
- `node:url` - URL to file path conversion via `fileURLToPath`

**SillyTavern Core Modules (Injected):**
- Vector Storage API (`extension_settings.vectors`, `/api/vector/*` endpoints)
- World Info system (`world-info.js`, `world_info` globals)
- Tokenizer (`getTokenCountAsync`)
- Slash command parser and handlers
- Settings and extension APIs
- Text generation settings (for query building context)
- OpenAI settings integration
- Popup/UI system

## Configuration

**Environment:**
- Vector backend configuration inherited from SillyTavern's Vector Storage settings
- Supports multiple vector sources: `transformers`, `ollama`, `llamacpp`, `vllm`, `palm`, `extras`
- Model selection via `${source}_model` convention (e.g., `ollama_model`, `vllm_model`)

**Build:**
- `deploy-plugin.mjs` - Deployment script that:
  - Copies plugin files from `plugin/` to `/plugins/worlds-apart/`
  - Generates `package.json` with `"type": "module"` for ES modules
  - Modifies `config.yaml` to enable server plugins

**Manifest:**
- `manifest.json` - SillyTavern extension metadata:
  - Entry point: `worldsapart.js`
  - Load order: 101
  - Hooks: `activate` → `init` function
  - Generate interceptor: `worldsApart_intercept`

## Platform Requirements

**Development:**
- Node.js (for running eval scripts and deploy script)
- SillyTavern server with web browser support

**Production (Browser/Client):**
- Modern browser with ES6 module support
- SillyTavern v1.x installation

**Production (Server Plugin):**
- Node.js runtime (same as SillyTavern server)
- Server plugins enabled in `config.yaml`
- Vector Storage extension installed and configured in SillyTavern
- Optional vector embedding backend (Ollama for mean-centered search; fallback to SillyTavern's stock vector search if plugin unavailable)

## Special Deployment Note

The extension and server plugin are tightly coupled:
- Source of truth: `plugin/` directory in this repo
- Deployed copy: `/plugins/worlds-apart/` in SillyTavern root
- Fingerprinting (`plugin/fingerprint.mjs`) detects out-of-date deployments
- Redeploy command: `node deploy-plugin.mjs` from this extension's directory
- Requires SillyTavern restart after plugin deploy

---

*Stack analysis: 2026-08-04*
