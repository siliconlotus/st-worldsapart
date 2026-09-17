// divergence-audit.mjs — for a keyword-only book's graded bundle (no vector index, so scene.mjs cannot load it): over-matches (matchd, graded 0-1) and window misses (unmatched, though a key occurs in WA's frozen scan window — core's shallower scan expired it). Key misses beyond the window need a judge.
// Usage: node eval/divergence-audit.mjs <sample.json> [more samples...]   (needs a bundle that embeds its books)
import { readFileSync } from 'node:fs';
import * as matcher from '../extension/matcher.mjs';
import { countKey } from '../extension/matcher.mjs';
import { openBundle } from '../extension/grading.mjs';
import { gradeValue } from './lib/metrics.mjs';

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
    const matched = new Set(j.candidates.map(r => Number(r.uid)));
    const gradeOf = new Map(j.entries.map(g => [Number(g.uid), gradeValue(g)]));

    console.log(`\n== ${name} — book "${j.primaryBook}", ${entries.length} entries ==`);
    const matchedTok = [...matched].reduce((a, u) => a + (byUid.has(u) ? tokOf(byUid.get(u)) : 0), 0);
    const dist = [0, 1, 2, 3, 4].map(g => [...gradeOf.values()].filter(x => x === g).length);
    console.log(`matched ${matched.size} (${matchedTok} tokens ~chars/4); graded ${gradeOf.size}; grades 0:${dist[0]} 1:${dist[1]} 2:${dist[2]} 3:${dist[3]} 4:${dist[4]}`);
    const rel = [...gradeOf.values()].filter(g => g >= 3).length;
    console.log(`matched-set precision: ${(rel / gradeOf.size).toFixed(2)} at grade>=3, ${((rel + dist[2]) / gradeOf.size).toFixed(2)} at grade>=2`);

    for (const [uid, g] of gradeOf) if (g <= 1) {
        const why = (j.candidates.find(r => Number(r.uid) === uid)?.why ?? [])
            .map(w => `${w.key}${w.excerpt ? ` (${w.excerpt})` : ''}`).join('; ');
        console.log(`  OVER-MATCH  uid=${uid} grade=${g} "${(byUid.get(uid)?.comment ?? '').slice(0, 40)}"${why ? ' — ' + why : ''}`);
    }

    // countKey decides, never a re-derivation.
    if (!entries.length || entries.every(e => !e.content)) {
        console.log('  (book embeds no entry text — malformed bundle; unfired analysis skipped)');
        continue;
    }
    // scene.mjs makeCandidateSet's stage-2 guard: keys blanked under suppressVectorKeys could never fire, so that is no window miss. paramSnapshot is a scalar dump under settings.
    const suppress = j.params?.suppressVectorKeys ?? j.paramSnapshot?.settings?.suppressVectorKeys;
    let eligible = 0, misses = 0;
    for (const e of entries) {
        if (matched.has(Number(e.uid)) || e.disable || e.constant || (e.vectorized && suppress)) continue;
        eligible++;
        const hits = (e.key ?? []).filter(k => countKey(k, sceneText, e.caseSensitive, e.matchWholeWords) > 0);
        if (hits.length) {
            misses++;
            console.log(`  WINDOW MISS uid=${e.uid} "${(e.comment ?? '').slice(0, 40)}" — in WA window: ${hits.slice(0, 4).join(', ')}`);
        }
    }
    console.log(`window misses: ${misses} of ${eligible} eligible unfired entries (relevance of each is a judgement call — grade before acting)`);
}
