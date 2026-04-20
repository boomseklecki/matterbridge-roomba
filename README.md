# matterbridge-roomba

A [Matterbridge](https://matterbridge.io) plugin that exposes iRobot Roomba robotic vacuum cleaners as Matter devices, so you can control them from Apple Home, Google Home, Amazon Alexa, Home Assistant's Matter controller, or any other Matter-compatible ecosystem.

Uses [`@karlvr/dorita980`](https://github.com/karlvr/dorita980) for local MQTT communication — no cloud polling at runtime, just a direct TLS connection to the robot on your LAN.

## Features

- **Start / Stop / Pause / Resume / Dock / Identify** via the Matter `RoboticVacuumCleaner` device type
- **Battery level & charge state** via PowerSource cluster
- **Operational state** (Running, Paused, SeekingCharger, Charging, Docked, Error, Stuck) mapped from Roomba's mission phases
- **Error reporting** (stuck, bin full, low battery, hardware error) via RvcOperationalState errors
- **Room-targeted cleans** — pick a room in Apple Home / Google Home, plugin translates to Roomba's native `cleanRoom` command
- **Discovery mode** captures room IDs and map metadata automatically from the iRobot app's clean commands
- **Cloud-assisted onboarding** — paste your iRobot account email/password and the plugin auto-fetches every robot's BLID and local MQTT password
- **Standalone Matter device** (default) — each robot exposes its own QR code, dodging Apple Home's single-device-bridge quirks
- **Exponential-backoff reconnect** with TLS cipher rotation (AES128-SHA256 → TLS_AES_256_GCM_SHA384)

## Install

```bash
matterbridge -add matterbridge-roomba
```

Or from the Matterbridge frontend: **Plugins → Install → matterbridge-roomba**.

## Configure

The simplest path is **cloud onboarding** — your iRobot account email/password, plus the robot's LAN IP.

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

Restart the plugin — BLID, local MQTT password, model, and firmware are fetched from iRobot's cloud automatically. Use the **Test cloud login** button in the frontend to verify credentials without restarting.

### Manual credentials (no cloud account)

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

Run `npx @karlvr/dorita980 getpassword <robot-ip>` on any machine on the same LAN to retrieve `blid`/`password` (hold the robot's Home button until it beeps first).

### Room setup

Roomba stores room names in the iRobot cloud — they're **not** sent over local MQTT. Instead, the plugin captures room IDs from the robot's clean commands, then you rename them. Full guide in [ONBOARDING.md](./ONBOARDING.md); the short version:

1. Set `"discoverRooms": true` on your device
2. Restart the plugin
3. In the iRobot app, clean each room you want controllable — one at a time, so you know which ID is which (plugin logs each mission as it happens)
4. In the Matterbridge frontend, click **Save discovered rooms to config**
5. Edit the auto-populated `name` fields in the config UI (e.g. `"Room 3"` → `"Kitchen"`), optionally set a `type` (`"Kitchen"`, `"LivingRoom"`, etc.)
6. Set `"discoverRooms": false` and restart

After this, "Hey Siri, tell Rumi to clean the kitchen" will run a targeted clean on just that room.

## Supported commands

| Matter command | Roomba action |
|---|---|
| `RvcRunMode.changeToMode(Cleaning)` without selected areas | `clean()` — whole home |
| `RvcRunMode.changeToMode(Cleaning)` with `ServiceArea.selectAreas` | `cleanRoom()` — selected rooms only |
| `RvcRunMode.changeToMode(Idle)` | `stop()` |
| `RvcOperationalState.pause` | `pause()` |
| `RvcOperationalState.resume` | `resume()` |
| `RvcOperationalState.goHome` | `dock()` |
| `Identify.identify` | `find()` — beep to locate |

## Server vs bridged mode

By default each robot is exposed as its **own independent Matter device** (`"serverMode": true`) with a separate QR code shown in the Matterbridge frontend. This is what the roborock plugin does and what Apple Home / Google Home handle best — both controllers have historically struggled with bridged RVC devices, showing "Matterbridge / Aggregator" for metadata and sometimes duplicate "unsupported device" cards.

If you prefer a single pairing code for all Matterbridge plugins, set `"serverMode": false` and the robot appears as a bridged endpoint under the main Matterbridge accessory. Be aware of the controller quirks above.

## Troubleshooting

- **"Connection failed with cipher TLS_AES_256_GCM_SHA384"** — normal on first connect; the plugin auto-rotates to `AES128-SHA256` which Roombas accept.
- **"Roomba … went offline"** — the robot only allows **one** local MQTT connection. Close the iRobot app on your phone (or any other integration that holds a persistent connection, like Home Assistant's `roomba` integration).
- **"Could not find a cloud robot matching …"** — the robot's name in your iRobot app doesn't match the `name` in config. Either rename in iRobot, or match exactly in config (case-insensitive).
- **Room-targeted cleans fall back to whole-home** — means `pmapId`/`userPmapvId` aren't set or a `regionId` in config is missing. Re-run discovery.
- **Firmware shows "3.7.4" in Apple Home** — that's matterbridge's version. The plugin overrides it but HomeKit caches the value at pairing time; remove and re-add the accessory to refresh.

## Credits

- [`@karlvr/dorita980`](https://github.com/karlvr/dorita980) — local MQTT client, cloud auth reference
- [Matterbridge](https://github.com/Luligu/matterbridge) — Matter bridging framework
- [`matterbridge-roborock-vacuum-plugin`](https://github.com/RinDevJunior/matterbridge-roborock-vacuum-plugin) — reference vacuum-plugin architecture

## License

Apache-2.0
