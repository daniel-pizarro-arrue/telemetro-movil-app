/**
 * app.js - Flujo táctico de inicio aéreo, confirmación de posición, descenso y primera persona
 */

document.addEventListener('DOMContentLoaded', async () => {
  'use strict';

  // ─── ELEMENTOS DOM ────────────────────────────────────────────────────────
  const statusToast = document.getElementById('statusToast');
  const gpsBadge = document.getElementById('gpsBadge');
  const gpsDot = document.getElementById('gpsDot');
  const gpsText = document.getElementById('gpsText');

  const compassRibbon = document.getElementById('compassRibbon');
  const compassHeadingMils = document.getElementById('compassHeadingMils');
  const compassCardinal = document.getElementById('compassCardinal');

  const centerLocationPin = document.getElementById('centerLocationPin');
  const locationConfirmCard = document.getElementById('locationConfirmCard');
  const btnConfirmLocation = document.getElementById('btnConfirmLocation');

  const postureBtn = document.getElementById('postureBtn');
  const postureIcon = document.getElementById('postureIcon');
  const modeToggleBtn = document.getElementById('modeToggleBtn');

  const reticleContainer = document.getElementById('reticleContainer');
  const telemetryCard = document.getElementById('telemetryCard');
  const bottomActions = document.getElementById('bottomActions');
  const btnMeasure = document.getElementById('btnMeasure');
  const btnClear = document.getElementById('btnClear');

  const resDirectDist = document.getElementById('resDirectDist');
  const resDeltaH = document.getElementById('resDeltaH');
  const resBearing = document.getElementById('resBearing');
  const resUtm = document.getElementById('resUtm');

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

  function updateGpsUI(status, customLabel) {
    const st = status || 'connecting';
    const colorClass = st === 'connected' ? 'green' : (st === 'disconnected' ? 'red' : 'yellow');

    if (gpsBadge) {
      gpsBadge.className = `gps-badge ${colorClass}`;
    }
    if (gpsDot) {
      gpsDot.className = `gps-dot ${colorClass}`;
    }
    if (gpsText) {
      if (customLabel) {
        gpsText.textContent = customLabel;
      } else if (st === 'connected') {
        gpsText.textContent = 'GPS FIJADO';
      } else if (st === 'disconnected') {
        gpsText.textContent = 'SIN GPS';
      } else {
        gpsText.textContent = 'BUSCANDO...';
      }
    }
  }

  // ─── POSTURAS TÁCTICAS DEL OBSERVADOR (SVGs SOBRIOS) ───────────────────
  const POSTURE_SVGS = {
    standing: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="4" r="2" fill="currentColor"/>
      <line x1="12" y1="6" x2="12" y2="13"/>
      <line x1="9" y1="9" x2="15" y2="9"/>
      <polyline points="9,20 12,13 15,20"/>
    </svg>`,
    kneeling: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="9" cy="5" r="2" fill="currentColor"/>
      <path d="M9 7v6l4 1"/>
      <path d="M7 10h4"/>
      <path d="M13 14v6"/>
      <line x1="8" y1="20" x2="14" y2="20"/>
    </svg>`,
    prone: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="5" cy="13" r="2" fill="currentColor"/>
      <line x1="7" y1="14" x2="17" y2="14"/>
      <polyline points="7,16 9,14 11,16"/>
      <polyline points="15,14 19,17 21,16"/>
      <line x1="2" y1="19" x2="22" y2="19" stroke-dasharray="2 2" opacity="0.6"/>
    </svg>`
  };

  const POSTURES = [
    { name: 'De pie', height: 1.6, key: 'standing' },
    { name: 'Arrodillado', height: 0.9, key: 'kneeling' },
    { name: 'Tendido', height: 0.3, key: 'prone' }
  ];
  let currentPostureIndex = 0; // 0 = De pie (1.6m) por defecto

  // ─── RECUPERAR ÚLTIMA UBICACIÓN GUARDADA O DEFECTO ────────────────────────
  let initialLocation = { lat: -33.4489, lng: -70.6693, alt: 600 };
  try {
    const saved = localStorage.getItem('telemetro_last_pos');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.lat && parsed.lng) {
        initialLocation.lat = parsed.lat;
        initialLocation.lng = parsed.lng;
      }
    }
  } catch (e) {}

  // ─── 1. INICIALIZAR MOTOR 3D CESIUM (VISTA AÉREA INICIAL) ─────────────────
  let cesiumMap = null;
  let hasGpsFlown = false;
  let hasConfirmedLocation = false;
  let isCompassActive = false; // Brújula por defecto "desactivada"

  try {
    cesiumMap = new window.Cesium3DMap('cesiumContainer', {
      initialLat: initialLocation.lat,
      initialLng: initialLocation.lng,
      initialAlt: initialLocation.alt
    });

    cesiumMap.onStatusChange = (msg) => {
      showToast(msg, 2500);
    };

    cesiumMap.onTargetMeasured = (data) => {
      renderMeasurementResults(data);
      syncWithFirebase(data);
    };

    // Actualizar cinta de rumbo en rotación táctil in-place
    cesiumMap.onOrientationChanged = (heading, pitch) => {
      const GeoMath = window.GeoMath;
      const mils = GeoMath ? GeoMath.degreesToMils(heading) : Math.round((heading * 6400) / 360);
      compassHeadingMils.textContent = GeoMath ? GeoMath.formatMils(mils) : `${mils} ₥`;
      compassCardinal.textContent = getCardinal(heading);
    };

    await cesiumMap.init();
  } catch (err) {
    console.error('Error inicializando Cesium3DMap:', err);
    showToast(`Error 3D: ${err.message}`, 5000);
  }

  // ─── 2. GESTOR DE SENSORES Y GPS ──────────────────────────────────────────
  const sensorMgr = new window.SensorManager();

  sensorMgr.onGpsUpdate = (gps) => {
    updateGpsUI(gps.status);
  };

  // Se activa exactamente UNA vez cuando se tiene certeza de las coordenadas reales:
  sensorMgr.onGpsLocked = (finalGps) => {
    updateGpsUI('connected', 'GPS FIJADO');
    showToast(`📍 Posición confirmada (±${Math.round(finalGps.accuracy)}m). Volando a tu ubicación...`, 3000);

    // Vuelo aéreo cenital único a la posición del usuario:
    if (cesiumMap && !hasConfirmedLocation && !hasGpsFlown) {
      hasGpsFlown = true;
      cesiumMap.setAerialView(finalGps.lat, finalGps.lng, 600, true);
    }
  };

  sensorMgr.onOrientationUpdate = (ori) => {
    const GeoMath = window.GeoMath;
    const mils = GeoMath ? GeoMath.degreesToMils(ori.heading) : Math.round((ori.heading * 6400) / 360);

    compassHeadingMils.textContent = GeoMath ? GeoMath.formatMils(mils) : `${mils} ₥`;
    compassCardinal.textContent = getCardinal(ori.heading);

    // Solo rota la cámara si la brújula está ACTIVADA por el usuario
    if (cesiumMap && isCompassActive) {
      cesiumMap.updateDeviceOrientation(ori.heading, ori.pitch, ori.roll);
    }
  };

  sensorMgr.onError = (err) => {
    showToast(err, 3500);
  };

  // Iniciar búsqueda de satélites GPS
  sensorMgr.startGps();

  // ─── 3. FASE: CONFIRMACIÓN DE UBICACIÓN (PIN CENTRAL) ─────────────────────
  btnConfirmLocation.addEventListener('click', async () => {
    if (!cesiumMap) return;

    // Obtener las coordenadas exactas del centro de la pantalla bajo el pin
    const centerCoords = cesiumMap.getCenterCoordinates();

    // Guardar para el próximo inicio
    try {
      localStorage.setItem('telemetro_last_pos', JSON.stringify({
        lat: centerCoords.lat,
        lng: centerCoords.lng
      }));
    } catch (e) {}

    hasConfirmedLocation = true;

    // Ocultar pin central y botón de confirmación
    if (centerLocationPin) centerLocationPin.classList.add('hidden');
    if (btnConfirmLocation) btnConfirmLocation.classList.add('hidden');

    // Descenso cinemático suave mirando al horizonte
    const currentPosture = POSTURES[currentPostureIndex];
    await cesiumMap.descendToGround(centerCoords.lat, centerCoords.lng, currentPosture.height);

    // Activar elementos de primera persona
    compassRibbon.classList.remove('hidden');
    postureBtn.classList.remove('hidden');
    modeToggleBtn.classList.remove('hidden');
    reticleContainer.classList.remove('hidden');
    bottomActions.classList.remove('hidden');

    // Nota: El cuadro de información central se mantiene oculto por el momento según instrucción

    showToast('Posición fijada. Ajusta postura o activa la brújula.', 3500);
  });

  // ─── 4. BOTÓN DE POSTURA (DE PIE / ARRODILLADO / TENDIDO) ─────────────────
  postureBtn.addEventListener('click', () => {
    if (!cesiumMap) return;

    // Ciclar a la siguiente postura
    currentPostureIndex = (currentPostureIndex + 1) % POSTURES.length;
    const posture = POSTURES[currentPostureIndex];

    postureIcon.innerHTML = POSTURE_SVGS[posture.key];
    postureBtn.title = `Postura: ${posture.name} (${posture.height}m)`;

    cesiumMap.setPostureHeight(posture.height);
    showToast(`Postura: ${posture.name} (${posture.height}m)`, 2000);
  });

  // ─── 5. BOTÓN DE BRÚJULA (ACTIVADA / DESACTIVADA) ─────────────────────────
  modeToggleBtn.addEventListener('click', async () => {
    if (!cesiumMap) return;

    isCompassActive = !isCompassActive;

    if (isCompassActive) {
      await sensorMgr.startOrientation();
      modeToggleBtn.classList.add('active');
      cesiumMap.setControlMode('first_person_sensor');
      showToast('🧭 Brújula activada: El mapa sigue el teléfono.', 2500);
    } else {
      modeToggleBtn.classList.remove('active');
      cesiumMap.setControlMode('first_person_free');
      showToast('👆 Brújula desactivada: Arrastra libremente con los dedos.', 2500);
    }
  });

  // ─── 6. DISPARO / MEDICIÓN AL CENTRO ──────────────────────────────────────
  btnMeasure.addEventListener('click', () => {
    if (!cesiumMap) return;
    const res = cesiumMap.measureCenterReticle();
    if (!res) {
      showToast('Apunta hacia el terreno o edificio para medir');
    }
  });

  btnClear.addEventListener('click', () => {
    if (!cesiumMap) return;
    cesiumMap.clearTarget();
    showToast('Objetivo limpiado');
  });

  function renderMeasurementResults(data) {
    const GeoMath = window.GeoMath;
    const directStr = GeoMath ? GeoMath.formatDistance(data.directDistance) : `${Math.round(data.directDistance)} m`;
    const deltaSign = data.deltaElevation >= 0 ? '+' : '';
    const deltaStr = `${deltaSign}${Math.round(data.deltaElevation)} m`;
    const mils = GeoMath ? GeoMath.degreesToMils(data.bearing) : Math.round((data.bearing * 6400) / 360);
    const bearingStr = GeoMath ? GeoMath.formatMils(mils) : `${mils} ₥`;

    if (resDirectDist) resDirectDist.textContent = directStr;
    if (resDeltaH) resDeltaH.textContent = deltaStr;
    if (resBearing) resBearing.textContent = bearingStr;
    if (resUtm) resUtm.textContent = data.target.utm || '---';

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
      posture: POSTURES[currentPostureIndex].name,
      postureHeightMeters: POSTURES[currentPostureIndex].height,
      userGps: {
        lat: data.user.lat,
        lng: data.user.lng,
        alt: data.user.alt
      },
      targetPoint: {
        lat: data.target.lat,
        lng: data.target.lng,
        alt: data.target.alt
      }
    };

    window.TelemetryLogger.sendTelemetry(payload);
  }

});
