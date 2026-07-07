import type { AnalysisRequest, LinkProfile } from "../types";

export const defaultProfiles: LinkProfile[] = [
  {
    id: "control",
    direction: "operator-to-drone",
    frequencyMHz: 2450,
    txPowerDbm: 10 * Math.log10(250),
    txGainDbi: 3.8,
    txLossDb: 0,
    rxGainDbi: 1.2,
    rxLossDb: 0,
    rxSensitivityDbm: -112,
    requiredMarginDb: 10,
  },
  {
    id: "telemetry",
    direction: "drone-to-operator",
    frequencyMHz: 2450,
    txPowerDbm: 20,
    txGainDbi: 1.2,
    txLossDb: 0,
    rxGainDbi: 3.8,
    rxLossDb: 0,
    rxSensitivityDbm: -112,
    requiredMarginDb: 10,
  },
  {
    id: "video",
    direction: "drone-to-operator",
    frequencyMHz: 5800,
    txPowerDbm: 10 * Math.log10(125),
    txGainDbi: 2,
    txLossDb: 0,
    rxGainDbi: 2,
    rxLossDb: 0,
    rxSensitivityDbm: -100,
    requiredMarginDb: 10,
  },
];

export const defaultAnalysis: AnalysisRequest = {
  operator: {
    lng: -3.7038,
    lat: 40.4168,
    antennaHeightM: 1.5,
  },
  radiusM: 2500,
  gridSizePx: 100,
  calculationRange: {
    mode: "auto",
    manualM: 5000,
  },
  altitudeCriterion: "elevation-change",
  colorSteps: 20,
  altitude: {
    minM: 0,
    maxM: 120,
  },
  profiles: defaultProfiles,
  selectedProfileIds: ["control", "telemetry", "video"],
  includeBuildings: false,
  includeVegetation: false,
  vegetation: {
    minCanopyHeightM: 1.0,
  },
};
