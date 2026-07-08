import { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import {
  Activity,
  ChevronDown,
  Cuboid,
  Layers,
  MapPin,
  Radio,
  RefreshCw,
  Settings,
  Square,
} from "lucide-react";
import { defaultAnalysis } from "./analysis/defaults";
import {
  analysisRadiusM,
  inspectFlatEarthPixel,
  inspectTerrainPixel,
  occlusionHeightM,
  type TerrainSampler,
} from "./analysis/singleRay";
import {
  clampGridSize,
  createCoverageGridSpec,
  maxCpuCoverageGridPx,
  gridCellMercator,
  maxGpuCoverageGridPx,
  minCoverageGridPx,
  sampleHeightField,
} from "./analysis/coverageGrid";
import { analysisMercatorBounds, chooseDemZoom } from "./analysis/demTiles";
import {
  TerrainHeightTileLoader,
  type TerrainHeightField,
} from "./analysis/terrainTiles";
import {
  BuildingHeightTileLoader,
  sampleBuildingHeightField,
  type BuildingHeightField,
} from "./analysis/buildingTiles";
import {
  VegetationHeightTileLoader,
  sampleVegetationHeightField,
  type VegetationHeightField,
} from "./analysis/vegetationTiles";
import { shadeForPixel } from "./analysis/coverageShading";
import {
  lngLatToMercator01,
  mercator01ToLngLat,
  metersToMercatorUnits,
} from "./analysis/coordinates";
import {
  auditCoverageFootprint,
  canvasFingerprint,
  type CoverageBenchmarkResult,
  getCoverageSourceType,
  getStyleSourceTypeCounts,
  inspectCoverageCanvasAt,
  type DroneRangeDebugState,
  type ReferenceCircleFeature,
} from "./coverageDebug";
import { GpuCoverageLayer } from "./gpuCoverageLayer";
import droneRangerHeaderUrl from "./assets/drone-ranger-header.png";
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

const viteMapboxToken = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
const electronBridge = typeof window === "undefined" ? undefined : window.droneRanger;
const electronMapboxToken = electronBridge?.mapboxToken;
const token = electronMapboxToken || viteMapboxToken;
const isPackagedElectron = Boolean(electronBridge && !import.meta.env.DEV);

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

const defaultMapStyle = mapStyleTemplates.find((style) => style.id === "outdoors") ?? mapStyleTemplates[0];

const debugModes: Array<{ id: DebugMode; label: string }> = [
  { id: "combined", label: "Combined" },
  { id: "control", label: "Control" },
  { id: "telemetry", label: "Telemetry" },
  { id: "video", label: "Video" },
  { id: "los", label: "Line of Sight" },
  { id: "height-map", label: "Obstacle height" },
];

type InspectorTarget = {
  lng: number;
  lat: number;
};

const gpuHeightTextureTiersPx = [128, 256, 384, 512, 768, 1024, 1536, 2048] as const;
const coverageDisplayScale = 4;
const map3dPitch = 55;
let coverageSourceCanvas: HTMLCanvasElement | null = null;

type CachedBuildingField = {
  signature: string;
  field: BuildingHeightField;
};

type CachedVegetationField = {
  signature: string;
  field: VegetationHeightField;
};

type CachedTerrainField = {
  signature: string;
  field: TerrainHeightField;
};

function profileLabel(id: LinkProfileId): string {
  return id[0].toUpperCase() + id.slice(1);
}

function debugModeLabel(debugMode: DebugMode): string {
  return debugModes.find((mode) => mode.id === debugMode)?.label ?? "Combined";
}

function modeMarginLabel(debugMode: DebugMode): string {
  return `${debugModeLabel(debugMode)} margin`;
}

function gpuHeightTexturePxForGrid(gridSizePx: number): number {
  const targetPx = clampGridSize(gridSizePx, maxGpuCoverageGridPx) * 2;
  return gpuHeightTextureTiersPx.find((tier) => tier >= targetPx) ?? gpuHeightTextureTiersPx[gpuHeightTextureTiersPx.length - 1];
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

function coverageFootprintKey(analysis: AnalysisRequest, debugMode: DebugMode): string {
  const radiusM = analysisRadiusM(analysis, debugMode);
  const bounds = analysisMercatorBounds(analysis, radiusM);
  return [
    debugMode,
    bounds.west.toFixed(8),
    bounds.north.toFixed(8),
    bounds.east.toFixed(8),
    bounds.south.toFixed(8),
  ].join(":");
}

export function hideStaleCoverage(map: mapboxgl.Map): void {
  if (map.getLayer("los-coverage")) {
    map.setPaintProperty("los-coverage", "raster-opacity", 0);
  }
}

export function beginOperatorMove(map: mapboxgl.Map, analysis: AnalysisRequest): void {
  updateReferenceCircle(map, analysis);
  hideStaleCoverage(map);
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

export function renderCoverageImage(
  map: TerrainSampler | null,
  analysis: AnalysisRequest,
  debugMode: DebugMode,
  displayCanvas: HTMLCanvasElement,
): CoverageOverlay {
  const startedAt = performance.now();
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

  if (debugMode === "height-map") {
    const heights = new Float32Array(gridSize * gridSize);
    let minHeightM = Infinity;
    let maxHeightM = -Infinity;
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const dx = ((x + 0.5) / gridSize) * 2 - 1;
        const dy = ((y + 0.5) / gridSize) * 2 - 1;
        if (dx * dx + dy * dy > 1) {
          heights[y * gridSize + x] = NaN;
          continue;
        }
        const target = mercator01ToLngLat(gridCellMercator(spec, x, y));
        const heightM = map ? occlusionHeightM(map, analysis, target) : 0;
        heights[y * gridSize + x] = heightM;
        minHeightM = Math.min(minHeightM, heightM);
        maxHeightM = Math.max(maxHeightM, heightM);
      }
    }
    for (let index = 0; index < heights.length; index++) {
      const heightM = heights[index];
      if (!Number.isFinite(heightM)) {
        continue;
      }
      const [r, g, b, a] = shadeHeightMap(heightM, minHeightM, maxHeightM);
      const offset = index * 4;
      imageData.data[offset] = r;
      imageData.data[offset + 1] = g;
      imageData.data[offset + 2] = b;
      imageData.data[offset + 3] = a;
    }
    context.putImageData(imageData, 0, 0);
    const totalMs = performance.now() - startedAt;
    return {
      canvas: displayCanvas,
      coordinates: coverageImageCoordinates(analysis.operator, radiusM),
      gridSizePx: gridSize,
      engine: "cpu-fallback",
      renderedOperator: analysis.operator,
      timings: { totalMs, cpuSolveMs: totalMs },
    };
  }

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
      const [r, g, b, a] = shadeForPixel(pixel, analysis, debugMode);
      const offset = (y * gridSize + x) * 4;
      imageData.data[offset] = r;
      imageData.data[offset + 1] = g;
      imageData.data[offset + 2] = b;
      imageData.data[offset + 3] = a;
    }
  }
  context.putImageData(imageData, 0, 0);
  const totalMs = performance.now() - startedAt;

  return {
    canvas: displayCanvas,
    coordinates: coverageImageCoordinates(analysis.operator, radiusM),
    gridSizePx: gridSize,
    engine: "cpu-fallback",
    renderedOperator: analysis.operator,
    timings: {
      totalMs,
      cpuSolveMs: totalMs,
    },
  };
}

function ensureCoverageCanvasSource(
  map: mapboxgl.Map,
  overlay: CoverageOverlay,
): void {
  const existingSource = map.getSource("los-coverage") as
    | (mapboxgl.CanvasSource & {
        type?: string;
        width?: number;
        height?: number;
        setCoordinates?: (coordinates: CoverageCoordinates) => void;
      })
    | undefined;
  const isCanvasSource = !existingSource || existingSource.type === "canvas" || typeof existingSource.setCoordinates === "function";
  const hasStaleTextureSize = existingSource
    ? isCanvasSource && (existingSource.width !== overlay.canvas.width || existingSource.height !== overlay.canvas.height)
    : false;
  const hasStaleCanvas = Boolean(existingSource && coverageSourceCanvas && coverageSourceCanvas !== overlay.canvas);

  overlay.canvas.style.imageRendering = "pixelated";

  if (existingSource && (!isCanvasSource || hasStaleTextureSize || hasStaleCanvas)) {
    if (map.getLayer("los-coverage")) {
      map.removeLayer("los-coverage");
    }
    map.removeSource("los-coverage");
    coverageSourceCanvas = null;
  }

  const canvasSource = map.getSource("los-coverage") as
    | (mapboxgl.CanvasSource & { setCoordinates?: (coordinates: CoverageCoordinates) => void })
    | undefined;

  if (!canvasSource) {
    map.addSource("los-coverage", {
      type: "canvas",
      canvas: overlay.canvas,
      coordinates: overlay.coordinates,
      animate: false,
    });
    coverageSourceCanvas = overlay.canvas;
  } else if (typeof canvasSource.setCoordinates === "function") {
    canvasSource.setCoordinates(overlay.coordinates);
  }

  const refreshedSource = map.getSource("los-coverage") as
    | (mapboxgl.CanvasSource & { pause?: () => void; play?: () => void })
    | undefined;
  refreshedSource?.play?.();
  map.once("render", () => {
    refreshedSource?.pause?.();
  });

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
  map.setPaintProperty("los-coverage", "raster-opacity", 0.86);
  map.triggerRepaint();
}

function shadeHeightMap(heightM: number, minHeightM: number, maxHeightM: number): [number, number, number, number] {
  const span = Math.max(0.001, maxHeightM - minHeightM);
  const t = Math.max(0, Math.min(1, (heightM - minHeightM) / span));
  const stops: Array<{ t: number; color: [number, number, number] }> = [
    { t: 0, color: [34, 48, 92] },
    { t: 0.35, color: [31, 147, 139] },
    { t: 0.7, color: [246, 196, 83] },
    { t: 1, color: [238, 88, 73] },
  ];
  const upper = stops.find((stop) => stop.t >= t) ?? stops[stops.length - 1];
  const lower = stops[Math.max(0, stops.indexOf(upper) - 1)];
  const localT = upper.t === lower.t ? 0 : (t - lower.t) / (upper.t - lower.t);
  return [
    Math.round(lower.color[0] + (upper.color[0] - lower.color[0]) * localT),
    Math.round(lower.color[1] + (upper.color[1] - lower.color[1]) * localT),
    Math.round(lower.color[2] + (upper.color[2] - lower.color[2]) * localT),
    210,
  ];
}

function updateCoverageLayer(
  map: mapboxgl.Map,
  analysis: AnalysisRequest,
  debugMode: DebugMode,
  displayCanvas: HTMLCanvasElement,
): void {
  ensureCoverageCanvasSource(map, renderCoverageImage(mapTerrainSampler(map), analysis, debugMode, displayCanvas));
}

function mapTerrainSampler(map: mapboxgl.Map): TerrainSampler {
  return {
    queryTerrainElevation: (lngLat, options) => map.queryTerrainElevation(lngLat, options),
  };
}

function stylePreviewUrl(style: MapStyleTemplate): string {
  const path = style.uri.replace("mapbox://styles/", "");
  return `https://api.mapbox.com/styles/v1/${path}/static/-3.7038,40.4168,11,0/104x104?access_token=${token}`;
}

function shouldUseMapboxTerrain(): boolean {
  return true;
}

function setMapboxTerrainEnabled(map: mapboxgl.Map, enabled: boolean): void {
  map.setTerrain(enabled ? { source: "mapbox-dem", exaggeration: 1 } : null);
}

export function installAnalysisLayers(
  map: mapboxgl.Map,
  analysis: AnalysisRequest,
  debugMode: DebugMode,
  terrainEnabled = true,
): void {
  if (!map.getSource("mapbox-dem")) {
    map.addSource("mapbox-dem", {
      type: "raster-dem",
      url: "mapbox://mapbox.mapbox-terrain-dem-v1",
      tileSize: 512,
      maxzoom: 14,
    });
  }
  setMapboxTerrainEnabled(map, terrainEnabled);

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
  const gpuCoverageTexturePxRef = useRef<number | null>(null);
  const coverageDisplayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const coverageRenderSeqRef = useRef(0);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const terrainTileLoaderRef = useRef<TerrainHeightTileLoader | null>(null);
  const terrainFieldRef = useRef<CachedTerrainField | null>(null);
  const buildingTileLoaderRef = useRef<BuildingHeightTileLoader | null>(null);
  const buildingFieldRef = useRef<CachedBuildingField | null>(null);
  const vegetationTileLoaderRef = useRef<VegetationHeightTileLoader | null>(null);
  const vegetationFieldRef = useRef<CachedVegetationField | null>(null);
  const mapNodeRef = useRef<HTMLDivElement | null>(null);
  const previousStyleUriRef = useRef(defaultMapStyle.uri);
  const refreshCoverageRef = useRef<(map: mapboxgl.Map, analysis: AnalysisRequest) => void>(() => undefined);
  const skipNextCoverageEffectRef = useRef<AnalysisRequest | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisRequest>(defaultAnalysis);
  const [debugMode, setDebugMode] = useState<DebugMode>("combined");
  const [inspector, setInspector] = useState<CoveragePixel | null>(null);
  const [inspectorTarget, setInspectorTarget] = useState<InspectorTarget | null>(null);
  const [mapDataRevision, setMapDataRevision] = useState(0);
  const [coverageEngine, setCoverageEngine] = useState<CoverageEngine>("cpu-fallback");
  const [preferredCoverageEngine, setPreferredCoverageEngine] = useState<CoverageEngine>("gpu");
  const [selectedStyleId, setSelectedStyleId] = useState(defaultMapStyle.id);
  const [isStyleMenuOpen, setIsStyleMenuOpen] = useState(false);
  const [mapCamera, setMapCamera] = useState({ bearing: 0, pitch: 0 });
  const [analysisWarning, setAnalysisWarning] = useState<string | null>(null);
  const hadVegetationWarningRef = useRef(false);
  const hasToken = Boolean(token && token !== "your_mapbox_token_here");
  const selectedStyle = mapStyleTemplates.find((style) => style.id === selectedStyleId) ?? defaultMapStyle;
  const latestAnalysisRef = useRef(analysis);
  const latestCoverageFootprintRef = useRef(coverageFootprintKey(analysis, debugMode));

  useEffect(() => {
    if (analysisWarning?.includes("Vegetation CHM")) {
      hadVegetationWarningRef.current = true;
    }
  }, [analysisWarning]);

  useEffect(() => {
    if (!analysis.includeVegetation && hadVegetationWarningRef.current) {
      gpuCoverageRef.current?.dispose();
      gpuCoverageRef.current = null;
      gpuCoverageTexturePxRef.current = null;
      vegetationFieldRef.current = null;
      hadVegetationWarningRef.current = false;
    }
  }, [analysis.includeVegetation]);

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
      lastCoverageTimings: window.__droneRangeDebug?.lastCoverageTimings ?? null,
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
    window.__benchmarkCoverageRender = async (gridSizes = [64, 128, 256, 384, 768, 1024]) => {
      if (!token) {
        return [];
      }
      const results: CoverageBenchmarkResult[] = [];
      for (const gridSizePx of gridSizes) {
        const texturePx = gpuHeightTexturePxForGrid(gridSizePx);
        const layer = GpuCoverageLayer.create({
          mapboxToken: token,
          texturePx,
          coordinatesForAnalysis: coverageImageCoordinates,
        });
        if (!layer) {
          return results;
        }
        try {
          const request: AnalysisRequest = {
            ...latestAnalysisRef.current,
            gridSizePx,
            includeBuildings: false,
          };
          await layer.updateAnalysis(request, debugMode);
          const cpu = layer.renderCpuReference();
          const gpu = layer.render(true);
          const pixels = clampGridSize(gridSizePx, maxGpuCoverageGridPx) ** 2;
          const cpuMs = cpu?.timings?.totalMs ?? null;
          const gpuMs = gpu?.timings?.totalMs ?? null;
          results.push({
            gridSizePx: clampGridSize(gridSizePx, maxGpuCoverageGridPx),
            pixels,
            cpuMs,
            gpuMs,
            speedup: cpuMs !== null && gpuMs !== null && gpuMs > 0 ? cpuMs / gpuMs : null,
            cpuPixelsPerMs: cpuMs && cpuMs > 0 ? pixels / cpuMs : null,
            gpuPixelsPerMs: gpuMs && gpuMs > 0 ? pixels / gpuMs : null,
          });
        } finally {
          layer.dispose();
        }
      }
      return results;
    };
  }

  function getCoverageDisplayCanvas(): HTMLCanvasElement {
    if (!coverageDisplayCanvasRef.current) {
      const canvas = document.createElement("canvas");
      canvas.style.display = "none";
      canvas.style.imageRendering = "pixelated";
      canvas.dataset.coverageSource = "los-coverage";
      document.body.appendChild(canvas);
      coverageDisplayCanvasRef.current = canvas;
    }
    return coverageDisplayCanvasRef.current;
  }

  function applyCoverageOverlay(map: mapboxgl.Map, overlay: CoverageOverlay): void {
    const applyStartedAt = performance.now();
    const displayCanvas = getCoverageDisplayCanvas();
    const displaySize = overlay.gridSizePx * coverageDisplayScale;
    if (displayCanvas.width !== displaySize || displayCanvas.height !== displaySize) {
      displayCanvas.width = displaySize;
      displayCanvas.height = displaySize;
    }
    displayCanvas.style.imageRendering = "pixelated";
    const displayCopyStartedAt = performance.now();
    const context = displayCanvas.getContext("2d");
    if (context) {
      context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
      context.drawImage(overlay.canvas, 0, 0, displayCanvas.width, displayCanvas.height);
    }
    const displayCopyMs = performance.now() - displayCopyStartedAt;

    const mapSourceStartedAt = performance.now();
    ensureCoverageCanvasSource(
      map,
      {
        ...overlay,
        canvas: displayCanvas,
      },
    );
    const mapSourceUpdateMs = performance.now() - mapSourceStartedAt;
    const fingerprintStartedAt = performance.now();
    const coverageCanvasFingerprint = canvasFingerprint(displayCanvas);
    const fingerprintMs = performance.now() - fingerprintStartedAt;
    const overlayApplyMs = performance.now() - applyStartedAt;
    const benchmarkStartedAt = import.meta.env.DEV
      ? (window as Window & { __coverageBenchmarkStartedAt?: number }).__coverageBenchmarkStartedAt
      : undefined;
    const timings = overlay.timings
      ? {
          ...overlay.timings,
          actionToOverlayMs: benchmarkStartedAt === undefined ? undefined : performance.now() - benchmarkStartedAt,
          overlayApplyMs,
          displayCopyMs,
          mapSourceUpdateMs,
          fingerprintMs,
        }
      : null;
    updateDebugState({
      coverageCoordinates: overlay.coordinates,
      coverageCanvasFingerprint,
      renderedOperator: overlay.renderedOperator,
      renderSequence: coverageRenderSeqRef.current,
      engine: overlay.engine,
      preferredEngine: preferredCoverageEngine,
      lastCoverageTimings: timings,
      hasCoverageSource: Boolean(map.getSource("los-coverage")),
      sourceType: getCoverageSourceType(map),
      sourceTypeCounts: getStyleSourceTypeCounts(map),
    });
  }

  function buildingFieldSignature(request: AnalysisRequest, mode: DebugMode): string {
    const radiusM = analysisRadiusM(request, mode);
    const bounds = analysisMercatorBounds(request, radiusM);
    return [
      clampGridSize(request.gridSizePx),
      bounds.west.toFixed(8),
      bounds.north.toFixed(8),
      bounds.east.toFixed(8),
      bounds.south.toFixed(8),
    ].join(":");
  }

  function terrainFieldSignature(request: AnalysisRequest, mode: DebugMode): string {
    const radiusM = analysisRadiusM(request, mode);
    const bounds = analysisMercatorBounds(request, radiusM);
    const texturePx = gpuHeightTexturePxForGrid(request.gridSizePx);
    const zoom = chooseDemZoom(request, radiusM);
    return [
      zoom,
      texturePx,
      bounds.west.toFixed(8),
      bounds.north.toFixed(8),
      bounds.east.toFixed(8),
      bounds.south.toFixed(8),
    ].join(":");
  }

  function vegetationFieldSignature(request: AnalysisRequest, mode: DebugMode): string {
    const radiusM = analysisRadiusM(request, mode);
    const bounds = analysisMercatorBounds(request, radiusM);
    const texturePx = gpuHeightTexturePxForGrid(request.gridSizePx);
    return [
      texturePx,
      bounds.west.toFixed(8),
      bounds.north.toFixed(8),
      bounds.east.toFixed(8),
      bounds.south.toFixed(8),
    ].join(":");
  }

  function fixedOcclusionSampler(
    terrainField: TerrainHeightField,
    buildingField: BuildingHeightField | null,
    vegetationField: VegetationHeightField | null,
  ): TerrainSampler {
    return {
      queryTerrainElevation: (lngLat) => sampleHeightField(terrainField, lngLatToMercator01(lngLat.lng, lngLat.lat)),
      queryBuildingHeightM: buildingField
        ? (lngLat) => sampleBuildingHeightField(buildingField, lngLatToMercator01(lngLat.lng, lngLat.lat))
        : undefined,
      queryVegetationHeightM: vegetationField
        ? (lngLat) => sampleVegetationHeightField(vegetationField, lngLatToMercator01(lngLat.lng, lngLat.lat))
        : undefined,
    };
  }

  async function terrainFieldForAnalysis(request: AnalysisRequest, mode: DebugMode): Promise<TerrainHeightField | null> {
    if (!token) {
      terrainFieldRef.current = null;
      return null;
    }
    if (!terrainTileLoaderRef.current) {
      terrainTileLoaderRef.current = new TerrainHeightTileLoader(token);
    }
    const signature = terrainFieldSignature(request, mode);
    if (terrainFieldRef.current?.signature !== signature) {
      const radiusM = analysisRadiusM(request, mode);
      const bounds = analysisMercatorBounds(request, radiusM);
      const texturePx = gpuHeightTexturePxForGrid(request.gridSizePx);
      terrainFieldRef.current = {
        signature,
        field: await terrainTileLoaderRef.current.buildHeightField(bounds, chooseDemZoom(request, radiusM), texturePx),
      };
    }
    return terrainFieldRef.current.field;
  }

  async function terrainSamplerForAnalysis(
    map: mapboxgl.Map,
    request: AnalysisRequest,
    mode: DebugMode,
  ): Promise<TerrainSampler> {
    if (!token) {
      buildingFieldRef.current = null;
      return mapTerrainSampler(map);
    }
    const terrainField = await terrainFieldForAnalysis(request, mode);
    if (!terrainField) {
      return mapTerrainSampler(map);
    }
    if (!request.includeBuildings) {
      buildingFieldRef.current = null;
    }
    let buildingField: BuildingHeightField | null = null;
    if (request.includeBuildings && !buildingTileLoaderRef.current) {
      buildingTileLoaderRef.current = new BuildingHeightTileLoader(token);
    }
    if (request.includeBuildings && buildingTileLoaderRef.current) {
      const signature = buildingFieldSignature(request, mode);
      if (buildingFieldRef.current?.signature !== signature) {
        const radiusM = analysisRadiusM(request, mode);
        const bounds = analysisMercatorBounds(request, radiusM);
        const texturePx = gpuHeightTexturePxForGrid(request.gridSizePx);
        buildingFieldRef.current = {
          signature,
          field: await buildingTileLoaderRef.current.buildHeightField(bounds, texturePx, texturePx),
        };
      }
      buildingField = buildingFieldRef.current.field;
    }
    let vegetationField: VegetationHeightField | null = null;
    if (!request.includeVegetation) {
      vegetationFieldRef.current = null;
    } else {
      if (!vegetationTileLoaderRef.current) {
        vegetationTileLoaderRef.current = new VegetationHeightTileLoader({
          onWarning: setAnalysisWarning,
        });
      }
      const signature = vegetationFieldSignature(request, mode);
      if (vegetationFieldRef.current?.signature !== signature) {
        const radiusM = analysisRadiusM(request, mode);
        const bounds = analysisMercatorBounds(request, radiusM);
        const texturePx = gpuHeightTexturePxForGrid(request.gridSizePx);
        try {
          const field = await vegetationTileLoaderRef.current.buildHeightField(bounds, texturePx, texturePx);
          vegetationFieldRef.current = field.failedTileCount > 0 ? null : { signature, field };
          vegetationField = field;
        } catch (error) {
          console.warn("Vegetation CHM unavailable; continuing without canopy occlusion.", error);
          setAnalysisWarning(
            error instanceof Error ? error.message : "Vegetation CHM unavailable; continuing without canopy occlusion.",
          );
          vegetationFieldRef.current = null;
        }
      }
      vegetationField = vegetationField ?? vegetationFieldRef.current?.field ?? null;
    }
    return fixedOcclusionSampler(terrainField, buildingField, vegetationField);
  }

  const coverageEngineLabel =
    coverageEngine === "gpu"
      ? analysis.includeBuildings || analysis.includeVegetation
        ? `GPU terrain + ${[analysis.includeBuildings ? "buildings" : "", analysis.includeVegetation ? "canopy" : ""].filter(Boolean).join(" + ")}`
        : "GPU terrain"
      : (analysis.includeBuildings || analysis.includeVegetation) && preferredCoverageEngine === "gpu"
        ? "CPU fallback"
        : preferredCoverageEngine === "gpu"
          ? "CPU fallback"
          : analysis.includeBuildings || analysis.includeVegetation
        ? `CPU ${[analysis.includeBuildings ? "buildings" : "", analysis.includeVegetation ? "canopy" : ""].filter(Boolean).join(" + ")}`
        : "CPU fallback";

  async function refreshCoverageLayer(map: mapboxgl.Map, nextAnalysis: AnalysisRequest, nextDebugMode: DebugMode) {
    const sequence = ++coverageRenderSeqRef.current;
    setAnalysisWarning(null);
    setMapboxTerrainEnabled(map, shouldUseMapboxTerrain());
    if (token) {
      try {
        const mapboxToken = token;
        const texturePx = gpuHeightTexturePxForGrid(nextAnalysis.gridSizePx);
        if (gpuCoverageRef.current && gpuCoverageTexturePxRef.current !== texturePx) {
          gpuCoverageRef.current.dispose();
          gpuCoverageRef.current = null;
          gpuCoverageTexturePxRef.current = null;
        }
        if (!gpuCoverageRef.current) {
          gpuCoverageRef.current = GpuCoverageLayer.create({
            mapboxToken,
            texturePx,
            coordinatesForAnalysis: coverageImageCoordinates,
            onWarning: setAnalysisWarning,
          });
          gpuCoverageTexturePxRef.current = gpuCoverageRef.current ? texturePx : null;
        }
        const gpuCoverage = gpuCoverageRef.current;
        if (gpuCoverage) {
          const isCurrentGpuAnalysis = await gpuCoverage.updateAnalysis(nextAnalysis, nextDebugMode);
          if (!isCurrentGpuAnalysis || sequence !== coverageRenderSeqRef.current) {
            return;
          }
          const image =
            preferredCoverageEngine === "gpu"
              ? gpuCoverage.render()
              : gpuCoverage.renderCpuReference();
          if (image && sequence === coverageRenderSeqRef.current) {
            applyCoverageOverlay(map, image);
            updateDebugState({
              engine: image.engine,
            });
            setCoverageEngine(image.engine);
            return;
          }
        }
      } catch (error) {
        console.warn("Shared terrain coverage renderer failed; falling back to Mapbox CPU coverage.", error);
        setMapboxTerrainEnabled(map, true);
      }
    }

    if (sequence !== coverageRenderSeqRef.current) {
      return;
    }
    const sampler = await terrainSamplerForAnalysis(map, nextAnalysis, nextDebugMode);
    if (sequence !== coverageRenderSeqRef.current) {
      return;
    }
    const cpuOverlay = renderCoverageImage(sampler, nextAnalysis, nextDebugMode, document.createElement("canvas"));
    applyCoverageOverlay(map, cpuOverlay);
    setMapDataRevision((revision) => revision + 1);
    updateDebugState({
      coverageCoordinates: coverageImageCoordinates(nextAnalysis.operator, analysisRadiusM(nextAnalysis, nextDebugMode)),
      coverageCanvasFingerprint: canvasFingerprint(getCoverageDisplayCanvas()),
      renderedOperator: nextAnalysis.operator,
      renderSequence: coverageRenderSeqRef.current,
      engine: "cpu-fallback",
      preferredEngine: preferredCoverageEngine,
      lastCoverageTimings: cpuOverlay.timings ?? null,
      hasCoverageSource: Boolean(map.getSource("los-coverage")),
      sourceType: getCoverageSourceType(map),
      sourceTypeCounts: getStyleSourceTypeCounts(map),
    });
    setCoverageEngine("cpu-fallback");
  }
  refreshCoverageRef.current = (map, nextAnalysis) => {
    void refreshCoverageLayer(map, nextAnalysis, debugMode);
  };

  useEffect(() => {
    if (!analysis.includeVegetation || !token) {
      return;
    }
    let cancelled = false;
    const signature = vegetationFieldSignature(analysis, debugMode);
    if (vegetationFieldRef.current?.signature === signature) {
      return;
    }
    if (!vegetationTileLoaderRef.current) {
      vegetationTileLoaderRef.current = new VegetationHeightTileLoader({
        onWarning: setAnalysisWarning,
      });
    }
    const radiusM = analysisRadiusM(analysis, debugMode);
    const bounds = analysisMercatorBounds(analysis, radiusM);
    const texturePx =
      preferredCoverageEngine === "gpu"
        ? gpuHeightTexturePxForGrid(analysis.gridSizePx)
        : clampGridSize(analysis.gridSizePx);
    void vegetationTileLoaderRef.current
      .buildHeightField(bounds, texturePx, texturePx)
      .then((field) => {
        if (!cancelled && field.failedTileCount === 0) {
          vegetationFieldRef.current = { signature, field };
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("Vegetation CHM prewarm failed.", error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [analysis, debugMode, preferredCoverageEngine]);

  const activeProfiles = useMemo(
    () => analysis.profiles.filter((profile) => analysis.selectedProfileIds.includes(profile.id)),
    [analysis.profiles, analysis.selectedProfileIds],
  );
  const effectiveCalculationRadiusM = useMemo(
    () => analysisRadiusM(analysis, debugMode),
    [analysis, debugMode],
  );
  const maxSelectableGridPx =
    preferredCoverageEngine === "gpu" ? maxGpuCoverageGridPx : maxCpuCoverageGridPx;

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
      antialias: false,
      preserveDrawingBuffer: false,
    });
    map.touchZoomRotate.disableRotation();
    map.boxZoom.disable();
    map.setMaxPitch(75);

    mapRef.current = map;
    const syncMapCamera = () => {
      setMapCamera({
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      });
    };
    map.on("rotate", syncMapCamera);
    map.on("pitch", syncMapCamera);
    map.on("moveend", syncMapCamera);
    syncMapCamera();
    markerRef.current = new mapboxgl.Marker({ draggable: true, color: "#1f8fff" })
      .setLngLat([analysis.operator.lng, analysis.operator.lat])
      .addTo(map);
    updateDebugState();

    const commitOperatorMove = (lngLat: mapboxgl.LngLat) => {
      const nextAnalysis = {
        ...latestAnalysisRef.current,
        operator: operatorFromLngLat(latestAnalysisRef.current, lngLat),
      };
      beginOperatorMove(map, nextAnalysis);
      skipNextCoverageEffectRef.current = nextAnalysis;
      setAnalysis(nextAnalysis);
      refreshCoverageRef.current(map, nextAnalysis);
    };

    markerRef.current.on("dragend", () => {
      const lngLat = markerRef.current!.getLngLat();
      commitOperatorMove(lngLat);
    });

    const placeOperator = (lngLat: mapboxgl.LngLat) => {
      markerRef.current?.setLngLat(lngLat);
      commitOperatorMove(lngLat);
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
      installAnalysisLayers(map, analysis, debugMode, shouldUseMapboxTerrain());
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
      gpuCoverageTexturePxRef.current = null;
      coverageDisplayCanvasRef.current?.remove();
      coverageDisplayCanvasRef.current = null;
      map.off("rotate", syncMapCamera);
      map.off("pitch", syncMapCamera);
      map.off("moveend", syncMapCamera);
      map.remove();
      mapRef.current = null;
      if (import.meta.env.DEV) {
        delete window.__droneRangeDebug;
        delete window.__inspectCoverageAt;
        delete window.__auditCoverageFootprint;
      }
    };
  }, [hasToken]);

  useEffect(() => {
    latestAnalysisRef.current = analysis;
    markerRef.current?.setLngLat([analysis.operator.lng, analysis.operator.lat]);
    if (preferredCoverageEngine === "cpu-fallback") {
      gpuCoverageRef.current?.dispose();
      gpuCoverageRef.current = null;
      gpuCoverageTexturePxRef.current = null;
    }
    const shouldSkipCoverageRefresh = skipNextCoverageEffectRef.current === analysis;
    if (shouldSkipCoverageRefresh) {
      skipNextCoverageEffectRef.current = null;
    } else if (mapRef.current?.isStyleLoaded()) {
      const nextCoverageFootprint = coverageFootprintKey(analysis, debugMode);
      updateReferenceCircle(mapRef.current, analysis);
      if (nextCoverageFootprint !== latestCoverageFootprintRef.current) {
        hideStaleCoverage(mapRef.current);
      }
      latestCoverageFootprintRef.current = nextCoverageFootprint;
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
      installAnalysisLayers(
        map,
        latestAnalysisRef.current,
        debugMode,
        shouldUseMapboxTerrain(),
      );
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
    if (!map) {
      setInspector(inspectFlatEarthPixel(analysis, inspectorTarget, debugMode));
      return;
    }

    let cancelled = false;
    void terrainSamplerForAnalysis(map, analysis, debugMode).then((sampler) => {
      if (cancelled) {
        return;
      }
      setInspector(inspectTerrainPixel(sampler, analysis, inspectorTarget, debugMode));
    });

    return () => {
      cancelled = true;
    };
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

  function resetBearingToNorth() {
    mapRef.current?.easeTo({ bearing: 0, duration: 350 });
  }

  function toggleMapDimension() {
    const map = mapRef.current;
    if (!map) return;
    const is3d = map.getPitch() > 1;
    map.easeTo({
      pitch: is3d ? 0 : map3dPitch,
      bearing: is3d ? 0 : map.getBearing(),
      duration: 450,
    });
  }

  function manuallyReloadCoverage() {
    const map = mapRef.current;
    if (!map) return;
    void refreshCoverageLayer(map, latestAnalysisRef.current, debugMode);
  }

  const isMap3d = mapCamera.pitch > 1;

  return (
    <main className="app">
      <div ref={mapNodeRef} className="map" />
      {!hasToken && (
        <section className="token-panel">
          <MapPin size={24} />
          <h1>Drone Ranger</h1>
          {isPackagedElectron ? (
            <p>Restart the app and enter a Mapbox API key when prompted.</p>
          ) : (
            <p>Add a Mapbox token to <code>.env</code> as <code>VITE_MAPBOX_TOKEN</code>, then start the app.</p>
          )}
        </section>
      )}

      <aside className="toolbar" aria-label="Analysis controls">
        <div className="panel-title app-header">
          <img src={droneRangerHeaderUrl} alt="Drone Ranger" />
          <button
            type="button"
            title="Reload coverage"
            aria-label="Reload coverage"
            onClick={manuallyReloadCoverage}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </div>

        <label>
          <span className="inline-control">
            <span>Reference radius</span>
            <span className="input-with-unit compact-number">
              <input
                type="number"
                min="0"
                step="250"
                value={analysis.radiusM}
                onChange={(event) => setNumber("radiusM", Number(event.target.value))}
              />
              <span>m</span>
            </span>
          </span>
          <input
            type="range"
            min="250"
            max="10000"
            step="250"
            value={Math.min(10000, Math.max(250, analysis.radiusM))}
            onChange={(event) => setNumber("radiusM", Number(event.target.value))}
          />
        </label>

        <label>
          <span className="inline-control compact-inline">
            <span>Operator antenna height</span>
            <span className="input-with-unit tiny-number">
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
          </span>
        </label>

        <div className="altitude-range-row">
          <label className="range-pair-label">
            Altitude range
            <span className="range-pair">
              <span className="input-with-unit tiny-number">
              <input
                type="number"
                value={analysis.altitude.minM}
                onChange={(event) => setAltitude("minM", Number(event.target.value))}
              />
              <span>m</span>
              </span>
              <span className="range-separator">to</span>
              <span className="input-with-unit tiny-number">
              <input
                type="number"
                value={analysis.altitude.maxM}
                onChange={(event) => setAltitude("maxM", Number(event.target.value))}
              />
              <span>m</span>
              </span>
            </span>
          </label>
          <label>
            Relative to
            <select
              value={analysis.altitudeCriterion}
              onChange={(event) =>
                setAnalysis((current) => ({
                  ...current,
                  altitudeCriterion: event.target.value as AnalysisRequest["altitudeCriterion"],
                }))
              }
            >
              <option value="elevation-change">Operator</option>
              <option value="agl">Ground level</option>
            </select>
          </label>
        </div>

        <label>
          <span className="inline-control compact-inline">
            <span>Coverage mode</span>
            <select
              className="compact-select"
              value={debugMode}
              onChange={(event) => setDebugMode(event.target.value as DebugMode)}
            >
              {debugModes.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.label}
                </option>
              ))}
            </select>
          </span>
        </label>

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
        </label>

        <label>
          <span className="toggle-row">
            <span>Vegetation occlusion</span>
            <input
              type="checkbox"
              checked={analysis.includeVegetation}
              onChange={(event) =>
                setAnalysis((current) => ({
                  ...current,
                  includeVegetation: event.target.checked,
                }))
              }
            />
          </span>
        </label>

        {analysisWarning ? <div className="analysis-warning">{analysisWarning}</div> : null}

        <details className="config-menu">
          <summary>
            <Settings size={16} />
            <span>Advanced settings</span>
            <ChevronDown className="disclosure-icon" size={16} />
          </summary>

          <label>
            <span className="inline-control compact-inline">
              <span>Min canopy height</span>
              <span className="input-with-unit tiny-number">
                <input
                  className="tiny-number-input"
                  type="number"
                  min="0"
                  step="0.5"
                  value={analysis.vegetation.minCanopyHeightM}
                  onChange={(event) =>
                    setAnalysis((current) => ({
                      ...current,
                      vegetation: {
                        ...current.vegetation,
                        minCanopyHeightM: Number(event.target.value),
                      },
                    }))
                  }
                />
                <span>m</span>
              </span>
            </span>
          </label>

          <label>
            <span className="calc-range-control">
              <span>Calculation range</span>
              <span className="calc-range-actions">
                <span className="input-with-unit range-number">
                  <input
                    type="number"
                    min="250"
                    step="250"
                    value={
                      analysis.calculationRange.mode === "auto"
                        ? Math.round(effectiveCalculationRadiusM)
                        : analysis.calculationRange.manualM
                    }
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
                <span className="segmented mode-toggle" role="radiogroup" aria-label="Calculation range">
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
                </span>
              </span>
            </span>
          </label>

          <label>
            <span className="inline-control compact-inline">
              <span>Color steps</span>
              <input
                className="tiny-number-input"
                type="number"
                min="1"
                step="1"
                value={analysis.colorSteps}
                onChange={(event) =>
                  setAnalysis((current) => ({
                    ...current,
                    colorSteps: Math.max(1, Math.round(Number(event.target.value) || 1)),
                  }))
                }
              />
            </span>
          </label>

          <label>
            Grid resolution
            <input
              type="range"
              min={minCoverageGridPx}
              max={maxSelectableGridPx}
              step="1"
              value={Math.min(analysis.gridSizePx, maxSelectableGridPx)}
              onChange={(event) => setNumber("gridSizePx", Number(event.target.value))}
            />
            <output>
              {Math.min(analysis.gridSizePx, maxSelectableGridPx)} x{" "}
              {Math.min(analysis.gridSizePx, maxSelectableGridPx)} pixels
            </output>
          </label>

          <div className="renderer-row">
            <span>Solver / Renderer</span>
            <div className="segmented compact" role="radiogroup" aria-label="Coverage renderer">
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
                title={`Current: ${coverageEngine === "gpu" ? "GPU" : "CPU"}`}
              >
                GPU
              </button>
            </div>
          </div>
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
            <dt>Min. drone altitude (AGL)</dt>
            <dd>{inspector.minDroneAltitudeAglM.toFixed(1)} m</dd>
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
          <div className="map-view-controls" aria-label="Map view controls">
            <button
              type="button"
              className="map-icon-button"
              onClick={resetBearingToNorth}
              title="Reset north"
              aria-label="Reset north"
            >
              <span
                className="compass-face"
                style={{ transform: `rotate(${-mapCamera.bearing}deg)` }}
                aria-hidden="true"
              >
                <span className="compass-north" />
                <span className="compass-south" />
              </span>
            </button>
            <button
              type="button"
              className={`map-icon-button ${isMap3d ? "active" : ""}`}
              onClick={toggleMapDimension}
              title={isMap3d ? "Switch to top view" : "Switch to 3D view"}
              aria-label={isMap3d ? "Switch to top view" : "Switch to 3D view"}
            >
              {isMap3d ? <Cuboid size={21} aria-hidden="true" /> : <Square size={21} aria-hidden="true" />}
              <span>{isMap3d ? "3D" : "2D"}</span>
            </button>
          </div>
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
        <span className="hint-copy">
          <span>Drag marker or Shift-click to place operator. Click coverage for inspection.</span>
          <span>Engine: {coverageEngineLabel}.</span>
        </span>
      </div>
    </main>
  );
}
