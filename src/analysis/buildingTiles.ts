import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { buildingHeightM } from "./buildings";
import { lngLatToMercator01, type WebMercator } from "./coordinates";
import { coveringDemTiles, type DemTileId, type MercatorBounds } from "./demTiles";

type Position = [number, number];
type PolygonCoordinates = Position[][];
type MultiPolygonCoordinates = PolygonCoordinates[];

export type BuildingHeightField = {
  width: number;
  height: number;
  bounds: MercatorBounds;
  buildingHeightsM: Float32Array;
  zoom: number;
  tileCount: number;
};

const preferredBuildingZoom = 15;
const minBuildingZoom = 12;
const maxBuildingTiles = 96;

export class BuildingHeightTileLoader {
  private readonly tileCache = new Map<string, Promise<ArrayBuffer>>();

  constructor(private readonly mapboxToken: string) {}

  async buildHeightField(bounds: MercatorBounds, width: number, height: number): Promise<BuildingHeightField> {
    const zoom = chooseBuildingZoom(bounds);
    const tiles = coveringDemTiles(bounds, zoom);
    const buildingHeightsM = new Float32Array(width * height);
    await Promise.all(
      tiles.map(async (tile) => {
        const data = await this.loadTile(tile);
        rasterizeBuildingTile(data, tile, bounds, width, height, buildingHeightsM);
      }),
    );
    return {
      width,
      height,
      bounds,
      buildingHeightsM,
      zoom,
      tileCount: tiles.length,
    };
  }

  private loadTile(tile: DemTileId): Promise<ArrayBuffer> {
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    const cached = this.tileCache.get(key);
    if (cached) {
      return cached;
    }
    const promise = fetch(
      `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/${tile.z}/${tile.x}/${tile.y}.vector.pbf?access_token=${encodeURIComponent(
        this.mapboxToken,
      )}`,
    ).then((response) => {
      if (!response.ok) {
        throw new Error(`Unable to load building tile ${key}: ${response.status}`);
      }
      return response.arrayBuffer();
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

function rasterizeBuildingTile(
  data: ArrayBuffer,
  tileId: DemTileId,
  bounds: MercatorBounds,
  width: number,
  height: number,
  output: Float32Array,
): void {
  const tile = new VectorTile(new PbfReader(new Uint8Array(data)));
  const layer = tile.layers.building;
  if (!layer) {
    return;
  }

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
      rasterizePolygon(geometry.coordinates as PolygonCoordinates, heightM, bounds, width, height, output);
    } else if (geometry.type === "MultiPolygon") {
      for (const polygon of geometry.coordinates as MultiPolygonCoordinates) {
        rasterizePolygon(polygon, heightM, bounds, width, height, output);
      }
    }
  }
}

function rasterizePolygon(
  polygon: PolygonCoordinates,
  heightM: number,
  bounds: MercatorBounds,
  width: number,
  height: number,
  output: Float32Array,
): void {
  const rings = polygon.map((ring) => ring.map(([lng, lat]) => lngLatToMercator01(lng, lat)));
  const outer = rings[0];
  if (!outer || outer.length < 3) {
    return;
  }
  const flat = rings.flat();
  const minX = Math.min(...flat.map((point) => point.x));
  const maxX = Math.max(...flat.map((point) => point.x));
  const minY = Math.min(...flat.map((point) => point.y));
  const maxY = Math.max(...flat.map((point) => point.y));
  const x0 = Math.max(0, Math.floor(((minX - bounds.west) / (bounds.east - bounds.west)) * width));
  const x1 = Math.min(width - 1, Math.ceil(((maxX - bounds.west) / (bounds.east - bounds.west)) * width));
  const y0 = Math.max(0, Math.floor(((minY - bounds.north) / (bounds.south - bounds.north)) * height));
  const y1 = Math.min(height - 1, Math.ceil(((maxY - bounds.north) / (bounds.south - bounds.north)) * height));

  for (let y = y0; y <= y1; y++) {
    const mercatorY = bounds.north + ((y + 0.5) / height) * (bounds.south - bounds.north);
    for (let x = x0; x <= x1; x++) {
      const mercatorX = bounds.west + ((x + 0.5) / width) * (bounds.east - bounds.west);
      const point = { x: mercatorX, y: mercatorY };
      if (!isPointInPolygon(point, rings)) {
        continue;
      }
      const outputIndex = y * width + x;
      output[outputIndex] = Math.max(output[outputIndex] ?? 0, heightM);
    }
  }
}

function isPointInPolygon(point: WebMercator, rings: WebMercator[][]): boolean {
  const [outer, ...holes] = rings;
  if (!outer || !isPointInRing(point, outer)) {
    return false;
  }
  return !holes.some((hole) => isPointInRing(point, hole));
}

function isPointInRing(point: WebMercator, ring: WebMercator[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i];
    const pj = ring[j];
    if (!pi || !pj) {
      continue;
    }
    const intersects =
      pi.y > point.y !== pj.y > point.y &&
      point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}
