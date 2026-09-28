/**
 * app.js - Orquestador principal del Telémetro Móvil 3D
 * Conecta Cesium3DMap, SensorManager, GeoMath y TelemetryLogger.
 */

document.addEventListener('DOMContentLoaded', async () => {
  'use strict';

  // ─── ELEMENTOS DOM ────────────────────────────────────────────────────────
  const statusToast = document.getElementById('statusToast');
  const gpsStatusChip = document.getElementById('gpsStatusChip');
  const modeToggleBtn = document.getElementById('modeToggleBtn');
  const compassHeading = document.getElementById('compassHeading');
  const compassPitch = document.getElementById('compassPitch');
  const compassCardinal = document.getElementById('compassCardinal');
  const reticlePitchBadge = document.getElementById('reticlePitchBadge');
  const headingOffsetRange = document.getElementById('headingOffsetRange');
  const headingOffsetVal = document.getElementById('headingOffsetVal');

  const resDirectDist = document.getElementById('resDirectDist');
  const resHorizDist = document.getElementById('resHorizDist');
  const resDeltaH = document.getElementById('resDeltaH');
  const resBearing = document.getElementById('resBearing');
  const resAngle = document.getElementById('resAngle');
  const resCoords = document.getElementById('resCoords');
  const firebaseIndicator = document.getElementById('firebaseIndicator');
  const firebaseText = document.getElementById('firebaseText');

  const btnSensors = document.getElementById('btnSensors');
  const btnMeasure = document.getElementById('btnMeasure');
  const btnFreeze = document.getElementById('btnFreeze');
  const btnClear = document.getElementById('btnClear');

  let toastTimer = null;
  function showToast(message, duration = 3000) {
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

  // ─── 1. INICIALIZAR GESTOR DE SENSORES ────────────────────────────────────
  const sensorMgr = new window.SensorManager();

  sensorMgr.onGpsUpdate = (gps) => {
    const accStr = gps.accuracy ? `±${Math.round(gps.accuracy)}m` : '';
    const altStr = gps.alt ? `Alt: ${Math.round(gps.alt)}m` : '';
    gpsStatusChip.textContent = `GPS: ${accStr} ${altStr}`.trim();
    gpsStatusChip.classList.add('active');

    if (cesiumMap) {
      cesiumMap.updateUserPosition(gps.lat, gps.lng, gps.alt);
    }
  };

  sensorMgr.onOrientationUpdate = (ori) => {
    const heading360 = Math.round(ori.heading);
    const pitchVal = ori.pitch.toFixed(1);

    compassHeading.textContent = `${heading360.toString().padStart(3, '0')}°`;
    compassCardinal.textContent = getCardinal(heading360);
    compassPitch.textContent = `${pitchVal > 0 ? '+' : ''}${pitchVal}°`;
    reticlePitchBadge.textContent = `${pitchVal > 0 ? '+' : ''}${Math.round(ori.pitch)}°`;

    if (cesiumMap) {
      cesiumMap.updateDeviceOrientation(ori.heading, ori.pitch, ori.roll);
    }
  };

  sensorMgr.onError = (err) => {
    showToast(err, 4000);
  };

  // ─── 2. INICIALIZAR MAPA 3D CON GOOGLE 3D TILES ───────────────────────────
  let cesiumMap = null;

  try {
    cesiumMap = new window.Cesium3DMap('cesiumContainer', {
      initialLat: -33.4489,
      initialLng: -70.6693,
      initialAlt: 600
    });

    cesiumMap.onStatusChange = (msg) => {
      showToast(msg, 3500);
    };

    cesiumMap.onTargetMeasured = (data) => {
      renderMeasurementResults(data);
      syncWithFirebase(data);
    };

    await cesiumMap.init();
  } catch (err) {
    console.error('Error al inicializar mapa 3D:', err);
    showToast(`Error 3D: ${err.message}`, 6000);
  }

  // Iniciar GPS automáticamente
  sensorMgr.startGps();

  // ─── 3. CONTROL DE MEDICIONES Y TELEMETRÍA ────────────────────────────────
  function renderMeasurementResults(data) {
    const GeoMath = window.GeoMath;
    const directStr = GeoMath ? GeoMath.formatDistance(data.directDistance) : `${Math.round(data.directDistance)} m`;
    const horizStr = GeoMath ? GeoMath.formatDistance(data.horizDistance) : `${Math.round(data.horizDistance)} m`;
    const deltaSign = data.deltaElevation >= 0 ? '+' : '';
    const deltaStr = `${deltaSign}${Math.round(data.deltaElevation)} m`;

    resDirectDist.textContent = directStr;
    resHorizDist.textContent = horizStr;
    resDeltaH.textContent = deltaStr;
    resBearing.textContent = `${Math.round(data.bearing)}° (${getCardinal(data.bearing)})`;
    resAngle.textContent = `${data.elevAngle >= 0 ? '+' : ''}${data.elevAngle.toFixed(1)}°`;

    const tgt = data.target;
    resCoords.textContent = `${tgt.lat.toFixed(5)}°, ${tgt.lng.toFixed(5)}° (Cota: ${Math.round(tgt.alt)}m)`;

    // Efecto háptico sutil al medir
    if (navigator.vibrate) {
      navigator.vibrate([40, 30, 60]);
    }
  }

  async function syncWithFirebase(data) {
    if (!window.TelemetryLogger) return;
    firebaseIndicator.style.color = '#f59e0b';
    firebaseText.textContent = 'Enviando a Firebase...';

    const payload = {
      directDistanceMeters: data.directDistance,
      horizontalDistanceMeters: data.horizDistance,
      deltaElevationMeters: data.deltaElevation,
      bearingDegrees: data.bearing,
      elevationAngleDegrees: data.elevAngle,
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
      compassOffset: cesiumMap ? cesiumMap.headingOffset : 0,
      viewMode: cesiumMap ? cesiumMap.viewMode : 'sensor'
    };

    const ok = await window.TelemetryLogger.sendTelemetry(payload);
    if (ok) {
      firebaseIndicator.style.color = '#10b981';
      firebaseText.textContent = 'Sincronizado con Firebase RTDB';
    } else {
      firebaseIndicator.style.color = '#ef4444';
      firebaseText.textContent = 'Error al enviar telemetría';
    }
  }

  // ─── 4. INTERACCIÓN DE BOTONES Y CONTROLES ─────────────────────────────────

  // Botón Medir
  btnMeasure.addEventListener('click', () => {
    if (!cesiumMap) return;
    const res = cesiumMap.measureCenterReticle();
    if (!res) {
      showToast('Apunta hacia el terreno o edificio antes de medir');
    }
  });

  // Botón Activar Sensores
  btnSensors.addEventListener('click', async () => {
    const ok = await sensorMgr.startOrientation();
    if (ok) {
      btnSensors.classList.add('active-toggle');
      showToast('Sensores activados. Gira el teléfono.');
    }
  });

  // Botón Congelar / Descongelar
  let isFrozen = false;
  btnFreeze.addEventListener('click', () => {
    if (!cesiumMap) return;
    isFrozen = !isFrozen;
    cesiumMap.setFrozen(isFrozen);
    if (isFrozen) {
      btnFreeze.classList.add('active-toggle');
      btnFreeze.innerHTML = '▶️ SEGUIR';
      showToast('Vista fijada para medición precisa.');
    } else {
      btnFreeze.classList.remove('active-toggle');
      btnFreeze.innerHTML = '❄️ FIJAR';
      showToast('Siguiendo sensores en tiempo real.');
    }
  });

  // Botón Limpiar
  btnClear.addEventListener('click', () => {
    if (!cesiumMap) return;
    cesiumMap.clearTarget();
    resDirectDist.textContent = '---';
    resHorizDist.textContent = '---';
    resDeltaH.textContent = '---';
    resBearing.textContent = '---';
    resAngle.textContent = '---';
    resCoords.textContent = 'Toca un punto o dispara al centro';
    showToast('Objetivo limpiado');
  });

  // Alternar Modo Brújula vs Navegación Libre
  let currentMode = 'sensor';
  modeToggleBtn.addEventListener('click', () => {
    if (!cesiumMap) return;
    if (currentMode === 'sensor') {
      currentMode = 'free';
      modeToggleBtn.textContent = 'MODO: LIBRE / TÁCTIL';
      modeToggleBtn.classList.remove('active');
      cesiumMap.setViewMode('free');
      showToast('Modo libre activado: Arrastra y haz zoom con los dedos.');
    } else {
      currentMode = 'sensor';
      modeToggleBtn.textContent = 'MODO: BRÚJULA';
      modeToggleBtn.classList.add('active');
      cesiumMap.setViewMode('sensor');
      showToast('Modo brújula activo: El mapa sigue tu teléfono.');
    }
  });

  // Control deslizante de calibración de rumbo
  headingOffsetRange.addEventListener('input', (e) => {
    const offset = parseInt(e.target.value, 10);
    headingOffsetVal.textContent = `${offset > 0 ? '+' : ''}${offset}°`;
    if (cesiumMap) {
      cesiumMap.setHeadingOffset(offset);
    }
  });

  // Intentar iniciar orientación automáticamente al primer toque
  const triggerSensorsOnGesture = async () => {
    await sensorMgr.startOrientation();
    window.removeEventListener('touchstart', triggerSensorsOnGesture);
    window.removeEventListener('click', triggerSensorsOnGesture);
  };
  window.addEventListener('touchstart', triggerSensorsOnGesture, { once: true });
  window.addEventListener('click', triggerSensorsOnGesture, { once: true });

});
