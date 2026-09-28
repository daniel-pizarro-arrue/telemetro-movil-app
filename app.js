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
  const opticsZoomLevel = document.getElementById('opticsZoomLevel');

  const heightControlWidget = document.getElementById('heightControlWidget');
  const btnHeightUp = document.getElementById('btnHeightUp');
  const btnHeightDown = document.getElementById('btnHeightDown');
  const heightDisplayVal = document.getElementById('heightDisplayVal');

  const centerLocationPin = document.getElementById('centerLocationPin');
  const locationConfirmCard = document.getElementById('locationConfirmCard');
  const btnConfirmLocation = document.getElementById('btnConfirmLocation');

  const mapProgressOverlay = document.getElementById('mapProgressOverlay');
  const mapProgressFill = document.getElementById('mapProgressFill');
  const mapProgressPct = document.getElementById('mapProgressPct');
  const mapProgressSub = document.getElementById('mapProgressSub');

  const postureBtn = document.getElementById('postureBtn');
  const postureIcon = document.getElementById('postureIcon');
  const modeToggleBtn = document.getElementById('modeToggleBtn');

  const reticleContainer = document.getElementById('reticleContainer');
  const telemetryCard = document.getElementById('telemetryCard');
  const bottomActions = document.getElementById('bottomActions');
  const btnMeasure = document.getElementById('btnMeasure');
  const btnClear = document.getElementById('btnClear');

  const configBtn = document.getElementById('configBtn');
  const configPanel = document.getElementById('configPanel');
  const configPanelClose = document.getElementById('configPanelClose');
  const toggleBuildingsBtn = document.getElementById('toggleBuildingsBtn');
  const changeLocationBtn = document.getElementById('changeLocationBtn');

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

  function updateMapProgress(percent, subtitle) {
    if (mapProgressOverlay) mapProgressOverlay.classList.remove('hidden');
    if (mapProgressFill) mapProgressFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    if (mapProgressPct) mapProgressPct.textContent = `${Math.round(percent)}%`;
    if (mapProgressSub && subtitle) mapProgressSub.textContent = subtitle;
  }

  function hideMapProgress() {
    if (mapProgressOverlay) {
      mapProgressOverlay.classList.add('hidden');
    }
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

  // ─── POSTURAS TÁCTICAS DEL OBSERVADOR (SVGs ANATÓMICOS Y SOBRIOS) ───────
  const POSTURE_SVGS = {
    standing: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 21h16" stroke-width="1.5" opacity="0.3"/>
      <circle cx="12" cy="4" r="2" fill="currentColor"/>
      <path d="M12 6.5v7"/>
      <path d="M8 10h8"/>
      <path d="M9 21l3-7.5 3 7.5"/>
    </svg>`,
    kneeling: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 21h18" stroke-width="1.5" opacity="0.3"/>
      <circle cx="10" cy="6" r="2" fill="currentColor"/>
      <path d="M10 8l-1 6"/>
      <path d="M9 14l-4 7"/>
      <path d="M9 14l6 1v6"/>
      <path d="M10 9.5l5 5.5"/>
    </svg>`,
    prone: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 21h18" stroke-width="1.5" opacity="0.3"/>
      <circle cx="6" cy="14" r="2" fill="currentColor"/>
      <path d="M8 16l6 1.5 7 1.5"/>
      <path d="M8.5 16l-1.5 5 3-3"/>
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
        if (parsed.alt) initialLocation.alt = parsed.alt;
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

    // Actualizar cinta de rumbo en rotación táctil in-place (solo milésimas)
    cesiumMap.onOrientationChanged = (heading, pitch) => {
      const GeoMath = window.GeoMath;
      const mils = GeoMath ? GeoMath.degreesToMils(heading) : Math.round((heading * 6400) / 360);
      compassHeadingMils.textContent = GeoMath ? GeoMath.formatMils(mils) : `${mils} ₥`;
    };

    // Actualizar indicador de aumento óptico en zoom / pellizco
    cesiumMap.onZoomChanged = (magnification, fov) => {
      if (opticsZoomLevel) {
        opticsZoomLevel.textContent = `${magnification.toFixed(1)}x`;
      }
    };

    // Sincronizar display numérico de altura
    cesiumMap.onHeightChanged = (h) => {
      if (heightDisplayVal) {
        heightDisplayVal.textContent = h.toFixed(1);
      }
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

  /**
   * Flujo reutilizable: precarga del área + descenso al suelo + activar HUD de primera persona.
   * Se llama tanto en la confirmación inicial como al cambiar de ubicación.
   */
  async function processConfirmAndDescend() {
    if (!cesiumMap) return;

    const centerCoords = cesiumMap.getCenterCoordinates();

    // Guardar para el próximo inicio
    try {
      localStorage.setItem('telemetro_last_pos', JSON.stringify({
        lat: centerCoords.lat,
        lng: centerCoords.lng,
        alt: centerCoords.alt
      }));
    } catch (e) {}

    hasConfirmedLocation = true;

    // Ocultar pin central y botón de confirmación
    if (centerLocationPin) centerLocationPin.classList.add('hidden');
    if (btnConfirmLocation) btnConfirmLocation.classList.add('hidden');

    // 1. Mostrar barra de progreso de descarga del mapa
    updateMapProgress(5, 'Iniciando descarga de geometría y texturas (5 km)...');

    // 2. Precargar malla 3D en radio de 5km (descarga incremental: omite sectores ya en caché)
    await cesiumMap.preloadRadius5km(centerCoords.lat, centerCoords.lng, (percent, label) => {
      updateMapProgress(percent, label);
    });

    await new Promise((r) => setTimeout(r, 350));
    hideMapProgress();

    // 3. Descenso cinemático inmersivo a la cota real del suelo
    const currentPosture = POSTURES[currentPostureIndex];
    await cesiumMap.descendToGround(centerCoords.lat, centerCoords.lng, centerCoords.alt, currentPosture.height);

    // 4. Activar elementos de primera persona
    compassRibbon.classList.remove('hidden');
    postureBtn.classList.remove('hidden');
    modeToggleBtn.classList.remove('hidden');
    if (configBtn) configBtn.classList.remove('hidden');
    if (heightControlWidget) heightControlWidget.classList.remove('hidden');
    reticleContainer.classList.remove('hidden');
    bottomActions.classList.remove('hidden');

    showToast('Entorno 3D listo. Posición confirmada.', 3500);
  }

  btnConfirmLocation.addEventListener('click', async () => {
    await processConfirmAndDescend();
  });

  // ─── 3.1. CAMBIAR UBICACIÓN (desde panel de configuración) ─────────────────
  if (changeLocationBtn) {
    changeLocationBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!cesiumMap) return;

      // Cerrar el panel de configuración
      closeConfigPanel();

      // Ocultar todos los elementos de primera persona
      compassRibbon.classList.add('hidden');
      postureBtn.classList.add('hidden');
      modeToggleBtn.classList.add('hidden');
      if (configBtn) configBtn.classList.add('hidden');
      if (heightControlWidget) heightControlWidget.classList.add('hidden');
      reticleContainer.classList.add('hidden');
      bottomActions.classList.add('hidden');
      if (telemetryCard) telemetryCard.classList.add('hidden');

      // Limpiar el objetivo si hay uno dibujado
      cesiumMap.clearTarget();

      // Desactivar brújula si estaba activa
      if (isCompassActive) {
        isCompassActive = false;
        modeToggleBtn.classList.remove('active');
        cesiumMap.setControlMode('aerial');
      }

      // Volver a vista aérea sobre la última posición confirmada
      cesiumMap.setAerialView(cesiumMap.userLat, cesiumMap.userLng, 600, true);

      // Mostrar el pin y el botón de confirmación de nuevo
      hasConfirmedLocation = false;
      if (centerLocationPin) centerLocationPin.classList.remove('hidden');
      if (btnConfirmLocation) btnConfirmLocation.classList.remove('hidden');

      showToast('📍 Reposiciona el pin y toca CONFIRMAR', 4000);
    });
  }


  // ─── 4. BOTÓN DE POSTURA (DE PIE / ARRODILLADO / TENDIDO) ─────────────────
  postureBtn.addEventListener('click', () => {
    if (!cesiumMap) return;

    // Ciclar a la siguiente postura
    currentPostureIndex = (currentPostureIndex + 1) % POSTURES.length;
    const posture = POSTURES[currentPostureIndex];

    postureIcon.innerHTML = POSTURE_SVGS[posture.key];
    postureBtn.title = `Postura: ${posture.name} (${posture.height}m)`;

    cesiumMap.setPostureHeight(posture.height);
    if (heightDisplayVal) {
      heightDisplayVal.textContent = posture.height.toFixed(1);
    }
    showToast(`Postura: ${posture.name} (${posture.height}m)`, 2000);
  });

  // ─── 4.1. CONTROL DE AJUSTE FINO DE ALTURA (STEPPER CON PRESS-AND-HOLD) ───
  function setupHeightStepper() {
    if (!btnHeightUp || !btnHeightDown) return;

    let holdInterval = null;

    function step(delta) {
      if (!cesiumMap) return;
      const newH = cesiumMap.adjustHeight(delta);
      if (heightDisplayVal) heightDisplayVal.textContent = newH.toFixed(1);
    }

    function bindButton(btn, delta) {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation(); // Evitar que el evento llegue al canvas de Cesium
        step(delta);
        clearInterval(holdInterval);
        holdInterval = setInterval(() => {
          step(delta);
        }, 80);
      });

      const stopHold = (e) => {
        e && e.stopPropagation && e.stopPropagation();
        clearInterval(holdInterval);
      };

      btn.addEventListener('pointerup', stopHold);
      btn.addEventListener('pointerleave', stopHold);
      btn.addEventListener('pointercancel', stopHold);
    }

    bindButton(btnHeightUp, +0.2);
    bindButton(btnHeightDown, -0.2);
  }

  setupHeightStepper();

  // ─── 4.2. BOTÓN DE CONFIGURACIÓN Y PANEL ─────────────────────────────────
  let configPanelOpen = false;

  function openConfigPanel() {
    if (!configPanel) return;
    configPanelOpen = true;
    configPanel.classList.remove('hidden');
  }

  function closeConfigPanel() {
    if (!configPanel) return;
    configPanelOpen = false;
    configPanel.classList.add('hidden');
  }

  if (configBtn) {
    configBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (configPanelOpen) {
        closeConfigPanel();
      } else {
        openConfigPanel();
      }
    });
  }

  if (configPanelClose) {
    configPanelClose.addEventListener('click', (e) => {
      e.stopPropagation();
      closeConfigPanel();
    });
  }

  // Cerrar el panel al tocar fuera de él
  document.addEventListener('pointerdown', (e) => {
    if (!configPanelOpen) return;
    if (configPanel && !configPanel.contains(e.target) && e.target !== configBtn) {
      closeConfigPanel();
    }
  });

  // Toggle de Edificios y Estructuras 3D
  let buildingsVisible = true;
  if (toggleBuildingsBtn) {
    toggleBuildingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!cesiumMap) return;
      buildingsVisible = cesiumMap.toggleBuildings(!buildingsVisible);
      if (buildingsVisible) {
        toggleBuildingsBtn.classList.add('active');
      } else {
        toggleBuildingsBtn.classList.remove('active');
      }
    });
  }

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
