/**
 * app.js - Orquestador limpio del Telémetro Móvil 3D
 * Conecta Cesium3DMap, SensorManager, GeoMath y TelemetryLogger.
 */

document.addEventListener('DOMContentLoaded', async () => {
  'use strict';

  // ─── ELEMENTOS DOM ────────────────────────────────────────────────────────
  const statusToast = document.getElementById('statusToast');
  const gpsDot = document.getElementById('gpsDot');
  const modeToggleBtn = document.getElementById('modeToggleBtn');
  const compassHeadingMils = document.getElementById('compassHeadingMils');
  const compassCardinal = document.getElementById('compassCardinal');

  const resDirectDist = document.getElementById('resDirectDist');
  const resDeltaH = document.getElementById('resDeltaH');
  const resBearing = document.getElementById('resBearing');
  const resUtm = document.getElementById('resUtm');

  const btnMeasure = document.getElementById('btnMeasure');
  const btnClear = document.getElementById('btnClear');

  let toastTimer = null;
  function showToast(message, duration = 2500) {
    if (!statusToast) return;
    statusToast.textContent = message;
    statusToast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      statusToast.classList.remove('visible');
    }, duration);
  }

  function getCardinal(deg) {
    const cardinals = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
    const idx = Math.round(deg / 22.5) % 16;
    return cardinals[idx];
  }

  // ─── 1. GESTOR DE SENSORES ───────────────────────────────────────────────
  const sensorMgr = new window.SensorManager();

  sensorMgr.onGpsUpdate = (gps) => {
    if (gpsDot) {
      gpsDot.className = `gps-dot ${gps.status || 'yellow'}`;
    }

    if (cesiumMap) {
      cesiumMap.updateUserPosition(gps.lat, gps.lng, gps.alt);
    }
  };

  sensorMgr.onOrientationUpdate = (ori) => {
    const GeoMath = window.GeoMath;
    const mils = GeoMath ? GeoMath.degreesToMils(ori.heading) : Math.round((ori.heading * 6400) / 360);

    compassHeadingMils.textContent = GeoMath ? GeoMath.formatMils(mils) : `${mils} ₥`;
    compassCardinal.textContent = getCardinal(ori.heading);

    if (cesiumMap) {
      cesiumMap.updateDeviceOrientation(ori.heading, ori.pitch, ori.roll);
    }
  };

  sensorMgr.onError = (err) => {
    showToast(err, 3500);
  };

  // ─── 2. MAPA 3D FOTORREALISTA ─────────────────────────────────────────────
  let cesiumMap = null;

  try {
    cesiumMap = new window.Cesium3DMap('cesiumContainer', {
      initialLat: -33.4489,
      initialLng: -70.6693,
      initialAlt: 600
    });

    cesiumMap.onStatusChange = (msg) => {
      showToast(msg, 3000);
    };

    cesiumMap.onTargetMeasured = (data) => {
      renderMeasurementResults(data);
      syncWithFirebase(data);
    };

    await cesiumMap.init();
  } catch (err) {
    console.error('Error inicializando Cesium3DMap:', err);
    showToast(`Error 3D: ${err.message}`, 5000);
  }

  // Iniciar GPS
  sensorMgr.startGps();

  // ─── 3. TELEMETRÍA Y MEDICIÓN ────────────────────────────────────────────
  function renderMeasurementResults(data) {
    const GeoMath = window.GeoMath;

    const directStr = GeoMath ? GeoMath.formatDistance(data.directDistance) : `${Math.round(data.directDistance)} m`;
    const deltaSign = data.deltaElevation >= 0 ? '+' : '';
    const deltaStr = `${deltaSign}${Math.round(data.deltaElevation)} m`;

    const mils = GeoMath ? GeoMath.degreesToMils(data.bearing) : Math.round((data.bearing * 6400) / 360);
    const bearingStr = GeoMath ? GeoMath.formatMils(mils) : `${mils} ₥`;

    resDirectDist.textContent = directStr;
    resDeltaH.textContent = deltaStr;
    resBearing.textContent = bearingStr;

    // Coordenadas UTM
    const utmStr = data.target.utm || (GeoMath ? GeoMath.latLonToUTM(data.target.lat, data.target.lng).formatted : '---');
    resUtm.textContent = utmStr;

    if (navigator.vibrate) {
      navigator.vibrate([40, 30, 60]);
    }
  }

  async function syncWithFirebase(data) {
    if (!window.TelemetryLogger) return;

    const GeoMath = window.GeoMath;
    const mils = GeoMath ? GeoMath.degreesToMils(data.bearing) : Math.round((data.bearing * 6400) / 360);

    const payload = {
      directDistanceMeters: data.directDistance,
      horizontalDistanceMeters: data.horizDistance,
      deltaElevationMeters: data.deltaElevation,
      bearingMils: mils,
      bearingDegrees: data.bearing,
      targetUtm: data.target.utm,
      userGps: {
        lat: data.user.lat,
        lng: data.user.lng,
        alt: data.user.alt
      },
      targetPoint: {
        lat: data.target.lat,
        lng: data.target.lng,
        alt: data.target.alt
      },
      viewMode: cesiumMap ? cesiumMap.viewMode : 'sensor'
    };

    window.TelemetryLogger.sendTelemetry(payload);
  }

  // ─── 4. CONTROLES DE LA INTERFAZ ──────────────────────────────────────────

  // Botón Medir al centro
  btnMeasure.addEventListener('click', async () => {
    // Activar sensores si aún no lo están
    await sensorMgr.startOrientation();

    if (!cesiumMap) return;
    const res = cesiumMap.measureCenterReticle();
    if (!res) {
      showToast('Apunta hacia el terreno o edificio para medir');
    }
  });

  // Botón Limpiar
  btnClear.addEventListener('click', () => {
    if (!cesiumMap) return;
    cesiumMap.clearTarget();
    resDirectDist.textContent = '---';
    resDeltaH.textContent = '---';
    resBearing.textContent = '---';
    resUtm.textContent = 'Toca o mide al centro';
    showToast('Objetivo limpiado');
  });

  // Botón de Modo (Icono Brújula vs Modo Libre)
  let isSensorMode = true;
  modeToggleBtn.addEventListener('click', async () => {
    await sensorMgr.startOrientation();

    if (!cesiumMap) return;
    isSensorMode = !isSensorMode;

    if (isSensorMode) {
      modeToggleBtn.classList.add('active');
      cesiumMap.setViewMode('sensor');
      showToast('Brújula activada: Sigue tu orientación.');
    } else {
      modeToggleBtn.classList.remove('active');
      cesiumMap.setViewMode('free');
      showToast('Modo libre: Arrastra y haz zoom con los dedos.');
    }
  });

  // Activar sensores al primer toque en cualquier parte de la pantalla
  const activateSensorsOnGesture = async () => {
    await sensorMgr.startOrientation();
    window.removeEventListener('touchstart', activateSensorsOnGesture);
    window.removeEventListener('click', activateSensorsOnGesture);
  };
  window.addEventListener('touchstart', activateSensorsOnGesture, { once: true });
  window.addEventListener('click', activateSensorsOnGesture, { once: true });

});
