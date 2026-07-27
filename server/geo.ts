/**
 * أدوات حساب المسافات الجغرافية.
 */

const EARTH_RADIUS_METERS = 6_371_008.8;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/**
 * معادلة Haversine — تُعيد المسافة بين نقطتين على سطح الأرض بالأمتار.
 */
export function haversineDistanceMeters(a: Coordinates, b: Coordinates): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** يتحقق من أن الإحداثي رقم صالح داخل المدى المسموح. */
export function isValidCoordinates(value: unknown): value is Coordinates {
  if (typeof value !== "object" || value === null) return false;
  const { latitude, longitude } = value as Record<string, unknown>;
  return (
    typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    typeof longitude === "number" &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180
  );
}
