/**
 * test_sensors.js - Pruebas automáticas de algoritmos de fusión sensorial
 */
const SensorFusion = require('./sensorFusion.js');

function runSensorTests() {
  console.log('=== PRUEBAS DE FUSIÓN SENSORIAL ===\n');
  let passed = 0;
  let total = 0;

  function assert(condition, message) {
    total++;
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
    }
  }

  // Prueba 1: Declinación magnética
  // En Santiago de Chile (-33.45, -70.67), la declinación magnética suele estar entre +1° y +5° Este
  const dec = SensorFusion.estimateMagneticDeclination(-33.45, -70.67, 2026);
  console.log(`Declinación estimada para Santiago: ${dec}°`);
  assert(!isNaN(dec) && Math.abs(dec) < 30, `Declinación dentro de rangos plausibles: ${dec}°`);

  // Prueba 2: Filtro circular de ángulos en el cruce por 0° / 360°
  const filter = new SensorFusion.CircularEMA(0.3);
  // Simular oscilación alrededor del Norte: 358°, 2°, 359°, 1°
  filter.update(358);
  filter.update(2);
  filter.update(359);
  const smoothed = filter.update(1);
  console.log(`Ángulo filtrado cerca de 0°: ${smoothed.toFixed(2)}°`);
  // Debe mantenerse cercano a 0° o 360°, no promediar a 180° (el error clásico de promedio lineal)
  const isNearZero = smoothed < 10 || smoothed > 350;
  assert(isNearZero, `Filtro circular evita el error de 180° en el Norte: ${smoothed.toFixed(2)}°`);

  // Prueba 3: Filtro lineal de inclinación
  const linFilter = new SensorFusion.LinearEMA(0.2);
  linFilter.update(-5.0);
  linFilter.update(-5.2);
  const pitchSmooth = linFilter.update(-4.8);
  assert(Math.abs(pitchSmooth - (-5.0)) < 0.3, `Filtro lineal de pitch correcto: ${pitchSmooth.toFixed(2)}°`);

  console.log(`\n=== RESUMEN SENSOR FUSION: ${passed} de ${total} pruebas exitosas ===`);
  if (passed === total) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runSensorTests();
