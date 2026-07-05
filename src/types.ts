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

export type AnalysisRequest = {
  operator: {
    lng: number;
    lat: number;
    antennaHeightM: number;
  };
  radiusM: number;
  gridResolutionM: number;
  calculationRange: CalculationRange;
  altitude: {
    minM: number;
    maxM: number;
    stepM: number;
  };
  profiles: LinkProfile[];
  selectedProfileIds: LinkProfileId[];
};

export type DebugMode =
  | "combined"
  | "control"
  | "telemetry"
  | "video"
  | "los"
  | "blocker"
  | "shademap";

export type CoveragePixel = {
  requiredAltitudeM: number;
  requiredElevationChangeM: number;
  operatorAltitudeAslM: number;
  reachable: boolean;
  combinedMarginDb: number;
  modeMarginDb: number | null;
  profileMask: number;
  debugValue: number;
};
