// state.mjs — the settings seam shared by every WA module: the settings key, the defaults, the settings()
// accessor and the cross-module runState. ST's store is bound at init, never imported (node-loadable).

const MODULE_NAME = 'worldsApart';

export const defaultSettings = {
    enabled: true,
    chunkSize: 1750, // characters, not tokens; changing it re-embeds every collection
    chunkMode: 'paragraph', // 'paragraph' | 'length' (chunking.mjs splitRecursive)
    llmProfile: '', // Connection Manager profile id for WA's own generation calls; '' = the current API
    llmTemperature: '1', // '' sends none; ignored without a profile, since generateRaw takes no sampling parameters
    minChunkSize: 120, // paragraphs shorter than this are joined with the next one
    meanCentered: true, // passed to the plugin as a parameter; off buys uncentered scores, not the no-plugin path
    relevanceCutoff: 0.10, // stage-4 E[credit] cutoff for dynamic rows of both tiers; one setting for every model, never the fit's own `cutoff`
    maxVectorEntries: 20, // stage-5 cap, counted off the `vectorized` flag
    entityFilter: true, // keep capitalised tokens and lorebook vocabulary in the query
    properNounBoost: 3, // weight multiplier for capitalised query tokens under entityFilter
    stopwordDocFreq: 0.25, // drop query terms found in more than this fraction of chunks; 0 disables
    messageDepth: 10, // recent messages read, for both the retrieval query and the keyword scan window; per-entry scanDepth overrides
    dropChatTags: '', // comma-separated tag names removed, tag and content, from every message WA reads; '' = off
    presentationOrder: 'order-asc', // prompt order, not layout order: any SORT_FNS key (sort.mjs) | 'best-first' | 'best-last'
    presentationTiered: false, // group prompt order into tiers (constant → sticky → …) before the base sort
    dropUnavailable: true, // hide memory entries whose STMB_end postdates the current message (relevance.mjs postDates)
    matchWindow: 'paragraph', // 'scan' | 'message' | 'paragraph' — the unit a key must match within; 'scan' is core's
    wordBoundary: 'strict', // 'permissive' | 'strict' (also hyphen and apostrophes); read through matcher.mjs setBoundaryMode()
    raterId: '', // UUIDv4 a typed grade is signed as, generated on first use
    language: 'en', // which language pack the suggester and audit read (lang.mjs); 'en' is bundled, others fetch once

    bm25K1: 1.2, // tf saturation for the key scorer (matcher.mjs) and the content text scorer; the plugin ignores it
    repeatCurve: 'presence-log', // 'bm25' | 'presence-log' — the shape a key's repeats accrue by (matcher.mjs repeatCurveOf)
    repeatR: 1, // what repeats may add, as a multiple of presence
    bm25B: 0.75, // length normalisation 0..1, text scorer only
    maxTokensPercent: 40, // token budget as a percentage of max prompt tokens; 0 = off; the tighter of this and maxTokens wins
    maxTokens: 0, // absolute token budget over every activated entry; 0 = no cap
    budgetSlackPercent: 0, // an entry may exceed the budget by this percentage of it
    budgetSlackMode: 'once', // 'once' rescues one entry; 'all' lets every entry use the slack
    maxDynamicEntries: 0, // cap on keyword and vector entries; constants and stickies are not counted; 0 = no cap
    maxTokensIncludesExempt: false, // ignoreBudget entries' tokens come off the top of maxTokens
    maxTotalEntries: 0, // cap on every activated entry, constants and stickies consuming it first; 0 = no cap
    worldPriorityMode: 'interleaved', // 'interleaved' (one list; weight scales score, offset shifts prompt position) | 'sequential' (strict book tiers)
    /** @type {Record<string, Array<{ world: string, weight: number, offset: number, cap: number }>>} keyed by character/group id; the chat's own book is the sentinel `'chat'` */
    worldPriorityByChar: {},
    debugLog: false, // console.table the ranking every scan; per-generation token counting when a budget is set
};

/** Settings with no UI; ensureSettings resets them to defaults each init, so a value here is never user-tuned. */
const INTERNAL_KEYS = [
    'meanCentered', 'entityFilter', 'properNounBoost', 'stopwordDocFreq',
    'bm25K1', 'bm25B', 'repeatCurve', 'repeatR',
    'chunkSize', 'chunkMode', 'minChunkSize',
];

/** Settings that must be a number, and settings that must be a boolean. A corrupted or hand-edited store used to feed
 *  NaN into the caps and cutoffs, and NaN silently disables every stage that reads it (selection keeps non-finite
 *  scores); `Boolean('false')` is true, so a boolean is defaulted rather than coerced. `llmTemperature` is excluded —
 *  a string by design ('' sends none). */
const NUMERIC_KEYS = [
    'chunkSize', 'minChunkSize', 'relevanceCutoff', 'maxVectorEntries', 'properNounBoost', 'stopwordDocFreq',
    'messageDepth', 'bm25K1', 'repeatR', 'bm25B', 'maxTokensPercent', 'maxTokens', 'budgetSlackPercent',
    'maxDynamicEntries', 'maxTotalEntries',
];
const BOOLEAN_KEYS = ['enabled', 'meanCentered', 'entityFilter', 'dropUnavailable', 'presentationTiered', 'maxTokensIncludesExempt', 'debugLog'];

/** ST's `extension_settings`, bound by ensureSettings; never import it here (CLAUDE.md, *Pure vs ST-coupled*). */
let store = null;

/** The live WA settings object; throws if read before ensureSettings. */
export function settings() {
    if (!store) throw new Error('Worlds Apart: settings() read before ensureSettings() bound ST\'s store');
    return store[MODULE_NAME];
}

/** Merge defaults under stored settings and bind ST's store; call once at init, before settings(). */
export function ensureSettings(extensionSettings) {
    store = extensionSettings;
    // structuredClone of the defaults: a shallow Object.assign hands the live settings the SAME nested objects
    // defaultSettings holds, so the first write to one (worldPriorityByChar) edits this module's exported defaults.
    store[MODULE_NAME] = Object.assign(structuredClone(defaultSettings), store[MODULE_NAME]);
    for (const k of INTERNAL_KEYS) store[MODULE_NAME][k] = defaultSettings[k];
    const s = store[MODULE_NAME];
    for (const k of NUMERIC_KEYS) { const n = Number(s[k]); s[k] = Number.isFinite(n) ? n : defaultSettings[k]; }
    for (const k of BOOLEAN_KEYS) if (typeof s[k] !== 'boolean') s[k] = defaultSettings[k];
}

/** Cross-module mutable state. Stays a holder object: an imported `let` cannot be reassigned across modules. */
export const runState = {
    scanToken: 0,                 // generations increment it at intercept; after every await a continuation compares and bails when superseded
    armedToken: 0,                // the token selectAndActivate committed for; a SCAN_DONE ranks only while it is still the current one
    lastScores: new Map(),        // vector scores from the last retrieval, keyed `${world}.${uid}` — core's format, not the US separator
    lastPromptOrder: [],          // the last scan's prompt order, post-cut
    lastQuery: '',                // last retrieval query text
    lastQueryChat: [],            // the messages that query was joined from
    scanChat: null,               // the interceptor's chat — core's own scan haystack; SCAN_DONE consumers read this, not the raw chat
    lastScanChat: [],             // scan-eligible messages at capture depth
    gradeCutoff: null,            // /wa-grade's candidate-depth cap; null = no capture in flight
    lastCandidates: [],           // selection-candidate rows from the last debug-class run
    lastCandidateEntries: [],     // the WI entries behind those rows, aligned by index
    lastSkipped: [],              // per-entry budget rejections + the cap that caused each
    attachedWorlds: new Set(),    // books ST currently has active for this chat
    waOwnsScan: false,            // WA intercepted the scan in flight; gates the ENTRIES_LOADED key blanking and the per-loop SCAN_DONE feed
    waMatched: new Set(),         // `${world}.${uid}` WA has emitted or seen activated this scan — never rescanned
    waRecursionTexts: [],         // every pass's recursion-eligible entry content so far; the rematch window is chat + these
    waMinSkew: 0,                 // min-activation passes core has scheduled; widens WA's window one message per pass
    waCandidates: null,           // candidate entries fetched at intercept (live keys); null = no owned scan state
    verboseRun: false,            // true during a /wa-debug run
    dryRunInProgress: false,      // true during either slash-command run
    generationIsDryRun: false,    // true while ST's own dry-run generation is in flight
    pluginAvailable: null,        // did the server plugin answer /ping
    pluginRoot: null,             // absolute ST root from /ping
    pluginFP: null,               // fingerprint the deployed plugin reports
    sourceFP: null,               // fingerprint of this extension's source plugin files
    lastLayoutOrder: [],          // the last scan's LAYOUT order, pre-cut — what the caps take a prefix of; the capture's population
    lastInjects: [],              // the Author's Note and depth prompts the scan read, when allowWIScan is on
    lastSources: {},              // the card/persona fields an entry opted into, by source name
    lastCoreSet: null,            // what core alone selected during a /wa-versus probe
    inCoreProbe: false,           // true while that probe runs, so the takeover stands down
    waRecursionDepth: 0,          // the recursion level WA is emitting at
};
