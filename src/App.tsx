import { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import {
  Activity,
  Antenna,
  ChevronDown,
  Layers,
  MapPin,
  Radio,
  Settings,
} from "lucide-react";
import { defaultAnalysis } from "./analysis/defaults";
import {
  analysisRadiusM,
  inspectFlatEarthPixel,
  inspectTerrainPixel,
  type TerrainSampler,
} from "./analysis/singleRay";
import {
  clampGridSize,
  createCoverageGridSpec,
  gridCellMercator,
  maxCoverageGridPx,
  minCoverageGridPx,
} from "./analysis/coverageGrid";
import { shadeForPixel } from "./analysis/coverageShading";
import {
  lngLatToMercator01,
  mercator01ToLngLat,
  metersToMercatorUnits,
} from "./analysis/coordinates";
import { GpuCoverageLayer, type GpuCoverageDebugStats, type GpuCoverageImage } from "./gpuCoverageLayer";
import type {
  AnalysisRequest,
  CoverageEngine,
  CoverageCoordinates,
  CoverageOverlay,
  CoveragePixel,
  DebugMode,
  LinkProfile,
  LinkProfileId,
} from "./types";

const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;

type MapStyleTemplate = {
  id: string;
  label: string;
  uri: string;
};

const mapStyleTemplates: MapStyleTemplate[] = [
  { id: "satellite-streets", label: "Satellite", uri: "mapbox://styles/mapbox/satellite-streets-v12" },
  { id: "streets", label: "Streets", uri: "mapbox://styles/mapbox/streets-v12" },
  { id: "outdoors", label: "Outdoors", uri: "mapbox://styles/mapbox/outdoors-v12" },
  { id: "light", label: "Light", uri: "mapbox://styles/mapbox/light-v11" },
  { id: "dark", label: "Dark", uri: "mapbox://styles/mapbox/dark-v11" },
  { id: "navigation-day", label: "Nav Day", uri: "mapbox://styles/mapbox/navigation-day-v1" },
  { id: "navigation-night", label: "Nav Night", uri: "mapbox://styles/mapbox/navigation-night-v1" },
  { id: "standard", label: "Standard", uri: "mapbox://styles/mapbox/standard" },
];

const debugModes: Array<{ id: DebugMode; label: string }> = [
  { id: "combined", label: "Combined" },
  { id: "control", label: "Control" },
  { id: "telemetry", label: "Telemetry" },
  { id: "video", label: "Video" },
  { id: "los", label: "Line of Sight" },
];

type ReferenceCircleFeature = {
  type: "Feature";
  properties: Record<string, never>;
  geometry: {
    type: "Polygon";
    coordinates: number[][][];
  };
};

type InspectorTarget = {
  lng: number;
  lat: number;
};

type DroneRangeDebugState = {
  latestOperator: AnalysisRequest["operator"];
  renderedOperator: AnalysisRequest["operator"] | null;
  coverageCoordinates: CoverageCoordinates | null;
  coverageCanvasFingerprint: string | null;
  renderSequence: number;
  engine: CoverageEngine;
  preferredEngine: CoverageEngine;
  gpuStats: GpuCoverageDebugStats | null;
  hasCoverageSource: boolean;
  sourceType: string | null;
  sourceTypeCounts: Record<string, number>;
  referenceCircle: ReferenceCircleFeature | null;
  markerLngLat: { lng: number; lat: number } | null;
};

type CoverageInspection = {
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

type CoverageFootprintAudit = {
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

type RenderedCoverageFootprint = {
  width: number;
  height: number;
  changedPixels: number;
  bounds: PixelBounds | null;
  center: { x: number; y: number } | null;
  radiusX: number | null;
  radiusY: number | null;
  sampleCount: number;
  maxDelta: number;
};

declare global {
  interface Window {
    __droneRangeDebug?: DroneRangeDebugState;
    __inspectCoverageAt?: (lng: number, lat: number) => CoverageInspection;
    __auditCoverageFootprint?: () => CoverageFootprintAudit;
    __measureRenderedCoverageFootprint?: () => Promise<RenderedCoverageFootprint>;
  }
}

const gpuHeightTexturePx = 768;

function profileLabel(id: LinkProfileId): string {
  return id[0].toUpperCase() + id.slice(1);
}

function debugModeLabel(debugMode: DebugMode): string {
  return debugModes.find((mode) => mode.id === debugMode)?.label ?? "Combined";
}

function modeMarginLabel(debugMode: DebugMode): string {
  return `${debugModeLabel(debugMode)} margin`;
}

function updateProfile(
  profiles: LinkProfile[],
  id: LinkProfileId,
  patch: Partial<LinkProfile>,
): LinkProfile[] {
  return profiles.map((profile) => (profile.id === id ? { ...profile, ...patch } : profile));
}

function dbmToMw(dbm: number): number {
  return 10 ** (dbm / 10);
}

function mwToDbm(mw: number): number {
  return 10 * Math.log10(mw);
}

function referenceCircleFeature(
  operator: AnalysisRequest["operator"],
  radiusM: number,
): ReferenceCircleFeature {
  const coordinates: number[][] = [];
  const earthRadiusM = 6371008.8;
  const lat1 = (operator.lat * Math.PI) / 180;
  const lng1 = (operator.lng * Math.PI) / 180;
  const angularDistance = radiusM / earthRadiusM;

  for (let i = 0; i <= 160; i++) {
    const bearing = (i / 160) * Math.PI * 2;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angularDistance) +
        Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
    );
    const lng2 =
      lng1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
        Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
      );
    coordinates.push([((lng2 * 180) / Math.PI + 540) % 360 - 180, (lat2 * 180) / Math.PI]);
  }

  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [coordinates],
    },
  };
}

function updateReferenceCircle(map: mapboxgl.Map, analysis: AnalysisRequest): void {
  const source = map.getSource("reference-radius") as mapboxgl.GeoJSONSource | undefined;
  source?.setData(referenceCircleFeature(analysis.operator, analysis.radiusM));
}

function coverageImageCoordinates(
  operator: AnalysisRequest["operator"],
  radiusM: number,
): CoverageCoordinates {
  const center = lngLatToMercator01(operator.lng, operator.lat);
  const radius = metersToMercatorUnits(radiusM, operator.lat);
  const nw = mercator01ToLngLat({ x: center.x - radius, y: center.y - radius });
  const ne = mercator01ToLngLat({ x: center.x + radius, y: center.y - radius });
  const se = mercator01ToLngLat({ x: center.x + radius, y: center.y + radius });
  const sw = mercator01ToLngLat({ x: center.x - radius, y: center.y + radius });
  return [
    [nw.lng, nw.lat],
    [ne.lng, ne.lat],
    [se.lng, se.lat],
    [sw.lng, sw.lat],
  ];
}

function renderCoverageImage(
  map: TerrainSampler | null,
  analysis: AnalysisRequest,
  debugMode: DebugMode,
  displayCanvas: HTMLCanvasElement,
): CoverageOverlay {
  const radiusM = analysisRadiusM(analysis, debugMode);
  const spec = createCoverageGridSpec(analysis, debugMode);
  const gridSize = clampGridSize(analysis.gridSizePx);
  displayCanvas.width = gridSize;
  displayCanvas.height = gridSize;
  const context = displayCanvas.getContext("2d");
  if (!context) {
    return {
      canvas: displayCanvas,
      coordinates: coverageImageCoordinates(analysis.operator, radiusM),
      gridSizePx: gridSize,
      engine: "cpu-fallback",
      renderedOperator: analysis.operator,
    };
  }
  context.imageSmoothingEnabled = false;
  const imageData = context.createImageData(gridSize, gridSize);

  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const mercator = gridCellMercator(spec, x, y);
      const dx = ((x + 0.5) / gridSize) * 2 - 1;
      const dy = ((y + 0.5) / gridSize) * 2 - 1;
      if (dx * dx + dy * dy > 1) {
        continue;
      }
      const target = mercator01ToLngLat(mercator);
      const pixel = map
        ? inspectTerrainPixel(map, analysis, target, debugMode)
        : inspectFlatEarthPixel(analysis, target, debugMode);
      const [r, g, b, a] = shadeForPixel(pixel, analysis);
      const offset = (y * gridSize + x) * 4;
      imageData.data[offset] = r;
      imageData.data[offset + 1] = g;
      imageData.data[offset + 2] = b;
      imageData.data[offset + 3] = a;
    }
  }
  context.putImageData(imageData, 0, 0);

  return {
    canvas: displayCanvas,
    coordinates: coverageImageCoordinates(analysis.operator, radiusM),
    gridSizePx: gridSize,
    engine: "cpu-fallback",
    renderedOperator: analysis.operator,
  };
}

function getCoverageSourceType(map: mapboxgl.Map): string | null {
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

function getStyleSourceTypeCounts(map: mapboxgl.Map): Record<string, number> {
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

function canvasFingerprint(canvas: HTMLCanvasElement): string | null {
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

function waitForAnimationFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const tick = (remaining: number) => {
      if (remaining <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(() => tick(remaining - 1));
    };
    tick(count);
  });
}

async function mapCanvasImageData(map: mapboxgl.Map): Promise<ImageData> {
  const canvas = map.getCanvas();
  const image = new Image();
  image.src = canvas.toDataURL("image/png");
  await image.decode();
  const copy = document.createElement("canvas");
  copy.width = canvas.width;
  copy.height = canvas.height;
  const context = copy.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Unable to read Mapbox canvas copy");
  }
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, copy.width, copy.height);
}

function diffImageFootprint(visible: ImageData, hidden: ImageData): RenderedCoverageFootprint {
  let minX = visible.width;
  let minY = visible.height;
  let maxX = -1;
  let maxY = -1;
  let changedPixels = 0;
  let maxDelta = 0;
  const threshold = 18;

  for (let y = 0; y < visible.height; y++) {
    for (let x = 0; x < visible.width; x++) {
      const offset = (y * visible.width + x) * 4;
      const delta =
        Math.abs((visible.data[offset] ?? 0) - (hidden.data[offset] ?? 0)) +
        Math.abs((visible.data[offset + 1] ?? 0) - (hidden.data[offset + 1] ?? 0)) +
        Math.abs((visible.data[offset + 2] ?? 0) - (hidden.data[offset + 2] ?? 0));
      maxDelta = Math.max(maxDelta, delta);
      if (delta <= threshold) {
        continue;
      }
      changedPixels++;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  const bounds = maxX >= 0 ? { minX, minY, maxX, maxY } : null;
  return {
    width: visible.width,
    height: visible.height,
    changedPixels,
    bounds,
    center: bounds ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 } : null,
    radiusX: bounds ? (bounds.maxX - bounds.minX + 1) / 2 : null,
    radiusY: bounds ? (bounds.maxY - bounds.minY + 1) / 2 : null,
    sampleCount: visible.width * visible.height,
    maxDelta,
  };
}

async function measureRenderedCoverageFootprint(map: mapboxgl.Map | null): Promise<RenderedCoverageFootprint> {
  if (!map || !map.getLayer("los-coverage")) {
    return {
      width: 0,
      height: 0,
      changedPixels: 0,
      bounds: null,
      center: null,
      radiusX: null,
      radiusY: null,
      sampleCount: 0,
      maxDelta: 0,
    };
  }

  const opacity = map.getPaintProperty("los-coverage", "raster-opacity");
  map.triggerRepaint();
  await waitForAnimationFrames(3);
  const visible = await mapCanvasImageData(map);
  map.setPaintProperty("los-coverage", "raster-opacity", 0);
  map.triggerRepaint();
  await waitForAnimationFrames(3);
  const hidden = await mapCanvasImageData(map);
  map.setPaintProperty("los-coverage", "raster-opacity", opacity ?? 0.86);
  map.triggerRepaint();
  await waitForAnimationFrames(3);
  return diffImageFootprint(visible, hidden);
}

function auditCoverageFootprint(
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

function inspectCoverageCanvasAt(
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

function ensureCoverageCanvasSource(
  map: mapboxgl.Map,
  overlay: CoverageOverlay | GpuCoverageImage,
  options: { recreate?: boolean } = {},
): void {
  const existingSource = map.getSource("los-coverage") as
    | (mapboxgl.CanvasSource & { type?: string; setCoordinates?: (coordinates: CoverageCoordinates) => void })
    | undefined;
  const isCanvasSource = !existingSource || existingSource.type === "canvas" || typeof existingSource.setCoordinates === "function";

  if (existingSource && (options.recreate || !isCanvasSource)) {
    if (map.getLayer("los-coverage")) {
      map.removeLayer("los-coverage");
    }
    map.removeSource("los-coverage");
  }

  const canvasSource = map.getSource("los-coverage") as
    | (mapboxgl.CanvasSource & { setCoordinates?: (coordinates: CoverageCoordinates) => void })
    | undefined;

  if (!canvasSource) {
    map.addSource("los-coverage", {
      type: "canvas",
      canvas: overlay.canvas,
      coordinates: overlay.coordinates,
      animate: true,
    });
  } else if (typeof canvasSource.setCoordinates === "function") {
    canvasSource.setCoordinates(overlay.coordinates);
  }

  const refreshedSource = map.getSource("los-coverage") as
    | (mapboxgl.CanvasSource & { play?: () => void })
    | undefined;
  refreshedSource?.play?.();

  if (!map.getLayer("los-coverage")) {
    map.addLayer(
      {
        id: "los-coverage",
        type: "raster",
        source: "los-coverage",
        paint: {
          "raster-opacity": 0.86,
          "raster-fade-duration": 0,
          "raster-resampling": "nearest",
        },
      },
      map.getLayer("reference-radius-line") ? "reference-radius-line" : undefined,
    );
  }
  map.setPaintProperty("los-coverage", "raster-resampling", "nearest");
  map.setPaintProperty("los-coverage", "raster-fade-duration", 0);
  map.triggerRepaint();
}

function updateCoverageLayer(
  map: mapboxgl.Map,
  analysis: AnalysisRequest,
  debugMode: DebugMode,
  displayCanvas: HTMLCanvasElement,
): void {
  ensureCoverageCanvasSource(map, renderCoverageImage(map, analysis, debugMode, displayCanvas), { recreate: true });
}

function stylePreviewUrl(style: MapStyleTemplate): string {
  const path = style.uri.replace("mapbox://styles/", "");
  return `https://api.mapbox.com/styles/v1/${path}/static/-3.7038,40.4168,11,0/104x104?access_token=${token}`;
}

function installAnalysisLayers(map: mapboxgl.Map, analysis: AnalysisRequest, debugMode: DebugMode): void {
  if (!map.getSource("mapbox-dem")) {
    map.addSource("mapbox-dem", {
      type: "raster-dem",
      url: "mapbox://mapbox.mapbox-terrain-dem-v1",
      tileSize: 512,
      maxzoom: 14,
    });
  }
  map.setTerrain({ source: "mapbox-dem", exaggeration: 1 });

  if (map.getSource("composite") && !map.getLayer("los-building-reference")) {
    map.addLayer({
      id: "los-building-reference",
      type: "fill-extrusion",
      source: "composite",
      "source-layer": "building",
      minzoom: 0,
      paint: {
        "fill-extrusion-height": ["coalesce", ["get", "height"], ["get", "render_height"], 3.1],
        "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
        "fill-extrusion-opacity": 0,
      },
    });
  }

  if (!map.getSource("reference-radius")) {
    map.addSource("reference-radius", {
      type: "geojson",
      data: referenceCircleFeature(analysis.operator, analysis.radiusM),
    });
  } else {
    updateReferenceCircle(map, analysis);
  }

  if (!map.getLayer("reference-radius-fill")) {
    map.addLayer({
      id: "reference-radius-fill",
      type: "fill",
      source: "reference-radius",
      paint: {
        "fill-color": "#1f8fff",
        "fill-opacity": 0.04,
      },
    });
  }

  if (!map.getLayer("reference-radius-line")) {
    map.addLayer({
      id: "reference-radius-line",
      type: "line",
      source: "reference-radius",
      paint: {
        "line-color": "#1f8fff",
        "line-width": 2,
        "line-opacity": 0.9,
      },
    });
  }

}

function operatorFromLngLat(
  current: AnalysisRequest,
  lngLat: mapboxgl.LngLat,
): AnalysisRequest["operator"] {
  return {
    ...current.operator,
    lng: lngLat.lng,
    lat: lngLat.lat,
  };
}

export function App() {
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const gpuCoverageRef = useRef<GpuCoverageLayer | null>(null);
  const coverageDisplayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const coverageRenderSeqRef = useRef(0);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const mapNodeRef = useRef<HTMLDivElement | null>(null);
  const previousStyleUriRef = useRef(mapStyleTemplates[0].uri);
  const [analysis, setAnalysis] = useState<AnalysisRequest>(defaultAnalysis);
  const [debugMode, setDebugMode] = useState<DebugMode>("combined");
  const [inspector, setInspector] = useState<CoveragePixel | null>(null);
  const [inspectorTarget, setInspectorTarget] = useState<InspectorTarget | null>(null);
  const [mapDataRevision, setMapDataRevision] = useState(0);
  const [coverageEngine, setCoverageEngine] = useState<CoverageEngine>("cpu-fallback");
  const [preferredCoverageEngine, setPreferredCoverageEngine] = useState<CoverageEngine>("cpu-fallback");
  const [selectedStyleId, setSelectedStyleId] = useState(mapStyleTemplates[0].id);
  const [isStyleMenuOpen, setIsStyleMenuOpen] = useState(false);
  const hasToken = Boolean(token && token !== "your_mapbox_token_here");
  const selectedStyle = mapStyleTemplates.find((style) => style.id === selectedStyleId) ?? mapStyleTemplates[0];
  const latestAnalysisRef = useRef(analysis);

  function updateDebugState(patch: Partial<DroneRangeDebugState> = {}) {
    if (!import.meta.env.DEV) return;
    const map = mapRef.current;
    window.__droneRangeDebug = {
      latestOperator: latestAnalysisRef.current.operator,
      renderedOperator: window.__droneRangeDebug?.renderedOperator ?? null,
      coverageCoordinates: window.__droneRangeDebug?.coverageCoordinates ?? null,
      coverageCanvasFingerprint: window.__droneRangeDebug?.coverageCanvasFingerprint ?? null,
      renderSequence: coverageRenderSeqRef.current,
      engine: coverageEngine,
      preferredEngine: preferredCoverageEngine,
      gpuStats: window.__droneRangeDebug?.gpuStats ?? null,
      hasCoverageSource: Boolean(map?.getSource("los-coverage")),
      sourceType: map ? getCoverageSourceType(map) : null,
      sourceTypeCounts: map ? getStyleSourceTypeCounts(map) : {},
      referenceCircle: map
        ? referenceCircleFeature(latestAnalysisRef.current.operator, latestAnalysisRef.current.radiusM)
        : null,
      markerLngLat: markerRef.current
        ? {
            lng: markerRef.current.getLngLat().lng,
            lat: markerRef.current.getLngLat().lat,
          }
        : null,
      ...patch,
    };
    window.__inspectCoverageAt = (lng: number, lat: number) =>
      inspectCoverageCanvasAt(
        map,
        coverageDisplayCanvasRef.current,
        window.__droneRangeDebug?.coverageCoordinates ?? null,
        { lng, lat },
      );
    window.__auditCoverageFootprint = () =>
      auditCoverageFootprint(
        map,
        coverageDisplayCanvasRef.current,
        window.__droneRangeDebug?.coverageCoordinates ?? null,
        latestAnalysisRef.current,
        debugMode,
        window.__droneRangeDebug?.engine ?? coverageEngine,
        window.__droneRangeDebug?.preferredEngine ?? preferredCoverageEngine,
      );
    window.__measureRenderedCoverageFootprint = () => measureRenderedCoverageFootprint(map);
  }

  function getCoverageDisplayCanvas(): HTMLCanvasElement {
    if (!coverageDisplayCanvasRef.current) {
      const canvas = document.createElement("canvas");
      canvas.style.display = "none";
      canvas.dataset.coverageSource = "los-coverage";
      document.body.appendChild(canvas);
      coverageDisplayCanvasRef.current = canvas;
    }
    return coverageDisplayCanvasRef.current;
  }

  function applyCoverageOverlay(map: mapboxgl.Map, overlay: CoverageOverlay | GpuCoverageImage): void {
    const displayCanvas = getCoverageDisplayCanvas();
    if (displayCanvas !== overlay.canvas) {
      displayCanvas.width = overlay.gridSizePx;
      displayCanvas.height = overlay.gridSizePx;
      const context = displayCanvas.getContext("2d");
      if (context) {
        context.imageSmoothingEnabled = false;
        context.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
        context.drawImage(overlay.canvas, 0, 0, displayCanvas.width, displayCanvas.height);
      }
    }

    ensureCoverageCanvasSource(
      map,
      {
        ...overlay,
        canvas: displayCanvas,
      },
      { recreate: true },
    );
    updateDebugState({
      coverageCoordinates: overlay.coordinates,
      coverageCanvasFingerprint: canvasFingerprint(displayCanvas),
      renderedOperator: overlay.renderedOperator,
      renderSequence: coverageRenderSeqRef.current,
      engine: overlay.engine,
      preferredEngine: preferredCoverageEngine,
      hasCoverageSource: Boolean(map.getSource("los-coverage")),
      sourceType: getCoverageSourceType(map),
      sourceTypeCounts: getStyleSourceTypeCounts(map),
    });
  }

  const coverageEngineLabel =
    coverageEngine === "gpu"
      ? "GPU terrain"
      : analysis.includeBuildings && preferredCoverageEngine === "gpu"
        ? "CPU buildings"
        : preferredCoverageEngine === "gpu"
          ? "CPU fallback"
          : analysis.includeBuildings
        ? "CPU buildings"
        : "CPU fallback";

  async function refreshCoverageLayer(map: mapboxgl.Map, nextAnalysis: AnalysisRequest, nextDebugMode: DebugMode) {
    const sequence = ++coverageRenderSeqRef.current;
    if (!nextAnalysis.includeBuildings && token) {
      try {
        const mapboxToken = token;
        if (!gpuCoverageRef.current) {
          gpuCoverageRef.current = GpuCoverageLayer.create({
            mapboxToken,
            texturePx: gpuHeightTexturePx,
            coordinatesForAnalysis: coverageImageCoordinates,
          });
        }
        const gpuCoverage = gpuCoverageRef.current;
        if (gpuCoverage) {
          await gpuCoverage.updateAnalysis(nextAnalysis, nextDebugMode);
          const image =
            preferredCoverageEngine === "gpu"
              ? gpuCoverage.render()
              : gpuCoverage.renderCpuReference();
          if (image && sequence === coverageRenderSeqRef.current) {
            applyCoverageOverlay(map, image);
            updateDebugState({
              engine: image.engine,
              gpuStats: image.engine === "gpu" ? gpuCoverage.debugStats() : null,
            });
            setCoverageEngine(image.engine);
            return;
          }
        }
      } catch (error) {
        console.warn("Shared terrain coverage renderer failed; falling back to Mapbox CPU coverage.", error);
      }
    }

    if (sequence !== coverageRenderSeqRef.current) {
      return;
    }
    updateCoverageLayer(map, nextAnalysis, nextDebugMode, getCoverageDisplayCanvas());
    updateDebugState({
      coverageCoordinates: coverageImageCoordinates(nextAnalysis.operator, analysisRadiusM(nextAnalysis, nextDebugMode)),
      coverageCanvasFingerprint: canvasFingerprint(getCoverageDisplayCanvas()),
      renderedOperator: nextAnalysis.operator,
      renderSequence: coverageRenderSeqRef.current,
      engine: "cpu-fallback",
      preferredEngine: preferredCoverageEngine,
      gpuStats: null,
      hasCoverageSource: Boolean(map.getSource("los-coverage")),
      sourceType: getCoverageSourceType(map),
      sourceTypeCounts: getStyleSourceTypeCounts(map),
    });
    setCoverageEngine("cpu-fallback");
  }

  const activeProfiles = useMemo(
    () => analysis.profiles.filter((profile) => analysis.selectedProfileIds.includes(profile.id)),
    [analysis.profiles, analysis.selectedProfileIds],
  );
  const effectiveCalculationRadiusM = useMemo(
    () => analysisRadiusM(analysis, debugMode),
    [analysis, debugMode],
  );

  useEffect(() => {
    if (!mapNodeRef.current || !hasToken) return;
    mapboxgl.accessToken = token!;
    const map = new mapboxgl.Map({
      container: mapNodeRef.current,
      style: selectedStyle.uri,
      center: [analysis.operator.lng, analysis.operator.lat],
      zoom: 13.5,
      pitch: 0,
      bearing: 0,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
    map.boxZoom.disable();
    map.setMaxPitch(0);

    mapRef.current = map;
    markerRef.current = new mapboxgl.Marker({ draggable: true, color: "#1f8fff" })
      .setLngLat([analysis.operator.lng, analysis.operator.lat])
      .addTo(map);
    updateDebugState();

    markerRef.current.on("dragend", () => {
      const lngLat = markerRef.current!.getLngLat();
      setAnalysis((current) => ({
        ...current,
        operator: { ...current.operator, lng: lngLat.lng, lat: lngLat.lat },
      }));
    });

    const placeOperator = (lngLat: mapboxgl.LngLat) => {
      markerRef.current?.setLngLat(lngLat);
      setAnalysis((current) => ({
        ...current,
        operator: operatorFromLngLat(current, lngLat),
      }));
    };
    let placedOperatorOnMouseDown = false;

    map.on("mousedown", (event) => {
      if (event.originalEvent.shiftKey) {
        event.originalEvent.preventDefault();
        placedOperatorOnMouseDown = true;
        placeOperator(event.lngLat);
      }
    });

    map.on("click", (event) => {
      if (event.originalEvent.shiftKey) {
        event.originalEvent.preventDefault();
        if (placedOperatorOnMouseDown) {
          placedOperatorOnMouseDown = false;
          return;
        }
        placeOperator(event.lngLat);
        return;
      }
      setInspectorTarget({
        lng: event.lngLat.lng,
        lat: event.lngLat.lat,
      });
    });

    map.on("load", () => {
      installAnalysisLayers(map, analysis, debugMode);
      updateDebugState({
        sourceType: getCoverageSourceType(map),
        referenceCircle: referenceCircleFeature(latestAnalysisRef.current.operator, latestAnalysisRef.current.radiusM),
      });
      map.once("idle", () => {
        void refreshCoverageLayer(map, latestAnalysisRef.current, debugMode);
        setMapDataRevision((revision) => revision + 1);
      });
    });

    return () => {
      markerRef.current?.remove();
      gpuCoverageRef.current?.dispose();
      gpuCoverageRef.current = null;
      coverageDisplayCanvasRef.current?.remove();
      coverageDisplayCanvasRef.current = null;
      map.remove();
      mapRef.current = null;
      if (import.meta.env.DEV) {
        delete window.__droneRangeDebug;
        delete window.__inspectCoverageAt;
        delete window.__auditCoverageFootprint;
        delete window.__measureRenderedCoverageFootprint;
      }
    };
  }, [hasToken]);

  useEffect(() => {
    latestAnalysisRef.current = analysis;
    markerRef.current?.setLngLat([analysis.operator.lng, analysis.operator.lat]);
    if (preferredCoverageEngine === "cpu-fallback") {
      gpuCoverageRef.current?.dispose();
      gpuCoverageRef.current = null;
    }
    if (mapRef.current?.isStyleLoaded()) {
      updateReferenceCircle(mapRef.current, analysis);
      void refreshCoverageLayer(mapRef.current, analysis, debugMode);
    }
    updateDebugState({
      latestOperator: analysis.operator,
      referenceCircle: referenceCircleFeature(analysis.operator, analysis.radiusM),
      markerLngLat: markerRef.current
        ? {
            lng: markerRef.current.getLngLat().lng,
            lat: markerRef.current.getLngLat().lat,
          }
        : null,
    });
  }, [analysis, debugMode, preferredCoverageEngine]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !hasToken) return;
    if (previousStyleUriRef.current === selectedStyle.uri) return;
    previousStyleUriRef.current = selectedStyle.uri;
    map.setStyle(selectedStyle.uri);
    map.once("style.load", () => {
      installAnalysisLayers(map, latestAnalysisRef.current, debugMode);
      map.once("idle", () => {
        void refreshCoverageLayer(map, latestAnalysisRef.current, debugMode);
        setMapDataRevision((revision) => revision + 1);
      });
    });
  }, [debugMode, hasToken, selectedStyle.uri, preferredCoverageEngine]);

  useEffect(() => {
    const map = mapRef.current;
    if (!inspectorTarget) {
      setInspector(null);
      return;
    }
    setInspector(
      map
        ? inspectTerrainPixel(map, analysis, inspectorTarget, debugMode)
        : inspectFlatEarthPixel(analysis, inspectorTarget, debugMode),
    );
  }, [analysis, debugMode, inspectorTarget, mapDataRevision]);

  function setNumber(path: "radiusM" | "gridSizePx", value: number) {
    setAnalysis((current) => ({ ...current, [path]: value }));
  }

  function setAltitude(key: keyof AnalysisRequest["altitude"], value: number) {
    setAnalysis((current) => ({
      ...current,
      altitude: { ...current.altitude, [key]: value },
    }));
  }

  function toggleProfile(id: LinkProfileId) {
    setAnalysis((current) => {
      const selected = current.selectedProfileIds.includes(id)
        ? current.selectedProfileIds.filter((item) => item !== id)
        : [...current.selectedProfileIds, id];
      return { ...current, selectedProfileIds: selected };
    });
  }

  function selectStyle(style: MapStyleTemplate) {
    setSelectedStyleId(style.id);
    setIsStyleMenuOpen(false);
  }

  return (
    <main className="app">
      <div ref={mapNodeRef} className="map" />
      {!hasToken && (
        <section className="token-panel">
          <MapPin size={24} />
          <h1>Drone Range Mapper</h1>
          <p>Add a Mapbox token to <code>.env</code> as <code>VITE_MAPBOX_TOKEN</code>, then start the app.</p>
        </section>
      )}

      <aside className="toolbar" aria-label="Analysis controls">
        <div className="panel-title">
          <Antenna size={18} />
          <span>Range Calculator</span>
        </div>

        <label>
          Reference radius
          <input
            type="range"
            min="250"
            max="10000"
            step="250"
            value={analysis.radiusM}
            onChange={(event) => setNumber("radiusM", Number(event.target.value))}
          />
          <output>{analysis.radiusM.toLocaleString()} m</output>
        </label>

        <label>
          Operator antenna height
          <span className="input-with-unit">
            <input
              type="number"
              min="0"
              step="0.5"
              value={analysis.operator.antennaHeightM}
              onChange={(event) =>
                setAnalysis((current) => ({
                  ...current,
                  operator: { ...current.operator, antennaHeightM: Number(event.target.value) },
                }))
              }
            />
            <span>m</span>
          </span>
        </label>

        <div className="grid-three">
          <label>
            Min alt
            <span className="input-with-unit">
              <input
                type="number"
                value={analysis.altitude.minM}
                onChange={(event) => setAltitude("minM", Number(event.target.value))}
              />
              <span>m</span>
            </span>
          </label>
          <label>
            Max alt
            <span className="input-with-unit">
              <input
                type="number"
                value={analysis.altitude.maxM}
                onChange={(event) => setAltitude("maxM", Number(event.target.value))}
              />
              <span>m</span>
            </span>
          </label>
          <label>
            Step
            <span className="input-with-unit">
              <input
                type="number"
                value={analysis.altitude.stepM}
                onChange={(event) => setAltitude("stepM", Number(event.target.value))}
              />
              <span>m</span>
            </span>
          </label>
        </div>

        <label>
          Coverage mode
          <select
            value={debugMode}
            onChange={(event) => setDebugMode(event.target.value as DebugMode)}
          >
            {debugModes.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.label}
              </option>
            ))}
          </select>
        </label>

        <details className="config-menu">
          <summary>
            <Settings size={16} />
            <span>Calculation settings</span>
            <ChevronDown className="disclosure-icon" size={16} />
          </summary>

          <div className="segmented two" role="radiogroup" aria-label="Calculation range">
            <button
              type="button"
              className={analysis.calculationRange.mode === "auto" ? "active" : ""}
              onClick={() =>
                setAnalysis((current) => ({
                  ...current,
                  calculationRange: { ...current.calculationRange, mode: "auto" },
                }))
              }
            >
              Auto
            </button>
            <button
              type="button"
              className={analysis.calculationRange.mode === "manual" ? "active" : ""}
              onClick={() =>
                setAnalysis((current) => ({
                  ...current,
                  calculationRange: { ...current.calculationRange, mode: "manual" },
                }))
              }
            >
              Manual
            </button>
          </div>

          <label>
            Calculation range
            <span className="input-with-unit">
              <input
                type="number"
                min="250"
                step="250"
                value={analysis.calculationRange.manualM}
                disabled={analysis.calculationRange.mode === "auto"}
                onChange={(event) =>
                  setAnalysis((current) => ({
                    ...current,
                    calculationRange: {
                      mode: current.calculationRange.mode,
                      manualM: Number(event.target.value),
                    },
                  }))
                }
              />
              <span>m</span>
            </span>
            <output>
              {analysis.calculationRange.mode === "auto"
                ? `${Math.round(effectiveCalculationRadiusM).toLocaleString()} m auto`
                : `${Math.round(effectiveCalculationRadiusM).toLocaleString()} m manual`}
            </output>
          </label>

          <label>
            Grid resolution
            <input
              type="range"
              min={minCoverageGridPx}
              max={maxCoverageGridPx}
              step="1"
              value={analysis.gridSizePx}
              onChange={(event) => setNumber("gridSizePx", Number(event.target.value))}
            />
            <output>
              {analysis.gridSizePx} x {analysis.gridSizePx} pixels
            </output>
          </label>

          <div className="segmented two" role="radiogroup" aria-label="Coverage renderer">
            <button
              type="button"
              className={preferredCoverageEngine === "cpu-fallback" ? "active" : ""}
              onClick={() => setPreferredCoverageEngine("cpu-fallback")}
            >
              CPU
            </button>
            <button
              type="button"
              className={preferredCoverageEngine === "gpu" ? "active" : ""}
              onClick={() => setPreferredCoverageEngine("gpu")}
            >
              GPU
            </button>
          </div>
          <output>
            {preferredCoverageEngine === "gpu" && analysis.includeBuildings
              ? "GPU selected, CPU active for buildings"
              : `Active renderer: ${coverageEngine === "gpu" ? "GPU" : "CPU"}`}
          </output>

          <label>
            <span className="toggle-row">
              <span>Building occlusion</span>
              <input
                type="checkbox"
                checked={analysis.includeBuildings}
                onChange={(event) =>
                  setAnalysis((current) => ({
                    ...current,
                    includeBuildings: event.target.checked,
                  }))
                }
              />
            </span>
            <output>Use Mapbox building heights as line-of-sight blockers</output>
          </label>
        </details>
      </aside>

      <details className="profiles" aria-label="RF profiles" open>
        <summary className="panel-title">
          <Radio size={18} />
          <span>RF Profiles</span>
          <small>{activeProfiles.length} active</small>
          <ChevronDown className="disclosure-icon" size={16} />
        </summary>
        {analysis.profiles.map((profile) => (
          <details className="profile-card" key={profile.id}>
            <summary className="profile-card-summary">
              <label className="check-row" onClick={(event) => event.stopPropagation()}>
              <input
                type="checkbox"
                checked={analysis.selectedProfileIds.includes(profile.id)}
                onChange={() => toggleProfile(profile.id)}
              />
              <strong>{profileLabel(profile.id)}</strong>
            </label>
              <ChevronDown className="disclosure-icon" size={16} />
            </summary>
            <div className="profile-grid">
              <label>
                Frequency
                <span className="input-with-unit">
                  <input
                    type="number"
                    value={profile.frequencyMHz}
                    onChange={(event) =>
                      setAnalysis((current) => ({
                        ...current,
                        profiles: updateProfile(current.profiles, profile.id, {
                          frequencyMHz: Number(event.target.value),
                        }),
                      }))
                    }
                  />
                  <span>MHz</span>
                </span>
              </label>
              <label>
                TX power
                <span className="input-with-unit">
                  <input
                    type="number"
                    min="0.001"
                    step="1"
                    value={Number(dbmToMw(profile.txPowerDbm).toFixed(2))}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (!Number.isFinite(value) || value <= 0) return;
                      setAnalysis((current) => ({
                        ...current,
                        profiles: updateProfile(current.profiles, profile.id, {
                          txPowerDbm: mwToDbm(value),
                        }),
                      }));
                    }}
                  />
                  <span>mW</span>
                </span>
              </label>
              <label>
                TX antenna gain
                <span className="input-with-unit">
                  <input
                    type="number"
                    value={profile.txGainDbi}
                    onChange={(event) =>
                      setAnalysis((current) => ({
                        ...current,
                        profiles: updateProfile(current.profiles, profile.id, {
                          txGainDbi: Number(event.target.value),
                        }),
                      }))
                    }
                  />
                  <span>dBi</span>
                </span>
              </label>
              <label>
                TX loss
                <span className="input-with-unit">
                  <input
                    type="number"
                    value={profile.txLossDb}
                    onChange={(event) =>
                      setAnalysis((current) => ({
                        ...current,
                        profiles: updateProfile(current.profiles, profile.id, {
                          txLossDb: Number(event.target.value),
                        }),
                      }))
                    }
                  />
                  <span>dB</span>
                </span>
              </label>
              <label>
                RX antenna gain
                <span className="input-with-unit">
                  <input
                    type="number"
                    value={profile.rxGainDbi}
                    onChange={(event) =>
                      setAnalysis((current) => ({
                        ...current,
                        profiles: updateProfile(current.profiles, profile.id, {
                          rxGainDbi: Number(event.target.value),
                        }),
                      }))
                    }
                  />
                  <span>dBi</span>
                </span>
              </label>
              <label>
                RX loss
                <span className="input-with-unit">
                  <input
                    type="number"
                    value={profile.rxLossDb}
                    onChange={(event) =>
                      setAnalysis((current) => ({
                        ...current,
                        profiles: updateProfile(current.profiles, profile.id, {
                          rxLossDb: Number(event.target.value),
                        }),
                      }))
                    }
                  />
                  <span>dB</span>
                </span>
              </label>
              <label>
                Sensitivity
                <span className="input-with-unit">
                  <input
                    type="number"
                    value={profile.rxSensitivityDbm}
                    onChange={(event) =>
                      setAnalysis((current) => ({
                        ...current,
                        profiles: updateProfile(current.profiles, profile.id, {
                          rxSensitivityDbm: Number(event.target.value),
                        }),
                      }))
                    }
                  />
                  <span>dBm</span>
                </span>
              </label>
              <label>
                Required margin
                <span className="input-with-unit">
                  <input
                    type="number"
                    value={profile.requiredMarginDb}
                    onChange={(event) =>
                      setAnalysis((current) => ({
                        ...current,
                        profiles: updateProfile(current.profiles, profile.id, {
                          requiredMarginDb: Number(event.target.value),
                        }),
                      }))
                    }
                  />
                  <span>dB</span>
                </span>
              </label>
            </div>
          </details>
        ))}
      </details>

      {inspector && (
        <aside className="inspector">
          <div className="panel-title">
            <Activity size={18} />
            <span>Inspector</span>
            <button type="button" title="Close inspector" onClick={() => setInspectorTarget(null)}>
              x
            </button>
          </div>
          <dl>
            <dt>Reachable</dt>
            <dd>{inspector.reachable ? "Yes" : "No"}</dd>
            <dt>Violation criteria</dt>
            <dd>{inspector.violationCriteria}</dd>
            <dt>Min. elevation change</dt>
            <dd>{inspector.requiredElevationChangeM.toFixed(1)} m</dd>
            <dt>Operator altitude (ASL)</dt>
            <dd>{inspector.operatorAltitudeAslM.toFixed(1)} m</dd>
            {debugMode !== "combined" && debugMode !== "los" && inspector.modeMarginDb !== null && (
              <>
                <dt>{modeMarginLabel(debugMode)}</dt>
                <dd>{inspector.modeMarginDb.toFixed(1)} dB</dd>
              </>
            )}
            <dt>Combined margin</dt>
            <dd>{inspector.combinedMarginDb.toFixed(1)} dB</dd>
            <dt>Distance</dt>
            <dd>{inspector.debugValue.toFixed(0)} m</dd>
          </dl>
        </aside>
      )}

      {hasToken && (
        <aside className={`style-picker ${isStyleMenuOpen ? "open" : ""}`} aria-label="Map style selector">
          {isStyleMenuOpen && (
            <div className="style-menu" role="listbox" aria-label="Map styles">
              {mapStyleTemplates.map((style) => (
                <button
                  type="button"
                  key={style.id}
                  className={`style-option ${style.id === selectedStyle.id ? "active" : ""}`}
                  onClick={() => selectStyle(style)}
                  role="option"
                  aria-selected={style.id === selectedStyle.id}
                  title={style.label}
                >
                  <span
                    className="style-preview"
                    style={{ backgroundImage: `url("${stylePreviewUrl(style)}")` }}
                  />
                  <span>{style.label}</span>
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className="style-current"
            onClick={() => setIsStyleMenuOpen((open) => !open)}
            aria-expanded={isStyleMenuOpen}
            title={`Map style: ${selectedStyle.label}`}
          >
            <span
              className="style-preview"
              style={{ backgroundImage: `url("${stylePreviewUrl(selectedStyle)}")` }}
            />
          </button>
        </aside>
      )}

      <div className="hint">
        <Layers size={14} />
        <span>
          Drag marker or Shift-click to place operator. Click coverage for inspection. Engine:{" "}
          {coverageEngineLabel}.
        </span>
      </div>
    </main>
  );
}
