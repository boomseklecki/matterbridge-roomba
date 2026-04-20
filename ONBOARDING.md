# Onboarding Guide

## Part 1 — Pairing the robot

### Server mode (default, recommended)

By default this plugin exposes each robot as its **own independent Matter device** with its own QR code — NOT as a bridged accessory under the Matterbridge aggregator. This is what the roborock plugin does and what Apple Home / Google Home handle best. If you use a Matter controller that struggles with bridged RVC (both Apple and Google have historically), this is the right mode.

**Pairing flow:**

1. Install and start the plugin. Wait for `Connected to Roomba <BLID>` in the Matterbridge log.
2. Open the Matterbridge frontend (`http://<your-matterbridge-host>:8283`).
3. You'll see a new server node per robot (e.g. `Rumi`). Click its QR-code icon.
4. In your Matter controller (Apple Home / Google Home / etc.), add a new accessory and scan the QR code.
5. The robot pairs as a standalone Matter accessory — with correct vendor (`iRobot`), model (`j517020`), firmware, and serial number.

### Bridged mode (optional)

If you want the robot to appear under the Matterbridge aggregator alongside other Matterbridge plugins (single pairing code for everything), set `"serverMode": false` in the device config. Be aware:

- Apple Home may collapse a single-device bridge oddly and show the vacuum with "Matterbridge" metadata instead of iRobot.
- A ghost "unsupported device" card can appear for the bridged endpoint.

These issues disappear entirely in server mode, so only choose bridged mode if you know why you want it.

---

## Part 2 — Room Discovery

Roomba stores your room/zone names in the iRobot cloud, not on the robot itself. There is no simple REST endpoint that returns them, so every Roomba-based smart home integration (Home Assistant, rest980, roombapy, and this plugin) uses the same trick: trigger a single-room clean from the iRobot app, capture the region IDs the robot broadcasts over local MQTT, and pair them with friendly names in config.

This plugin automates that with a **discovery mode** that logs the captured IDs in a copy-paste-ready format.

## Step-by-step

### 1. Make sure the plugin is connected to your robot

Check the Matterbridge log for:

```
[matterbridge-roomba] Connected to Roomba <BLID>
[matterbridge-roomba] Registered Roomba device: <name>
```

If you don't see both, fix that first.

### 2. Turn discovery mode on

Open the plugin config (`<matterbridge homedir>/.matterbridge/matterbridge-roomba.config.json`, or the Config UI in the Matterbridge frontend) and set:

```jsonc
{
  "devices": [
    {
      "name": "Rumi",
      "blid": "…",
      "password": "…",
      "ipAddress": "192.168.x.y",
      "discoverRooms": true   // ← turn this on
      // leave the existing "rooms" in place or omit it
    }
  ]
}
```

Restart the Matterbridge add-on. You should see one log line per device:

```
[Rumi] Room discovery mode is ON. Start a single-room or "Clean My Home" mission
       from the iRobot app for each room you want exposed. Each new region will be
       logged here in copy-paste form.
```

### 3. Clean one room at a time from the iRobot app

1. Open the iRobot Home app on your phone.
2. Pick your robot, tap the room-selector, select a **single room**, and start cleaning.
3. Wait a few seconds — the plugin log will print something like:

   ```
   [Rumi] Discovered 1 room(s) on map 012345-abcd-…:
     "rooms": [
       { "areaId": 1, "name": "Room 1 (rename me)", "type": null }
     ]
     pmapId=012345-abcd-… userPmapvId=67890-efgh-…
   ```

4. You can **stop the clean immediately** — the discovery only needs the first state message that carries the region id. Send the robot back to the dock and move on to the next room.
5. Repeat for every room you want exposed.

> Shortcut: starting a **"Clean My Home"** mission that visits all rooms in one go also works — the plugin will log all regions at once as they're reported.

### 4. Copy the logged snippet into your config

Each time a new region is seen the plugin re-emits the **whole** accumulated list, so you only need to copy the *last* log entry. Replace the `discoverRooms: true` block with something like:

```jsonc
{
  "devices": [
    {
      "name": "Rumi",
      "blid": "…",
      "password": "…",
      "ipAddress": "192.168.x.y",
      "rooms": [
        { "areaId": 1, "name": "Living Room", "type": "LivingRoom" },
        { "areaId": 2, "name": "Kitchen",     "type": "Kitchen"    },
        { "areaId": 3, "name": "Bedroom",     "type": "Bedroom"    }
      ]
      // "discoverRooms" removed or set back to false
    }
  ]
}
```

#### Recognised `type` values

The `type` maps to a Matter AreaNamespace semantic tag — controllers can use this to pick a nice icon or group rooms by purpose. Supported values (case-insensitive, `-`/`_`/space tolerated):

`Bathroom`, `Bedroom`, `BreakfastRoom`, `Cellar`, `Closet`, `Dining`, `FamilyRoom`, `Foyer`, `GameRoom`, `Garage`, `GuestBathroom`, `GuestBedroom`, `GuestRoom`, `Gym`, `Hallway`, `Kidsroom`, `Kitchen`, `Laundry`, `Library`, `Living` / `LivingRoom`, `Lounge`, `Mudroom`, `Office`, `Pantry`, `Patio`, `Playroom`, `PrimaryBathroom`, `PrimaryBedroom`, `Recroom` / `RecreationRoom`, `Staircase`, `StorageRoom`, `Study`, `SunRoom`

Unknown values fall back to `null` (no semantic tag, name still shows).

### 5. Restart the plugin

One more restart and your rooms will show up in Apple Home / Google Home / whatever Matter controller you're using, with real names instead of the generic placeholders.

### Multi-floor homes (j7+, j9+, s9+)

If your Roomba stores **multiple persistent maps** — one per floor — run discovery **once per floor**:

1. Set `discoverRooms: true`, restart the plugin.
2. Place the robot on floor 1. From the iRobot app, either clean individual rooms or run a whole-floor mission. The plugin captures the first pmap's rooms.
3. **Move the robot to floor 2** (carry it up; pmap auto-switch on some models, manual-select on others via the iRobot app's map selector).
4. Clean rooms on floor 2 from the iRobot app. The plugin captures the second pmap's rooms under a distinct pmapId.
5. Click **"Save discovered rooms to config"** in the Matterbridge frontend.

The plugin detects that it has rooms from two (or more) pmaps and writes a `maps[]` array automatically:

```jsonc
"maps": [
  { "mapId": 1, "name": "Map 1", "pmapId": "…", "userPmapvId": "…" },
  { "mapId": 2, "name": "Map 2", "pmapId": "…", "userPmapvId": "…" }
],
"rooms": [
  { "areaId": 1, "mapId": 1, "regionId": "1", "name": "Room 1", … },
  …
  { "areaId": 7, "mapId": 2, "regionId": "3", "name": "Room 3", … }
]
```

Rename the maps (`"Map 1"` → `"Main Floor"`) and rooms, then restart. Your Matter controller will show the rooms grouped by floor.

## Troubleshooting

**I don't see any discovery log after starting a clean.**

Double-check the plugin is actually connected (look for `Connected to Roomba`). Also try the iRobot app's **"Clean My Home"** button — some firmware versions only populate `lastCommand.regions` on multi-room missions, not single-room.

**My region IDs are strings like `abc-123`, not numbers.**

The plugin automatically hashes non-numeric region IDs into stable numeric `areaId`s. You can use the logged `areaId` as-is; it will remain consistent across restarts because the hash is deterministic.

**Cleaning a specific room from Apple Home doesn't actually clean that room.**

Currently the plugin only reports rooms for display. Wiring the Matter `selectAreas` command back to a `cleanRoom` call with the correct `pmapId` / `user_pmapv_id` is on the roadmap. For now, use your iRobot app for room-targeted cleans; everything-else (start/stop/pause/dock) works from any Matter controller.
