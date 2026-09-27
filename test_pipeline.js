/**
 * test_pipeline.js - Prueba de integración completa del pipeline de Telémetro 3D
 */
const TerrainEngine = require('./terrainEngine.js');
const SensorFusion = require('./sensorFusion.js');

async function runPipelineTest() {
  console.log('=== TEST DE INTEGRACIÓN: PIPELINE COMPLETO TELÉMETRO 3D ===\n');

  // 1. Posición en Santiago mirando hacia el Cerro San Cristóbal / Cordillera
  // Observador en Providencia (-33.4350, -70.6200) apuntando al Norte hacia el Cerro San Cristóbal
  const obsLat = -33.4350;
  const obsLon = -70.6200;
  const posture = 1.60; // De pie

  console.log(`[1] Posición observador: ${obsLat}, ${obsLon} (Altura ojos: +${posture}m)`);

  // 2. Obtener cota DEM de la posición del observador
  console.log('[2] Obteniendo cota base del terreno DEM en la posición...');
  const baseElev = await TerrainEngine.fetchElevationsBatch([{ lat: obsLat, lon: obsLon }]);
  const groundAlt = baseElev[0];
  const effectiveAlt = groundAlt + posture;
  console.log(`    Cota de terreno DEM: ${groundAlt}m MSL | Altura efectiva cámara: ${effectiveAlt}m MSL`);

  // 3. Estimar declinación magnética
  const declination = SensorFusion.estimateMagneticDeclination(obsLat, obsLon, 2026);
  console.log(`[3] Declinación magnética calculada: ${declination}°`);

  // 4. Apuntar hacia el Cerro San Cristóbal (Rumbo Norte ~ 340°, inclinación hacia la ladera +4°)
  const rawCompassHeading = 340.0;
  const pitchAngle = 4.0;
  const trueAzimuth = (rawCompassHeading + declination + 360) % 360;

  console.log(`[4] Apuntando visor:`);
  console.log(`    Rumbo Magnético: ${rawCompassHeading}° -> Azimut Verdadero: ${trueAzimuth.toFixed(1)}°`);
  console.log(`    Inclinación (Pitch): +${pitchAngle}° hacia la ladera`);

  // 5. Trazar rayo láser topográfico 3D
  console.log('\n[5] Trazando rayo láser 3D con raymarching geodésico...');
  const trace = await TerrainEngine.traceRay({
    obsLat: obsLat,
    obsLon: obsLon,
    obsAlt: effectiveAlt,
    azimuth: trueAzimuth,
    pitch: pitchAngle,
    maxRange: 5000,
    numSamples: 35
  });

  console.log('\n=== RESULTADO DE LA TELEMETRÍA ===');
  console.log(`Impacto detectado: ${trace.hasHit ? 'SÍ (BLANCO ALCANZADO)' : 'NO'}`);
  if (trace.hasHit) {
    console.log(`- Distancia Real (Línea de Mira): ${trace.slantRange} m`);
    console.log(`- Distancia Horizontal:           ${trace.horizontalDistance} m`);
    console.log(`- Desnivel (Delta Altitud):       ${trace.deltaHeight > 0 ? '+' : ''}${trace.deltaHeight} m`);
    console.log(`- Pendiente / Ángulo de Sitio:    +${trace.pitchDeg}° (${trace.slopePercent}%)`);
    console.log(`- Coordenadas del Objetivo:       Lat: ${trace.targetCoords.lat}, Lon: ${trace.targetCoords.lon}`);
    console.log(`- Cota de Terreno del Objetivo:   ${trace.targetCoords.alt} m MSL`);
    console.log(`- Puntos de perfil analizados:    ${trace.profile.length} muestras`);
  }

  if (trace.hasHit && trace.slantRange > 0 && trace.targetCoords.lat !== 0) {
    console.log('\n[PASS] PIPELINE COMPLETO VALIDADO SATISFACTORIAMENTE.');
    process.exit(0);
  } else {
    console.error('\n[FAIL] El pipeline no arrojó los resultados esperados.');
    process.exit(1);
  }
}

runPipelineTest().catch(err => {
  console.error('Error en pipeline test:', err);
  process.exit(1);
});
