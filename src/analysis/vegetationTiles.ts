import { fromUrl } from "geotiff";
import { coveringDemTiles, mercatorToTextureUv, type DemTileId, type MercatorBounds } from "./demTiles";
import type { WebMercator } from "./coordinates";

export type VegetationHeightField = {
  width: number;
  height: number;
  bounds: MercatorBounds;
  canopyHeightsM: Float32Array;
  zoom: number;
  tileCount: number;
  urls: string[];
  failedTileCount: number;
  failedUrls: string[];
};

type DecodedVegetationTile = {
  width: number;
  height: number;
  canopyHeightsM: Float32Array;
};

type VegetationTileLoaderOptions = {
  loadTile?: (tile: DemTileId, url: string) => Promise<DecodedVegetationTile>;
  onWarning?: (message: string) => void;
};

type FastRemoteSourceOptions = Parameters<typeof fromUrl>[1] & {
  blockSize: number;
  cacheSize: number;
  maxRanges: number;
};

export const metaChmZoom = 10;
export const maxVegetationTiles = 64;
export const metaChmBaseUrl = "https://data.source.coop/tge-labs/meta-chm-v2/chm";
const preferredOverviewImageIndex = 7;
const remoteCogBlockSizeBytes = 256 * 1024;

export class VegetationHeightTileLoader {
  private readonly tileCache = new Map<string, Promise<DecodedVegetationTile>>();

  constructor(private readonly options: VegetationTileLoaderOptions = {}) {}

  async buildHeightField(bounds: MercatorBounds, width: number, height: number): Promise<VegetationHeightField> {
    const tileIds = coveringVegetationTiles(bounds);
    if (tileIds.length > maxVegetationTiles) {
      throw new Error(`Vegetation analysis skipped because it intersects ${tileIds.length} CHM tiles`);
    }
    const tileResults = await Promise.all(
      tileIds.map(async (tile) => {
        const url = metaChmTileUrl(tile);
        try {
          return { tile, url, decoded: await this.loadTile(tile) };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return { tile, url, decoded: null, error: detail };
        }
      }),
    );
    const urls = tileResults.map((result) => result.url);
    const failedUrls = tileResults.filter((result) => !result.decoded).map((result) => result.url);
    if (failedUrls.length > 0) {
      const sampleUrl = failedUrls[0] ? ` First failed URL: ${failedUrls[0]}` : "";
      this.options.onWarning?.(
        `Vegetation CHM unavailable for ${failedUrls.length} of ${tileIds.length} tile${tileIds.length === 1 ? "" : "s"}; continuing with available canopy data.${sampleUrl}`,
      );
    }
    const canopyHeightsM = new Float32Array(width * height);
    const scale = 2 ** metaChmZoom;

    for (let y = 0; y < height; y++) {
      const mercatorY = bounds.north + ((y + 0.5) / height) * (bounds.south - bounds.north);
      for (let x = 0; x < width; x++) {
        const mercatorX = bounds.west + ((x + 0.5) / width) * (bounds.east - bounds.west);
        const tileX = Math.max(0, Math.min(scale - 1, Math.floor(mercatorX * scale)));
        const tileY = Math.max(0, Math.min(scale - 1, Math.floor(mercatorY * scale)));
        const tileResult = tileResults.find((result) => result.tile.x === tileX && result.tile.y === tileY);
        const tile = tileResult?.decoded;
        if (!tile) {
          continue;
        }
        const localX = (mercatorX * scale - tileX) * tile.width - 0.5;
        const localY = (mercatorY * scale - tileY) * tile.height - 0.5;
        canopyHeightsM[y * width + x] = sampleDecodedTile(tile, localX, localY);
      }
    }

    return {
      width,
      height,
      bounds,
      canopyHeightsM,
      zoom: metaChmZoom,
      tileCount: tileIds.length,
      urls,
      failedTileCount: failedUrls.length,
      failedUrls,
    };
  }

  private loadTile(tile: DemTileId): Promise<DecodedVegetationTile> {
    const key = tileKey(tile);
    const cached = this.tileCache.get(key);
    if (cached) {
      return cached;
    }
    const url = metaChmTileUrl(tile);
    const promise = (this.options.loadTile ? this.options.loadTile(tile, url) : loadMetaChmTile(url)).catch((error) => {
      this.tileCache.delete(key);
      throw error;
    });
    this.tileCache.set(key, promise);
    return promise;
  }
}

export function coveringVegetationTiles(bounds: MercatorBounds): DemTileId[] {
  return coveringDemTiles(bounds, metaChmZoom);
}

export function metaChmTileUrl(tile: DemTileId): string {
  return `${metaChmBaseUrl}/${tileToQuadkey(tile)}.tif`;
}

export function sampleVegetationHeightField(field: VegetationHeightField, point: WebMercator): number {
  const uv = mercatorToTextureUv(point, field.bounds);
  const x = Math.max(0, Math.min(field.width - 1, Math.floor(uv.u * field.width)));
  const y = Math.max(0, Math.min(field.height - 1, Math.floor(uv.v * field.height)));
  return field.canopyHeightsM[y * field.width + x] ?? 0;
}

export function tileToQuadkey(tile: DemTileId): string {
  let quadkey = "";
  for (let bit = tile.z; bit > 0; bit--) {
    let digit = 0;
    const mask = 1 << (bit - 1);
    if ((tile.x & mask) !== 0) digit += 1;
    if ((tile.y & mask) !== 0) digit += 2;
    quadkey += String(digit);
  }
  return quadkey;
}

async function loadMetaChmTile(url: string): Promise<DecodedVegetationTile> {
  const fastRemoteOptions: FastRemoteSourceOptions = {
    blockSize: remoteCogBlockSizeBytes,
    cacheSize: 50,
    maxRanges: 16,
  };
  const tiff = await fromUrl(url, fastRemoteOptions);
  const image = await preferredReadableImage(tiff);
  const width = image.getWidth();
  const height = image.getHeight();
  const raster = await image.readRasters({ samples: [0], interleave: true });
  return {
    width,
    height,
    canopyHeightsM: new Float32Array(raster as ArrayLike<number>),
  };
}

async function preferredReadableImage(tiff: Awaited<ReturnType<typeof fromUrl>>) {
  try {
    const image = await tiff.getImage(preferredOverviewImageIndex);
    if (image.getWidth() <= 1024 && image.getHeight() <= 1024) {
      return image;
    }
  } catch {
    // Fall back to scanning below for non-standard COG layouts.
  }

  const imageCount = await tiff.getImageCount();
  let best = await tiff.getImage(0);
  for (let index = 1; index < imageCount; index++) {
    const image = await tiff.getImage(index);
    if (image.getWidth() * image.getHeight() < best.getWidth() * best.getHeight()) {
      best = image;
    }
  }
  return best;
}

function tileKey(tile: DemTileId): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

function sampleDecodedTile(tile: DecodedVegetationTile, x: number, y: number): number {
  const clampedX = Math.max(0, Math.min(tile.width - 1, x));
  const clampedY = Math.max(0, Math.min(tile.height - 1, y));
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(tile.width - 1, x0 + 1);
  const y1 = Math.min(tile.height - 1, y0 + 1);
  const tx = clampedX - x0;
  const ty = clampedY - y0;
  const h00 = tile.canopyHeightsM[y0 * tile.width + x0] ?? 0;
  const h10 = tile.canopyHeightsM[y0 * tile.width + x1] ?? h00;
  const h01 = tile.canopyHeightsM[y1 * tile.width + x0] ?? h00;
  const h11 = tile.canopyHeightsM[y1 * tile.width + x1] ?? h10;
  const top = h00 + (h10 - h00) * tx;
  const bottom = h01 + (h11 - h01) * tx;
  return top + (bottom - top) * ty;
}
