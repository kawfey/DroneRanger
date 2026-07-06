import {
  coveringDemTiles,
  mapboxTerrainRgbElevationM,
  type DemTileId,
  type MercatorBounds,
} from "./demTiles";
import type { HeightField } from "./coverageGrid";

type DecodedTerrainTile = {
  width: number;
  height: number;
  elevations: Float32Array;
};

export type TerrainHeightField = HeightField & {
  zoom: number;
  tileCount: number;
};

export class TerrainHeightTileLoader {
  private readonly tileCache = new Map<string, Promise<DecodedTerrainTile>>();

  constructor(private readonly mapboxToken: string) {}

  async buildHeightField(bounds: MercatorBounds, zoom: number, texturePx: number): Promise<TerrainHeightField> {
    const tileIds = coveringDemTiles(bounds, zoom);
    const tiles = await Promise.all(tileIds.map((tile) => this.loadTile(tile)));
    const elevations = new Float32Array(texturePx * texturePx);
    const scale = 2 ** zoom;

    for (let y = 0; y < texturePx; y++) {
      const mercatorY = bounds.north + ((y + 0.5) / texturePx) * (bounds.south - bounds.north);
      for (let x = 0; x < texturePx; x++) {
        const mercatorX = bounds.west + ((x + 0.5) / texturePx) * (bounds.east - bounds.west);
        const tileX = Math.max(0, Math.min(scale - 1, Math.floor(mercatorX * scale)));
        const tileY = Math.max(0, Math.min(scale - 1, Math.floor(mercatorY * scale)));
        const tileIndex = tileIds.findIndex((tile) => tile.x === tileX && tile.y === tileY);
        const tile = tiles[tileIndex];
        if (!tile) {
          elevations[y * texturePx + x] = 0;
          continue;
        }
        const localX = (mercatorX * scale - tileX) * tile.width - 0.5;
        const localY = (mercatorY * scale - tileY) * tile.height - 0.5;
        elevations[y * texturePx + x] = sampleDecodedTile(tile, localX, localY);
      }
    }

    return {
      width: texturePx,
      height: texturePx,
      bounds,
      elevations,
      zoom,
      tileCount: tileIds.length,
    };
  }

  private loadTile(tile: DemTileId): Promise<DecodedTerrainTile> {
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    const cached = this.tileCache.get(key);
    if (cached) {
      return cached;
    }
    const promise = loadTerrainTile(tile, this.mapboxToken);
    this.tileCache.set(key, promise);
    return promise;
  }
}

async function loadTerrainTile(tile: DemTileId, token: string): Promise<DecodedTerrainTile> {
  const image = await loadImage(
    `https://api.mapbox.com/v4/mapbox.terrain-rgb/${tile.z}/${tile.x}/${tile.y}.pngraw?access_token=${encodeURIComponent(token)}`,
  );
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Unable to decode DEM tile");
  }
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const elevations = new Float32Array(canvas.width * canvas.height);
  for (let index = 0; index < elevations.length; index++) {
    elevations[index] = mapboxTerrainRgbElevationM(pixels[index * 4], pixels[index * 4 + 1], pixels[index * 4 + 2]);
  }
  return {
    width: canvas.width,
    height: canvas.height,
    elevations,
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Unable to load DEM tile: ${url}`));
    image.src = url;
  });
}

function sampleDecodedTile(tile: DecodedTerrainTile, x: number, y: number): number {
  const clampedX = Math.max(0, Math.min(tile.width - 1, x));
  const clampedY = Math.max(0, Math.min(tile.height - 1, y));
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(tile.width - 1, x0 + 1);
  const y1 = Math.min(tile.height - 1, y0 + 1);
  const tx = clampedX - x0;
  const ty = clampedY - y0;
  const h00 = tile.elevations[y0 * tile.width + x0] ?? 0;
  const h10 = tile.elevations[y0 * tile.width + x1] ?? h00;
  const h01 = tile.elevations[y1 * tile.width + x0] ?? h00;
  const h11 = tile.elevations[y1 * tile.width + x1] ?? h10;
  const top = h00 + (h10 - h00) * tx;
  const bottom = h01 + (h11 - h01) * tx;
  return top + (bottom - top) * ty;
}
