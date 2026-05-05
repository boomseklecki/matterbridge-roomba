/**
 * Pure builders for Matter ServiceArea cluster shapes. Kept free of matterbridge
 * runtime imports so they're directly unit-testable — the only things we need
 * from Matter here are the TLV value shapes, which we redeclare as structural
 * types below.
 */
import type { RoombaRoomConfig, RoombaMapConfig } from './roombaConnection.js';
/** Minimal structural shape of ServiceArea.Area — matches matter.js's TlvArea. */
export interface ServiceAreaArea {
    areaId: number;
    mapId: number | null;
    areaInfo: {
        locationInfo: {
            locationName: string;
            floorNumber: number;
            areaType: number | null;
        } | null;
        landmarkInfo: null;
    };
}
/** Minimal structural shape of ServiceArea.Map — matches matter.js's TlvMap. */
export interface ServiceAreaMap {
    mapId: number;
    name: string;
}
export declare function resolveAreaTypeId(type: string | undefined): number | null;
/**
 * Matter's ServiceArea cluster requires `CurrentArea` to reference a valid id
 * in `SupportedAreas`. To keep conformance happy when the user hasn't
 * configured any rooms, we expose a single "Everywhere" catch-all area with
 * id 1. This mirrors how the iRobot app treats a whole-home clean.
 */
export declare const EVERYWHERE_AREA: ServiceAreaArea;
/**
 * Build the list of areas for the ServiceArea cluster's `SupportedAreas`.
 *
 * Matter spec §1.17.5.4.2: if `SupportedMaps` is non-empty, every area's
 * `mapId` must reference an entry in it. If empty, every area's `mapId` must
 * be null. We route accordingly and fall back to the first configured map
 * when a room doesn't specify one.
 */
export declare function buildSupportedAreas(rooms: RoombaRoomConfig[] | undefined, maps: RoombaMapConfig[] | undefined): ServiceAreaArea[];
/**
 * Convert the plugin's `maps` config into the Matter `SupportedMaps` struct
 * array. Empty / unset → empty list (single-map mode).
 */
export declare function buildSupportedMaps(maps: RoombaMapConfig[] | undefined): ServiceAreaMap[];
//# sourceMappingURL=serviceAreaBuilder.d.ts.map