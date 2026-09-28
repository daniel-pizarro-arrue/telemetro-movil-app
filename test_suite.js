/**
 * test_suite.js - Pruebas automáticas basadas en ejecución de código
 */

const assert = require('assert');
const GeoMath = require('./geoMath.js');

console.log('--- INICIANDO TEST SUITE GEOMATH ---');

// Test 1: Distancia Haversine conocida
// Santiago (-33.4489, -70.6693) a Cerro San Cristóbal (-33.4253, -70.6331)
const dist1 = GeoMath.haversineDistance(-33.4489, -70.6693, -33.4253, -70.6331);
console.log(`Distancia Santiago a San Cristóbal: ${dist1.toFixed(1)} m`);
assert(dist1 > 4000 && dist1 < 5000, `Distancia esperada ~4.2km, obtenida: ${dist1}`);

// Test 2: Rumbo / Bearing hacia el Noreste
const bearing1 = GeoMath.calculateBearing(-33.4489, -70.6693, -33.4253, -70.6331);
console.log(`Rumbo Santiago a San Cristóbal: ${bearing1.toFixed(1)}°`);
assert(bearing1 > 35 && bearing1 < 65, `Rumbo esperado ~50°, obtenido: ${bearing1}`);

// Test 3: Ángulo de elevación y distancia 3D
// Distancia horizontal 1000m, diferencia de altura 500m -> atan2(500, 1000) ~ 26.56°
const elevAngle = GeoMath.calculateElevationAngle(1000, 500, 1000);
console.log(`Ángulo de elevación: ${elevAngle.toFixed(2)}°`);
assert(Math.abs(elevAngle - 26.565) < 0.01, `Ángulo esperado ~26.57°, obtenido: ${elevAngle}`);

const dist3D = GeoMath.calculate3DDistance(1000, 500, 1000);
console.log(`Distancia 3D: ${dist3D.toFixed(1)} m`);
assert(Math.abs(dist3D - 1118.03) < 0.1, `Distancia 3D esperada ~1118.03m, obtenida: ${dist3D}`);

// Test 4: Formateo
assert.strictEqual(GeoMath.formatDistance(450), '450 m');
assert.strictEqual(GeoMath.formatDistance(1250), '1.25 km');

console.log('--- TEST SENSOR MANAGER LOGIC ---');
const SensorManager = require('./sensorManager.js');
const sm = new SensorManager();
// Test lerp crossing North 359° to 2°
const lerped = sm._lerpAngle(359, 2, 0.5);
console.log(`Lerp entre 359° y 2° (t=0.5): ${lerped}°`);
assert(Math.abs(lerped - 0.5) < 0.1, `Esperado ~0.5°, obtenido ${lerped}`);

// Test destination point: 1000m North from origin
const dest = GeoMath.destinationPoint(0, 0, 1000, 0);
const calcDist = GeoMath.haversineDistance(0, 0, dest.lat, dest.lon);
console.log(`Punto proyectado a 1000m: dist calculada = ${calcDist.toFixed(1)}m`);
assert(Math.abs(calcDist - 1000) < 1.0, `Error en proyección de punto geodésico: ${calcDist}`);

// Test GPS locking behavior
let gpsLockedCalled = false;
sm.onGpsLocked = (lockedGps) => {
  gpsLockedCalled = true;
  assert.strictEqual(lockedGps.status, 'connected');
  assert.strictEqual(lockedGps.accuracy, 12);
};
sm._lockGps({ lat: -33.45, lng: -70.67, alt: 580, accuracy: 12, timestamp: Date.now() });
assert.strictEqual(gpsLockedCalled, true);
assert.strictEqual(sm.isGpsLocked, true);
console.log('GPS Lock Unit Test: Bloqueo exitoso verificado');

console.log('--- TEST MILS Y UTM ---');
// Test 360 deg = 0 mils, 90 deg = 1600 mils, 180 deg = 3200 mils, 270 deg = 4800 mils
assert.strictEqual(GeoMath.degreesToMils(0), 0);
assert.strictEqual(GeoMath.degreesToMils(90), 1600);
assert.strictEqual(GeoMath.degreesToMils(180), 3200);
assert.strictEqual(GeoMath.degreesToMils(270), 4800);
console.log(`90° = ${GeoMath.degreesToMils(90)} mils (esperado 1600)`);

// Test UTM Santiago (-33.4489, -70.6693)
const utm = GeoMath.latLonToUTM(-33.4489, -70.6693);
console.log(`UTM Santiago: ${utm.formatted}`);
assert.strictEqual(utm.zoneNumber, 19);
assert.strictEqual(utm.zoneLetter, 'H');
assert(utm.easting > 340000 && utm.easting < 350000, `Easting fuera de rango: ${utm.easting}`);
assert(utm.northing > 6290000 && utm.northing < 6305000, `Northing fuera de rango: ${utm.northing}`);

console.log('✅ TODOS LOS TESTS PASARON EXITOSAMENTE');


