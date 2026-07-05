import type mapboxgl from "mapbox-gl";

export type TerrainSource = {
  id: string;
  refresh(map: mapboxgl.Map): void;
  dispose(): void;
};

export type ObstacleSource = {
  id: string;
  enabled: boolean;
  refresh(map: mapboxgl.Map): void;
  dispose(): void;
};

export class MapboxTerrainSource implements TerrainSource {
  readonly id = "mapbox-terrain-dem";

  refresh(map: mapboxgl.Map): void {
    if (!map.getSource("mapbox-dem")) {
      map.addSource("mapbox-dem", {
        type: "raster-dem",
        url: "mapbox://mapbox.mapbox-terrain-dem-v1",
        tileSize: 512,
        maxzoom: 14,
      });
      map.setTerrain({ source: "mapbox-dem", exaggeration: 1 });
    }
  }

  dispose(): void {}
}

export class MapboxBuildingObstacleSource implements ObstacleSource {
  readonly id = "mapbox-buildings";
  enabled = true;

  refresh(map: mapboxgl.Map): void {
    const style = map.getStyle();
    const composite = Object.keys(style.sources ?? {}).find((id) => id === "composite");
    if (!composite || map.getLayer("los-building-reference")) {
      return;
    }
    map.addLayer({
      id: "los-building-reference",
      type: "fill-extrusion",
      source: composite,
      "source-layer": "building",
      paint: {
        "fill-extrusion-color": "rgba(0,0,0,0)",
        "fill-extrusion-height": [
          "coalesce",
          ["get", "height"],
          ["get", "render_height"],
          ["*", ["coalesce", ["get", "building:levels"], 1], 3.1],
        ],
        "fill-extrusion-opacity": 0,
      },
    });
  }

  dispose(): void {}
}

export class DisabledCanopyObstacleSource implements ObstacleSource {
  readonly id = "tree-canopy";
  enabled = false;
  refresh(): void {}
  dispose(): void {}
}
