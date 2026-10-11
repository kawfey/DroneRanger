export type LinkProfileId = "control" | "telemetry" | "video";

export type LinkDirection = "operator-to-drone" | "drone-to-operator";

export type LinkProfile = {
  id: LinkProfileId;
  direction: LinkDirection;
  frequencyMHz: number;
  txPowerDbm: number;
  txGainDbi: number;
  txLossDb: number;
  rxGainDbi: number;
  rxLossDb: number;
  rxSensitivityDbm: number;
  requiredMarginDb: number;
};

export type CalculationRange =
  | {
      mode: "auto";
      manualM: number;
    }
  | {
      mode: "manual";
      manualM: number;
    };

export type PropagationSettings = {
  /** Effective earth radius factor k (4/3 = standard atmosphere). null disables curvature (flat vertical profile). */
  effectiveEarthRadiusK: number | null;
};

export type AnalysisRequest = {
  operator: {
    lng: number;
    lat: number;
    antennaHeightM: number;
  };
  propagation: PropagationSettings;
  radiusM: number;
  gridSizePx: number;
  calculationRange: CalculationRange;
  altitudeCriterion: "elevation-change" | "agl";
  colorSteps: number;
  altitude: {
    minM: number;
    maxM: number;
  };
  profiles: LinkProfile[];
  selectedProfileIds: LinkProfileId[];
  includeBuildings: boolean;
  includeVegetation: boolean;
  vegetation: {
    minCanopyHeightM: number;
  };
};

export type DebugMode =
  | "combined"
  | "control"
  | "telemetry"
  | "video"
  | "los"
  | "blocker"
  | "height-map";

export type CoverageEngine = "gpu" | "cpu-fallback";

export type CoverageCoordinates = [[number, number], [number, number], [number, number], [number, number]];

export type CoverageOverlay = {
  canvas: HTMLCanvasElement;
  coordinates: CoverageCoordinates;
  gridSizePx: number;
  engine: CoverageEngine;
  renderedOperator: AnalysisRequest["operator"];
  timings?: CoverageTimings;
};

export type CoverageTimings = {
  totalMs: number;
  actionToOverlayMs?: number;
  updateAnalysisMs?: number;
  renderMs?: number;
  demBuildMs?: number;
  buildingBuildMs?: number;
  buildingFetchParseMs?: number;
  buildingRasterizeMs?: number;
  combineMs?: number;
  demUploadMs?: number;
  overlayApplyMs?: number;
  displayCopyMs?: number;
  mapSourceUpdateMs?: number;
  fingerprintMs?: number;
  cpuSolveMs?: number;
  cpuShadeMs?: number;
  gpuDrawMs?: number;
  gpuReadbackMs?: number;
};

export type CoverageGridData = {
  coordinates: CoverageCoordinates;
  gridSizePx: number;
  engine: CoverageEngine;
  renderedOperator: AnalysisRequest["operator"];
  requiredAltitudeM: Float32Array;
  requiredAltitudeAglM: Float32Array;
  reachable: Uint8Array;
};

export type CoveragePixel = {
  requiredAltitudeM: number;
  requiredElevationChangeM: number;
  minDroneAltitudeAglM: number;
  operatorAltitudeAslM: number;
  violationCriteria: string;
  reachable: boolean;
  combinedMarginDb: number;
  modeMarginDb: number | null;
  profileMask: number;
  debugValue: number;
  /** Earth-curvature bulge at the sample that limits the required altitude; 0 when no sample limits. */
  earthBulgeAtLimitM: number;
  /** First Fresnel zone radius at the limiting sample for the lowest active frequency; null outside RF modes. */
  fresnelRadiusAtLimitM: number | null;
  /** Diagnostic only: altitude that would keep 0.6·F1 clearance along the whole path. */
  fresnelClearElevationChangeM: number | null;
  fresnelClearAglM: number | null;
};
