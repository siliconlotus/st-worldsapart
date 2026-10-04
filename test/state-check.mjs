// state-check.mjs — the settings seam: a corrupted or hand-edited store falls back to defaults instead of feeding NaN
// into the caps and cutoffs, where it would silently disable every stage that reads it.
import { ensureSettings, settings, defaultSettings, cleanedSettings } from '../extension/state.mjs';
import { eq } from '../eval/lib/metrics.mjs';

// Garbage present before init: the shape a corrupted write or a hand edit leaves behind.
const store = { worldsApart: { relevanceCutoff: 'abc', maxTokens: ' 500', messageDepth: '25', enabled: 'false', debugLog: 'yes', meanCentered: 'true', wordBoundary: 'Permissive' } };
ensureSettings(store);
const s = settings();

eq(s.relevanceCutoff, defaultSettings.relevanceCutoff, 'a cutoff that cannot be a number falls back to the default');
eq(s.maxTokens, 500, 'a numeric string coerces — the cap works instead of silently disappearing');
eq(s.messageDepth, 25, '...likewise for the depth');
eq(s.enabled, true, 'a boolean spelled as a string falls back to the default: Boolean("false") is true');
eq(s.meanCentered, true, '...and an internal boolean resets with the rest');
eq(s.wordBoundary, defaultSettings.wordBoundary, 'a wordBoundary that is no mode resets to the default, warned, before any scope is built from it');
eq(s.chunkSize, defaultSettings.chunkSize, 'an internal key resets to the shipped value, as always');
eq(s.worldPriorityByChar && Array.isArray(s.worldPriorityByChar) === false && typeof s.worldPriorityByChar === 'object', true, 'the object settings still merge');

// A second init on an already-coerced store is stable, and the shipped default does not console.table every generation.
ensureSettings(store);
eq(s.messageDepth, 25, 're-init on a coerced store is stable');
eq(defaultSettings.debugLog, false, 'debugLog ships off: the per-generation table and token counting are opt-in');

// --- what a clean keeps: the settings a user built up go only when named
{
    const stored = { relevanceCutoff: 0.2, language: 'fr', worldPriorityByChar: { a: [] }, keywordIgnore: { B: ['x'] }, studioSortByBook: { B: {} } };
    const keys = opts => Object.keys(cleanedSettings(stored, opts) ?? {}).join(',');
    eq(keys({}), 'relevanceCutoff,language,worldPriorityByChar,keywordIgnore,studioSortByBook', 'nothing ticked removes nothing');
    eq(keys({ settings: true }), 'worldPriorityByChar,keywordIgnore,studioSortByBook', 'settings alone leaves the order, priorities and curation');
    eq(keys({ priority: true }), 'relevanceCutoff,language,keywordIgnore,studioSortByBook', 'priorities alone go');
    eq(keys({ curation: true }), 'relevanceCutoff,language,worldPriorityByChar', 'curation alone goes');
    eq(cleanedSettings(stored, { settings: true, priority: true, curation: true }), null, 'everything ticked leaves no block at all');
}

if (process.exitCode !== 1) console.log('state-check: ok');
