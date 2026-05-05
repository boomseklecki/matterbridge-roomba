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
export declare function toAreaId(regionId: string): number;
/**
 * Wrap a promise in a timeout. Resolves with the promise's value, rejects with
 * `<label> after <ms>ms` if the deadline trips first. Used on startup to keep
 * plugin initialization from hanging on a slow robot or cloud call.
 */
export declare function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T>;
//# sourceMappingURL=utils.d.ts.map