import { describe, expect, it } from 'vitest';
import {
  buildSupportedAreas,
  buildSupportedMaps,
  resolveAreaTypeId,
  EVERYWHERE_AREA,
} from '../src/serviceAreaBuilder.js';
import type { RoombaRoomConfig, RoombaMapConfig } from '../src/roombaConnection.js';

describe('resolveAreaTypeId', () => {
  it('maps common room types to their Matter namespace tag values', () => {
    expect(resolveAreaTypeId('Kitchen')).toBe(0x2f);
    expect(resolveAreaTypeId('LivingRoom')).toBe(0x34);
    expect(resolveAreaTypeId('Living')).toBe(0x34);
    expect(resolveAreaTypeId('Bedroom')).toBe(0x07);
    expect(resolveAreaTypeId('Bathroom')).toBe(0x06);
  });

  it('is case-insensitive and tolerant of separators', () => {
    expect(resolveAreaTypeId('living room')).toBe(0x34);
    expect(resolveAreaTypeId('LIVING-ROOM')).toBe(0x34);
    expect(resolveAreaTypeId('guest_bedroom')).toBe(0x27);
  });

  it('returns null for unknown types and undefined/empty', () => {
    expect(resolveAreaTypeId(undefined)).toBeNull();
    expect(resolveAreaTypeId('')).toBeNull();
    expect(resolveAreaTypeId('TopSecretLair')).toBeNull();
  });
});

describe('buildSupportedAreas — single-map (no `maps` config)', () => {
  it('returns the Everywhere fallback when rooms is empty / undefined', () => {
    expect(buildSupportedAreas(undefined, undefined)).toEqual([EVERYWHERE_AREA]);
    expect(buildSupportedAreas([], undefined)).toEqual([EVERYWHERE_AREA]);
  });

  it('maps each room to an Area with mapId=null when no maps configured', () => {
    const rooms: RoombaRoomConfig[] = [
      { areaId: 3, regionId: '3', name: 'Kitchen', type: 'Kitchen' },
      { areaId: 4, regionId: '4', name: 'Living Room', type: 'LivingRoom', floor: 1 },
    ];
    const areas = buildSupportedAreas(rooms, []);
    expect(areas).toHaveLength(2);
    expect(areas[0]).toMatchObject({
      areaId: 3,
      mapId: null,
      areaInfo: {
        locationInfo: { locationName: 'Kitchen', floorNumber: 0, areaType: 0x2f },
        landmarkInfo: null,
      },
    });
    expect(areas[1]).toMatchObject({
      areaId: 4,
      mapId: null,
      areaInfo: { locationInfo: { locationName: 'Living Room', floorNumber: 1, areaType: 0x34 } },
    });
  });

  it('treats undefined maps the same as an empty maps array', () => {
    const rooms: RoombaRoomConfig[] = [{ areaId: 3, name: 'Kitchen' }];
    expect(buildSupportedAreas(rooms, undefined)[0].mapId).toBeNull();
  });
});

describe('buildSupportedAreas — multi-map', () => {
  const maps: RoombaMapConfig[] = [
    { mapId: 1, name: 'Main Floor', pmapId: 'pmap-main' },
    { mapId: 2, name: 'Upstairs', pmapId: 'pmap-upstairs' },
  ];

  it('resolves each room to its declared mapId when valid', () => {
    const rooms: RoombaRoomConfig[] = [
      { areaId: 3, name: 'Kitchen', mapId: 1 },
      { areaId: 4, name: 'Bedroom', mapId: 2 },
    ];
    const areas = buildSupportedAreas(rooms, maps);
    expect(areas[0].mapId).toBe(1);
    expect(areas[1].mapId).toBe(2);
  });

  it('falls back to the first mapId when room.mapId is missing', () => {
    const rooms: RoombaRoomConfig[] = [{ areaId: 3, name: 'Kitchen' }];
    expect(buildSupportedAreas(rooms, maps)[0].mapId).toBe(1);
  });

  it('falls back to the first mapId when room.mapId references an unknown map', () => {
    const rooms: RoombaRoomConfig[] = [{ areaId: 3, name: 'Kitchen', mapId: 999 }];
    expect(buildSupportedAreas(rooms, maps)[0].mapId).toBe(1);
  });

  it('never returns mapId=null when maps is non-empty (conformance requirement)', () => {
    const rooms: RoombaRoomConfig[] = [
      { areaId: 1, name: 'A' },
      { areaId: 2, name: 'B', mapId: 2 },
      { areaId: 3, name: 'C', mapId: 42 }, // unknown -> falls back, NOT null
    ];
    for (const area of buildSupportedAreas(rooms, maps)) {
      expect(area.mapId).not.toBeNull();
    }
  });
});

describe('buildSupportedMaps', () => {
  it('returns an empty array for undefined / empty input', () => {
    expect(buildSupportedMaps(undefined)).toEqual([]);
    expect(buildSupportedMaps([])).toEqual([]);
  });

  it('converts each map config to the Matter SupportedMap struct', () => {
    const maps: RoombaMapConfig[] = [
      { mapId: 1, name: 'Main Floor', pmapId: 'pmap-main', userPmapvId: 'v1' },
      { mapId: 2, name: 'Upstairs', pmapId: 'pmap-upstairs' },
    ];
    expect(buildSupportedMaps(maps)).toEqual([
      { mapId: 1, name: 'Main Floor' },
      { mapId: 2, name: 'Upstairs' },
    ]);
  });

  it('truncates map names to the Matter-mandated 64-char ceiling', () => {
    const longName = 'x'.repeat(100);
    const maps: RoombaMapConfig[] = [{ mapId: 1, name: longName, pmapId: 'p' }];
    const result = buildSupportedMaps(maps);
    expect(result[0].name).toHaveLength(64);
  });
});
