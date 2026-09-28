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
    formatCoords
  };
});
