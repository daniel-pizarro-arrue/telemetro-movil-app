/**
 * geoMath.js - Módulo de cálculos geodésicos y balísticos tácticos
 * Compatible con Node.js (CommonJS) y Navegadores (ES Module / Window)
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GeoMath = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EARTH_RADIUS_METERS = 6378137.0; // Radio ecuatorial WGS84

  /**
   * Convierte grados a radianes
   */
  function toRad(deg) {
    return (deg * Math.PI) / 180.0;
  }

  /**
   * Convierte radianes a grados
   */
  function toDeg(rad) {
    return (rad * 180.0) / Math.PI;
  }

  /**
   * Normaliza un ángulo en grados al rango [0, 360)
   */
  function normalizeAngle360(deg) {
    let a = deg % 360;
    if (a < 0) a += 360;
    return a;
  }

  /**
   * Calcula la distancia horizontal exacta sobre la superficie terrestre (Fórmula Haversine)
   * @param {number} lat1 - Latitud origen en grados
   * @param {number} lon1 - Longitud origen en grados
   * @param {number} lat2 - Latitud destino en grados
   * @param {number} lon2 - Longitud destino en grados
   * @returns {number} Distancia en metros
   */
  function haversineDistance(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const phi1 = toRad(lat1);
    const phi2 = toRad(lat2);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
    return EARTH_RADIUS_METERS * c;
  }

  /**
   * Calcula el azimut inicial / rumbo geográfico desde punto 1 a punto 2
   * @returns {number} Azimut en grados [0, 360) respecto al Norte verdadero
   */
  function calculateBearing(lat1, lon1, lat2, lon2) {
    const phi1 = toRad(lat1);
    const phi2 = toRad(lat2);
    const deltaLambda = toRad(lon2 - lon1);

    const y = Math.sin(deltaLambda) * Math.cos(phi2);
    const x =
      Math.cos(phi1) * Math.sin(phi2) -
      Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

    const bearingRad = Math.atan2(y, x);
    return normalizeAngle360(toDeg(bearingRad));
  }

  /**
   * Calcula el ángulo de elevación (pitch) en grados hacia el objetivo
   * @param {number} horizontalDistance - Distancia en el plano horizontal (m)
   * @param {number} userAlt - Altitud del observador (m)
   * @param {number} targetAlt - Altitud del objetivo (m)
   * @returns {number} Ángulo en grados (-90 a +90)
   */
  function calculateElevationAngle(horizontalDistance, userAlt, targetAlt) {
    const deltaH = targetAlt - userAlt;
    if (horizontalDistance <= 0.001) {
      return deltaH >= 0 ? 90.0 : -90.0;
    }
    return toDeg(Math.atan2(deltaH, horizontalDistance));
  }

  /**
   * Calcula la distancia 3D en línea recta (Slant Range / Línea de Vista)
   * @param {number} horizontalDistance - Distancia en metros sobre el elipsoide
   * @param {number} userAlt - Altitud observador (m)
   * @param {number} targetAlt - Altitud objetivo (m)
   * @returns {number} Distancia 3D en metros
   */
  function calculate3DDistance(horizontalDistance, userAlt, targetAlt) {
    const deltaH = targetAlt - userAlt;
    return Math.sqrt(horizontalDistance * horizontalDistance + deltaH * deltaH);
  }

  /**
   * Calcula un punto destino geográfico a partir de origen, distancia y rumbo
   */
  function destinationPoint(lat, lon, distanceMeters, bearingDeg) {
    const delta = distanceMeters / EARTH_RADIUS_METERS;
    const theta = toRad(bearingDeg);
    const phi1 = toRad(lat);
    const lambda1 = toRad(lon);

    const phi2 = Math.asin(
      Math.sin(phi1) * Math.cos(delta) +
        Math.cos(phi1) * Math.sin(delta) * Math.cos(theta)
    );
    const lambda2 =
      lambda1 +
      Math.atan2(
        Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
        Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
      );

    return {
      lat: toDeg(phi2),
      lon: ((toDeg(lambda2) + 540) % 360) - 180
    };
  }

  /**
   * Convierte coordenadas cartesianas locales métricas respecto a un origen
   */
  function geodeticToLocalENU(lat, lon, alt, originLat, originLon, originAlt) {
    const dLatRad = toRad(lat - originLat);
    const dLonRad = toRad(lon - originLon);
    const originLatRad = toRad(originLat);

    const east = dLonRad * EARTH_RADIUS_METERS * Math.cos(originLatRad);
    const north = dLatRad * EARTH_RADIUS_METERS;
    const up = (alt || 0) - (originAlt || 0);

    return { east, north, up };
  }

  /**
   * Formatea distancia de forma legible (ej. "842 m" o "4.25 km")
   */
  function formatDistance(meters) {
    if (meters == null || isNaN(meters)) return '---';
    if (meters < 1000) {
      return `${Math.round(meters)} m`;
    }
    return `${(meters / 1000).toFixed(2)} km`;
  }

  /**
   * Formatea coordenadas geográficas en formato decimal con sufijos N/S, E/W
   */
  function formatCoords(lat, lon) {
    if (lat == null || lon == null || isNaN(lat) || isNaN(lon)) return '---';
    const latStr = `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'}`;
    const lonStr = `${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? 'E' : 'O'}`;
    return `${latStr}, ${lonStr}`;
  }

  /**
   * Convierte un ángulo en grados a milésimas artilleras OTAN (6400 milésimas por círculo completo)
   */
  function degreesToMils(deg) {
    const normalized = normalizeAngle360(deg);
    return Math.round((normalized * 6400) / 360) % 6400;
  }

  /**
   * Formatea milésimas artilleras (ej. "1250 ₥")
   */
  function formatMils(mils) {
    if (mils == null || isNaN(mils)) return '---';
    return `${mils.toString().padStart(4, '0')} ₥`;
  }

  /**
   * Convierte coordenadas geográficas WGS84 a proyección Universal Transversal de Mercator (UTM)
   * @param {number} lat - Latitud decimal [-80, 84]
   * @param {number} lon - Longitud decimal [-180, 180]
   * @returns {{ zoneNumber: number, zoneLetter: string, easting: number, northing: number, formatted: string }}
   */
  function latLonToUTM(lat, lon) {
    if (lat == null || lon == null || isNaN(lat) || isNaN(lon)) {
      return { zoneNumber: 0, zoneLetter: '', easting: 0, northing: 0, formatted: '---' };
    }

    const a = 6378137.0; // Semieje mayor WGS84
    const f = 1 / 298.257223563; // Aplanamiento
    const e2 = f * (2 - f); // Excentricidad al cuadrado
    const ep2 = e2 / (1 - e2); // Segunda excentricidad
    const k0 = 0.9996; // Factor de escala central

    // Zona UTM
    let zoneNumber = Math.floor((lon + 180) / 6) + 1;
    if (lat >= 56.0 && lat < 64.0 && lon >= 3.0 && lon < 12.0) zoneNumber = 32;
    if (lat >= 72.0 && lat < 84.0) {
      if (lon >= 0.0 && lon < 9.0) zoneNumber = 31;
      else if (lon >= 9.0 && lon < 21.0) zoneNumber = 33;
      else if (lon >= 21.0 && lon < 33.0) zoneNumber = 35;
      else if (lon >= 33.0 && lon < 42.0) zoneNumber = 37;
    }

    // Banda de latitud (MGRS)
    const letters = 'CDEFGHJKLMNPQRSTUVWX';
    let zoneLetter = 'Z';
    if (lat >= -80 && lat <= 84) {
      zoneLetter = letters[Math.floor((lat + 80) / 8)];
    }

    const lon0 = ((zoneNumber - 1) * 6 - 180 + 3) * (Math.PI / 180);
    const phi = lat * (Math.PI / 180);
    const lambda = lon * (Math.PI / 180);

    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const tanPhi = Math.tan(phi);

    const N = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
    const T = tanPhi * tanPhi;
    const C = ep2 * cosPhi * cosPhi;
    const A = cosPhi * (lambda - lon0);

    const e4 = e2 * e2;
    const e6 = e4 * e2;
    const M = a * (
      (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
      - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
      + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi)
      - (35 * e6 / 3072) * Math.sin(6 * phi)
    );

    const easting = k0 * N * (
      A
      + (1 - T + C) * Math.pow(A, 3) / 6
      + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * Math.pow(A, 5) / 120
    ) + 500000.0;

    let northing = k0 * (
      M
      + N * tanPhi * (
        A * A / 2
        + (5 - T + 9 * C + 4 * C * C) * Math.pow(A, 4) / 24
        + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * Math.pow(A, 6) / 720
      )
    );

    if (lat < 0) {
      northing += 10000000.0; // Falso norte para hemisferio sur
    }

    const roundedE = Math.round(easting);
    const roundedN = Math.round(northing);
    const formatted = `${zoneNumber}${zoneLetter} ${roundedE}E ${roundedN}N`;

    return {
      zoneNumber,
      zoneLetter,
      easting: roundedE,
      northing: roundedN,
      formatted
    };
  }

  return {
    EARTH_RADIUS_METERS,
    toRad,
    toDeg,
    normalizeAngle360,
    haversineDistance,
    calculateBearing,
    calculateElevationAngle,
    calculate3DDistance,
    destinationPoint,
    geodeticToLocalENU,
    formatDistance,
    formatCoords,
    degreesToMils,
    formatMils,
    latLonToUTM
  };
});
