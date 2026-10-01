// runs.mjs — one WA run at a time, from a generation's interceptor to its armed scan's last loop. Pure; ST's send lock,
// the token counter and the supersede report are injected.

/** How long a newcomer waits on a run whose scan has started; past it the run is taken to be blocked on the newcomer. */
export const RUN_WAIT_MS = 15_000;
/** How long a newcomer waits for a run to arm: a hang detector past the longest retrieval a first sync can take. */
export const ARM_WAIT_MS = 600_000;
/** How long a newcomer waits for an armed run's scan to start when ST's lock cannot say whether its generation is over. */
export const SCAN_START_MS = 2_000;

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
/** `promise`'s value, or undefined after `ms`; an already-settled promise wins a 0 ms race. */
const within = (promise, ms) => { let id; return Promise.race([promise, new Promise(r => { id = setTimeout(r, ms); })]).finally(() => clearTimeout(id)); };

/**
 * The run slot. `take` waits out the run in progress and starts one; `armed`, `scanning` and `end` report its progress.
 * @param {() => boolean} o.isGenerating ST's send lock, held by every generation but a quiet one
 * @param {() => number} o.nextToken the next scan token
 * @param {(why: 'unscanned'|'unarmed'|'unfinished') => void} o.onSupersede told why a run was taken over
 * @param {{run?: number, arm?: number, start?: number}} [o.waits] the three timeouts, for the check
 */
export function createRuns({ isGenerating, nextToken, onSupersede, waits = {} }) {
    const { run = RUN_WAIT_MS, arm = ARM_WAIT_MS, start = SCAN_START_MS } = waits;
    let current = null;   // { token, locked, armed, scanning, done }

    /** Waits out the run in progress, then starts one and returns its token. `locked`: this run's generation holds ST's lock. */
    async function take(locked = false) {
        while (current) {
            const prior = current;
            const armed = await within(prior.armed.promise.then(() => true), arm);
            if (current !== prior) continue;
            if (armed) {
                // ST runs one locked generation at a time: a locked newcomer, or a released lock, means the prior one is over —
                // aborted after WA's interceptor, which ST reports by no event.
                const over = prior.locked && (locked || !isGenerating());
                const scanning = await within(prior.scanning.promise.then(() => true), over ? 0 : start);
                if (current !== prior) continue;
                if (!scanning) { onSupersede('unscanned'); break; }
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
        /** Ends it, if it is still the current one. */
        end: token => { const r = at(token); if (!r) return; r.armed.resolve(); r.scanning.resolve(); r.done.resolve(true); current = null; },
        /** The current run's token, or null. */
        current: () => current?.token ?? null,
    };
}
