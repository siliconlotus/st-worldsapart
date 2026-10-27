// entry-form.mjs — pure helpers for the Studio's entry card: chip packing, bounded-select options, the state summary.
import { hasPromoteDecorator } from './matcher.mjs';

const plain = (s, ...v) => String.raw({ raw: s }, ...v);

/** Longest first so the flex wrap packs chips into fewer lines; ties keep input order. */
export function packByLength(keys) {
    return keys.map((k, i) => [k, i]).sort((a, b) => b[0].length - a[0].length || a[1] - b[1]).map(x => x[0]);
}

/** Options for a bounded select. `off` and `any` are the labels of the '' and 'any' options when wanted; a `value` beyond `max` is appended so an existing value is never changed by rendering. */
export function rangeOptions(value, { off = null, any = null, max }) {
    const out = [];
    if (off != null) out.push({ value: '', label: off });
    if (any != null) out.push({ value: 'any', label: any });
    for (let n = off != null ? 1 : 0; n <= max; n++) out.push({ value: String(n), label: String(n) });
    const v = Number(value);
    if (Number.isFinite(v) && value !== '' && value != null && (v > max || v < (off != null ? 1 : 0))) out.push({ value: String(v), label: String(v) });
    return out;
}

/** What is set on an entry, as short human parts: the card's Advanced summary and the row's tooltips read the same list. `??`, not `||`: null inherits the global, false is an entry override. */
export function entryStateParts(e, { caseGlobal, wholeGlobal }, t = plain) {
    const parts = [];
    if (Number(e.sticky) > 0) parts.push(t`sticky ${Number(e.sticky)}`);
    const prob = e.probability != null ? Number(e.probability) : 100;
    if (e.useProbability !== false && prob < 100) parts.push(`${prob}%`);
    if (hasPromoteDecorator(e)) parts.push(t`promoted`);
    if (e.caseSensitive === true) parts.push(t`case-sensitive`);
    if (e.matchWholeWords === true) parts.push(t`whole words`);
    if (Number(e.cooldown) > 0) parts.push(t`cooldown ${Number(e.cooldown)}`);
    if (Number(e.delay) > 0) parts.push(t`delay ${Number(e.delay)}`);
    if (e.excludeRecursion) parts.push(t`non-recursable`);
    if (e.preventRecursion) parts.push(t`prevent recursion`);
    if (e.delayUntilRecursion) parts.push(typeof e.delayUntilRecursion === 'number' && e.delayUntilRecursion > 0 ? t`delay until recursion ${e.delayUntilRecursion}` : t`delay until recursion`);
    if (e.ignoreBudget) parts.push(t`ignore budget`);
    if (e.scanDepth != null) parts.push(t`scan depth ${e.scanDepth}`);
    return parts;
}
