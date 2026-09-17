// version.mjs — staging's build counter and the version predicates the pre-push gate and the bump script read.

// Base is SemVer major.minor.patch with an optional prerelease; `+build.N` is the only build metadata WA writes.
const PARTS = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)(?:\+build\.(\d+))?$/;

/** `X.Y.Z[-pre]+build.N` -> N+1; a base with no counter -> `+build.1`. Throws on anything else. */
export function nextBuildVersion(version) {
    const m = PARTS.exec(String(version ?? ''));
    if (!m) throw new Error(`not a WA version: ${version}`);
    return `${m[1]}+build.${m[2] ? Number(m[2]) + 1 : 1}`;
}

/** A version `release` may carry: no prerelease and no build metadata. */
export const isReleaseVersion = v => /^\d+\.\d+\.\d+$/.test(String(v ?? ''));

/** A version `staging` may carry: any base plus the counter. */
export const hasBuildCounter = v => {
    const m = PARTS.exec(String(v ?? ''));
    return Boolean(m && m[2]);
};

/** A valid WA version with no counter — a release cut parked on staging. */
export const isCounterless = v => {
    const m = PARTS.exec(String(v ?? ''));
    return Boolean(m && !m[2]);
};
