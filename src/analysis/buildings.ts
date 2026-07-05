export type BuildingLike = {
  properties?: Record<string, unknown> | null;
};

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function buildingHeightM(feature: BuildingLike): number {
  const props = feature.properties ?? {};
  const height = numeric(props.height);
  if (height !== null && height > 0) {
    return height;
  }
  const renderHeight = numeric(props.render_height);
  if (renderHeight !== null && renderHeight > 0) {
    return renderHeight;
  }
  const levels = numeric(props["building:levels"]);
  if (levels !== null && levels > 0) {
    return levels * 3.1;
  }
  return 3.1;
}
