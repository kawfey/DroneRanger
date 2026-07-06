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
  lngLatToMercator01,
  mercator01ToLngLat,
  metersToMercatorUnits,
} from "./analysis/coordinates";
import type { AnalysisRequest, CoveragePixel, DebugMode, LinkProfile, LinkProfileId } from "./types";

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

type CoverageImage = {
  url: string;
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
};

const minCoverageGridPx = 25;
const maxCoverageGridPx = 384;
const coverageTexturePx = 768;

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
): CoverageImage["coordinates"] {
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

function shadeForPixel(pixel: CoveragePixel, analysis: AnalysisRequest): [number, number, number, number] {
  if (!pixel.reachable) {
    return [0, 0, 0, 0];
  }
  const span = Math.max(0.001, analysis.altitude.maxM - analysis.altitude.minM);
  const altitudeStepM = Math.max(0.001, Math.abs(analysis.altitude.stepM));
  const steppedAltitudeM =
    analysis.altitude.minM +
    Math.ceil((pixel.requiredAltitudeM - analysis.altitude.minM) / altitudeStepM) * altitudeStepM;
  const t = Math.max(0, Math.min(1, (steppedAltitudeM - analysis.altitude.minM) / span));
  const stops: Array<{ t: number; color: [number, number, number] }> = [
    { t: 0, color: [31, 184, 88] },
    { t: 0.5, color: [247, 220, 72] },
    { t: 0.75, color: [242, 143, 44] },
    { t: 1, color: [220, 54, 46] },
  ];
  const upper = stops.find((stop) => stop.t >= t) ?? stops[stops.length - 1];
  const lower = stops[Math.max(0, stops.indexOf(upper) - 1)];
  const localT = upper.t === lower.t ? 0 : (t - lower.t) / (upper.t - lower.t);
  const r = Math.round(lower.color[0] + (upper.color[0] - lower.color[0]) * localT);
  const g = Math.round(lower.color[1] + (upper.color[1] - lower.color[1]) * localT);
  const b = Math.round(lower.color[2] + (upper.color[2] - lower.color[2]) * localT);
  return [r, g, b, 178];
}

function renderCoverageImage(
  map: TerrainSampler | null,
  analysis: AnalysisRequest,
  debugMode: DebugMode,
): CoverageImage {
  const radiusM = analysisRadiusM(analysis, debugMode);
  const gridSize = Math.max(minCoverageGridPx, Math.min(maxCoverageGridPx, Math.round(analysis.gridSizePx)));
  const center = lngLatToMercator01(analysis.operator.lng, analysis.operator.lat);
  const radius = metersToMercatorUnits(radiusM, analysis.operator.lat);
  const canvas = document.createElement("canvas");
  canvas.width = coverageTexturePx;
  canvas.height = coverageTexturePx;
  const context = canvas.getContext("2d");
  if (!context) {
    return { url: "", coordinates: coverageImageCoordinates(analysis.operator, radiusM) };
  }
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, coverageTexturePx, coverageTexturePx);

  for (let y = 0; y < gridSize; y++) {
    const y0 = Math.floor((y / gridSize) * coverageTexturePx);
    const y1 = Math.floor(((y + 1) / gridSize) * coverageTexturePx);
    for (let x = 0; x < gridSize; x++) {
      const nx = (x + 0.5) / gridSize;
      const ny = (y + 0.5) / gridSize;
      const dx = nx * 2 - 1;
      const dy = ny * 2 - 1;
      if (dx * dx + dy * dy > 1) {
        continue;
      }
      const target = mercator01ToLngLat({
        x: center.x + dx * radius,
        y: center.y + dy * radius,
      });
      const pixel = map
        ? inspectTerrainPixel(map, analysis, target, debugMode)
        : inspectFlatEarthPixel(analysis, target, debugMode);
      const [r, g, b, a] = shadeForPixel(pixel, analysis);
      const x0 = Math.floor((x / gridSize) * coverageTexturePx);
      const x1 = Math.floor(((x + 1) / gridSize) * coverageTexturePx);
      context.fillStyle = `rgba(${r}, ${g}, ${b}, ${a / 255})`;
      context.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
    }
  }

  return {
    url: canvas.toDataURL("image/png"),
    coordinates: coverageImageCoordinates(analysis.operator, radiusM),
  };
}

function updateCoverageLayer(
  map: mapboxgl.Map,
  analysis: AnalysisRequest,
  debugMode: DebugMode,
): void {
  const image = renderCoverageImage(map, analysis, debugMode);
  const source = map.getSource("los-coverage") as
    | (mapboxgl.ImageSource & {
        updateImage?: (image: { url: string; coordinates: CoverageImage["coordinates"] }) => void;
      })
    | undefined;

  if (!source) {
    map.addSource("los-coverage", {
      type: "image",
      url: image.url,
      coordinates: image.coordinates,
    });
  } else {
    source.updateImage?.(image);
  }

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

  updateCoverageLayer(map, analysis, debugMode);
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
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const mapNodeRef = useRef<HTMLDivElement | null>(null);
  const previousStyleUriRef = useRef(mapStyleTemplates[0].uri);
  const [analysis, setAnalysis] = useState<AnalysisRequest>(defaultAnalysis);
  const [debugMode, setDebugMode] = useState<DebugMode>("combined");
  const [inspector, setInspector] = useState<CoveragePixel | null>(null);
  const [inspectorTarget, setInspectorTarget] = useState<InspectorTarget | null>(null);
  const [mapDataRevision, setMapDataRevision] = useState(0);
  const [selectedStyleId, setSelectedStyleId] = useState(mapStyleTemplates[0].id);
  const [isStyleMenuOpen, setIsStyleMenuOpen] = useState(false);
  const hasToken = Boolean(token && token !== "your_mapbox_token_here");
  const selectedStyle = mapStyleTemplates.find((style) => style.id === selectedStyleId) ?? mapStyleTemplates[0];
  const latestAnalysisRef = useRef(analysis);

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
      map.once("idle", () => {
        updateCoverageLayer(map, latestAnalysisRef.current, debugMode);
        setMapDataRevision((revision) => revision + 1);
      });
    });

    return () => {
      markerRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
  }, [hasToken]);

  useEffect(() => {
    latestAnalysisRef.current = analysis;
    markerRef.current?.setLngLat([analysis.operator.lng, analysis.operator.lat]);
    if (mapRef.current?.isStyleLoaded()) {
      updateReferenceCircle(mapRef.current, analysis);
      updateCoverageLayer(mapRef.current, analysis, debugMode);
    }
  }, [analysis, debugMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !hasToken) return;
    if (previousStyleUriRef.current === selectedStyle.uri) return;
    previousStyleUriRef.current = selectedStyle.uri;
    map.setStyle(selectedStyle.uri);
    map.once("style.load", () => {
      installAnalysisLayers(map, latestAnalysisRef.current, debugMode);
      map.once("idle", () => {
        updateCoverageLayer(map, latestAnalysisRef.current, debugMode);
        setMapDataRevision((revision) => revision + 1);
      });
    });
  }, [debugMode, hasToken, selectedStyle.uri]);

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
        <span>Drag marker or Shift-click to place operator. Click coverage for inspection.</span>
      </div>
    </main>
  );
}
