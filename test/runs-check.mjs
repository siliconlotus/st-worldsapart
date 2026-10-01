// runs-check.mjs — runs.mjs: when a newcomer waits on the run in progress and when it takes over. Self-checking; run with no arguments.
import { createRuns } from '../extension/runs.mjs';
import { eq } from '../eval/lib/metrics.mjs';

const waits = { run: 300, arm: 300, start: 150 };
/** A slot whose lock reads `lock.held`, recording each takeover. */
const slot = () => {
    const lock = { held: true }, why = [];
    let n = 0;
    return { lock, why, runs: createRuns({ isGenerating: () => lock.held, nextToken: () => ++n, onSupersede: w => why.push(w), waits }) };
};
const timed = async p => { const t0 = Date.now(); const v = await p; return { v, ms: Date.now() - t0 }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

{
    const { why, runs } = slot();
    const a = await runs.take(true); runs.armed(a);
    const { ms } = await timed(runs.take(true));
    eq(why.join(), 'unscanned', 'a locked run that armed and never scanned, met by a locked newcomer, was aborted: taken over');
    eq(ms < waits.start, true, '...at once, with no wait');
}
{
    const { lock, why, runs } = slot();
    const a = await runs.take(true); runs.armed(a);
    lock.held = false;
    const { ms } = await timed(runs.take(false));
    eq(why.join() === 'unscanned' && ms < waits.start, true, 'a quiet newcomer finding the lock released takes over at once too');
}
{
    const { why, runs } = slot();
    const a = await runs.take(true); runs.armed(a);
    const { ms } = await timed(runs.take(false));
    eq(why.join(), 'unscanned', 'with the lock still held, a quiet newcomer cannot tell an abort from a run blocked on it');
    eq(ms >= waits.start - 10 && ms < waits.run, true, '...so it waits the scan-start grace, and no longer');
}
{
    const { why, runs } = slot();
    const a = await runs.take(false); runs.armed(a);
    const late = sleep(50).then(() => runs.scanning(a));
    const b = timed(runs.take(false));
    await late; await sleep(50); runs.end(a);
    const { v, ms } = await b;
    eq(why.length, 0, 'a scan that starts inside the grace and ends inside the wait is waited out, not taken over');
    eq(v === 2 && ms >= 90, true, '...and the newcomer starts after it');
}
{
    const { why, runs } = slot();
    const a = await runs.take(true); runs.armed(a); runs.scanning(a);
    const b = timed(runs.take(true));
    await sleep(50); runs.end(a);
    await b;
    eq(why.length, 0, 'a lock reading "over" does not cut short a scan that had already started');
}
{
    const { why, runs } = slot();
    const a = await runs.take(false); runs.armed(a); runs.scanning(a);
    await runs.take(false);
    eq(why.join(), 'unfinished', 'a scan still running past the wait is taken over, with the warning');
}
{
    const { why, runs } = slot();
    await runs.take(false);
    await runs.take(false);
    eq(why.join(), 'unarmed', 'a run that never arms is taken over past the arm wait');
}
{
    const { runs } = slot();
    const a = await runs.take(false);
    runs.end(a);
    eq(runs.current(), null, 'an ended run leaves the slot empty');
    runs.end(a + 1); runs.armed(a); runs.scanning(a);
    eq(runs.current(), null, '...and a stale token touches nothing');
}
console.log(process.exitCode ? 'FAIL' : 'ok   runs: abort, grace, wait and takeover');
