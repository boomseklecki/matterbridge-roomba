import { describe, expect, it } from 'vitest';
import { toAreaId, withTimeout } from '../src/utils.js';

describe('toAreaId', () => {
  it('preserves small numeric region ids', () => {
    expect(toAreaId('0')).toBe(0);
    expect(toAreaId('1')).toBe(1);
    expect(toAreaId('42')).toBe(42);
  });

  it('preserves large numeric region ids within uint31', () => {
    expect(toAreaId('2147483647')).toBe(0x7fffffff);
  });

  it('hashes non-numeric ids deterministically', () => {
    const a = toAreaId('abc-123-def');
    const b = toAreaId('abc-123-def');
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThanOrEqual(0x7fffffff);
  });

  it('produces different hashes for different non-numeric ids', () => {
    const ids = ['alpha', 'beta', 'gamma', 'delta', '7b0e3f42-abcd', 'x'];
    const hashes = ids.map(toAreaId);
    const unique = new Set(hashes);
    expect(unique.size).toBe(ids.length);
  });

  it('hashes out-of-range numeric strings rather than returning negatives', () => {
    // Larger than uint31 — must fall through to hash path, not parse as-is.
    const id = '9999999999';
    const result = toAreaId(id);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(0x7fffffff);
  });

  it('never returns 0 when the input would hash to that slot', () => {
    // Empty string => FNV starting value 0x811c9dc5, unchanged, masked to 0x011c9dc5.
    // This is just a smoke check that the function never returns 0 from the hash path
    // (0 is valid for numeric "0" but not from collisions).
    const result = toAreaId('');
    expect(result).not.toBe(0);
  });
});

describe('withTimeout', () => {
  it('resolves when the inner promise settles before the deadline', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 100, 'test')).resolves.toBe('ok');
  });

  it('rejects with the labelled error when the deadline trips', async () => {
    const pending = new Promise((resolve) => setTimeout(resolve, 1000));
    await expect(withTimeout(pending, 20, 'slow call')).rejects.toThrow(/slow call after 20ms/);
  });

  it('propagates rejection from the inner promise', async () => {
    const err = new Error('boom');
    await expect(withTimeout(Promise.reject(err), 100, 'x')).rejects.toBe(err);
  });
});
