# Onboarding Guide

End-to-end walkthrough from install to a fully-configured Roomba in your Matter controller. Skim the headings and jump to whichever part you need.

- [Part 1 — Pairing the robot](#part-1--pairing-the-robot)
- [Part 2 — Room discovery](#part-2--room-discovery)
- [Part 3 — Multi-floor homes](#part-3--multi-floor-homes)
- [Part 4 — Mopping (swappable & combo models)](#part-4--mopping-swappable--combo-models)
- [Troubleshooting](#troubleshooting)

---

## Part 1 — Pairing the robot

### 1a. Install & configure

Follow the **Install** and **Quick start** sections in [README.md](./README.md). The simplest path is cloud-assisted onboarding: paste your iRobot account email / password + the robot's LAN IP, and the plugin auto-fetches BLID + local MQTT password.

### 1b. Server mode vs bridged mode

By default every robot is exposed as its **own independent Matter device** (`"serverMode": true`) with a separate QR code shown in the Matterbridge frontend. This is what other vacuum plugins do and what Apple Home / Google Home handle best.

If you prefer a single pairing code for all your Matterbridge plugins and accept that the robot's metadata will show as "Matterbridge" in some controllers, set `"serverMode": false` per device.

### 1c. Commission in your Matter controller

1. Wait for `Registered Roomba device: <name>` in the Matterbridge log.
2. Open the Matterbridge frontend (`http://<matterbridge-host>:8283`).
3. You'll see a new device tile per robot (e.g. `Rumi`) with a QR-code icon. Click it.
4. In Apple Home / Google Home / etc., add a new accessory and scan the QR.
5. After commissioning, the accessory detail panel should show vendor `iRobot`, model (e.g. `j517020`), and firmware (e.g. `amethyst+24.29.3+…`). If it shows `Matterbridge 3.7.4` instead, remove the accessory and re-pair — HomeKit caches metadata at pairing time.

> **During commissioning** Apple Home labels the device "Matter Accessory" because we use the CSA test VendorID (`0xfff1`). This is a CSA-certification thing, not a bug. After commissioning, the accessory shows `iRobot` correctly.

---

## Part 2 — Room discovery

Roomba stores room / zone names **in the iRobot cloud**, not on the robot. No local API returns them. Every Roomba smart-home integration uses the same trick: trigger a clean from the iRobot app, capture region IDs from the robot's MQTT state, and pair them with friendly names.

This plugin automates the capture and offers a one-click **"Save discovered rooms to config"** action.

### 2a. Turn discovery on

In the Matterbridge frontend, open the plugin's config UI (gear icon) → expand `devices[0]` → flip **`discoverRooms`** to `true` → **Confirm** → restart the plugin.

In the log, you'll see:

```
[Rumi] Room discovery mode is ON. Clean rooms ONE AT A TIME from the iRobot app
       — each mission will be logged with its region id and timestamp so you can tell
       which room is which.
```

### 2b. Clean each room from the iRobot app

1. Open the iRobot Home app → pick your robot → tap the room selector → select **one room** → start cleaning.
2. Wait a few seconds. You'll see a log like:
   ```
   [Rumi] Mission "start" at 10:23:45 PM: regions=[3] (NEW: 3). (If you just cleaned
          a single room in the iRobot app, region 3 = that room.)
   ```
3. Stop the clean and send the robot home. Move on to the next room.
4. Repeat for every room you want controllable from Matter.

> Shortcut: "Clean My Home" visits every room in one mission — the plugin captures all regions at once.

### 2c. Save discoveries to config

In the Matterbridge frontend, open the plugin's config UI → flip **`Save discovered rooms to config`** to `true` → **Confirm**. (The toggle auto-resets after processing.)

The plugin writes `rooms[]` (or `maps[]` + `rooms[]` for multi-floor — see Part 3) back to your config:

```jsonc
"rooms": [
  { "areaId": 1, "regionId": "1", "regionType": "rid", "name": "Room 1", "type": null },
  { "areaId": 3, "regionId": "3", "regionType": "rid", "name": "Room 3", "type": null },
  …
]
```

### 2d. Rename

Open the plugin config UI again, expand each room in the `rooms` array, and change `name` to your friendly label. Optionally set `type` to one of:

`Bathroom`, `Bedroom`, `BreakfastRoom`, `Cellar`, `Closet`, `Dining`, `FamilyRoom`, `Foyer`, `GameRoom`, `Garage`, `GuestBathroom`, `GuestBedroom`, `GuestRoom`, `Gym`, `Hallway`, `Kidsroom`, `Kitchen`, `Laundry`, `Library`, `Living` / `LivingRoom`, `Lounge`, `Mudroom`, `Office`, `Pantry`, `Patio`, `Playroom`, `PrimaryBathroom`, `PrimaryBedroom`, `Recroom` / `RecreationRoom`, `Staircase`, `StorageRoom`, `Study`, `SunRoom`

(Case-insensitive; `-`/`_`/space tolerated.)

### 2e. Turn discovery off, restart

Flip **`discoverRooms`** back to `false`, **Confirm**, restart the plugin. Your rooms show up in Apple Home / Google Home / wherever, with the right names and icons.

After this: "Hey Siri, tell Rumi to clean the kitchen" works.

---

## Part 3 — Multi-floor homes

If your Roomba stores **multiple persistent maps** (j7+, j9+, s9+ with Imprint Smart Maps across floors), repeat the discovery once per floor:

1. Turn `discoverRooms` on, restart.
2. Place the robot on floor 1. Clean rooms from the iRobot app. Plugin captures pmap A.
3. **Carry the robot to floor 2.** Pmap auto-switches on some firmware; on others you have to pick the map in the iRobot app's map selector first.
4. Clean rooms on floor 2. Plugin captures pmap B under a distinct `pmap_id`.
5. Hit **Save discovered rooms to config**.

The plugin detects that it has rooms from 2+ pmaps and writes:

```jsonc
"maps": [
  { "mapId": 1, "name": "Map 1", "pmapId": "<first-pmap>", "userPmapvId": "…" },
  { "mapId": 2, "name": "Map 2", "pmapId": "<second-pmap>", "userPmapvId": "…" }
],
"rooms": [
  { "areaId": 1, "mapId": 1, "regionId": "1", "name": "Room 1", … },
  …
  { "areaId": 7, "mapId": 2, "regionId": "3", "name": "Room 3", … }
]
```

Rename maps (`"Map 1"` → `"Main Floor"`, `"Map 2"` → `"Upstairs"`) and rooms, restart. Your controller shows rooms grouped by floor.

> Single-floor config (`rooms[]` + top-level `pmapId`) and multi-floor config (`maps[]` + tagged `rooms[]`) are both valid — the plugin picks the right shape based on how many pmaps it sees during discovery.

---

## Part 4 — Mopping (swappable & combo models)

The plugin exposes clean modes based on your robot's family:

| Family | Example SKUs | Modes exposed |
|---|---|---|
| Vacuum-only | 900-series, i1–i4, s9 (non-combo) | `Vacuum`, `Deep Clean` |
| Swappable | j5, j6, some i7s | `Vacuum`, `Deep Clean`, `Mop` |
| Combo | j7 Combo, j9 Combo, s9+ Combo | `Vacuum`, `Deep Clean`, `Mop`, `Vacuum then Mop` |
| Mop-only | Braava m6, m8 | `Mop` |

Family is detected at startup from the robot's SKU (`sku` in MQTT state). Check the startup log:

```
[Rumi] Classified as family "swappable" (sku=j517020)
```

### 4a. Swappable models (j5 / j6)

The bin and mop reservoir are **mutually exclusive**: you physically swap one for the other.

- When the bin is installed → `Mop` mode is **currently unavailable**. If you pick it anyway, the plugin blocks the clean with a log message: *"Swap in the mop reservoir first — the bin is currently installed."*
- When the mop reservoir is installed → `Vacuum` / `Deep Clean` modes are blocked with a similar message.

Matterbridge's cluster server doesn't let plugins reject the Matter `changeToMode` command with an `InvalidInMode` response directly, so Matter still shows the mode as selected. The gating happens at **start-of-clean** time instead — the user sees the helpful message in the log and the robot doesn't start a no-op clean.

### 4b. Combo models (j7/j9 Combo)

Bin and tank are integrated. The robot auto-picks the right tool per surface (vacuum on carpet, mop on hard floor). All clean modes are always available.

When `Mop` or `Vacuum then Mop` is selected but the robot reports `detectedPad: invalid` (pad misseated), the plugin blocks the clean with *"Mop pad is missing or not detected. Reseat the pad."*

### 4c. Mop-only models (Braava)

Only `Mop` mode is exposed. `Vacuum` and `Deep Clean` aren't options.

---

## Troubleshooting

**No discovery log after starting a clean.**
Confirm the plugin is connected (`Connected to Roomba <BLID>` in the log). If yes but still no log, try the iRobot app's "Clean My Home" button — some firmware versions only populate `lastCommand.regions` on multi-room missions.

**My region IDs are UUIDs (`abc-123-…`), not integers.**
Fine — the plugin hashes non-numeric IDs into stable uint32 areaIds. The hash is deterministic so the same region always gets the same areaId across restarts.

**Cleaning a specific room from Apple Home doesn't actually clean that room.**
Re-run discovery — the room's `regionId` or your device's `pmapId` is probably missing. You'll see a warning at clean time: *"selectAreas referenced Matter areaId(s) [X] that have no regionId in config — falling back to whole-home clean."*

**Multi-room clean shows the wrong "currently cleaning" room in Apple Home.**
Roomba doesn't report per-region progress during a mission on j-series firmware — the plugin falls back to a sqft-based (and time-based) heuristic. Tune `roomCleanSqft` (default 75) if rooms flip too early or too late. Pressing **Skip** in the iRobot app advances `currentArea` instantly and correctly.

**Apple Home's "Send to Dock" loops the robot.**
Fixed in v1.1.1. The plugin now `stop()`s before `dock()` to cancel any paused mission — the firmware-level trigger for the loop.

**Battery and charge state frozen at 80% / "Not Charging" after a restart.**
Fixed in v1.1.1. The reconnect path now calls `markActive()` alongside `initializeState()`, so state updates propagate after recovery.

**"The plugin disconnected and can't reconnect."**
Roomba only allows **one** local MQTT connection at a time. If the iRobot app is open, or Home Assistant's `roomba` integration is enabled, or any other tool is connected, ours gets refused. Close the iRobot app and disable competing integrations.
