import { describe, expect, it, vi } from "vitest";
import { defaultAnalysis } from "./analysis/defaults";
import { beginOperatorMove, hideStaleCoverage, installAnalysisLayers, renderCoverageImage } from "./App";
import type { AnalysisRequest } from "./types";

function createCanvas(): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({
      imageSmoothingEnabled: false,
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: vi.fn(),
    })),
  } as unknown as HTMLCanvasElement;
}

describe("terrain-backed coverage", () => {
  it("keeps Mapbox terrain enabled for queryTerrainElevation", () => {
    const addedSources: Record<string, unknown> = {};
    const setTerrain = vi.fn();
    const map = {
      getSource: vi.fn((id: string) => addedSources[id]),
      addSource: vi.fn((id: string, source: unknown) => {
        addedSources[id] = source;
      }),
      setTerrain,
      getLayer: vi.fn(() => undefined),
      addLayer: vi.fn(),
    };

    installAnalysisLayers(map as never, defaultAnalysis, "combined");

    expect(map.addSource).toHaveBeenCalledWith(
      "mapbox-dem",
      expect.objectContaining({ type: "raster-dem" }),
    );
    expect(setTerrain).toHaveBeenCalledWith({ source: "mapbox-dem", exaggeration: 1 });
    expect(setTerrain).not.toHaveBeenCalledWith(null);
  });

  it("CPU coverage rendering uses terrain elevations from the sampler", () => {
    const analysis: AnalysisRequest = {
      ...defaultAnalysis,
      gridSizePx: 25,
      radiusM: 3000,
      altitude: {
        ...defaultAnalysis.altitude,
        maxM: 40,
      },
      calculationRange: {
        mode: "manual",
        manualM: 3000,
      },
    };
    let terrainQueries = 0;
    const terrainMap = {
      queryTerrainElevation: vi.fn((lngLat: { lng: number }) => {
        terrainQueries++;
        return lngLat.lng > analysis.operator.lng ? 500 : 0;
      }),
    };

    const overlay = renderCoverageImage(
      terrainMap as never,
      analysis,
      "los",
      createCanvas(),
    );

    expect(terrainQueries).toBeGreaterThan(analysis.gridSizePx * analysis.gridSizePx);
    expect(overlay.engine).toBe("cpu-fallback");
  });

  it("hides stale coverage while an operator move is recalculating", () => {
    const setPaintProperty = vi.fn();
    const map = {
      getLayer: vi.fn((id: string) => (id === "los-coverage" ? {} : undefined)),
      setPaintProperty,
    };

    hideStaleCoverage(map as never);

    expect(setPaintProperty).toHaveBeenCalledWith("los-coverage", "raster-opacity", 0);
  });

  it("updates the reference circle immediately when an operator move starts", () => {
    const setData = vi.fn();
    const setPaintProperty = vi.fn();
    const map = {
      getSource: vi.fn((id: string) => (id === "reference-radius" ? { setData } : undefined)),
      getLayer: vi.fn((id: string) => (id === "los-coverage" ? {} : undefined)),
      setPaintProperty,
    };
    const movedAnalysis: AnalysisRequest = {
      ...defaultAnalysis,
      operator: {
        ...defaultAnalysis.operator,
        lng: defaultAnalysis.operator.lng + 0.02,
        lat: defaultAnalysis.operator.lat + 0.01,
      },
    };

    beginOperatorMove(map as never, movedAnalysis);

    expect(setData).toHaveBeenCalledTimes(1);
    expect(setData.mock.calls[0]?.[0].geometry.coordinates[0][0]).not.toEqual(
      defaultAnalysis.operator.lng,
    );
    expect(setPaintProperty).toHaveBeenCalledWith("los-coverage", "raster-opacity", 0);
  });
});
