import {
  lngLatToMercator01,
  mercator01ToLngLat,
  metersToMercatorUnits,
  type WebMercator,
} from "./coordinates";
import type { AnalysisRequest } from "../types";

export type MercatorBounds = {
  west: number;
  north: number;
  east: number;
  south: number;
};

export type DemTileId = {
  z: number;
  x: number;
  y: number;
};

export const mapboxTerrainDemMaxZoom = 14;

export function mapboxTerrainRgbElevationM(r: number, g: number, b: number): number {
  return -10000 + (r * 256 * 256 + g * 256 + b) * 0.1;
}

export function analysisMercatorBounds(request: AnalysisRequest, radiusM: number): MercatorBounds {
  const center = lngLatToMercator01(request.operator.lng, request.operator.lat);
  const radius = metersToMercatorUnits(radiusM, request.operator.lat);
  return {
    west: center.x - radius,
    north: center.y - radius,
    east: center.x + radius,
    south: center.y + radius,
  };
}

export function tileForMercator(point: WebMercator, z: number): { x: number; y: number } {
  const scale = 2 ** z;
  return {
    x: Math.floor(point.x * scale),
    y: Math.floor(point.y * scale),
  };
}

export function coveringDemTiles(bounds: MercatorBounds, z: number): DemTileId[] {
  const scale = 2 ** z;
  const minX = Math.max(0, Math.floor(bounds.west * scale));
  const maxX = Math.min(scale - 1, Math.floor((bounds.east - Number.EPSILON) * scale));
  const minY = Math.max(0, Math.floor(bounds.north * scale));
  const maxY = Math.min(scale - 1, Math.floor((bounds.south - Number.EPSILON) * scale));
  const tiles: DemTileId[] = [];

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      tiles.push({ z, x, y });
    }
  }

  return tiles;
}

export function chooseDemZoom(request: AnalysisRequest, radiusM: number): number {
  const gridSize = Math.max(1, Math.round(request.gridSizePx));
  const center = lngLatToMercator01(request.operator.lng, request.operator.lat);
  const east = mercator01ToLngLat({
    x: center.x + metersToMercatorUnits((radiusM * 2) / gridSize, request.operator.lat),
    y: center.y,
  });
  const samplePxM = Math.max(1e-9, Math.abs(east.lng - request.operator.lng));
  const targetTileLngSpan = samplePxM * 256;
  const zoom = Math.ceil(Math.log2(360 / targetTileLngSpan));
  return Math.max(0, Math.min(mapboxTerrainDemMaxZoom, zoom));
}

export function mercatorToTextureUv(point: WebMercator, bounds: MercatorBounds): { u: number; v: number } {
  return {
    u: (point.x - bounds.west) / (bounds.east - bounds.west),
    v: (point.y - bounds.north) / (bounds.south - bounds.north),
  };
}
