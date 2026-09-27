/**
 * read_telemetry.js - Herramienta CLI para que el agente Antigravity inspeccione
 * en tiempo real las mediciones, datos crudos de sensores y diagnóstico del teléfono.
 */

const https = require('https');

const FIREBASE_API_KEY = "AIzaSyC-26ZaTDMapEJXciLRP-mhWERlsjZjyTw";
const RTDB_HOST = "chatin-e31ea-default-rtdb.firebaseio.com";
const SESSIONS_PATH = "sessions/telemetro_debug";

function getAuthToken() {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ returnSecureToken: true });
    const req = https.request({
      hostname: 'identitytoolkit.googleapis.com',
      path: '/v1/accounts:signUp?key=' + FIREBASE_API_KEY,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.idToken) resolve(json.idToken);
          else reject(new Error('No idToken in response: ' + data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function fetchJson(path, token) {
  return new Promise((resolve, reject) => {
    const url = `https://${RTDB_HOST}/${path}.json?auth=${token}`;
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('========================================================');
  console.log('   ANTIGRAVITY TELEMETRY INSPECTOR (FIREBASE RTDB)');
  console.log('========================================================\n');

  try {
    const token = await getAuthToken();
    const latest = await fetchJson(`${SESSIONS_PATH}/latest`, token);

    if (!latest) {
      console.log('No se han registrado mediciones aún en Firebase.');
      return;
    }

    console.log(`[TIMESTAMP CLIENTE]: ${latest.clientTimestamp}`);
    console.log(`[DISPOSITIVO]:       ${latest.userAgent || 'Desconocido'}\n`);

    console.log('--- [1] DATOS CRUDOS DE SENSORES ---');
    if (latest.rawSensors) {
      console.log(`- Alpha (Brújula raw):     ${latest.rawSensors.alpha}°`);
      console.log(`- Beta (Inclinación raw):  ${latest.rawSensors.beta}°`);
      console.log(`- Gamma (Alabeo raw):      ${latest.rawSensors.gamma}°`);
      console.log(`- Es Absoluto:             ${latest.rawSensors.isAbsolute ? 'SÍ (Magnetómetro)' : 'NO'}`);
      if (latest.rawSensors.webkitCompassHeading !== undefined) {
        console.log(`- iOS Compass Heading:     ${latest.rawSensors.webkitCompassHeading}°`);
      }
    }

    console.log('\n--- [2] VECTOR 3D Y ÁNGULOS FILTRADOS ---');
    if (latest.camera3D) {
      console.log(`- Azimut Verdadero:        ${latest.camera3D.azimuthTrue}° (${Math.round(latest.camera3D.azimuthTrue/360*6400)} ₥)`);
      console.log(`- Inclinación (Pitch):     ${latest.camera3D.pitch}° (${Math.round(latest.camera3D.pitch/360*6400)} ₥)`);
      console.log(`- Alabeo (Roll):           ${latest.camera3D.roll}°`);
      console.log(`- Declinación Magnética:   ${latest.camera3D.declination}°`);
      console.log(`- Vector óptico cámara:    Este=${latest.camera3D.vEast?.toFixed(3)}, Norte=${latest.camera3D.vNorth?.toFixed(3)}, Arriba=${latest.camera3D.vUp?.toFixed(3)}`);
    }

    console.log('\n--- [3] GEOLOCALIZACIÓN Y COTAS ---');
    if (latest.gps) {
      console.log(`- Coordenadas Observador:  ${latest.gps.lat}, ${latest.gps.lon}`);
      console.log(`- Precisión GPS:           ±${latest.gps.accuracy} m`);
      console.log(`- Cota Terreno Base (DEM): ${latest.gps.groundAlt} m MSL`);
      console.log(`- Altura Ojos / Postura:   +${latest.gps.postureHeight} m`);
      console.log(`- Cota Efectiva Cámara:    ${latest.gps.effectiveAlt} m MSL`);
    }

    console.log('\n--- [4] RESULTADO DEL RAYMARCHING ---');
    if (latest.result) {
      console.log(`- Impacto detectado:       ${latest.result.hasHit ? 'SÍ (BLANCO ALCANZADO)' : 'NO'}`);
      if (latest.result.hasHit) {
        console.log(`- Distancia Real (Slant):  ${latest.result.slantRange} m`);
        console.log(`- Distancia Horizontal:    ${latest.result.horizontalDistance} m`);
        console.log(`- Desnivel (Delta h):      ${latest.result.deltaHeight > 0 ? '+' : ''}${latest.result.deltaHeight} m`);
        console.log(`- Coordenadas del Blanco:  Lat ${latest.result.targetCoords?.lat}, Lon ${latest.result.targetCoords?.lon}`);
        console.log(`- Cota del Blanco (MSL):   ${latest.result.targetCoords?.alt} m`);
      } else {
        console.log(`- Mensaje / Causa:         ${latest.result.message}`);
      }
    }

    console.log('\n========================================================\n');
  } catch (err) {
    console.error('Error inspeccionando Firebase:', err.message);
  }
}

main();
