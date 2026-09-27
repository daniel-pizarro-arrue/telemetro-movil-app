// Test Near-field Raymarching Fix
function testNearFieldRay(pitchDeg, obsAlt, groundAlt, distances, elevations) {
  // distances[0] = 37, elevations[0] = 596
  // groundAlt = 595, obsAlt = 596.6
  
  // Point 0: Observer at d = 0
  const profile = [
    { distance: 0, rayAlt: obsAlt, terrainAlt: groundAlt, delta: obsAlt - groundAlt }
  ];

  for (let i = 0; i < distances.length; i++) {
    const d = distances[i];
    const rayAlt = obsAlt + d * Math.sin(pitchDeg * Math.PI / 180);
    const tAlt = elevations[i];
    profile.push({
      distance: d,
      rayAlt: rayAlt,
      terrainAlt: tAlt,
      delta: rayAlt - tAlt
    });
  }

  // Near-field threshold: Ray cannot hit flat ground within 75m if looking forward/up
  let hitIndex = -1;
  for (let i = 1; i < profile.length; i++) {
    const p = profile[i];
    // Si estamos en los primeros 75 metros y el rayo apunta hacia arriba o al horizonte,
    // ignorar pequeñas discrepancias de píxeles DEM de 1-2 metros
    if (p.distance < 75 && pitchDeg >= -0.5) {
      if (p.terrainAlt <= obsAlt) {
        continue; // No es colisión real con una montaña
      }
    }

    if (p.delta <= 0) {
      hitIndex = i;
      break;
    }
  }

  return { hitIndex, hit: hitIndex !== -1 ? profile[hitIndex] : null };
}

// Caso 1: Mirando a un cerro a 2000m con pitch = +2.0°
// En los primeros metros el DEM tiene 595m, pero a 2000m sube a 750m
const dists = [37, 80, 150, 300, 600, 1000, 1500, 2000, 2500, 3000];
const elevs = [596, 595, 594, 598, 610,  630,  680,  780,  900, 1050];

const res = testNearFieldRay(2.0, 596.6, 595.0, dists, elevs);
console.log('Resultado con filtro near-field:', res);
