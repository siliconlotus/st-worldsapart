// runs-check.mjs — runs.mjs: when a newcomer waits on the run in progress and when it takes over. Self-checking; run with no arguments.
import { createRuns } from '../extension/runs.mjs';
import { eq } from '../eval/lib/metrics.mjs';

const waits = { run: 300, arm: 300 };
/** A slot recording each takeover. */
const slot = () => {
    const why = [];
    let n = 0;
    return { why, runs: createRuns({ nextToken: () => ++n, onSupersede: w => why.push(w), waits }) };
};
const timed = async p => { const t0 = Date.now(); const v = await p; return { v, ms: Date.now() - t0 }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

{
    const { why, runs } = slot();
    const a = await runs.take(true); runs.armed(a);
    const { ms } = await timed(runs.take(true));
    eq(why.join(), 'aborted', 'a locked run that armed and never scanned, met by a locked newcomer, was aborted: taken over');
    eq(ms < 50, true, '...at once, with no wait');
}
{
    const { why, runs } = slot();
    const a = await runs.take(true); runs.armed(a);
    const { ms } = await timed(runs.take(false));
    eq(why.join(), 'unscanned', 'a quiet newcomer cannot tell an abort from a run still on its way to its scan');
    eq(ms >= waits.run - 10, true, '...so it waits the full wait for the scan to start');
}
{
    const { why, runs } = slot();
    const a = await runs.take(false); runs.armed(a);
    await runs.take(true);
    eq(why.join(), 'unscanned', 'a locked newcomer is no evidence about a prior that never held the lock');
}
{
    const { why, runs } = slot();
    const a = await runs.take(false); runs.armed(a);
    const late = sleep(50).then(() => runs.scanning(a));
    const b = timed(runs.take(false));
    await late; await sleep(50); runs.end(a);
    const { v, ms } = await b;
    eq(why.length, 0, 'a scan that starts and ends inside the wait is waited out, not taken over');
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
console.log(process.exitCode ? 'FAIL' : 'ok   runs: abort, wait and takeover');
