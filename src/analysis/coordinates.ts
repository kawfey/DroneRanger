export type WebMercator = {
  x: number;
  y: number;
};

const earthCircumferenceM = 40075016.68557849;

export function lngLatToMercator01(lng: number, lat: number): WebMercator {
  const x = (lng + 180) / 360;
  const limitedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const sin = Math.sin((limitedLat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  return { x, y };
}

export function metersToMercatorUnits(meters: number, lat: number): number {
  return meters / (earthCircumferenceM * Math.cos((lat * Math.PI) / 180));
}

export function haversineDistanceM(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const r = 6371008.8;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}
