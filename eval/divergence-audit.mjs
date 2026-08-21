// divergence-audit.mjs — the analysis tool for KEYWORD-ONLY books' graded samples.
//
// Keyword-only books exist and are different. A reference book (e.g. Foxbridge: every entry keyed
// or constant, nothing vectorized — deliberately, since reference register does not match narrative
// prose) has no retrieval channel, so activation IS delivery and core's scan window is the book's
// entire memory horizon. The graded-scene machinery does not apply to them twice over:
//   - scene.mjs needs a vector index and these books have none (loadScene throws ENOENT), and
//   - ranking metrics (nDCG, oracle-prefix) are definitionally empty here — reference-entry
//     relevance is presence-DECLARED (author keys), not prose-discoverable, so the whole book is
//     the class those metrics exclude. Set metrics are the only ones that mean anything.
// What a graded sample of such a book measures is the KEYS: did each firing deserve to fire
// (the grades), and what should have fired but did not. This tool reads the frozen bundle
// directly — candidates, grades, scanText, embedded book — plus countKey, and reports the
// divergences, in three classes with different fixes:
//   key miss        — no key of a relevant entry occurs anywhere; fix the keys (suggester).
//   window miss     — a key occurs in the sample's scanText (WA's window) but the entry did not
//                     fire, i.e. core's shallower scan expired it; fix is depth/persistence
//                     (WA's messageDepth supersedes core's depth).
//   over-fire       — a fired row graded 0-1; fix the keys (prune / tighten).
// This tool finds window misses mechanically and lists candidates for the other two; "relevant but
// unfired" beyond the window class needs a judge, since ungraded unfired entries have no grades.
//
// Usage: node eval/divergence-audit.mjs <sample.json> [more samples...]
// Needs bookMode 'full' samples (the default) — 'meta'/'none' have no entry text to match against.
import { readFileSync } from 'node:fs';
import * as matcher from '../extension/matcher.mjs';
import { countKey } from '../extension/matcher.mjs';
import { openBundle } from '../extension/grading.mjs';
import { gradeValue } from './metrics.mjs';

const files = process.argv.slice(2);
if (!files.length) {
    console.error('usage: node eval/divergence-audit.mjs <sample.json> [more samples...]');
    process.exit(1);
}

const tokOf = e => Math.ceil(String(e.content ?? '').length / 4);

for (const file of files) {
    const j = openBundle(JSON.parse(readFileSync(file, 'utf8')));
    const name = file.split('/').pop();
    const sceneText = matcher.scanWindow(j.scanChat ?? [], { depth: j.depth, includeNames: true });
    if (!j.candidates?.length || !j.entries?.length || !sceneText) {
        console.log(`\n== ${name}: not a gradeable scene (needs candidates, entries, scanChat) — skipped`);
        continue;
    }
    const entries = Object.values(j.books?.[j.primaryBook] ?? Object.values(j.books ?? {})[0] ?? {});
    const byUid = new Map(entries.map(e => [Number(e.uid), e]));
    const fired = new Set(j.candidates.map(r => Number(r.uid)));
    const gradeOf = new Map(j.entries.map(g => [Number(g.uid), gradeValue(g)]));

    console.log(`\n== ${name} — book "${j.primaryBook}", ${entries.length} entries ==`);
    const firedTok = [...fired].reduce((a, u) => a + (byUid.has(u) ? tokOf(byUid.get(u)) : 0), 0);
    const dist = [0, 1, 2, 3, 4].map(g => [...gradeOf.values()].filter(x => x === g).length);
    console.log(`fired ${fired.size} (${firedTok} tokens ~chars/4); graded ${gradeOf.size}; grades 0:${dist[0]} 1:${dist[1]} 2:${dist[2]} 3:${dist[3]} 4:${dist[4]}`);
    const rel = [...gradeOf.values()].filter(g => g >= 3).length;
    console.log(`fired-set precision: ${(rel / gradeOf.size).toFixed(2)} at grade>=3, ${((rel + dist[2]) / gradeOf.size).toFixed(2)} at grade>=2`);

    // over-fires: fired and judged irrelevant — a key that matched on the wrong evidence.
    for (const [uid, g] of gradeOf) if (g <= 1) {
        const why = (j.candidates.find(r => Number(r.uid) === uid)?.why ?? [])
            .map(w => `${w.key}${w.excerpt ? ` (${w.excerpt})` : ''}`).join('; ');
        console.log(`  OVER-FIRE  uid=${uid} grade=${g} "${(byUid.get(uid)?.comment ?? '').slice(0, 40)}"${why ? ' — ' + why : ''}`);
    }

    // window misses: unfired, but a key occurs in the frozen scanText (WA's window) — evidence was
    // in reach and core's shallower scan expired it. The real matcher decides, not a re-derivation.
    if (!entries.length || entries.every(e => !e.content)) {
        console.log('  (book has no entry text — bookMode was not \'full\'; unfired analysis skipped)');
        continue;
    }
    // Same stage-2 guard as scene.mjs makeCandidateSet: a vectorized entry under suppressVectorKeys
    // has blanked keys, so core could never keyword-fire it — it is not a window miss, it has no
    // keyword door at all. Matters only when this tool is pointed at a mixed book.
    const suppress = j.params?.suppressVectorKeys ?? j.paramSnapshot?.suppressVectorKeys;
    let eligible = 0, misses = 0;
    for (const e of entries) {
        if (fired.has(Number(e.uid)) || e.disable || e.constant || (e.vectorized && suppress)) continue;
        eligible++;
        const hits = (e.key ?? []).filter(k => countKey(k, sceneText, e.caseSensitive, e.matchWholeWords) > 0);
        if (hits.length) {
            misses++;
            console.log(`  WINDOW MISS uid=${e.uid} "${(e.comment ?? '').slice(0, 40)}" — in WA window: ${hits.slice(0, 4).join(', ')}`);
        }
    }
    console.log(`window misses: ${misses} of ${eligible} eligible unfired entries (relevance of each is a judgement call — grade before acting)`);
}
