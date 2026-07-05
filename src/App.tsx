import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import mapboxgl from "mapbox-gl";
import {
  Activity,
  Antenna,
  ChevronDown,
  Layers,
  MapPin,
  Radio,
  RefreshCw,
  Settings,
} from "lucide-react";
import { defaultAnalysis } from "./analysis/defaults";
import { inspectFlatEarthPixel, inspectTerrainPixel } from "./analysis/singleRay";
import { LosCoverageLayer } from "./vendor/shademap";
import { analysisRadiusM, coverageTextureSizeFor } from "./vendor/shademap/CoverageRenderer";
import type { AnalysisRequest, CoveragePixel, DebugMode, LinkProfile, LinkProfileId } from "./types";

const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
const minGridResolutionM = 5;
const maxGridResolutionM = 500;

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

function gridResolutionToSlider(valueM: number): number {
  const min = Math.log(minGridResolutionM);
  const max = Math.log(maxGridResolutionM);
  const clamped = Math.max(minGridResolutionM, Math.min(maxGridResolutionM, valueM));
  return ((Math.log(clamped) - min) / (max - min)) * 100;
}

function sliderToGridResolution(value: number): number {
  const min = Math.log(minGridResolutionM);
  const max = Math.log(maxGridResolutionM);
  const normalized = Math.max(0, Math.min(100, value)) / 100;
  return Math.round(Math.exp(min + normalized * (max - min)));
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

function stylePreviewUrl(style: MapStyleTemplate): string {
  const path = style.uri.replace("mapbox://styles/", "");
  return `https://api.mapbox.com/styles/v1/${path}/static/-3.7038,40.4168,11,0/104x104?access_token=${token}`;
}

function installAnalysisLayers(
  map: mapboxgl.Map,
  analysis: AnalysisRequest,
  debugMode: DebugMode,
  layerRef: MutableRefObject<LosCoverageLayer | null>,
): void {
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

  const layer = new LosCoverageLayer(analysis, debugMode);
  layerRef.current = layer;
  map.addLayer(layer, "reference-radius-line");
  map.once("idle", () => layer.refreshSources());
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
  const layerRef = useRef<LosCoverageLayer | null>(null);
  const mapNodeRef = useRef<HTMLDivElement | null>(null);
  const previousStyleUriRef = useRef(mapStyleTemplates[0].uri);
  const [analysis, setAnalysis] = useState<AnalysisRequest>(defaultAnalysis);
  const [debugMode, setDebugMode] = useState<DebugMode>("combined");
  const [inspector, setInspector] = useState<CoveragePixel | null>(null);
  const [inspectorTarget, setInspectorTarget] = useState<{ lng: number; lat: number } | null>(null);
  const [selectedStyleId, setSelectedStyleId] = useState(mapStyleTemplates[0].id);
  const [isStyleMenuOpen, setIsStyleMenuOpen] = useState(false);
  const hasToken = Boolean(token && token !== "your_mapbox_token_here");
  const selectedStyle = mapStyleTemplates.find((style) => style.id === selectedStyleId) ?? mapStyleTemplates[0];
  const latestAnalysisRef = useRef(analysis);
  const latestDebugModeRef = useRef(debugMode);

  const activeProfiles = useMemo(
    () => analysis.profiles.filter((profile) => analysis.selectedProfileIds.includes(profile.id)),
    [analysis.profiles, analysis.selectedProfileIds],
  );
  const effectiveCalculationRadiusM = useMemo(
    () => analysisRadiusM(analysis, debugMode),
    [analysis, debugMode],
  );
  const effectiveTextureSize = useMemo(
    () => coverageTextureSizeFor(effectiveCalculationRadiusM, analysis.gridResolutionM),
    [analysis.gridResolutionM, effectiveCalculationRadiusM],
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
      setInspectorTarget({ lng: event.lngLat.lng, lat: event.lngLat.lat });
    });

    map.on("load", () => {
      installAnalysisLayers(map, analysis, debugMode, layerRef);
    });

    return () => {
      layerRef.current = null;
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
    }
    layerRef.current?.setRequest(analysis);
  }, [analysis]);

  useEffect(() => {
    latestDebugModeRef.current = debugMode;
    layerRef.current?.setDebugMode(debugMode);
  }, [debugMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !hasToken) return;
    if (previousStyleUriRef.current === selectedStyle.uri) return;
    previousStyleUriRef.current = selectedStyle.uri;
    layerRef.current = null;
    map.setStyle(selectedStyle.uri);
    map.once("style.load", () =>
      installAnalysisLayers(map, latestAnalysisRef.current, latestDebugModeRef.current, layerRef),
    );
  }, [hasToken, selectedStyle.uri]);

  useEffect(() => {
    const map = mapRef.current;
    setInspector(
      inspectorTarget
        ? map
          ? inspectTerrainPixel(map, analysis, inspectorTarget, debugMode)
          : inspectFlatEarthPixel(analysis, inspectorTarget, debugMode)
        : null,
    );
  }, [analysis, debugMode, inspectorTarget]);

  function setNumber(path: "radiusM" | "gridResolutionM", value: number) {
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
          <button type="button" title="Resample terrain" onClick={() => layerRef.current?.refreshSources()}>
            <RefreshCw size={16} />
          </button>
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
          Operator antenna
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
              min="0"
              max="100"
              step="1"
              value={gridResolutionToSlider(analysis.gridResolutionM)}
              onChange={(event) =>
                setNumber("gridResolutionM", sliderToGridResolution(Number(event.target.value)))
              }
            />
            <output>
              {analysis.gridResolutionM} m cells, {effectiveTextureSize} x {effectiveTextureSize}
            </output>
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
          <details className="profile-card" key={profile.id} open>
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
