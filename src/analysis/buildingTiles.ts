import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { buildingHeightM } from "./buildings";
import { lngLatToMercator01, type WebMercator } from "./coordinates";
import { coveringDemTiles, type DemTileId, type MercatorBounds } from "./demTiles";

type Position = [number, number];
type PolygonCoordinates = Position[][];
type MultiPolygonCoordinates = PolygonCoordinates[];
type XInterval = { start: number; end: number };

export type BuildingHeightField = {
  width: number;
  height: number;
  bounds: MercatorBounds;
  buildingHeightsM: Float32Array;
  zoom: number;
  tileCount: number;
  fetchParseMs: number;
  rasterizeMs: number;
};

type BuildingTileSet = {
  bounds: MercatorBounds;
  zoom: number;
  tiles: DemTileId[];
};

export type ParsedBuildingPolygon = {
  rings: WebMercator[][];
  mercatorBounds: MercatorBounds;
  heightM: number;
};

type BuildingTileLoaderOptions = {
  fetchTile?: (tile: DemTileId, url: string) => Promise<ArrayBuffer>;
  parseTile?: (data: ArrayBuffer, tile: DemTileId) => ParsedBuildingPolygon[];
};

const preferredBuildingZoom = 15;
const minBuildingZoom = 12;
const maxBuildingTiles = 96;

export class BuildingHeightTileLoader {
  private readonly tileCache = new Map<string, Promise<ArrayBuffer>>();
  private readonly parsedTileCache = new Map<string, Promise<ParsedBuildingPolygon[]>>();

  constructor(
    private readonly mapboxToken: string,
    private readonly options: BuildingTileLoaderOptions = {},
  ) {}

  async buildHeightField(bounds: MercatorBounds, width: number, height: number): Promise<BuildingHeightField> {
    const tileSets = chooseBuildingTileSets(bounds);
    const tiles = tileSets.flatMap((tileSet) => tileSet.tiles);
    const buildingHeightsM = new Float32Array(width * height);
    const fetchParseStartedAt = performance.now();
    const parsedTileSets = await Promise.all(
      tileSets.map(async (tileSet) => ({
        ...tileSet,
        polygons: await Promise.all(
          tileSet.tiles.map((tile) =>
            this.loadParsedTile(tile).catch((error) => {
              console.warn(`Unable to load building tile ${tile.z}/${tile.x}/${tile.y}; continuing without it.`, error);
              return [];
            }),
          ),
        ),
      })),
    );
    const fetchParseMs = performance.now() - fetchParseStartedAt;
    const rasterizeStartedAt = performance.now();
    for (const tileSet of parsedTileSets) {
      for (const polygons of tileSet.polygons) {
        rasterizeParsedBuildingPolygons(polygons, bounds, width, height, buildingHeightsM, tileSet.bounds);
      }
    }
    const rasterizeMs = performance.now() - rasterizeStartedAt;
    return {
      width,
      height,
      bounds,
      buildingHeightsM,
      zoom: Math.max(...tileSets.map((tileSet) => tileSet.zoom)),
      tileCount: tiles.length,
      fetchParseMs,
      rasterizeMs,
    };
  }

  private loadParsedTile(tile: DemTileId): Promise<ParsedBuildingPolygon[]> {
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    const cached = this.parsedTileCache.get(key);
    if (cached) {
      return cached;
    }
    const promise = this.loadTile(tile)
      .then((data) => (this.options.parseTile ?? parseBuildingTile)(data, tile))
      .catch((error) => {
        this.parsedTileCache.delete(key);
        throw error;
      });
    this.parsedTileCache.set(key, promise);
    return promise;
  }

  private loadTile(tile: DemTileId): Promise<ArrayBuffer> {
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    const cached = this.tileCache.get(key);
    if (cached) {
      return cached;
    }
    const url = `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/${tile.z}/${tile.x}/${tile.y}.vector.pbf?access_token=${encodeURIComponent(
      this.mapboxToken,
    )}`;
    const promise = (this.options.fetchTile
      ? this.options.fetchTile(tile, url)
      : fetch(url).then((response) => {
          if (!response.ok) {
            throw new Error(`Unable to load building tile ${key}: ${response.status}`);
          }
          return response.arrayBuffer();
        })).catch((error) => {
      this.tileCache.delete(key);
      throw error;
    });
    this.tileCache.set(key, promise);
    return promise;
  }
}

export function sampleBuildingHeightField(field: BuildingHeightField, point: WebMercator): number {
  const u = (point.x - field.bounds.west) / (field.bounds.east - field.bounds.west);
  const v = (point.y - field.bounds.north) / (field.bounds.south - field.bounds.north);
  const x = Math.max(0, Math.min(field.width - 1, Math.floor(u * field.width)));
  const y = Math.max(0, Math.min(field.height - 1, Math.floor(v * field.height)));
  return field.buildingHeightsM[y * field.width + x] ?? 0;
}

function chooseBuildingZoom(bounds: MercatorBounds): number {
  for (let zoom = preferredBuildingZoom; zoom > minBuildingZoom; zoom--) {
    if (coveringDemTiles(bounds, zoom).length <= maxBuildingTiles) {
      return zoom;
    }
  }
  return minBuildingZoom;
}

export function chooseBuildingTileSets(bounds: MercatorBounds): BuildingTileSet[] {
  const zoom = chooseBuildingZoom(bounds);
  const fullTiles = coveringDemTiles(bounds, zoom);
  if (zoom === preferredBuildingZoom) {
    return [{ bounds, zoom, tiles: fullTiles }];
  }

  const nearFieldBounds = centeredNearFieldBounds(bounds, preferredBuildingZoom, maxBuildingTiles);
  if (!nearFieldBounds) {
    return [{ bounds, zoom, tiles: fullTiles }];
  }

  return [
    { bounds, zoom, tiles: fullTiles },
    {
      bounds: nearFieldBounds,
      zoom: preferredBuildingZoom,
      tiles: coveringDemTiles(nearFieldBounds, preferredBuildingZoom),
    },
  ];
}

function centeredNearFieldBounds(bounds: MercatorBounds, zoom: number, maxTiles: number): MercatorBounds | null {
  let low = 0;
  let high = 1;
  let best: MercatorBounds | null = null;

  for (let iteration = 0; iteration < 24; iteration++) {
    const scale = (low + high) / 2;
    const candidate = scaleBoundsFromCenter(bounds, scale);
    if (coveringDemTiles(candidate, zoom).length <= maxTiles) {
      best = candidate;
      low = scale;
    } else {
      high = scale;
    }
  }

  return best;
}

function scaleBoundsFromCenter(bounds: MercatorBounds, scale: number): MercatorBounds {
  const centerX = (bounds.west + bounds.east) / 2;
  const centerY = (bounds.north + bounds.south) / 2;
  const halfWidth = ((bounds.east - bounds.west) * scale) / 2;
  const halfHeight = ((bounds.south - bounds.north) * scale) / 2;
  return {
    west: centerX - halfWidth,
    north: centerY - halfHeight,
    east: centerX + halfWidth,
    south: centerY + halfHeight,
  };
}

function parseBuildingTile(
  data: ArrayBuffer,
  tileId: DemTileId,
): ParsedBuildingPolygon[] {
  const tile = new VectorTile(new PbfReader(new Uint8Array(data)));
  const layer = tile.layers.building;
  if (!layer) {
    return [];
  }

  const polygons: ParsedBuildingPolygon[] = [];
  for (let index = 0; index < layer.length; index++) {
    const feature = layer.feature(index);
    if (feature.type !== 3) {
      continue;
    }
    const heightM = buildingHeightM(feature);
    if (heightM <= 0) {
      continue;
    }
    const geometry = feature.toGeoJSON(tileId.x, tileId.y, tileId.z).geometry;
    if (geometry.type === "Polygon") {
      polygons.push(parsedBuildingPolygon(geometry.coordinates as PolygonCoordinates, heightM));
    } else if (geometry.type === "MultiPolygon") {
      for (const polygon of geometry.coordinates as MultiPolygonCoordinates) {
        polygons.push(parsedBuildingPolygon(polygon, heightM));
      }
    }
  }
  return polygons;
}

function parsedBuildingPolygon(polygon: PolygonCoordinates, heightM: number): ParsedBuildingPolygon {
  const rings = mercatorRings(polygon);
  return {
    rings,
    mercatorBounds: boundsForRings(rings),
    heightM,
  };
}

function mercatorRings(polygon: PolygonCoordinates): WebMercator[][] {
  return polygon.map((ring) => ring.map(([lng, lat]) => lngLatToMercator01(lng, lat)));
}

function boundsForRings(rings: WebMercator[][]): MercatorBounds {
  let west = Infinity;
  let north = Infinity;
  let east = -Infinity;
  let south = -Infinity;
  for (const ring of rings) {
    for (const point of ring) {
      west = Math.min(west, point.x);
      north = Math.min(north, point.y);
      east = Math.max(east, point.x);
      south = Math.max(south, point.y);
    }
  }
  return { west, north, east, south };
}

export function rasterizeParsedBuildingPolygons(
  polygons: ParsedBuildingPolygon[],
  bounds: MercatorBounds,
  width: number,
  height: number,
  output: Float32Array,
  clipBounds: MercatorBounds = bounds,
): void {
  for (const polygon of polygons) {
    rasterizePolygon(polygon.rings, polygon.mercatorBounds, polygon.heightM, bounds, clipBounds, width, height, output);
  }
}

function rasterizePolygon(
  rings: WebMercator[][],
  polygonBounds: MercatorBounds,
  heightM: number,
  bounds: MercatorBounds,
  clipBounds: MercatorBounds,
  width: number,
  height: number,
  output: Float32Array,
): void {
  const outer = rings[0];
  if (!outer || outer.length < 3) {
    return;
  }
  const minX = Math.max(polygonBounds.west, clipBounds.west);
  const maxX = Math.min(polygonBounds.east, clipBounds.east);
  const minY = Math.max(polygonBounds.north, clipBounds.north);
  const maxY = Math.min(polygonBounds.south, clipBounds.south);
  if (maxX < bounds.west || minX > bounds.east || maxY < bounds.north || minY > bounds.south) {
    return;
  }
  const x0 = Math.max(0, Math.floor(((minX - bounds.west) / (bounds.east - bounds.west)) * width));
  const x1 = Math.min(width - 1, Math.ceil(((maxX - bounds.west) / (bounds.east - bounds.west)) * width));
  const y0 = Math.max(0, Math.floor(((minY - bounds.north) / (bounds.south - bounds.north)) * height));
  const y1 = Math.min(height - 1, Math.ceil(((maxY - bounds.north) / (bounds.south - bounds.north)) * height));

  const holes = rings.slice(1);
  for (let y = y0; y <= y1; y++) {
    const mercatorY = bounds.north + ((y + 0.5) / height) * (bounds.south - bounds.north);
    let intervals = ringIntervalsAtY(outer, mercatorY);
    for (const hole of holes) {
      intervals = subtractIntervals(intervals, ringIntervalsAtY(hole, mercatorY));
      if (intervals.length === 0) {
        break;
      }
    }
    for (const interval of intervals) {
      const startX = Math.max(x0, Math.ceil(((interval.start - bounds.west) / (bounds.east - bounds.west)) * width - 0.5));
      const endX = Math.min(x1, Math.floor(((interval.end - bounds.west) / (bounds.east - bounds.west)) * width - 0.5));
      for (let x = startX; x <= endX; x++) {
        const outputIndex = y * width + x;
        output[outputIndex] = Math.max(output[outputIndex] ?? 0, heightM);
      }
    }
  }
}

function ringIntervalsAtY(ring: WebMercator[], y: number): XInterval[] {
  const intersections: number[] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i];
    const pj = ring[j];
    if (!pi || !pj) {
      continue;
    }
    const intersects =
      pi.y > y !== pj.y > y;
    if (intersects) {
      intersections.push(((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x);
    }
  }
  intersections.sort((a, b) => a - b);
  const intervals: XInterval[] = [];
  for (let index = 0; index + 1 < intersections.length; index += 2) {
    const start = intersections[index];
    const end = intersections[index + 1];
    if (start !== undefined && end !== undefined && end > start) {
      intervals.push({ start, end });
    }
  }
  return intervals;
}

function subtractIntervals(intervals: XInterval[], holes: XInterval[]): XInterval[] {
  let remaining = intervals;
  for (const hole of holes) {
    const next: XInterval[] = [];
    for (const interval of remaining) {
      if (hole.end <= interval.start || hole.start >= interval.end) {
        next.push(interval);
        continue;
      }
      if (hole.start > interval.start) {
        next.push({ start: interval.start, end: Math.min(hole.start, interval.end) });
      }
      if (hole.end < interval.end) {
        next.push({ start: Math.max(hole.end, interval.start), end: interval.end });
      }
    }
    remaining = next;
  }
  return remaining;
}
