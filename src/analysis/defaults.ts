import type { AnalysisRequest, LinkProfile } from "../types";

export const defaultProfiles: LinkProfile[] = [
  {
    id: "control",
    direction: "operator-to-drone",
    frequencyMHz: 2400,
    txPowerDbm: 26,
    txGainDbi: 3,
    txLossDb: 0,
    rxGainDbi: 3,
    rxLossDb: 0,
    rxSensitivityDbm: -96,
    requiredMarginDb: 6,
  },
  {
    id: "telemetry",
    direction: "drone-to-operator",
    frequencyMHz: 915,
    txPowerDbm: 20,
    txGainDbi: 3,
    txLossDb: 0,
    rxGainDbi: 3,
    rxLossDb: 0,
    rxSensitivityDbm: -108,
    requiredMarginDb: 10,
  },
  {
    id: "video",
    direction: "drone-to-operator",
    frequencyMHz: 5800,
    txPowerDbm: 23,
    txGainDbi: 3,
    txLossDb: 0,
    rxGainDbi: 3,
    rxLossDb: 0,
    rxSensitivityDbm: -86,
    requiredMarginDb: 8,
  },
];

export const defaultAnalysis: AnalysisRequest = {
  operator: {
    lng: -3.7038,
    lat: 40.4168,
    antennaHeightM: 2,
  },
  radiusM: 2500,
  gridResolutionM: 75,
  calculationRange: {
    mode: "auto",
    manualM: 5000,
  },
  altitude: {
    minM: 0,
    maxM: 120,
    stepM: 5,
  },
  profiles: defaultProfiles,
  selectedProfileIds: ["control", "telemetry", "video"],
};
