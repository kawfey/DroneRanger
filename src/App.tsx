import { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import { Activity, Antenna, Layers, MapPin, Radio, RefreshCw } from "lucide-react";
import { defaultAnalysis } from "./analysis/defaults";
import { inspectFlatEarthPixel } from "./analysis/singleRay";
import { LosCoverageLayer } from "./vendor/shademap";
import type { AnalysisRequest, CoveragePixel, DebugMode, LinkProfile, LinkProfileId } from "./types";

const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;

const debugModes: Array<{ id: DebugMode; label: string }> = [
  { id: "combined", label: "Combined" },
  { id: "control", label: "Control" },
  { id: "telemetry", label: "Telemetry" },
  { id: "video", label: "Video" },
  { id: "los", label: "LOS" },
  { id: "margin", label: "Margin" },
  { id: "shademap", label: "ShadeMap" },
];

function profileLabel(id: LinkProfileId): string {
  return id[0].toUpperCase() + id.slice(1);
}

function updateProfile(
  profiles: LinkProfile[],
  id: LinkProfileId,
  patch: Partial<LinkProfile>,
): LinkProfile[] {
  return profiles.map((profile) => (profile.id === id ? { ...profile, ...patch } : profile));
}

export function App() {
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const layerRef = useRef<LosCoverageLayer | null>(null);
  const mapNodeRef = useRef<HTMLDivElement | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisRequest>(defaultAnalysis);
  const [debugMode, setDebugMode] = useState<DebugMode>("combined");
  const [inspector, setInspector] = useState<CoveragePixel | null>(null);
  const analysisRef = useRef(analysis);
  const hasToken = Boolean(token && token !== "pk.your_mapbox_token_here");

  const activeProfiles = useMemo(
    () => analysis.profiles.filter((profile) => analysis.selectedProfileIds.includes(profile.id)),
    [analysis.profiles, analysis.selectedProfileIds],
  );

  useEffect(() => {
    if (!mapNodeRef.current || !hasToken) return;
    mapboxgl.accessToken = token!;
    const map = new mapboxgl.Map({
      container: mapNodeRef.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [analysis.operator.lng, analysis.operator.lat],
      zoom: 13.5,
      pitch: 0,
      bearing: 0,
      antialias: true,
    });
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
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

    map.on("click", (event) => {
      if (event.originalEvent.shiftKey) {
        markerRef.current?.setLngLat(event.lngLat);
        setAnalysis((current) => ({
          ...current,
          operator: { ...current.operator, lng: event.lngLat.lng, lat: event.lngLat.lat },
        }));
        return;
      }
      setInspector(inspectFlatEarthPixel(analysisRef.current, event.lngLat));
    });

    map.on("load", () => {
      const layer = new LosCoverageLayer(analysis, debugMode);
      layerRef.current = layer;
      map.addLayer(layer);
      map.on("moveend", () => layer.refreshSources());
      map.on("sourcedata", () => {
        if (map.isSourceLoaded("mapbox-dem")) {
          layer.refreshSources();
        }
      });
    });

    return () => {
      layerRef.current = null;
      markerRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
  }, [hasToken]);

  useEffect(() => {
    analysisRef.current = analysis;
    markerRef.current?.setLngLat([analysis.operator.lng, analysis.operator.lat]);
    layerRef.current?.setOperator(analysis.operator);
    layerRef.current?.setProfiles(analysis.profiles, analysis.selectedProfileIds);
    layerRef.current?.setAnalysisArea({
      radiusM: analysis.radiusM,
      gridResolutionM: analysis.gridResolutionM,
      altitude: analysis.altitude,
    });
  }, [analysis]);

  useEffect(() => {
    layerRef.current?.setDebugMode(debugMode);
  }, [debugMode]);

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
          <span>LOS Range</span>
          <button type="button" title="Refresh sources" onClick={() => layerRef.current?.refreshSources()}>
            <RefreshCw size={16} />
          </button>
        </div>

        <label>
          LOS radius
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
        </label>

        <div className="grid-three">
          <label>
            Min alt
            <input
              type="number"
              value={analysis.altitude.minM}
              onChange={(event) => setAltitude("minM", Number(event.target.value))}
            />
          </label>
          <label>
            Max alt
            <input
              type="number"
              value={analysis.altitude.maxM}
              onChange={(event) => setAltitude("maxM", Number(event.target.value))}
            />
          </label>
          <label>
            Step
            <input
              type="number"
              value={analysis.altitude.stepM}
              onChange={(event) => setAltitude("stepM", Number(event.target.value))}
            />
          </label>
        </div>

        <label>
          Grid resolution
          <input
            type="range"
            min="5"
            max="100"
            step="5"
            value={analysis.gridResolutionM}
            onChange={(event) => setNumber("gridResolutionM", Number(event.target.value))}
          />
          <output>{analysis.gridResolutionM} m</output>
        </label>

        <div className="segmented" role="tablist" aria-label="Coverage mode">
          {debugModes.map((mode) => (
            <button
              key={mode.id}
              type="button"
              className={debugMode === mode.id ? "active" : ""}
              onClick={() => setDebugMode(mode.id)}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </aside>

      <aside className="profiles" aria-label="RF profiles">
        <div className="panel-title">
          <Radio size={18} />
          <span>RF Profiles</span>
          <small>{activeProfiles.length} active</small>
        </div>
        {analysis.profiles.map((profile) => (
          <section className="profile-card" key={profile.id}>
            <label className="check-row">
              <input
                type="checkbox"
                checked={analysis.selectedProfileIds.includes(profile.id)}
                onChange={() => toggleProfile(profile.id)}
              />
              <strong>{profileLabel(profile.id)}</strong>
            </label>
            <div className="profile-grid">
              <label>
                MHz
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
              </label>
              <label>
                TX dBm
                <input
                  type="number"
                  value={profile.txPowerDbm}
                  onChange={(event) =>
                    setAnalysis((current) => ({
                      ...current,
                      profiles: updateProfile(current.profiles, profile.id, {
                        txPowerDbm: Number(event.target.value),
                      }),
                    }))
                  }
                />
              </label>
              <label>
                Sens.
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
              </label>
              <label>
                Margin
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
              </label>
            </div>
          </section>
        ))}
      </aside>

      {inspector && (
        <aside className="inspector">
          <div className="panel-title">
            <Activity size={18} />
            <span>Inspector</span>
            <button type="button" title="Close inspector" onClick={() => setInspector(null)}>
              x
            </button>
          </div>
          <dl>
            <dt>Reachable</dt>
            <dd>{inspector.reachable ? "Yes" : "No"}</dd>
            <dt>Required altitude</dt>
            <dd>{inspector.requiredAltitudeM.toFixed(1)} m</dd>
            <dt>Combined margin</dt>
            <dd>{inspector.marginDb.toFixed(1)} dB</dd>
            <dt>Distance</dt>
            <dd>{inspector.debugValue.toFixed(0)} m</dd>
          </dl>
        </aside>
      )}

      <div className="hint">
        <Layers size={14} />
        <span>Drag marker or Shift-click to place operator. Click coverage for inspection.</span>
      </div>
    </main>
  );
}
