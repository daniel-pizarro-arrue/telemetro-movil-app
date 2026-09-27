const TerrainEngine = require('./terrainEngine.js');

async function testDemResolution() {
  // Supongamos un observador en una ciudad o pie de cerro
  const obsLat = -33.4350;
  const obsLon = -70.6200;

  // Supongamos que el observador mide su cota base:
  const baseElev = await TerrainEngine.fetchElevationsBatch([{ lat: obsLat, lon: obsLon }]);
  const groundAlt = baseElev[0];
  const obsAlt = groundAlt + 1.60;
  console.log(`Cota terreno observador: ${groundAlt}m, obsAlt (con 1.6m de ojos): ${obsAlt}m`);

  // Supongamos que el usuario apunta con pitch = +1.0° hacia un cerro al Norte (azimuth = 340°)
  const pitch = 1.0;
  const azimuth = 340.0;

  // Tomemos las distancias que genera generateSamplingDistances
  const distances = TerrainEngine.generateSamplingDistances(5000, 45);
  console.log(`Primeras distancias de muestreo:`, distances.slice(0, 5));

  const samplePoints = distances.map(dist => {
    const dest = TerrainEngine.getDestinationPoint(obsLat, obsLon, dist, azimuth);
    const rayAlt = TerrainEngine.getRayAltitude(obsAlt, pitch, dist);
    return { distance: dist, lat: dest.lat, lon: dest.lon, rayAlt };
  });

  const terrainElevations = await TerrainEngine.fetchElevationsBatch(samplePoints);

  console.log('\nComparación Rayo vs Terreno en los primeros 10 puntos:');
  for (let i = 0; i < 10; i++) {
    const p = samplePoints[i];
    const tAlt = terrainElevations[i];
    const delta = p.rayAlt - tAlt;
    console.log(`d=${p.distance.toFixed(1)}m | RayAlt=${p.rayAlt.toFixed(2)}m | TerrainAlt=${tAlt.toFixed(2)}m | delta=${delta.toFixed(2)}m ${delta <= 0 ? '<-- IMPACTO!' : ''}`);
  }
}

testDemResolution();
