/**
 * test_engine.js - Suite de pruebas programáticas para terrainEngine
 */
const TerrainEngine = require('./terrainEngine.js');

async function runTests() {
  console.log('=== INICIANDO PRUEBAS DE TERRAIN ENGINE ===\n');
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

  // Prueba 1: Destino geodésico básico
  const startLat = -33.4489;
  const startLon = -70.6693;
  const destNorth1km = TerrainEngine.getDestinationPoint(startLat, startLon, 1000, 0); // 1 km al norte
  // 1 km al norte debería incrementar la latitud en aprox 1000 / 111139 ≈ +0.00899 grados
  const latDiff = destNorth1km.lat - startLat;
  assert(Math.abs(latDiff - 0.00899) < 0.0002, `Desplazamiento al Norte 1km: latDiff=${latDiff.toFixed(5)}`);

  // Prueba 2: Curvatura terrestre y cota de rayo
  // A 2000m horizontal con pitch=0, el rayo debería caer por curvatura:
  // drop ≈ (2000^2 / (2 * 6371000)) * (1 - 0.13) ≈ (4,000,000 / 12,742,000) * 0.87 ≈ 0.27 m
  const rayAlt2km = TerrainEngine.getRayAltitude(500, 0, 2000);
  const drop = 500 - rayAlt2km;
  assert(drop > 0.25 && drop < 0.30, `Caída por curvatura terrestre a 2km: ${drop.toFixed(3)}m (esperado ~0.27m)`);

  // Prueba 3: Generación de distancias progresivas
  const samples = TerrainEngine.generateSamplingDistances(3000, 30);
  assert(samples.length === 30, `Número de muestras correcto: ${samples.length}`);
  assert(samples[0] > 0 && samples[samples.length - 1] === 3000, `Rango inicial > 0 y final = 3000m`);

  // Prueba 4: Trazado de rayo real contra la API de Open-Meteo
  console.log('\nEjecutando trazado de rayo real con API DEM...');
  try {
    // Apuntando desde la cumbre de un cerro hacia abajo (ej. Cerro San Cristóbal hacia el valle)
    // Cerro San Cristóbal: ~ -33.4253, -70.6335 (~850m) apuntando al sur (-33.44) hacia abajo (-5 grados)
    const result = await TerrainEngine.traceRay({
      obsLat: -33.4253,
      obsLon: -70.6335,
      obsAlt: 850,
      azimuth: 180, // Hacia el Sur
      pitch: -8.0,  // Apuntando hacia abajo (-8°)
      maxRange: 3000,
      numSamples: 25
    });

    console.log('Resultado del impacto:', {
      hasHit: result.hasHit,
      slantRange: result.slantRange,
      horizontalDistance: result.horizontalDistance,
      deltaHeight: result.deltaHeight,
      targetCoords: result.targetCoords
    });

    assert(result.hasHit === true, 'El rayo apuntado hacia abajo impactó con el terreno');
    assert(result.slantRange > 100 && result.slantRange < 3000, `Distancia medida coherente: ${result.slantRange}m`);
    assert(result.targetCoords.alt > 400 && result.targetCoords.alt < 800, `Altitud de impacto coherente: ${result.targetCoords.alt}m`);
  } catch (err) {
    console.error('Error durante traceRay:', err);
    assert(false, `Excepción en traceRay: ${err.message}`);
  }

  console.log(`\n=== RESUMEN: ${passed} de ${total} pruebas exitosas ===`);
  if (passed === total) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runTests();
