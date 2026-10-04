// runs.mjs — one WA run at a time, from a generation's interceptor to its armed scan's last loop. Pure; the token counter
// and the supersede report are injected.

/** How long a newcomer waits on an armed run's scan, to start and then to finish; past it the run is taken to be blocked on the newcomer. */
export const RUN_WAIT_MS = 15_000;
/** How long a newcomer waits for a run to arm: a hang detector past the longest first sync. */
export const ARM_WAIT_MS = 600_000;

const deferred = () => { const d = { settled: false }; d.promise = new Promise(r => { d.resolve = v => { d.settled = true; r(v); }; }); return d; };
/** `promise`'s value, or undefined after `ms`; an already-settled promise wins a 0 ms race. */
const within = (promise, ms) => { let id; return Promise.race([promise, new Promise(r => { id = setTimeout(r, ms); })]).finally(() => clearTimeout(id)); };

/**
 * The run slot. `take` waits out the run in progress and starts one; `armed`, `scanning` and `end` report its progress.
 * @param {() => number} o.nextToken the next scan token
 * @param {(why: 'aborted'|'unscanned'|'unarmed'|'unfinished') => void} o.onSupersede told why a run was taken over; only
 *   'aborted' is certain the prior generation is over
 * @param {{run?: number, arm?: number}} [o.waits] the timeouts, for the check
 */
export function createRuns({ nextToken, onSupersede, waits = {} }) {
    const { run = RUN_WAIT_MS, arm = ARM_WAIT_MS } = waits;
    let current = null;   // { token, locked, armed, scanning, done }

    /** Waits out the run in progress, then starts one and returns its token. `locked`: this run's generation holds ST's lock. */
    async function take(locked = false) {
        while (current) {
            const prior = current;
            const armed = await within(prior.armed.promise.then(() => true), arm);
            if (current !== prior) continue;
            if (armed) {
                // ST starts a locked generation only once the last one released the lock, so a locked newcomer means the prior one
                // is over — aborted after WA's interceptor. A free lock is not evidence: a quiet
                // generation's end releases the lock a visible one still holds.
                const over = prior.locked && locked;
                const scanning = await within(prior.scanning.promise.then(() => true), over ? 0 : run);
                if (current !== prior) continue;
                if (!scanning) { onSupersede(over ? 'aborted' : 'unscanned'); break; }
                if (await within(prior.done.promise, run) || current !== prior) continue;
            }
            onSupersede(armed ? 'unfinished' : 'unarmed');
            break;
        }
        const token = nextToken();
        current = { token, locked, armed: deferred(), scanning: deferred(), done: deferred() };
        return token;
    }

    const at = token => (current && current.token === token ? current : null);
    return {
        take,
        /** The run `token` names has armed: a newcomer now waits for its scan. */
        armed: token => at(token)?.armed.resolve(),
        /** Its scan has started: a newcomer now waits for it to finish. */
        scanning: token => at(token)?.scanning.resolve(),
        /** Whether it has armed and its scan has not started: what a generation that ended before its scan leaves in the slot. */
        unscanned: token => { const r = at(token); return Boolean(r && r.armed.settled && !r.scanning.settled); },
        /** Ends it, if it is still the current one. */
        end: token => { const r = at(token); if (!r) return; r.armed.resolve(); r.scanning.resolve(); r.done.resolve(true); current = null; },
        /** The current run's token, or null. */
        current: () => current?.token ?? null,
    };
}
