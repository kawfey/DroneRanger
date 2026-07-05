import type { AnalysisRequest, LinkProfile } from "../types";

export const defaultProfiles: LinkProfile[] = [
  {
    id: "control",
    direction: "operator-to-drone",
    frequencyMHz: 2400,
    txPowerDbm: 26,
    txGainDbi: 3,
    txLossDb: 1,
    rxGainDbi: 2,
    rxLossDb: 1,
    rxSensitivityDbm: -96,
    requiredMarginDb: 6,
  },
  {
    id: "telemetry",
    direction: "drone-to-operator",
    frequencyMHz: 915,
    txPowerDbm: 20,
    txGainDbi: 2,
    txLossDb: 0.5,
    rxGainDbi: 4,
    rxLossDb: 1,
    rxSensitivityDbm: -108,
    requiredMarginDb: 10,
  },
  {
    id: "video",
    direction: "drone-to-operator",
    frequencyMHz: 5800,
    txPowerDbm: 23,
    txGainDbi: 2,
    txLossDb: 1,
    rxGainDbi: 8,
    rxLossDb: 1.5,
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
  gridResolutionM: 20,
  altitude: {
    minM: 0,
    maxM: 120,
    stepM: 5,
  },
  profiles: defaultProfiles,
  selectedProfileIds: ["control", "telemetry", "video"],
};
