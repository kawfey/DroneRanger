export function combineObstacleElevations(
  terrainM: Float32Array,
  buildingHeightM: Float32Array | null | undefined,
  canopyHeightM: Float32Array | null | undefined,
  minCanopyHeightM: number,
): Float32Array {
  const output = new Float32Array(terrainM.length);
  for (let index = 0; index < terrainM.length; index++) {
    const buildingM = buildingHeightM?.[index] ?? 0;
    const rawCanopyM = canopyHeightM?.[index] ?? 0;
    const canopyM = rawCanopyM >= minCanopyHeightM ? rawCanopyM : 0;
    output[index] = (terrainM[index] ?? 0) + Math.max(buildingM, canopyM);
  }
  return output;
}
