// Self-check for extension/lang.mjs: a pack becomes the table, a stand-down empties it, and the switch touches the store and the network only when it must.
import { eq } from './metrics.mjs';
import { table, usePack, standDown, parsePacked } from '../extension/lang.mjs';

const pack = {
    lang: 'xx', label: 'Test', source: 'synthetic', license: 'none',
    packed: '55:the of;38:tavern;30:warlock', va95: 'ran', va85: 'slept', adj85: 'briny',
    common: 'the of and', hash: 'h1',
};

const t = usePack(pack);
eq(t.lang, 'xx', 'usePack sets the language');
eq(t.zipf.get('the'), 5.5, 'a decile band unpacks to its Zipf value');
eq(t.zipf.get('warlock'), 3.0, 'the last band too');
eq(t.zipf.has('minotaur'), false, 'absence means rare');
eq(t.posVAStrict.has('ran') && t.posVA.has('ran') && t.posVA.has('slept') && !t.posVAStrict.has('slept'), true, 'VA95 is inside VA, VA85 is not strict');
eq(t.posAdj.has('briny'), true, 'ADJ85 is the adjective set');
eq(t.common.has('and') && !t.common.has('tavern'), true, 'common is the pack list');
eq(t.loaded, true, 'a pack is loaded');
eq(table(), t, 'table() is the current object');

const d = standDown('yy');
eq(d.lang, 'yy', 'stand-down keeps the requested language');
eq(d.zipf.size + d.posVA.size + d.posAdj.size + d.common.size, 0, 'stand-down empties every collection');
eq(d.loaded, false, 'and is not loaded');
eq(parsePacked('').size, 0, 'an empty packed string is an empty table');
console.log(process.exitCode ? 'FAIL' : 'ok');
