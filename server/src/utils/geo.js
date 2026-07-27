// geo.js — حساب المسافة بين نقطتين جغرافيتين باستخدام معادلة Haversine

const EARTH_RADIUS_METERS = 6371000;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * يرجع المسافة بالأمتار بين نقطتين (lat1,lon1) و(lat2,lon2)
 */
function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/**
 * يتحقق مما إذا كانت نقطة الموظف ضمن نطاق الفرع (geofence)
 * branch: { latitude, longitude, geofence_radius_meters }
 */
function isWithinGeofence(branch, employeeLat, employeeLon, defaultRadius = 150) {
  if (
    typeof employeeLat !== 'number' ||
    typeof employeeLon !== 'number' ||
    Number.isNaN(employeeLat) ||
    Number.isNaN(employeeLon)
  ) {
    return { withinFence: false, distanceMeters: null, reason: 'INVALID_COORDINATES' };
  }

  const radius = branch.geofence_radius_meters || defaultRadius;
  const distance = haversineDistanceMeters(
    Number(branch.latitude),
    Number(branch.longitude),
    employeeLat,
    employeeLon
  );

  return {
    withinFence: distance <= radius,
    distanceMeters: Math.round(distance),
    allowedRadiusMeters: radius,
  };
}

module.exports = { haversineDistanceMeters, isWithinGeofence };
