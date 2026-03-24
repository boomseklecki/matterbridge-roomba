# matterbridge-roomba

A [Matterbridge](https://github.com/Luligu/matterbridge) plugin for iRobot Roomba devices. Exposes each Roomba as a Matter **Robotic Vacuum Cleaner** device, giving HomeKit a proper robot vacuum tile with room selection, operational state, and battery level — no switch or fan workarounds required.

## Features

- **Room selection** via Matter ServiceArea cluster — select individual named missions or clean everywhere
- **Named missions** — configure per-robot cleaning missions with specific rooms, two-pass, carpet boost, and other per-region parameters pulled directly from the iRobot app
- **Operational state** — Running, Paused, Charging, Docked, Seeking Charger, Error
- **Battery level** — live percentage and charge state
- **Smart polling** — 5 s while user is active, 10 s while robot is active, configurable idle interval (default 15 min)
- **Cloud or local** — authenticate with iRobot cloud credentials for automatic discovery, or configure devices manually with local credentials

## Prerequisites

- [Matterbridge](https://github.com/Luligu/matterbridge) installed and running
- iRobot Roomba with local MQTT access (i-series, j-series, s-series with firmware ≥ 3.x)
- Local device credentials (`blid` and `robotpwd`) — see [Obtaining credentials](#obtaining-credentials)

## Installation

### Via Matterbridge frontend (recommended)

Open the Matterbridge frontend at `http://[matterbridge-host]:8283`, search for `matterbridge-roomba`, and click **Install**.

### Via terminal

**Linux / macOS:**
```bash
sudo npm install -g matterbridge-roomba --omit=dev
matterbridge -add matterbridge-roomba
```

**Windows:**
```powershell
npm install -g matterbridge-roomba --omit=dev
matterbridge -add matterbridge-roomba
```

Then restart Matterbridge and configure the plugin through the frontend.

## Configuration

Open the Matterbridge frontend, navigate to the plugin settings, and fill in your device details. All fields are also documented in the built-in schema.

### Top-level options

| Field | Type | Description |
|---|---|---|
| `email` | string | iRobot cloud account email. Optional if all devices are configured manually. |
| `password` | string | iRobot cloud account password. Optional if all devices are configured manually. |
| `idleWatchInterval` | number | How often to poll when idle, in minutes. Default: `15`. |
| `devices` | array | Manual device configuration. Required if not using cloud credentials. |

### Device options (`devices[]`)

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Display name for this Roomba. |
| `blid` | string | ✓ | Robot ID. See [Obtaining credentials](#obtaining-credentials). |
| `robotpwd` | string | ✓ | Local MQTT password. See [Obtaining credentials](#obtaining-credentials). |
| `ipaddress` | string | ✓ | Local IP address of the robot. |
| `serialNumber` | string | | Serial number (printed on the robot). Auto-populated from cloud discovery if available; shown in Matterbridge device list instead of the blid. |
| `stopBehaviour` | `"home"` \| `"pause"` | | What to do when stopped from HomeKit. `"home"` sends the robot to dock; `"pause"` just pauses. Default: `"home"`. |
| `idleWatchInterval` | number | | Per-device override for the idle poll interval (minutes). |
| `missions` | array | | Named cleaning missions. See below. |

### Mission options (`devices[].missions[]`)

Named missions correspond to saved cleaning jobs in the iRobot app. Each mission appears as a selectable room in HomeKit's room picker. An **Everywhere** option is always present to clean without a specific mission.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Display name shown in HomeKit room picker. |
| `pmap_id` | string | ✓ | Persistent map ID. Copy from `lastCommand` state. |
| `user_pmapv_id` | string | ✓ | Map version ID. Copy from `lastCommand` state. |
| `ordered` | number | | Whether regions are cleaned in order. Default: `1`. |
| `favorite_id` | string | | Favorite ID for multi-room presets saved in the iRobot app. |
| `regions` | array | ✓ | Regions to clean. |

### Region options (`missions[].regions[]`)

| Field | Type | Required | Description |
|---|---|---|---|
| `region_id` | string | ✓ | Region ID. Copy from `lastCommand` state. |
| `type` | string | ✓ | Region type. Default: `"rid"`. |
| `params.noAutoPasses` | boolean | | Disable auto-pass detection. |
| `params.twoPass` | boolean | | Clean each region twice. |
| `params.carpetBoost` | boolean | | Boost suction on carpet. |
| `params.vacHigh` | boolean | | High vacuum mode. |
| `params.gentleMode` | number | | Gentle cleaning mode. |

### Example configuration

```json
{
  "name": "matterbridge-roomba",
  "type": "DynamicPlatform",
  "devices": [
    {
      "name": "Roomba i7",
      "blid": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      "robotpwd": "YYYYYYYY",
      "ipaddress": "192.168.1.50",
      "stopBehaviour": "home",
      "missions": [
        {
          "name": "Kitchen",
          "pmap_id": "EnfGy5e6QPuv4xKra1DkCQ",
          "user_pmapv_id": "250605T181117",
          "regions": [
            { "region_id": "4", "type": "rid" }
          ]
        },
        {
          "name": "Downstairs",
          "pmap_id": "EnfGy5e6QPuv4xKra1DkCQ",
          "user_pmapv_id": "250605T181117",
          "favorite_id": "0eada7e3d5afa60926ed373da961c064",
          "regions": [
            { "region_id": "1", "type": "rid" },
            { "region_id": "4", "type": "rid" },
            { "region_id": "25", "type": "rid" }
          ]
        }
      ]
    }
  ]
}
```

## Obtaining credentials

### Using iRobot cloud (automatic discovery)

Provide your `email` and `password` in the plugin config. The plugin will authenticate with iRobot's cloud and discover all robots associated with your account, including their local IP addresses.

### Manual credentials (local only)

Use the [dorita980](https://github.com/koalazak/dorita980) credential tool to retrieve your robot's `blid` and local password without cloud access:

```bash
npx dorita980 getpassword <robot-ip>
```

Follow the prompts (you'll need to hold the HOME button on the robot). The tool prints the `blid` and `robotpwd` values to use in the config.

### Finding mission IDs

Start a cleaning mission from the iRobot app, then query the robot's last command state using dorita980 or any MQTT client. The `lastCommand` field contains `pmap_id`, `user_pmapv_id`, and the `regions` array with `region_id` values needed for mission configuration.

## Room selection behaviour

| HomeKit room selection | Action |
|---|---|
| Nothing selected | Full vacuum (`clean()`) |
| **Everywhere** selected | Full vacuum (`clean()`) |
| One or more rooms selected (no `favorite_id`) | Regions from all selected missions are merged into a single `cleanRoom` call |
| A room with `favorite_id` selected | Runs that mission's `cleanRoom` call; logs a warning if multiple `favorite_id` missions are selected |

## License

Apache-2.0
