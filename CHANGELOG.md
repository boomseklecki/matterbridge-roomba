# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.0] — 2026-04-20

First public npm release. Consolidates everything since 1.5.0 (never published):
capability-aware clean modes, completion events, and the iOS Home "All Rooms"
workaround.

### Added

- **Capability-gated `RvcCleanMode`**. The plugin now reads Roomba's reported
  `cap.multiPass`, `cap.carpetBoost`, `cap.pp`, and `cap.floorTypeDetect` fields
  and only exposes the clean modes a given robot actually supports. A 600/i3+
  no longer sees a non-functional Deep Clean option; a j5+ gets Vacuum + Quick +
  Max + Deep Clean; a Combo model gets Vacuum + Mop + Vacuum-then-Mop. Swappable
  models (j5/j6) toggle Mop vs Vacuum based on which reservoir is installed.
- **`Quick` and `Max` clean modes** on vacuum-capable robots that support them —
  mapped to `setCleaningPassesOne` + carpet-boost-eco and
  `setCleaningPassesTwo` + carpet-boost-performance respectively.
- **`OperationCompletion` events** (`RvcOperationalState`). Fires on every
  running-to-idle transition with `totalOperationalTime` and `completionErrorCode`
  so controllers can push notifications for "Roomba finished cleaning".
- **`ReachableChanged` events** (`BridgedDeviceBasicInformation`). The plugin
  now updates `reachable` on MQTT connect/disconnect, so controllers show the
  right online/offline state when a robot goes dark.
- **`iosAllRoomsWorkaround` config option** (default on). Works around an iOS
  Home UI bug where picking "All Rooms" leaves the picker checkboxes showing only
  the first room. When enabled, the plugin mirrors the full room list back to
  `SelectedAreas` so iOS Home's summary display matches intent within a few
  seconds. Technically violates Matter spec §1.17.6.4 (attribute-via-command-only);
  set to `false` to return to spec-compliant behavior.

### Fixed

- **Stale error on `OperationCompletion`**. The plugin now latches the last
  non-zero error code during a mission so it survives Roomba's
  clear-error-on-dock behavior and is reported accurately on completion.
- **iOS Home "All Rooms" picker reset**. Previously the picker summary briefly
  showed "1 Room" and sometimes stuck there; now resolves to "All Rooms" once
  the subscription update lands (full fix requires the iOS side; see known
  limitations in README.md).

## [1.4.0] — 2026-04-20

### Added

- **Multi-floor home support** via the `ServiceArea` cluster's `Maps` feature
  (Matter 1.4 §17.7). Each persistent map on the robot becomes a `SupportedMap`
  entry; rooms are grouped under the right floor in Apple Home / Google Home.
- **`maps[]` config array** for multi-pmap setups, and a `mapId` field on each
  room entry to associate it with a map. Single-map setups continue to work
  with the top-level `pmapId` / `userPmapvId` fields.
- **Multi-map discovery**. `applyDiscoveredRooms` now detects 2+ distinct
  pmaps and writes the `maps[]` array automatically, preserving any renamed
  entries from previous runs.

### Fixed

- Multi-map discovery previously saved only the primary pmap; all discovered
  maps are now preserved.

## [1.3.0] — 2026-04-20

### Added

- **Model-aware `RvcCleanMode`**. SKU classification (j5/j6 swappable,
  j7+/j9+ combo, m-series mop-only, older vacuum-only) drives which clean modes
  appear in the Matter controller.
- **Mop mode** on swappable models with runtime gating based on which reservoir
  is installed — picking Mop while the bin is in raises an error.
- **Vacuum-then-Mop mode** on Combo models, routed through Roomba's native
  combo behavior.

## [1.2.0] — 2026-04-20

### Added

- **Full Matter 1.4 RVC error enum coverage**: Stuck, WheelsJammed, BrushJammed,
  NavigationSensorObscured, CannotReachTargetArea, BinMissing, BinFull,
  WaterTankMissing, WaterTankEmpty, WaterTankLidOpen, MopCleaningPadMissing,
  FailedToFindChargingDock, low-battery — all mapped from Roomba error codes.
- **`OperationalError` events** fire on transitions into error states so
  controllers can push-notify. No event spam on clear-to-zero transitions.
- **`Mapping` run mode** routed to Roomba's `train()` mission so training
  runs are triggerable from the Matter controller.

## [1.1.2] — 2026-04-20

### Added

- **Multi-room progress tracking**. `currentArea` auto-advances across rooms
  during a multi-room mission using a cumulative-sqft heuristic, with
  wall-clock time as fallback. Tuned by `roomCleanSqft` and
  `roomCleanDurationMinutes` config keys.
- **Skip detection** from the iRobot app. Pressing Skip advances the Matter
  controller's "currently cleaning" indicator within ~1 second.

## [1.1.1] — 2026-04-20

### Fixed

- **Dock-loop bug**. "Send to Dock" previously left Roomba in a paused mission,
  which caused the robot to re-undock after the controller's subsequent
  refresh. The plugin now sends `stop()` before `dock()` to cancel any paused
  state.
- Various operational-state edge cases around pause/resume and charging.

## [1.1.0] — 2026-04-19

### Added

- **Room-targeted cleans** via `ServiceArea.SelectAreas`. Apple Home / Google
  Home room selection is translated to Roomba's `cleanRoom` command with pmap
  + region IDs resolved from config.
- **Cloud-assisted onboarding**. Enter your iRobot account email/password in
  config and the plugin auto-fetches each robot's BLID and local MQTT password
  at startup via the Gigya federated login.
- **Frontend actions**: `testCloudLogin` and `applyDiscoveredRooms` toggles
  exposed in the Matterbridge UI for one-click ops.
- **Room discovery mode**. Toggle `discoverRooms: true` on a device and the
  plugin captures room/region IDs from the robot's own clean commands, ready
  for `applyDiscoveredRooms` to snapshot into config.
- **CI workflow** (GitHub Actions) building against Node 18/20/22/24.

## [1.0.2] — 2026-04-19

### Added

- **Standalone server mode per robot** (`serverMode: true`, default). Each
  robot gets its own Matter server node and QR code, avoiding Apple Home's
  bridged-RVC-device quirks.

### Fixed

- Root-node identity now uses the robot's own vendor/product info instead of
  inheriting Matterbridge's.

## [1.0.1] — 2026-04-18

### Fixed

- Device registration timing and initial state update race conditions.
- `BasicInformation` metadata correctness (vendor, model, firmware).

## [1.0.0] — 2026-03-24

Initial implementation. Exposes a single Roomba as a Matter RVC device with
basic clean / pause / resume / dock commands and operational-state mapping.

[1.6.0]: https://github.com/Rashed97/matterbridge-roomba/releases/tag/v1.6.0
[1.4.0]: https://github.com/Rashed97/matterbridge-roomba/releases/tag/v1.4.0
[1.3.0]: https://github.com/Rashed97/matterbridge-roomba/releases/tag/v1.3.0
[1.2.0]: https://github.com/Rashed97/matterbridge-roomba/releases/tag/v1.2.0
[1.1.2]: https://github.com/Rashed97/matterbridge-roomba/releases/tag/v1.1.2
[1.1.1]: https://github.com/Rashed97/matterbridge-roomba/releases/tag/v1.1.1
[1.1.0]: https://github.com/Rashed97/matterbridge-roomba/releases/tag/v1.1.0
[1.0.2]: https://github.com/Rashed97/matterbridge-roomba/releases/tag/v1.0.2
[1.0.1]: https://github.com/Rashed97/matterbridge-roomba/releases/tag/v1.0.1
[1.0.0]: https://github.com/Rashed97/matterbridge-roomba/releases/tag/v1.0.0
