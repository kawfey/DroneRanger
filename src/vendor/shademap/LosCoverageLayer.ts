import type mapboxgl from "mapbox-gl";
import { CoverageRenderer } from "./CoverageRenderer";
import {
  DisabledCanopyObstacleSource,
  MapboxBuildingObstacleSource,
  MapboxTerrainSource,
  type ObstacleSource,
  type TerrainSource,
} from "./sources";
import type { AnalysisRequest, DebugMode, LinkProfile } from "../../types";

export class LosCoverageLayer implements mapboxgl.CustomLayerInterface {
  readonly id = "los-coverage-layer";
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private map: mapboxgl.Map | null = null;
  private renderer: CoverageRenderer | null = null;
  private repaintTimer: number | null = null;
  private terrain: TerrainSource = new MapboxTerrainSource();
  private obstacles: ObstacleSource[] = [
    new MapboxBuildingObstacleSource(),
    new DisabledCanopyObstacleSource(),
  ];

  constructor(
    private request: AnalysisRequest,
    private debugMode: DebugMode = "combined",
  ) {}

  onAdd(map: mapboxgl.Map, gl: WebGLRenderingContext): void {
    this.map = map;
    this.terrain.refresh(map);
    this.obstacles.forEach((source) => source.refresh(map));
    this.renderer = new CoverageRenderer(gl as WebGL2RenderingContext);
  }

  render(_gl: WebGLRenderingContext, matrix: number[]): void {
    if (!this.map) return;
    this.renderer?.render(this.map, this.request, this.debugMode, matrix);
  }

  setRequest(request: AnalysisRequest): void {
    this.request = request;
    this.invalidate();
  }

  setOperator(operator: AnalysisRequest["operator"]): void {
    this.request = { ...this.request, operator };
    this.invalidate();
  }

  setProfiles(profiles: LinkProfile[], selectedProfileIds = this.request.selectedProfileIds): void {
    this.request = { ...this.request, profiles, selectedProfileIds };
    this.invalidate();
  }

  setAnalysisArea(
    area: Pick<AnalysisRequest, "radiusM" | "gridResolutionM" | "calculationRange" | "altitude">,
  ): void {
    this.request = { ...this.request, ...area };
    this.invalidate();
  }

  setDebugMode(debugMode: DebugMode): void {
    this.debugMode = debugMode;
    this.invalidate();
  }

  refreshSources(): void {
    if (!this.map) return;
    this.terrain.refresh(this.map);
    this.obstacles.forEach((source) => source.refresh(this.map!));
    this.invalidate();
  }

  onRemove(): void {
    this.renderer?.dispose();
    if (this.repaintTimer !== null) {
      window.clearTimeout(this.repaintTimer);
    }
    this.terrain.dispose();
    this.obstacles.forEach((source) => source.dispose());
    this.renderer = null;
    this.map = null;
  }

  private invalidate(): void {
    this.renderer?.markDirty();
    this.map?.triggerRepaint();
    if (this.repaintTimer !== null) {
      window.clearTimeout(this.repaintTimer);
    }
    this.repaintTimer = window.setTimeout(() => {
      this.repaintTimer = null;
      this.map?.triggerRepaint();
    }, 140);
  }

  remove(): void {
    if (this.map?.getLayer(this.id)) {
      this.map.removeLayer(this.id);
    } else {
      this.onRemove();
    }
  }
}
