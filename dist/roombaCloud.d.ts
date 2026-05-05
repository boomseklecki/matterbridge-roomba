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
export type RoombaCloudErrorKind = 'discovery_failed' | 'gigya_invalid_credentials' | 'gigya_captcha_required' | 'gigya_other' | 'irobot_login_failed' | 'network' | 'unexpected_response';
export declare class RoombaCloudError extends Error {
    readonly kind: RoombaCloudErrorKind;
    readonly statusCode?: number;
    readonly details?: unknown;
    constructor(kind: RoombaCloudErrorKind, message: string, opts?: {
        statusCode?: number;
        details?: unknown;
        cause?: unknown;
    });
}
/**
 * Log in to the iRobot cloud and enumerate the account's robots.
 *
 * - Invalid credentials -> throws `RoombaCloudError` with kind `gigya_invalid_credentials`.
 * - Captcha required    -> throws `RoombaCloudError` with kind `gigya_captcha_required`.
 * - Network failure     -> throws `RoombaCloudError` with kind `network`.
 * - Account has no robots -> resolves with `[]`.
 */
export declare function getRoombaCloudCredentials(input: RoombaCloudCredentials): Promise<RoombaCloudRobot[]>;
//# sourceMappingURL=roombaCloud.d.ts.map