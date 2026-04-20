# matterbridge-roomba

A [Matterbridge](https://matterbridge.io) plugin that exposes iRobot Roomba robotic vacuum cleaners as Matter devices, so you can control them from **Apple Home**, **Google Home**, **Amazon Alexa**, **Home Assistant** (Matter controller), or any Matter-compatible ecosystem.

Uses [`@karlvr/dorita980`](https://github.com/karlvr/dorita980) for **local MQTT** communication — a direct TLS connection to the robot on your LAN. The iRobot cloud is only touched at initial setup (if you use cloud-assisted onboarding).

## Highlights

- **Runs locally.** No cloud polling at runtime. Robot state arrives over MQTT in real time.
- **Per-room cleans that actually clean that room.** Apple Home / Google Home room selection is translated to Roomba's native `cleanRoom` command with pmap + region IDs resolved for you.
- **Model-aware clean modes.** Vacuum-only robots show just Vacuum + Deep Clean; j5+/j6 swappable robots show Vacuum + Mop (with runtime gating based on what reservoir is installed); j7+/j9+ Combo robots show Vacuum + Mop + Vacuum-then-Mop.
- **Standalone Matter device per robot.** Own QR code, own Matter server node — skips Apple Home's single-device-bridge quirks.
- **Full Matter 1.4 RVC error coverage.** Stuck, brush/wheel jammed, bin missing/full, water tank missing/empty/lid-open, mop-pad missing, failed-to-dock, low battery — all mapped from Roomba error codes and surfaced via `OperationalError` events so your phone can push-notify you.
- **Multi-floor homes.** j7+/j9+/s9+ with multiple persistent maps show rooms grouped by floor.
- **Cloud-assisted onboarding.** Paste your iRobot account email/password; the plugin auto-fetches every robot's BLID and local MQTT password.
- **Room discovery built-in.** A single button in the Matterbridge UI captures your rooms from the robot's own clean commands — no hand-editing IDs.
- **Skip detection.** Press Skip in the iRobot app; Apple Home's "currently cleaning" indicator advances to the next room within a second.
- **Self-healing reconnects.** Exponential backoff, TLS cipher rotation, and automatic state refresh after recovery.

## Requirements

- Matterbridge 3.6.1+
- Node.js 18+
- Roomba on the same LAN as your Matterbridge host, reachable on TCP port 8883

Any j-series, s-series, i-series, 900-series, or Braava m-series Roomba that `dorita980` supports should work. Tested on j5+.

## Install

From the Matterbridge frontend: **Plugins → Install → `matterbridge-roomba`**.

Or via CLI:

```bash
matterbridge -add matterbridge-roomba
```

## Quick start (cloud-assisted)

The simplest setup: your iRobot account email/password + the robot's LAN IP.

```jsonc
{
  "name": "matterbridge-roomba",
  "type": "DynamicPlatform",
  "cloud": {
    "email": "you@example.com",
    "password": "your-irobot-account-password"
  },
  "devices": [
    {
      "name": "Rumi",
      "ipAddress": "192.168.1.214"
    }
  ]
}
```

Restart the plugin — BLID, local MQTT password, model, and firmware are fetched from the iRobot cloud automatically. Use **Test cloud login** in the frontend to verify credentials before restarting.

Then run through the onboarding flow in [ONBOARDING.md](./ONBOARDING.md) to discover and name your rooms.

## Manual credentials (no cloud account needed)

If you already have the BLID + local MQTT password:

```jsonc
{
  "devices": [
    {
      "name": "Rumi",
      "blid": "15CC75AC…",
      "password": ":1:1763614303:Jf4C…",
      "ipAddress": "192.168.1.214"
    }
  ]
}
```

To retrieve `blid` / `password` without sharing iRobot credentials, run `npx @karlvr/dorita980 getpassword <robot-ip>` on any machine on the same LAN (hold the robot's **Home** button until it beeps first, then run the command within 2 seconds).

## What appears in your Matter controller

| Matter feature | Controller UX | Backed by |
|---|---|---|
| `RvcRunMode.Cleaning` | "Clean" button | `clean()` (or `cleanRoom()` if rooms selected) |
| `RvcRunMode.Mapping` | "Mapping" run mode | `train()` — training mission, robot explores without cleaning |
| `RvcRunMode.Idle` | "Stop" | `stop()` |
| `RvcCleanMode.Vacuum` | mode picker | default robot behavior |
| `RvcCleanMode.DeepClean` | mode picker | two-pass + carpet boost |
| `RvcCleanMode.Mop` | mode picker (mop-capable only) | gated on installed tool |
| `RvcCleanMode.VacuumThenMop` | mode picker (Combo models) | Roomba Combo native behavior |
| `RvcOperationalState.Pause` | pause button | `pause()` |
| `RvcOperationalState.Resume` | play button | `resume()` |
| `RvcOperationalState.GoHome` | "Send to Dock" | `stop()` then `dock()` (prevents dock-loop) |
| `Identify.Identify` | "Identify" | `find()` — beep locator |
| `ServiceArea.SelectAreas` | room selector | resolves pmap + region IDs, calls `cleanRoom()` |
| Room skip in iRobot app | Controller's "currently cleaning" advances | state detection (no Matter command yet) |
| Battery & charge state | Battery icon | `batPct` + `phase === 'charge'` |
| Bin full / tank empty / stuck / dock failed | Error notification | mapped to Matter RVC error states + `OperationalError` event |

## Server vs bridged mode

By default each robot is exposed as its **own independent Matter device** (`"serverMode": true`) with a separate QR code shown in the Matterbridge frontend. This is what other vacuum plugins do and what Apple Home / Google Home handle best — both controllers have historically struggled with bridged RVC devices (showing "Matterbridge / Aggregator" for metadata, ghost "unsupported device" cards, etc).

If you prefer a single pairing code for all Matterbridge plugins, set `"serverMode": false` per device. Be aware of the controller quirks above.

## Room discovery

See [ONBOARDING.md](./ONBOARDING.md) for the full walkthrough. The short version:

1. Flip `"discoverRooms": true` on your device.
2. Clean each room once from the iRobot app (or run "Clean My Home").
3. Hit **Save discovered rooms to config** in the Matterbridge frontend.
4. Rename the auto-populated `Room N` labels to friendly names; optionally set a `type` (`"Kitchen"`, `"LivingRoom"`, etc.) for the controller to pick the right icon.
5. Turn discovery off, restart.

For **multi-floor homes** (j7+/j9+/s9+ with multiple pmaps), run discovery on each floor in sequence — the plugin detects distinct pmaps and writes a `maps[]` array automatically, grouping rooms by floor.

## Config reference

| Key | Default | Purpose |
|---|---|---|
| `cloud.email` / `cloud.password` | — | iRobot account for auto-discovering robots |
| `cloud.countryCode` | `"US"` | ISO-2 country code (rarely needs changing) |
| `devices[].name` | — | Friendly name shown in the Matter controller |
| `devices[].blid` | — | Robot's MQTT username (auto-filled by cloud onboarding) |
| `devices[].password` | — | Robot's LOCAL MQTT password (not your iRobot password) |
| `devices[].ipAddress` | — | Robot's LAN IP (required; not auto-detected) |
| `devices[].serverMode` | `true` | Standalone Matter server vs bridged endpoint |
| `devices[].vendor` | `"iRobot"` | BasicInformation vendor name |
| `devices[].model` | robot-reported SKU | BasicInformation model name |
| `devices[].refreshInterval` | `10` | Active polling interval in seconds |
| `devices[].idleRefreshInterval` | `120` | Idle polling interval in seconds |
| `devices[].roomCleanSqft` | `75` | Sqft threshold per room for `currentArea` auto-advance during multi-room cleans |
| `devices[].roomCleanDurationMinutes` | `10` | Fallback per-room advance when sqft isn't emitted |
| `devices[].discoverRooms` | `false` | Enable room-capture logging |
| `devices[].verboseState` | `false` | Dump MQTT state deltas for debugging |
| `devices[].pmapId` / `.userPmapvId` | — | Single-map pmap reference (auto-filled by discovery) |
| `devices[].maps[]` | `[]` | Multi-floor pmap list (auto-filled by discovery) |
| `devices[].rooms[]` | `[]` | Room list (auto-filled by discovery) |

Full JSON schema in [`matterbridge-roomba.schema.json`](./matterbridge-roomba.schema.json).

## Troubleshooting

- **"Connection failed with cipher TLS_AES_256_GCM_SHA384"** — expected on first attempt; the plugin auto-rotates to `AES128-SHA256` which older Roombas accept.
- **"Roomba … went offline"** — the robot only permits **one** local MQTT connection. Close the iRobot app on your phone, and disable Home Assistant's `roomba` integration if you have it enabled.
- **Firmware shows "3.7.4" in Apple Home** — Matterbridge stamps its own version on the root node; the plugin overrides it but HomeKit caches the value at pairing. Remove + re-pair the accessory to refresh.
- **"Could not find a cloud robot matching …"** — the robot's name in your iRobot app doesn't match the `name` in config (case-insensitive). Rename in iRobot or update config.
- **Robot keeps re-undocking after you hit "Send to Dock"** — fixed in v1.1.1. The plugin now sends `stop()` before `dock()` to cancel any paused mission (the trigger for the loop).
- **Room-targeted cleans fall back to whole-home** — means `pmapId` / `userPmapvId` aren't set, or a `regionId` in config is missing. Re-run discovery.
- **Multi-room clean shows the wrong current room in Apple Home** — Roomba doesn't report per-region progress on j5+/j7+ firmware. The plugin advances `currentArea` via a sqft-based heuristic (fallback: wall-clock time). Tune with `roomCleanSqft`. Pressing Skip in the iRobot app advances instantly.

## Known limitations

- **No per-region progress report from the j-series firmware.** `cleanMissionStatus.sqft` and `mssnM` stay at 0 on j5+ during a mission. Without those, multi-room `currentArea` cycling relies on wall-clock time — imprecise when room sizes vary.
- **SkipArea command not forwarded to the robot.** Matterbridge's cluster server doesn't route `SkipArea` to plugins yet, and `@karlvr/dorita980` doesn't expose a `skip()` method. We detect skip-from-iRobot-app and advance Matter state, but the other direction (skip from Matter controller → robot) is blocked upstream.
- **"Matter Accessory" during pairing.** All open-source Matter devices use the CSA test VendorID `0xfff1`, which Apple Home doesn't map to a brand. After pairing, the accessory details correctly show `iRobot` as manufacturer.
- **iOS Home's room picker briefly shows "1 Room" after picking "All Rooms"** — then resolves to "All Rooms" after the subscription update lands (a few seconds). This is an iOS Home UI quirk; Apple sends `selectAreas([])` to mean "unconstrained", and the plugin mirrors the full area list back so the summary renders correctly, but iOS's local picker state lags the subscription briefly. macOS Home handles the empty-list semantic correctly without any lag.
- **Schedule / do-not-disturb / map geometry** — Matter doesn't define clusters for these. They stay in the iRobot app.

## Credits

- [`@karlvr/dorita980`](https://github.com/karlvr/dorita980) — local MQTT client + cloud auth reference
- [Matterbridge](https://github.com/Luligu/matterbridge) — Matter bridging framework
- [`matterbridge-roborock-vacuum-plugin`](https://github.com/RinDevJunior/matterbridge-roborock-vacuum-plugin) — reference vacuum-plugin architecture
- [`NickWaterton/Roomba980-Python`](https://github.com/NickWaterton/Roomba980-Python) — state field reverse-engineering

## License

Apache-2.0
