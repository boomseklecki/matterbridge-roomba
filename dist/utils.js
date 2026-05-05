/**
 * Pure, dependency-free helpers shared between runtime and tests.
 * Keep this file free of `matterbridge/*` imports so vitest can run it directly.
 */
/**
 * Convert a Roomba `region_id` string to a stable Matter `areaId` (uint32).
 *
 * - Numeric strings ("0", "1", "2", …) parse as-is so the number stays recognisable
 *   in config and logs.
 * - Non-numeric ids (some older pmaps use UUIDs) are hashed with FNV-1a. Deterministic
 *   — same regionId always produces the same areaId across restarts.
 * - Collision space is 31-bit (≈ 2.1 billion) so practical collisions are negligible.
 * - Never returns 0 for hashed inputs (FNV-1a can only collide to 0 if the input hashes
 *   exactly to 0x80000000 — we coerce that to 1 for safety).
 */
export function toAreaId(regionId) {
    // Guard empty string — `Number('')` is 0 in JS which would masquerade as a
    // valid small region id.
    if (regionId.length > 0) {
        const asNumber = Number(regionId);
        if (Number.isInteger(asNumber) && asNumber >= 0 && asNumber <= 0x7fffffff) {
            return asNumber;
        }
    }
    let hash = 0x811c9dc5;
    for (let i = 0; i < regionId.length; i++) {
        hash ^= regionId.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return (hash & 0x7fffffff) || 1;
}
/**
 * Wrap a promise in a timeout. Resolves with the promise's value, rejects with
 * `<label> after <ms>ms` if the deadline trips first. Used on startup to keep
 * plugin initialization from hanging on a slow robot or cloud call.
 */
export function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} after ${ms}ms`)), ms);
        promise.then((v) => {
            clearTimeout(timer);
            resolve(v);
        }, (e) => {
            clearTimeout(timer);
            reject(e);
        });
    });
}
//# sourceMappingURL=utils.js.map