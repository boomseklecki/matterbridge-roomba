/**
 * Pure builders for Matter ServiceArea cluster shapes. Kept free of matterbridge
 * runtime imports so they're directly unit-testable — the only things we need
 * from Matter here are the TLV value shapes, which we redeclare as structural
 * types below.
 */
/**
 * Matter Area namespace tag values (spec §7.19.12.4.15). Unknown types fall back
 * to null so the user-supplied room name still shows — controllers just don't
 * get an icon suggestion.
 */
const AREA_TAG_BY_NAME = {
    bathroom: 0x06,
    bedroom: 0x07,
    breakfastroom: 0x0a,
    cellar: 0x0c,
    closet: 0x0e,
    dining: 0x15,
    familyroom: 0x1d,
    foyer: 0x1e,
    gameroom: 0x21,
    garage: 0x22,
    guestbathroom: 0x26,
    guestbedroom: 0x27,
    guestroom: 0x29,
    gym: 0x2a,
    hallway: 0x2b,
    kidsroom: 0x2d,
    kitchen: 0x2f,
    laundry: 0x31,
    library: 0x33,
    living: 0x34,
    livingroom: 0x34,
    lounge: 0x35,
    mudroom: 0x36,
    office: 0x38,
    pantry: 0x3b,
    patio: 0x3e,
    playroom: 0x3f,
    primarybathroom: 0x42,
    primarybedroom: 0x43,
    recroom: 0x46,
    recreationroom: 0x46,
    staircase: 0x52,
    storageroom: 0x54,
    study: 0x56,
    sunroom: 0x57,
};
export function resolveAreaTypeId(type) {
    if (!type)
        return null;
    return AREA_TAG_BY_NAME[type.toLowerCase().replace(/[\s_-]/g, '')] ?? null;
}
/**
 * Matter's ServiceArea cluster requires `CurrentArea` to reference a valid id
 * in `SupportedAreas`. To keep conformance happy when the user hasn't
 * configured any rooms, we expose a single "Everywhere" catch-all area with
 * id 1. This mirrors how the iRobot app treats a whole-home clean.
 */
export const EVERYWHERE_AREA = {
    areaId: 1,
    mapId: null,
    areaInfo: {
        locationInfo: {
            locationName: 'Everywhere',
            floorNumber: 0,
            areaType: null,
        },
        landmarkInfo: null,
    },
};
/**
 * Build the list of areas for the ServiceArea cluster's `SupportedAreas`.
 *
 * Matter spec §1.17.5.4.2: if `SupportedMaps` is non-empty, every area's
 * `mapId` must reference an entry in it. If empty, every area's `mapId` must
 * be null. We route accordingly and fall back to the first configured map
 * when a room doesn't specify one.
 */
export function buildSupportedAreas(rooms, maps) {
    if (!rooms || rooms.length === 0)
        return [EVERYWHERE_AREA];
    const hasMaps = maps && maps.length > 0;
    const defaultMapId = hasMaps ? maps[0].mapId : null;
    const validMapIds = new Set(maps?.map((m) => m.mapId));
    return rooms.map((room) => {
        let mapId;
        if (!hasMaps) {
            mapId = null;
        }
        else if (room.mapId !== undefined && validMapIds.has(room.mapId)) {
            mapId = room.mapId;
        }
        else {
            mapId = defaultMapId;
        }
        return {
            areaId: room.areaId,
            mapId,
            areaInfo: {
                locationInfo: {
                    locationName: room.name,
                    floorNumber: room.floor ?? 0,
                    areaType: resolveAreaTypeId(room.type),
                },
                landmarkInfo: null,
            },
        };
    });
}
/**
 * Convert the plugin's `maps` config into the Matter `SupportedMaps` struct
 * array. Empty / unset → empty list (single-map mode).
 */
export function buildSupportedMaps(maps) {
    if (!maps || maps.length === 0)
        return [];
    return maps.map((m) => ({
        mapId: m.mapId,
        name: m.name.slice(0, 64),
    }));
}
//# sourceMappingURL=serviceAreaBuilder.js.map