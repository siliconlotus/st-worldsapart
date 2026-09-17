// entry-filter-check.mjs — entry-filter.mjs: the Explorer's search, facet groups and term-tab ranking.
// Self-checking; run with no arguments.

import { facetMatch, matchSearch, rankBySearch, typeMatch } from '../extension/entry-filter.mjs';
import { MINOR, MODERATE, SEVERE } from '../extension/keyword-audit.mjs';
import { eq } from '../eval/lib/metrics.mjs';

const ALL = { title: true, entry: true, keywords: true };
const e = (o) => ({ uid: 1, comment: 'Ravensgate', content: 'A walled city.', key: ['ravensgate', 'the gate'], ...o });

// --- search: the scope decides which fields are read, and no scope admits everything
eq(matchSearch(e(), '', ALL), true, 'an empty query admits');
eq(matchSearch(e(), 'RAVENS', ALL), true, 'search is case-insensitive');
eq(matchSearch(e(), 'walled', { title: true }), false, 'title-only scope does not read the text');
eq(matchSearch(e(), 'walled', { entry: true }), true, 'entry scope reads the text');
eq(matchSearch(e(), 'the gate', { keywords: true }), true, 'keyword scope reads the joined key list');
eq(matchSearch(e(), 'nothing', {}), true, 'a scope with nothing ticked admits, rather than filtering everything out');
eq(matchSearch({ uid: 7, key: null }, 'UID 7', ALL), true, 'a comment-less entry searches under its wiTitleOf name');

// --- facets
eq(facetMatch(e(), 'keyword', null), true, 'neither constant nor vectorized is a keyword entry');
eq(facetMatch(e({ constant: true }), 'keyword', null), false, 'a constant entry is not a keyword entry');
eq(facetMatch(e({ vectorized: true }), 'vector', null), true, 'vectorized is the vector facet');
eq(facetMatch(e({ disable: true }), 'enabled', null), false, 'disabled is not enabled');
eq(facetMatch(e(), 'flagged', null), false, 'without a scan the audit facets admit nothing');

// A stand-in for buildKeyPruneScan: only the three methods the facets call.
const scanOf = (flagged, unusable = []) => ({
    classifyEntry: () => flagged.map(([key, sev]) => ({ key, sev })),
    unusableKeysOf: () => unusable,
    severityOf: p => p.sev,
});
eq(facetMatch(e(), 'flagged', scanOf([])), false, 'no flags and no unusable keys is not flagged');
eq(facetMatch(e(), 'flagged', scanOf([['the gate', MINOR]])), true, 'one flagged key flags the entry');
eq(facetMatch(e(), 'flagged', scanOf([], ['?bad('])), true, 'an unusable key alone flags the entry');
eq(facetMatch(e(), SEVERE, scanOf([], ['?bad('])), true, 'an unusable key counts severe, as it does on the badge');
eq(facetMatch(e(), MODERATE, scanOf([['a', MINOR], ['b', MODERATE]])), true, 'severity is "holds at least one"');
eq(facetMatch(e(), SEVERE, scanOf([['a', MINOR], ['b', MODERATE]])), false, 'and only the severities it holds');

// --- groups: OR within a group, AND across groups; an untouched group admits everything
const f = (...xs) => new Set(xs);
eq(typeMatch(e(), f(), null), true, 'no facet picked admits every entry');
eq(typeMatch(e({ constant: true }), f('keyword', 'constant'), null), true, 'two facets of one group are OR');
eq(typeMatch(e({ constant: true }), f('keyword'), null), false, 'a picked group excludes what it does not name');
eq(typeMatch(e({ constant: true, disable: true }), f('constant', 'enabled'), null), false,
    'groups are AND: constant admits but enabled refuses');
eq(typeMatch(e({ constant: true }), f('constant', 'enabled'), null), true, 'and admits when every picked group admits');

// --- term-tab ranking: title beats term beats text, and the incoming order survives within a band
const g = (uid, comment, content, terms) => ({ entry: { uid, comment, content }, rows: terms.map(term => ({ term })) });
const groups = [
    g(1, 'Beta', 'nothing here', ['moss']),          // term band
    g(2, 'Nothing', 'a mossy wall', ['stone']),      // text band
    g(3, 'Moss Keep', 'nothing here', ['stone']),    // title band
    g(4, 'Alpha', 'nothing here', ['mossy stone']),  // term band, after group 1
    g(5, 'Nothing', 'nothing here', ['stone']),      // dropped
];
eq(rankBySearch(groups, 'moss', ALL).map(x => x.entry.uid).join(','), '3,1,4,2',
    'title first, then term, then text; groups tie-break on the incoming order, and a non-match is dropped');
eq(rankBySearch(groups, '', ALL).length, 5, 'an empty query keeps every group, unranked');
eq(rankBySearch(groups, 'moss', { keywords: true }).map(x => x.entry.uid).join(','), '1,4',
    'a narrowed scope drops the bands it does not read');
eq(rankBySearch(groups, 'moss', ALL).find(x => x.entry.uid === 1).rows.length, 1,
    'rows are never filtered, only the group is');
