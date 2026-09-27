/**
 * test_suite.js - Suite de pruebas unitarias automatizadas para el Telémetro Móvil 3D.
 * Valida la matriz W3C, azimuts cardinales, pitch y raymarching geodésico con datos reales.
 */

const assert = require('assert');
const SensorFusion = require('./sensorFusion.js');
const TerrainEngine = require('./terrainEngine.js');

async function runTests() {
  console.log('=== [1] VALIDACIÓN DE MATRIZ DE ORIENTACIÓN 3D (W3C SPEC) ===');

  // Test 1: Teléfono en vertical retrato (beta=90, gamma=0) apuntando al Norte geográfico
  const north = SensorFusion.calculateCameraOrientation(0, 90, 0);
  assert(Math.abs(north.azimuth - 0) < 0.1, `Azimut Norte falló: esperado ~0°, obtenido ${north.azimuth}°`);
  assert(Math.abs(north.pitch - 0) < 0.1, `Pitch Norte falló: esperado ~0°, obtenido ${north.pitch}°`);
  console.log('✔ Retrato Vertical Norte: OK (Az 0°, Pitch 0°)');

  // Test 2: Inclinado hacia arriba 10° mirando al Norte (beta=100)
  const pitchUp = SensorFusion.calculateCameraOrientation(0, 100, 0);
  assert(Math.abs(pitchUp.pitch - 10) < 0.1, `Pitch hacia arriba falló: esperado +10°, obtenido ${pitchUp.pitch}°`);
  console.log('✔ Inclinación +10° hacia cerro/cielo: OK (+10.0°)');

  // Test 3: Inclinado hacia abajo 10° (beta=80)
  const pitchDown = SensorFusion.calculateCameraOrientation(0, 80, 0);
  assert(Math.abs(pitchDown.pitch - (-10)) < 0.1, `Pitch hacia abajo falló: esperado -10°, obtenido ${pitchDown.pitch}°`);
  console.log('✔ Inclinación -10° hacia suelo: OK (-10.0°)');

  console.log('\n=== [2] VALIDACIÓN CON CAPTURAS REALES DE USUARIO EN CHILE ===');

  // Captura #1 del usuario:
  const c1 = SensorFusion.calculateCameraOrientation(22.2, 97.6, 76.8);
  assert(c1.pitch > 0, `Pitch debe ser positivo al apuntar cerro (+1.73°), obtenido: ${c1.pitch}°`);
  assert(Math.abs(c1.azimuth - 260.9) < 1.0, `Azimut Captura #1 debe ser ~261°, obtenido: ${c1.azimuth}°`);
  console.log(`✔ Captura #1 Ángulos: Az=${c1.azimuth.toFixed(1)}°, Pitch=+${c1.pitch.toFixed(2)}°`);

  const res1 = await TerrainEngine.traceRay({
    obsLat: -33.5836433,
    obsLon: -70.7019017,
    obsAlt: 561.6,
    azimuth: c1.azimuth,
    pitch: c1.pitch,
    maxRange: 5000,
    numSamples: 45
  });
  assert(res1.hasHit === true, 'Captura #1 debe impactar la colina');
  assert(res1.slantRange > 2000 && res1.slantRange < 3000, `Distancia esperada 2-3km, obtenida: ${res1.slantRange}m`);
  console.log(`✔ Captura #1 Raymarching: Impacto a ${res1.slantRange}m (Δh: +${res1.deltaHeight}m) [Cerro 2.4km confirmado]`);

  // Captura #2 del usuario:
  const c2 = SensorFusion.calculateCameraOrientation(63.4, 95.6, 73.5);
  assert(c2.pitch > 0, `Pitch debe ser positivo (+1.59°), obtenido: ${c2.pitch}°`);
  console.log(`✔ Captura #2 Ángulos: Az=${c2.azimuth.toFixed(1)}°, Pitch=+${c2.pitch.toFixed(2)}°`);

  const res2 = await TerrainEngine.traceRay({
    obsLat: -33.5841833,
    obsLon: -70.7011083,
    obsAlt: 561.6,
    azimuth: c2.azimuth,
    pitch: c2.pitch,
    maxRange: 5000,
    numSamples: 45
  });
  assert(res2.hasHit === true, 'Captura #2 debe impactar la colina');
  assert(res2.slantRange > 2500 && res2.slantRange < 3500, `Distancia esperada ~2.9km, obtenida: ${res2.slantRange}m`);
  console.log(`✔ Captura #2 Raymarching: Impacto a ${res2.slantRange}m (Δh: +${res2.deltaHeight}m) [Cerro 2.9km confirmado]`);

  console.log('\n=== [3] VALIDACIÓN DE MODO HORIZONTAL (LANDSCAPE) ===');

  // Test Landscape Primary (alpha=270, beta=0, gamma=90) mirando al Norte
  const landNorth = SensorFusion.calculateCameraOrientation(270, 0, 90);
  assert(Math.abs(landNorth.azimuth - 0) < 0.1 || Math.abs(landNorth.azimuth - 360) < 0.1, `Azimut Landscape Norte falló: ${landNorth.azimuth}°`);
  assert(Math.abs(landNorth.pitch - 0) < 0.1, `Pitch Landscape Norte falló: ${landNorth.pitch}°`);
  console.log('✔ Modo Horizontal (Landscape Primary) apuntando al Norte: OK (Az 0°, Pitch 0°)');

  // Test Landscape Roll Projection:
  // Función auxiliar de prueba que emula la proyección de devicemotion en sensorFusion
  function projectGravityRoll(accX, accY, screenAngle) {
    const rad = (screenAngle * Math.PI) / 180.0;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const sx = cos * accX - sin * accY;
    const sy = sin * accX + cos * accY;
    return Math.atan2(sx, sy) * (180.0 / Math.PI);
  }

  const rollLandLevel = projectGravityRoll(9.8, 0, 90);
  assert(Math.abs(rollLandLevel) < 0.01, `Nivel horizontal en Landscape falló: ${rollLandLevel}°`);
  console.log('✔ Nivel de Horizonte Artificial en Landscape (0.0°): OK');

  const rollLandTilt = projectGravityRoll(9.8 * Math.cos(10 * Math.PI / 180), -9.8 * Math.sin(10 * Math.PI / 180), 90);
  assert(Math.abs(rollLandTilt - 10) < 0.01, `Inclinación lateral en Landscape falló: ${rollLandTilt}°`);
  console.log('✔ Inclinación lateral en Landscape (+10.0°): OK');

  console.log('\n======================================================');
  console.log('   TODAS LAS PRUEBAS UNITARIAS PASARON EXITOSAMENTE   ');
  console.log('======================================================');
}

runTests().catch(err => {
  console.error('ERROR EN PRUEBAS:', err);
  process.exit(1);
});
