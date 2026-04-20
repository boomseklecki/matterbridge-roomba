import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRoombaCloudCredentials, RoombaCloudError } from '../src/roombaCloud.js';

/**
 * These tests mock `global.fetch` to simulate the three-step iRobot cloud flow
 * (discovery → Gigya → /v2/login) and verify the plugin's error handling.
 * We don't hit the real iRobot API; replaying the documented response shapes
 * is enough to prove the request path.
 */

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubHappyPath(robots: Record<string, unknown>): void {
  mockFetch
    // Step 1: discovery
    .mockResolvedValueOnce(
      jsonResponse(200, {
        httpBase: 'https://unauth2.prod.iot.irobotapi.com',
        gigya: { api_key: 'TEST_API_KEY', datacenter_domain: 'us1.gigya.com' },
      }),
    )
    // Step 2: Gigya
    .mockResolvedValueOnce(
      jsonResponse(200, {
        statusCode: 200,
        errorCode: 0,
        UID: 'uid-123',
        UIDSignature: 'sig-abc',
        signatureTimestamp: '1700000000',
        sessionInfo: { sessionToken: 'tok' },
      }),
    )
    // Step 3: iRobot
    .mockResolvedValueOnce(
      jsonResponse(200, {
        robots,
        access_token: 'at',
        id_token: 'it',
      }),
    );
}

describe('getRoombaCloudCredentials', () => {
  it('returns all robots from a successful cloud login', async () => {
    stubHappyPath({
      BLID1: { name: 'Rumi', password: 'pw1', sku: 'j517020', softwareVer: 'amethyst+24.29.3' },
      BLID2: { name: 'Dusty', password: 'pw2', sku: 'R981040', softwareVer: 'raven+5.1.0' },
    });

    const robots = await getRoombaCloudCredentials({ email: 'a@b.com', password: 'x' });
    expect(robots).toHaveLength(2);
    expect(robots[0]).toMatchObject({ blid: 'BLID1', name: 'Rumi', password: 'pw1', sku: 'j517020' });
    expect(robots[1]).toMatchObject({ blid: 'BLID2', name: 'Dusty', password: 'pw2' });
    // Ip is intentionally not populated; LAN discovery handles that.
    expect(robots[0].ip).toBeUndefined();
  });

  it('hits the three endpoints in order with the right URLs', async () => {
    stubHappyPath({});
    await getRoombaCloudCredentials({ email: 'a@b.com', password: 'x' });
    expect(mockFetch).toHaveBeenCalledTimes(3);

    const [discoveryCall, gigyaCall, iRobotCall] = mockFetch.mock.calls;
    expect(discoveryCall[0]).toMatch(/disc-prod\.iot\.irobotapi\.com.*country_code=US/);
    expect(gigyaCall[0]).toMatch(/accounts\.us1\.gigya\.com\/accounts\.login\?/);
    expect(gigyaCall[0]).toContain('apiKey=TEST_API_KEY');
    expect(gigyaCall[0]).toContain('loginID=a%40b.com');
    expect(iRobotCall[0]).toBe('https://unauth2.prod.iot.irobotapi.com/v2/login');
  });

  it('skips robots without a local password (unpaired entries)', async () => {
    stubHappyPath({
      BLID1: { name: 'paired', password: 'pw1', sku: 'x' },
      BLID2: { name: 'unpaired', sku: 'y' }, // no password
    });
    const robots = await getRoombaCloudCredentials({ email: 'a@b.com', password: 'x' });
    expect(robots).toHaveLength(1);
    expect(robots[0].blid).toBe('BLID1');
  });

  it('throws gigya_invalid_credentials on a 403041 errorCode', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(200, {
          httpBase: 'https://unauth2.prod.iot.irobotapi.com',
          gigya: { api_key: 'K', datacenter_domain: 'us1.gigya.com' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { statusCode: 403, errorCode: 403041, errorMessage: 'Invalid loginID' }),
      );

    await expect(getRoombaCloudCredentials({ email: 'a@b.com', password: 'wrong' })).rejects.toSatisfy((err) => {
      return err instanceof RoombaCloudError && err.kind === 'gigya_invalid_credentials';
    });
  });

  it('throws gigya_captcha_required on a 403042 errorCode', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(200, {
          httpBase: 'https://unauth2.prod.iot.irobotapi.com',
          gigya: { api_key: 'K', datacenter_domain: 'us1.gigya.com' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { statusCode: 403, errorCode: 403042, errorMessage: 'Security verification failed' }),
      );

    await expect(getRoombaCloudCredentials({ email: 'a@b.com', password: 'x' })).rejects.toSatisfy((err) => {
      return err instanceof RoombaCloudError && err.kind === 'gigya_captcha_required';
    });
  });

  it('throws network error when fetch itself rejects', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(getRoombaCloudCredentials({ email: 'a@b.com', password: 'x' })).rejects.toSatisfy((err) => {
      return err instanceof RoombaCloudError && err.kind === 'network';
    });
  });

  it('rejects empty credentials without hitting the network', async () => {
    await expect(getRoombaCloudCredentials({ email: '', password: 'x' })).rejects.toSatisfy((err) => {
      return err instanceof RoombaCloudError && err.kind === 'gigya_invalid_credentials';
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns [] when the account has no robots', async () => {
    stubHappyPath({});
    const robots = await getRoombaCloudCredentials({ email: 'a@b.com', password: 'x' });
    expect(robots).toEqual([]);
  });

  it('honors the gigyaApiKeyOverride to skip discovery', async () => {
    // Only 2 fetches expected (no discovery).
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(200, {
          statusCode: 200,
          errorCode: 0,
          UID: 'u',
          UIDSignature: 's',
          signatureTimestamp: 't',
          sessionInfo: { sessionToken: 'tok' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { robots: {} }));

    await getRoombaCloudCredentials({ email: 'a@b.com', password: 'x', gigyaApiKeyOverride: 'OVERRIDE_KEY' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toContain('apiKey=OVERRIDE_KEY');
  });

  it('passes the given countryCode to discovery', async () => {
    stubHappyPath({});
    await getRoombaCloudCredentials({ email: 'a@b.com', password: 'x', countryCode: 'de' });
    expect(mockFetch.mock.calls[0][0]).toContain('country_code=DE');
  });
});
