/**
 * roombaCloud.ts
 *
 * Self-contained TypeScript implementation of iRobot's cloud authentication
 * flow. Given an iRobot account email + password, returns the per-robot
 * credentials (BLID + local MQTT password) plus metadata needed to talk to
 * the robot on the LAN via dorita980.
 *
 * Reverse-engineered from:
 *   - @karlvr/dorita980 `bin/getPasswordCloud.js`   (verbatim Gigya -> /v2/login flow)
 *   - NickWaterton/Roomba980-Python `getcloudpassword.py`
 *     (confirms the per-region discovery endpoint and that the Gigya API key
 *     + httpBase should be looked up dynamically, not hardcoded)
 *
 * Flow
 * ----
 * 1. GET  https://disc-prod.iot.irobotapi.com/v1/discover/endpoints?country_code=XX
 *    -> { deployments: { <name>: { httpBase: "...", ... } },
 *         gigya: { api_key: "...", datacenter_domain: "us1.gigya.com" },
 *         httpBase: "https://unauth2.prod.iot.irobotapi.com",
 *         ... }
 *    The response tells us which Gigya datacenter + API key to use for the
 *    account's region and which iRobot API base to hit for /v2/login. The
 *    defaults baked into dorita980's CLI (`accounts.us1.gigya.com` + the
 *    hardcoded API key) work for US accounts only; EU/APAC accounts need
 *    discovery or they fail with errorCode 403005 / "invalid apikey".
 *
 * 2. POST https://accounts.<datacenter_domain>/accounts.login
 *    Query string: apiKey, targetenv=mobile, loginID=<email>,
 *                  password=<password>, format=json, targetEnv=mobile
 *    (Yes, both camelCase `targetEnv` AND lowercase `targetenv` are sent;
 *    that mirrors the official Android app and dorita980. Dropping either
 *    can trigger captcha gating on some accounts.)
 *    -> { statusCode: 200, errorCode: 0, UID, UIDSignature,
 *         signatureTimestamp, sessionInfo: { sessionToken, ... } }
 *    Non-zero errorCode means credential/captcha failure — see error map below.
 *
 * 3. POST <httpBase>/v2/login
 *    JSON body:
 *      {
 *        "app_id": "ANDROID-C7FB240E-DF34-42D7-AE4E-A8C17079A294",
 *        "assume_robot_ownership": 0,
 *        "gigya": { "signature": UIDSignature,
 *                   "timestamp": signatureTimestamp,
 *                   "uid":       UID }
 *      }
 *    -> { robots: { "<BLID>": { name, password, sku, softwareVer, ... } },
 *         access_token, id_token, ... }
 *    `password` here is the 8-char-ish local MQTT password that dorita980
 *    needs to connect on port 8883. BLID is the object key, not a field.
 *
 * Risks / gotchas
 * ---------------
 * - Rate limiting: hammering /accounts.login from one IP trips Gigya's
 *   captcha after ~5-10 failures. We surface errorCode 403042 ("Security
 *   verification failed") as a distinct error so callers can prompt the user
 *   to log in via the app once to clear the flag.
 * - Token expiry: the /v2/login response contains access_token/id_token that
 *   expire (~1h). For LAN-only use we don't care — BLID + local password are
 *   stable for the life of the robot. Only rerun this flow if the user
 *   changes their iRobot password or factory-resets a robot.
 * - IP discovery: the cloud response does NOT include the robot's LAN IP.
 *   Plugin must mDNS / UDP-broadcast discover it (dorita980 ships
 *   `lib/discovery.js` — UDP broadcast to 255.255.255.255:5678 with payload
 *   "irobotmcs"). We leave `ip` undefined here; the platform layer fills it.
 * - Region codes: dorita980's CLI defaults to no region (Gigya US1). We
 *   default to "US" for the discovery call which works globally — the
 *   response still contains the correct per-account datacenter_domain
 *   because Gigya federates. Users in CN/JP may need to pass their own code.
 * - Node 24 / undici: global `fetch` is stable. No AbortController needed
 *   for the short-lived requests, but we add a 15s timeout per call defensively.
 *
 * This module intentionally has zero runtime dependencies — we cannot import
 * the flow from @karlvr/dorita980 because it's only exposed as a CLI.
 */

export interface RoombaCloudCredentials {
  /** iRobot account email. */
  email: string;
  /** iRobot account password. */
  password: string;
  /**
   * ISO country code for the discovery endpoint. Defaults to "US".
   * Gigya federates so this rarely matters, but pass "DE", "JP", etc. if
   * discovery returns the wrong datacenter for your account.
   */
  countryCode?: string;
  /**
   * Optional override Gigya API key. If set, skips discovery entirely and
   * uses `accounts.us1.gigya.com`. Matches dorita980 CLI's third positional
   * arg / GIGYA_API_KEY env var. Only useful for debugging.
   */
  gigyaApiKeyOverride?: string;
}

export interface RoombaCloudRobot {
  /** Robot BLID — the MQTT username for local connections. */
  blid: string;
  /** Local MQTT password (long random-looking string). */
  password: string;
  /** LAN IP — never populated by this module, filled in by LAN discovery. */
  ip?: string;
  /** User-assigned robot name (e.g. "Rosie"). */
  name: string;
  /** Model SKU, e.g. "R981040". Used to branch feature support. */
  sku: string;
  /** Current firmware version string, e.g. "22.29.3+4". */
  softwareVer: string;
}

/** Discriminated error type so callers can react to auth failures specifically. */
export type RoombaCloudErrorKind =
  | 'discovery_failed'
  | 'gigya_invalid_credentials'
  | 'gigya_captcha_required'
  | 'gigya_other'
  | 'irobot_login_failed'
  | 'network'
  | 'unexpected_response';

export class RoombaCloudError extends Error {
  public readonly kind: RoombaCloudErrorKind;
  public readonly statusCode?: number;
  public readonly details?: unknown;

  constructor(kind: RoombaCloudErrorKind, message: string, opts?: { statusCode?: number; details?: unknown; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'RoombaCloudError';
    this.kind = kind;
    this.statusCode = opts?.statusCode;
    this.details = opts?.details;
  }
}

/**
 * Magic constants — all sourced from dorita980/Roomba980-Python so that
 * iRobot's backend treats us as a legitimate Android app client.
 */
const APP_ID = 'ANDROID-C7FB240E-DF34-42D7-AE4E-A8C17079A294';
const DISCOVERY_BASE = 'https://disc-prod.iot.irobotapi.com/v1/discover/endpoints';
const FALLBACK_GIGYA_DATACENTER = 'us1.gigya.com';
const FALLBACK_GIGYA_API_KEY = '3_rWtvxmUKwgOzu3AUPTMLnM46lj-LxURGflmu5PcE_sGptTbD-wMeshVbLvYpq01K';
const FALLBACK_IROBOT_HTTP_BASE = 'https://unauth2.prod.iot.irobotapi.com';
const DEFAULT_COUNTRY_CODE = 'US';
const REQUEST_TIMEOUT_MS = 15_000;

// --- Response type shapes (minimal — only the fields we read). --------------

interface DiscoveryResponse {
  httpBase?: string;
  httpBaseAuth?: string;
  gigya?: {
    api_key?: string;
    datacenter_domain?: string;
  };
  deployments?: Record<string, { httpBase?: string; httpBaseAuth?: string }>;
  current_deployment?: string;
}

interface GigyaLoginResponse {
  statusCode?: number;
  errorCode?: number;
  errorMessage?: string;
  errorDetails?: string;
  UID?: string;
  UIDSignature?: string;
  signatureTimestamp?: string;
  sessionInfo?: {
    sessionToken?: string;
  };
}

interface IRobotRobotEntry {
  name?: string;
  password?: string;
  sku?: string;
  softwareVer?: string;
}

interface IRobotLoginResponse {
  robots?: Record<string, IRobotRobotEntry>;
  access_token?: string;
  id_token?: string;
}

// --- Tiny fetch helper with timeout + JSON decoding -------------------------

async function fetchJson<T>(url: string, init: RequestInit): Promise<{ status: number; body: T }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    throw new RoombaCloudError('network', `Network error calling ${url}: ${(err as Error).message}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let body: unknown;
  if (text.length === 0) {
    body = {};
  } else {
    try {
      body = JSON.parse(text);
    } catch (err) {
      throw new RoombaCloudError('unexpected_response', `Non-JSON response from ${url} (status ${response.status})`, {
        statusCode: response.status,
        details: text.slice(0, 500),
        cause: err,
      });
    }
  }
  return { status: response.status, body: body as T };
}

// --- Step 1: discovery -------------------------------------------------------

async function discoverEndpoints(countryCode: string): Promise<{
  gigyaApiKey: string;
  gigyaDatacenter: string;
  iRobotHttpBase: string;
}> {
  const url = `${DISCOVERY_BASE}?country_code=${encodeURIComponent(countryCode)}`;
  const { status, body } = await fetchJson<DiscoveryResponse>(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Connection: 'close',
    },
  });

  if (status !== 200) {
    throw new RoombaCloudError('discovery_failed', `Discovery endpoint returned HTTP ${status}`, {
      statusCode: status,
      details: body,
    });
  }

  const gigyaApiKey = body.gigya?.api_key ?? FALLBACK_GIGYA_API_KEY;
  const gigyaDatacenter = body.gigya?.datacenter_domain ?? FALLBACK_GIGYA_DATACENTER;

  // Prefer top-level httpBase; fall back to current_deployment entry, then constant.
  let iRobotHttpBase = body.httpBase;
  if (!iRobotHttpBase && body.current_deployment && body.deployments) {
    iRobotHttpBase = body.deployments[body.current_deployment]?.httpBase;
  }
  if (!iRobotHttpBase) {
    iRobotHttpBase = FALLBACK_IROBOT_HTTP_BASE;
  }

  return { gigyaApiKey, gigyaDatacenter, iRobotHttpBase: iRobotHttpBase.replace(/\/+$/, '') };
}

// --- Step 2: Gigya login -----------------------------------------------------

async function gigyaLogin(
  email: string,
  password: string,
  apiKey: string,
  datacenter: string,
): Promise<Required<Pick<GigyaLoginResponse, 'UID' | 'UIDSignature' | 'signatureTimestamp'>>> {
  const qs = new URLSearchParams({
    apiKey,
    targetenv: 'mobile',
    loginID: email,
    password,
    format: 'json',
    // Yes, both cases on purpose — see module header.
    targetEnv: 'mobile',
  });
  const url = `https://accounts.${datacenter}/accounts.login?${qs.toString()}`;

  const { status, body } = await fetchJson<GigyaLoginResponse>(url, {
    method: 'POST',
    headers: {
      Connection: 'close',
      Accept: 'application/json',
    },
  });

  if (status === 401 || status === 403) {
    throw new RoombaCloudError('gigya_invalid_credentials', 'iRobot/Gigya rejected credentials (HTTP ' + status + ').', {
      statusCode: status,
      details: body,
    });
  }
  if (status !== 200) {
    throw new RoombaCloudError('gigya_other', `Gigya returned unexpected HTTP ${status}.`, {
      statusCode: status,
      details: body,
    });
  }

  // Gigya embeds its real status inside the JSON body even when HTTP is 200.
  const innerStatus = body.statusCode;
  const innerError = body.errorCode ?? 0;

  // Check the specific errorCodes FIRST before falling back on statusCode — Gigya
  // returns HTTP 200 always but embeds different failure modes in `errorCode`, and
  // returns innerStatus 403 for many of them (not just captcha).
  if (innerError === 403041 || innerError === 403043 || innerError === 400009 || innerError === 401030) {
    // Various "invalid login" / "invalid password" codes.
    throw new RoombaCloudError('gigya_invalid_credentials', body.errorMessage ?? 'Invalid email or password.', {
      statusCode: innerStatus,
      details: body,
    });
  }
  if (innerError === 403042) {
    // 403042 = "Security verification failed" (captcha gate).
    throw new RoombaCloudError(
      'gigya_captcha_required',
      'Gigya is requiring a captcha. Sign in once via the official iRobot app to clear it, then retry.',
      { statusCode: innerStatus, details: body },
    );
  }
  if (innerError !== 0) {
    throw new RoombaCloudError(
      'gigya_other',
      `Gigya error ${innerError}: ${body.errorMessage ?? 'unknown'} (${body.errorDetails ?? ''})`,
      { statusCode: innerStatus, details: body },
    );
  }

  const { UID, UIDSignature, signatureTimestamp, sessionInfo } = body;
  if (!UID || !UIDSignature || !signatureTimestamp || !sessionInfo?.sessionToken) {
    throw new RoombaCloudError('unexpected_response', 'Gigya login succeeded but required fields are missing.', {
      details: body,
    });
  }
  return { UID, UIDSignature, signatureTimestamp };
}

// --- Step 3: iRobot /v2/login -----------------------------------------------

async function iRobotLogin(
  httpBase: string,
  gigya: { UID: string; UIDSignature: string; signatureTimestamp: string },
): Promise<IRobotLoginResponse> {
  const url = `${httpBase}/v2/login`;
  const { status, body } = await fetchJson<IRobotLoginResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Connection: 'close',
    },
    body: JSON.stringify({
      app_id: APP_ID,
      assume_robot_ownership: 0,
      gigya: {
        signature: gigya.UIDSignature,
        timestamp: gigya.signatureTimestamp,
        uid: gigya.UID,
      },
    }),
  });

  if (status !== 200) {
    throw new RoombaCloudError('irobot_login_failed', `iRobot /v2/login returned HTTP ${status}.`, {
      statusCode: status,
      details: body,
    });
  }
  return body;
}

// --- Public entry point ------------------------------------------------------

/**
 * Log in to the iRobot cloud and enumerate the account's robots.
 *
 * - Invalid credentials -> throws `RoombaCloudError` with kind `gigya_invalid_credentials`.
 * - Captcha required    -> throws `RoombaCloudError` with kind `gigya_captcha_required`.
 * - Network failure     -> throws `RoombaCloudError` with kind `network`.
 * - Account has no robots -> resolves with `[]`.
 */
export async function getRoombaCloudCredentials(
  input: RoombaCloudCredentials,
): Promise<RoombaCloudRobot[]> {
  const email = input.email?.trim();
  const password = input.password;
  if (!email || !password) {
    throw new RoombaCloudError('gigya_invalid_credentials', 'Email and password are required.');
  }
  const countryCode = (input.countryCode ?? DEFAULT_COUNTRY_CODE).toUpperCase();

  // Step 1: discovery (skippable if user passed an override API key).
  let gigyaApiKey: string;
  let gigyaDatacenter: string;
  let iRobotHttpBase: string;
  if (input.gigyaApiKeyOverride) {
    gigyaApiKey = input.gigyaApiKeyOverride;
    gigyaDatacenter = FALLBACK_GIGYA_DATACENTER;
    iRobotHttpBase = FALLBACK_IROBOT_HTTP_BASE;
  } else {
    ({ gigyaApiKey, gigyaDatacenter, iRobotHttpBase } = await discoverEndpoints(countryCode));
  }

  // Step 2: Gigya login.
  const gigyaSession = await gigyaLogin(email, password, gigyaApiKey, gigyaDatacenter);

  // Step 3: iRobot /v2/login.
  const loginBody = await iRobotLogin(iRobotHttpBase, gigyaSession);

  const robotsMap = loginBody.robots ?? {};
  const result: RoombaCloudRobot[] = [];
  for (const [blid, entry] of Object.entries(robotsMap)) {
    if (!entry || !entry.password) {
      // Skip entries that don't have a local password — robot isn't paired.
      continue;
    }
    result.push({
      blid,
      password: entry.password,
      name: entry.name ?? blid,
      sku: entry.sku ?? 'unknown',
      softwareVer: entry.softwareVer ?? 'unknown',
      // ip intentionally omitted; caller performs LAN discovery.
    });
  }
  return result;
}
