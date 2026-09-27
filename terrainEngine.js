/**
 * terrainEngine.js - Motor Geodésico y de Raymarching Topográfico 3D
 * Simulación de rayo láser virtual contra modelos digitales de terreno (DEM)
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TerrainEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EARTH_RADIUS = 6371000.0; // Radio medio de la Tierra en metros
  const REFRACTION_COEFF = 0.13;   // Coeficiente estándar de refracción atmosférica k

  /**
   * Conversiones angulares
   */
  function toRad(deg) {
    return (deg * Math.PI) / 180.0;
  }

  function toDeg(rad) {
    return (rad * 180.0) / Math.PI;
  }

  /**
   * Calcula el punto de destino geodésico a partir de punto origen, distancia y azimut
   * @param {number} lat - Latitud en grados
   * @param {number} lon - Longitud en grados
   * @param {number} distance - Distancia en metros
   * @param {number} azimuth - Azimut verdadero en grados (0 a 360)
   * @returns {{lat: number, lon: number}}
   */
  function getDestinationPoint(lat, lon, distance, azimuth) {
    const dR = distance / EARTH_RADIUS;
    const brng = toRad(azimuth);
    const lat1 = toRad(lat);
    const lon1 = toRad(lon);

    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(dR) +
      Math.cos(lat1) * Math.sin(dR) * Math.cos(brng)
    );

    const lon2 = lon1 + Math.atan2(
      Math.sin(brng) * Math.sin(dR) * Math.cos(lat1),
      Math.cos(dR) - Math.sin(lat1) * Math.sin(lat2)
    );

    return {
      lat: toDeg(lat2),
      lon: ((toDeg(lon2) + 540) % 360) - 180 // Normalizar a [-180, 180]
    };
  }

  /**
   * Calcula la cota del rayo láser a una distancia 'd' considerando curvatura y refracción
   * @param {number} initialAlt - Altura inicial del observador (MSL)
   * @param {number} pitchDeg - Inclinación del teléfono (positivo = arriba, negativo = abajo)
   * @param {number} distance - Distancia en línea de visión (m)
   * @returns {number} Altura absoluta aproximada del rayo sobre el nivel del mar
   */
  function getRayAltitude(initialAlt, pitchDeg, distance) {
    const pitchRad = toRad(pitchDeg);
    // Componente geométrica vertical directa
    const verticalOffset = distance * Math.sin(pitchRad);
    // Corrección geodésica combinada de curvatura y refracción terrestre
    const curvatureDrop = (Math.pow(distance, 2) / (2 * EARTH_RADIUS)) * (1.0 - REFRACTION_COEFF);
    return initialAlt + verticalOffset - curvatureDrop;
  }

  /**
   * Genera una lista de distancias de muestreo progresivo a lo largo del rayo
   * @param {number} maxRange - Alcance máximo en metros (ej. 3000m o 5000m)
   * @param {number} numSamples - Número de muestras (ej. 35 a 50)
   * @returns {number[]} Array de distancias en metros
   */
  function generateSamplingDistances(maxRange = 4000, numSamples = 40) {
    const distances = [];
    // Distribución suavemente progresiva: mayor densidad cerca del observador
    for (let i = 1; i <= numSamples; i++) {
      const t = i / numSamples;
      // Progresión cuadrática moderada para densificar el corto alcance
      const dist = maxRange * (0.3 * t + 0.7 * Math.pow(t, 1.8));
      distances.push(Math.round(dist * 10) / 10);
    }
    return distances;
  }

  /**
   * Consulta elevaciones por lote a la API de Open-Meteo (Copernicus DEM 30m/90m)
   * @param {Array<{lat: number, lon: number}>} points
   * @returns {Promise<number[]>} Array de elevaciones en metros
   */
  async function fetchElevationsBatch(points) {
    if (!points || points.length === 0) return [];

    const lats = points.map(p => p.lat.toFixed(5)).join(',');
    const lons = points.map(p => p.lon.toFixed(5)).join(',');
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Error en API de elevación: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.elevation) {
      throw new Error('Respuesta inválida de la API de elevación');
    }

    return Array.isArray(data.elevation) ? data.elevation : [data.elevation];
  }

  /**
   * Ejecuta el trazado del rayo láser virtual y encuentra la intersección topográfica
   * @param {Object} params
   * @param {number} params.obsLat - Latitud del observador
   * @param {number} params.obsLon - Longitud del observador
   * @param {number} params.obsAlt - Altura absoluta de los ojos del observador (MSL)
   * @param {number} params.azimuth - Azimut verdadero (grados, 0-360)
   * @param {number} params.pitch - Ángulo de elevación / inclinación (grados)
   * @param {number} [params.maxRange=5000] - Distancia máxima de barrido (m)
   * @param {number} [params.numSamples=40] - Número de pasos de muestreo
   * @returns {Promise<Object>} Resultado completo de la medición
   */
  async function traceRay(params) {
    const {
      obsLat,
      obsLon,
      obsAlt,
      azimuth,
      pitch,
      maxRange = 5000,
      numSamples = 45,
      postureHeight = 1.60
    } = params;

    const distances = generateSamplingDistances(maxRange, numSamples);
    
    // Generar coordenadas de cada muestra
    const samplePoints = distances.map(dist => {
      const dest = getDestinationPoint(obsLat, obsLon, dist, azimuth);
      const rayAlt = getRayAltitude(obsAlt, pitch, dist);
      return {
        distance: dist,
        lat: dest.lat,
        lon: dest.lon,
        rayAlt: rayAlt
      };
    });

    // Consultar elevaciones reales del terreno en un único lote
    const terrainElevations = await fetchElevationsBatch(samplePoints);

    // Mapear el perfil completo de terreno y rayo, incluyendo el origen d = 0
    const groundBase = obsAlt - postureHeight;
    const profile = [
      {
        distance: 0,
        lat: obsLat,
        lon: obsLon,
        rayAlt: obsAlt,
        terrainAlt: groundBase,
        delta: postureHeight // Positivo: la cámara está por encima del suelo local
      }
    ];

    for (let i = 0; i < samplePoints.length; i++) {
      profile.push({
        ...samplePoints[i],
        terrainAlt: terrainElevations[i],
        delta: samplePoints[i].rayAlt - terrainElevations[i]
      });
    }

    // Buscar primer punto de colisión (donde el rayo pasa de estar por encima a por debajo del terreno)
    let hitIndex = -1;
    for (let i = 1; i < profile.length; i++) {
      const p = profile[i];
      // FILTRO NEAR-FIELD:
      // Si el rayo apunta hacia el horizonte o hacia arriba (pitch >= -1.0°),
      // no puede colisionar con el suelo plano a los pies del observador (< 80m).
      // Solo se acepta impacto a < 80m si el terreno es genuinamente más alto que los ojos del observador
      // (ej. una pared o ladera vertical inmediata).
      if (p.distance < 80 && pitch >= -1.0) {
        if (p.terrainAlt <= obsAlt) {
          continue; // Ignorar artefacto de discretización de cuadrícula DEM
        }
      }

      if (p.delta <= 0) {
        hitIndex = i;
        break;
      }
    }

    // Si no hubo impacto (rayo apunta al cielo o pasa por encima de las colinas)
    if (hitIndex === -1) {
      return {
        hasHit: false,
        message: pitch > 0 
          ? 'Rayo sin impacto en el relieve (apunta al cielo o sobrepasa el terreno)'
          : 'Sin impacto dentro del alcance máximo configurado (5.0 km)',
        maxRangeAnalyzed: maxRange,
        profile: profile,
        closestApproach: findClosestApproach(profile)
      };
    }

    // Interpolar con precisión el punto exacto de intersección entre profile[hitIndex - 1] y profile[hitIndex]
    const pPrev = profile[hitIndex - 1];
    const pHit = profile[hitIndex];

    const delta1 = pPrev.delta;
    const delta2 = pHit.delta;
    // Interpolación lineal del cruce por cero
    const denom = Math.abs(delta1) + Math.abs(delta2);
    const t = denom > 0 ? Math.abs(delta1) / denom : 0.5;

    const exactDistance = pPrev.distance + t * (pHit.distance - pPrev.distance);
    const exactDest = getDestinationPoint(obsLat, obsLon, exactDistance, azimuth);
    const targetLat = exactDest.lat;
    const targetLon = exactDest.lon;
    const targetAlt = pPrev.terrainAlt + t * (pHit.terrainAlt - pPrev.terrainAlt);

    const horizontalDistance = exactDistance * Math.cos(toRad(pitch));
    const deltaHeight = targetAlt - obsAlt;
    const slopePercent = (Math.tan(toRad(pitch)) * 100);

    return {
      hasHit: true,
      slantRange: Math.round(exactDistance * 10) / 10,       // Distancia real / línea de visión
      horizontalDistance: Math.round(horizontalDistance * 10) / 10, // Distancia en plano
      deltaHeight: Math.round(deltaHeight * 10) / 10,       // Desnivel relativo
      slopePercent: Math.round(slopePercent * 10) / 10,
      pitchDeg: pitch,
      azimuthDeg: azimuth,
      targetCoords: {
        lat: Number(targetLat.toFixed(6)),
        lon: Number(targetLon.toFixed(6)),
        alt: Math.round(targetAlt * 10) / 10
      },
      profile: profile
    };
  }

  /**
   * Encuentra el punto donde el rayo estuvo más cerca del terreno si no hubo colisión
   */
  function findClosestApproach(profile) {
    if (!profile || profile.length === 0) return null;
    let minDelta = Infinity;
    let bestPoint = null;
    for (const p of profile) {
      if (p.delta < minDelta) {
        minDelta = p.delta;
        bestPoint = p;
      }
    }
    return {
      distance: bestPoint.distance,
      clearance: Math.round(minDelta * 10) / 10
    };
  }

  return {
    EARTH_RADIUS,
    toRad,
    toDeg,
    getDestinationPoint,
    getRayAltitude,
    generateSamplingDistances,
    fetchElevationsBatch,
    traceRay
  };
});
