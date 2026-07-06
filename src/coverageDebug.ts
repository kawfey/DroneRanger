import type mapboxgl from "mapbox-gl";
import { analysisRadiusM } from "./analysis/singleRay";
import { lngLatToMercator01, mercator01ToLngLat } from "./analysis/coordinates";
import type { AnalysisRequest, CoverageCoordinates, CoverageEngine, CoverageTimings, DebugMode } from "./types";

export type ReferenceCircleFeature = {
  type: "Feature";
  properties: Record<string, never>;
  geometry: {
    type: "Polygon";
    coordinates: number[][][];
  };
};

export type DroneRangeDebugState = {
  latestOperator: AnalysisRequest["operator"];
  renderedOperator: AnalysisRequest["operator"] | null;
  coverageCoordinates: CoverageCoordinates | null;
  coverageCanvasFingerprint: string | null;
  renderSequence: number;
  engine: CoverageEngine;
  preferredEngine: CoverageEngine;
  hasCoverageSource: boolean;
  sourceType: string | null;
  sourceTypeCounts: Record<string, number>;
  referenceCircle: ReferenceCircleFeature | null;
  markerLngLat: { lng: number; lat: number } | null;
  lastCoverageTimings: CoverageTimings | null;
};

export type CoverageInspection = {
  lngLat: { lng: number; lat: number };
  canvas: {
    width: number;
    height: number;
    x: number;
    y: number;
    rgba: [number, number, number, number];
  } | null;
  projected: { x: number; y: number } | null;
  uv: { u: number; v: number } | null;
  insideCoverageCoordinates: boolean;
  expectedCanvasPixel: { x: number; y: number } | null;
  nearestNonTransparentPixelDistance: number | null;
  coverageCoordinates: CoverageCoordinates | null;
};

type PixelBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type LngLatBounds = {
  nw: { lng: number; lat: number };
  ne: { lng: number; lat: number };
  se: { lng: number; lat: number };
  sw: { lng: number; lat: number };
};

type ScreenBounds = {
  nw: { x: number; y: number };
  ne: { x: number; y: number };
  se: { x: number; y: number };
  sw: { x: number; y: number };
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type CoverageFootprintAudit = {
  referenceRadiusM: number;
  activeCalculationRadiusM: number;
  engine: CoverageEngine;
  preferredEngine: CoverageEngine;
  coverageCoordinates: CoverageCoordinates | null;
  canvas: {
    width: number;
    height: number;
  } | null;
  alphaBoundsCanvasPx: PixelBounds | null;
  alphaBoundsUv: PixelBounds | null;
  alphaBoundsLngLat: LngLatBounds | null;
  projectedCoverageBounds: ScreenBounds | null;
  projectedAlphaBounds: ScreenBounds | null;
  mapboxSource: {
    type: string | null;
    styleType: string | null;
    hasRuntimeSource: boolean;
  };
  layerPaint: Record<string, unknown> | null;
};

export type CoverageBenchmarkResult = {
  gridSizePx: number;
  pixels: number;
  cpuMs: number | null;
  gpuMs: number | null;
  speedup: number | null;
  cpuPixelsPerMs: number | null;
  gpuPixelsPerMs: number | null;
};

declare global {
  interface Window {
    __droneRangeDebug?: DroneRangeDebugState;
    __inspectCoverageAt?: (lng: number, lat: number) => CoverageInspection;
    __auditCoverageFootprint?: () => CoverageFootprintAudit;
    __benchmarkCoverageRender?: (gridSizes?: number[]) => Promise<CoverageBenchmarkResult[]>;
  }
}

export function getCoverageSourceType(map: mapboxgl.Map): string | null {
  try {
    const styleSource = map.getStyle().sources?.["los-coverage"];
    if (typeof styleSource?.type === "string") {
      return styleSource.type;
    }
  } catch {
    // Fall through to the runtime source, which may be available during style transitions.
  }
  const source = map.getSource("los-coverage") as ({ type?: string } & Record<string, unknown>) | undefined;
  return typeof source?.type === "string" ? source.type : source ? "unknown" : null;
}

export function getStyleSourceTypeCounts(map: mapboxgl.Map): Record<string, number> {
  try {
    const style = map.getStyle();
    return Object.values(style.sources ?? {}).reduce<Record<string, number>>((counts, source) => {
      const type = typeof source.type === "string" ? source.type : "unknown";
      counts[type] = (counts[type] ?? 0) + 1;
      return counts;
    }, {});
  } catch {
    return {};
  }
}

export function canvasFingerprint(canvas: HTMLCanvasElement): string | null {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || canvas.width === 0 || canvas.height === 0) {
    return null;
  }
  try {
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    const stride = Math.max(4, Math.floor(data.length / 2048));
    for (let index = 0; index < data.length; index += stride) {
      hash ^= data[index] ?? 0;
      hash = Math.imul(hash, 16777619);
    }
    return `${canvas.width}x${canvas.height}:${(hash >>> 0).toString(16)}`;
  } catch {
    return null;
  }
}

export function auditCoverageFootprint(
  map: mapboxgl.Map | null,
  canvas: HTMLCanvasElement | null,
  coordinates: CoverageCoordinates | null,
  analysis: AnalysisRequest,
  debugMode: DebugMode,
  engine: CoverageEngine,
  preferredEngine: CoverageEngine,
): CoverageFootprintAudit {
  const alphaCanvas = canvas ? alphaBoundsForCanvas(canvas) : null;
  const alphaUv = canvas && alphaCanvas ? pixelBoundsToUv(alphaCanvas, canvas) : null;
  const alphaLngLat = coordinates && alphaUv ? uvBoundsToLngLatBounds(alphaUv, coordinates) : null;
  let styleType: string | null = null;
  try {
    const styleSource = map?.getStyle().sources?.["los-coverage"];
    styleType = typeof styleSource?.type === "string" ? styleSource.type : null;
  } catch {
    styleType = null;
  }

  return {
    referenceRadiusM: analysis.radiusM,
    activeCalculationRadiusM: analysisRadiusM(analysis, debugMode),
    engine,
    preferredEngine,
    coverageCoordinates: coordinates,
    canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
    alphaBoundsCanvasPx: alphaCanvas,
    alphaBoundsUv: alphaUv,
    alphaBoundsLngLat: alphaLngLat,
    projectedCoverageBounds: map && coordinates ? lngLatBoundsToScreenBounds(map, coordinatesToLngLatBounds(coordinates)) : null,
    projectedAlphaBounds: map && alphaLngLat ? lngLatBoundsToScreenBounds(map, alphaLngLat) : null,
    mapboxSource: {
      type: map ? getCoverageSourceType(map) : null,
      styleType,
      hasRuntimeSource: Boolean(map?.getSource("los-coverage")),
    },
    layerPaint: map ? getCoverageLayerPaint(map) : null,
  };
}

export function inspectCoverageCanvasAt(
  map: mapboxgl.Map | null,
  canvas: HTMLCanvasElement | null,
  coordinates: CoverageCoordinates | null,
  lngLat: { lng: number; lat: number },
): CoverageInspection {
  const projected = map ? map.project(lngLat) : null;
  if (!canvas || !coordinates) {
    return {
      lngLat,
      canvas: null,
      projected: projected ? { x: projected.x, y: projected.y } : null,
      uv: null,
      insideCoverageCoordinates: false,
      expectedCanvasPixel: null,
      nearestNonTransparentPixelDistance: null,
      coverageCoordinates: coordinates,
    };
  }

  const nw = lngLatToMercator01(coordinates[0][0], coordinates[0][1]);
  const se = lngLatToMercator01(coordinates[2][0], coordinates[2][1]);
  const point = lngLatToMercator01(lngLat.lng, lngLat.lat);
  const u = (point.x - nw.x) / (se.x - nw.x);
  const v = (point.y - nw.y) / (se.y - nw.y);
  const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(u * canvas.width)));
  const y = Math.max(0, Math.min(canvas.height - 1, Math.floor(v * canvas.height)));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const pixel = context?.getImageData(x, y, 1, 1).data;
  const insideCoverageCoordinates = u >= 0 && u <= 1 && v >= 0 && v <= 1;
  const isTransparent = (pixel?.[3] ?? 0) === 0;

  return {
    lngLat,
    canvas: {
      width: canvas.width,
      height: canvas.height,
      x,
      y,
      rgba: [pixel?.[0] ?? 0, pixel?.[1] ?? 0, pixel?.[2] ?? 0, pixel?.[3] ?? 0],
    },
    projected: projected ? { x: projected.x, y: projected.y } : null,
    uv: { u, v },
    insideCoverageCoordinates,
    expectedCanvasPixel: insideCoverageCoordinates ? { x, y } : null,
    nearestNonTransparentPixelDistance: isTransparent
      ? nearestNonTransparentPixelDistance(canvas, x, y)
      : 0,
    coverageCoordinates: coordinates,
  };
}

function lngLatBoundsToScreenBounds(map: mapboxgl.Map, bounds: LngLatBounds): ScreenBounds {
  const nw = map.project(bounds.nw);
  const ne = map.project(bounds.ne);
  const se = map.project(bounds.se);
  const sw = map.project(bounds.sw);
  const points = [nw, ne, se, sw];
  return {
    nw: { x: nw.x, y: nw.y },
    ne: { x: ne.x, y: ne.y },
    se: { x: se.x, y: se.y },
    sw: { x: sw.x, y: sw.y },
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function mercatorCoveragePoint(
  coordinates: CoverageCoordinates,
  u: number,
  v: number,
): { lng: number; lat: number } {
  const nw = lngLatToMercator01(coordinates[0][0], coordinates[0][1]);
  const se = lngLatToMercator01(coordinates[2][0], coordinates[2][1]);
  return mercator01ToLngLat({
    x: nw.x + (se.x - nw.x) * u,
    y: nw.y + (se.y - nw.y) * v,
  });
}

function coordinatesToLngLatBounds(coordinates: CoverageCoordinates): LngLatBounds {
  return {
    nw: { lng: coordinates[0][0], lat: coordinates[0][1] },
    ne: { lng: coordinates[1][0], lat: coordinates[1][1] },
    se: { lng: coordinates[2][0], lat: coordinates[2][1] },
    sw: { lng: coordinates[3][0], lat: coordinates[3][1] },
  };
}

function alphaBoundsForCanvas(canvas: HTMLCanvasElement): PixelBounds | null {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || canvas.width === 0 || canvas.height === 0) {
    return null;
  }

  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (data[(y * canvas.width + x) * 4 + 3] === 0) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  return maxX >= 0 ? { minX, minY, maxX, maxY } : null;
}

function pixelBoundsToUv(bounds: PixelBounds, canvas: HTMLCanvasElement): PixelBounds {
  return {
    minX: bounds.minX / canvas.width,
    minY: bounds.minY / canvas.height,
    maxX: (bounds.maxX + 1) / canvas.width,
    maxY: (bounds.maxY + 1) / canvas.height,
  };
}

function uvBoundsToLngLatBounds(bounds: PixelBounds, coordinates: CoverageCoordinates): LngLatBounds {
  return {
    nw: mercatorCoveragePoint(coordinates, bounds.minX, bounds.minY),
    ne: mercatorCoveragePoint(coordinates, bounds.maxX, bounds.minY),
    se: mercatorCoveragePoint(coordinates, bounds.maxX, bounds.maxY),
    sw: mercatorCoveragePoint(coordinates, bounds.minX, bounds.maxY),
  };
}

function nearestNonTransparentPixelDistance(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
): number | null {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || canvas.width === 0 || canvas.height === 0) {
    return null;
  }
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let bestDistanceSq = Infinity;
  for (let py = 0; py < canvas.height; py++) {
    for (let px = 0; px < canvas.width; px++) {
      if (data[(py * canvas.width + px) * 4 + 3] === 0) {
        continue;
      }
      const distanceSq = (px - x) ** 2 + (py - y) ** 2;
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq;
      }
    }
  }
  return Number.isFinite(bestDistanceSq) ? Math.sqrt(bestDistanceSq) : null;
}

function getCoverageLayerPaint(map: mapboxgl.Map): Record<string, unknown> | null {
  if (!map.getLayer("los-coverage")) {
    return null;
  }
  return {
    rasterOpacity: map.getPaintProperty("los-coverage", "raster-opacity"),
    rasterResampling: map.getPaintProperty("los-coverage", "raster-resampling"),
    rasterFadeDuration: map.getPaintProperty("los-coverage", "raster-fade-duration"),
  };
}
