/**
 * app.js - Controlador principal del Telémetro Móvil 3D
 * Integra la cámara, retícula táctica, fusión sensorial y trazado de rayos DEM.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Erradicar de inmediato cualquier badge, iframe o drawer inyectado por Netlify
  const cleanNetlifyInjections = () => {
    const selectors = [
      'netlify-drawer',
      '[class*="netlify"]',
      '[id*="netlify"]',
      'iframe[src*="netlify"]',
      'iframe[id*="netlify"]',
      '[data-netlify-deploy-id]',
      '#netlify-badge',
      '.netlify-badge'
    ];
    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        try { el.remove(); } catch (e) {}
      });
    });
  };
  cleanNetlifyInjections();
  const netlifyObserver = new MutationObserver(cleanNetlifyInjections);
  netlifyObserver.observe(document.documentElement, { childList: true, subtree: true });

  // Elementos del DOM
  const cameraStream = document.getElementById('camera-stream');
  const cameraPlaceholder = document.getElementById('camera-placeholder');
  const btnStartCamera = document.getElementById('btn-start-camera');

  const hudAzimuth = document.getElementById('hud-azimuth');
  const hudPitch = document.getElementById('hud-pitch');
  const hudRoll = document.getElementById('hud-roll');
  const compassTape = document.getElementById('compass-tape');
  const artificialHorizon = document.getElementById('artificial-horizon');

  const gpsCoords = document.getElementById('gps-coords');
  const gpsAccuracy = document.getElementById('gps-accuracy');
  const gpsTerrainAlt = document.getElementById('gps-terrain-alt');

  const btnMeasure = document.getElementById('btn-measure');
  const telemetrySheet = document.getElementById('telemetry-sheet');
  const btnCloseSheet = document.getElementById('btn-close-sheet');
  const sheetCloseHandle = document.getElementById('sheet-close-handle');

  const resSlantRange = document.getElementById('res-slant-range');
  const resHorizontalDist = document.getElementById('res-horizontal-dist');
  const resDeltaAlt = document.getElementById('res-delta-alt');
  const resPitch = document.getElementById('res-pitch');
  const resAzimuth = document.getElementById('res-azimuth');
  const resTargetCoords = document.getElementById('res-target-coords');
  const resTargetAlt = document.getElementById('res-target-alt');
  const btnOpenMaps = document.getElementById('btn-open-maps');
  const terrainCanvas = document.getElementById('terrain-canvas');
  const toastMsg = document.getElementById('toast-msg');

  // Elementos del Motor 3D AR y Visión Sintética
  const svsCanvas = document.getElementById('svs-canvas');
  const btnModeLaser = document.getElementById('btn-mode-laser');
  const btnModeSvs = document.getElementById('btn-mode-svs');
  const svsToolbar = document.getElementById('svs-toolbar');
  const btnSvsFreeze = document.getElementById('btn-svs-freeze');
  const svsFreezeIcon = document.getElementById('svs-freeze-icon');
  const svsFreezeText = document.getElementById('svs-freeze-text');
  const sliderSvsOpacity = document.getElementById('slider-svs-opacity');
  const valSvsOpacity = document.getElementById('val-svs-opacity');
  const btnSvsZoomIn = document.getElementById('btn-svs-zoom-in');
  const btnSvsZoomOut = document.getElementById('btn-svs-zoom-out');
  const valSvsZoom = document.getElementById('val-svs-zoom');
  const btnSvsMapStyle = document.getElementById('btn-svs-map-style');
  const btnSvsWireframe = document.getElementById('btn-svs-wireframe');
  const btnSvsReset = document.getElementById('btn-svs-reset');
  const svsStatusBanner = document.getElementById('svs-status-banner');
  const svsBannerText = document.getElementById('svs-banner-text');

  // Inicializar Gestor de Sensores (Milésimas 6400 y 1.60m de pie por defecto)
  const sensorMgr = new SensorFusion.SensorManager({
    postureHeight: 1.60,
    angleUnit: 'mils'
  });

  let currentAngleUnit = 'mils';
  let activeOperatingMode = 'laser'; // 'laser' o 'svs'
  let svsZoomLevel = 1.0;
  let lastHitCoords = null;
  let lastProfileData = null;
  let audioCtx = null;

  // Sintetizador de sonido táctico para disparo láser (sin archivos externos)
  function playLaserSound() {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(880, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(220, audioCtx.currentTime + 0.18);

      gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
      gain.gain.linearRampToValueAtTime(0.01, audioCtx.currentTime + 0.18);

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.start();
      osc.stop(audioCtx.currentTime + 0.18);
    } catch (e) {
      console.warn('Audio no soportado o bloqueado:', e);
    }
  }

  function showToast(text, duration = 3000) {
    toastMsg.textContent = text;
    toastMsg.classList.add('show');
    setTimeout(() => {
      toastMsg.classList.remove('show');
    }, duration);
  }

  // Activar Cámara Trasera
  async function initCamera() {
    try {
      const constraints = {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      cameraStream.srcObject = stream;
      cameraPlaceholder.style.display = 'none';
      showToast('Cámara trasera activada');
    } catch (err) {
      console.warn('No se pudo activar la cámara:', err);
      cameraPlaceholder.querySelector('p').textContent = 'Acceso a cámara no disponible';
      showToast('Cámara no disponible, usando modo HUD virtual');
    }
  }

  btnStartCamera.addEventListener('click', initCamera);

  // Iniciar Sensores y GPS
  function initSensors() {
    // 1. Geolocalización
    try {
      sensorMgr.startGPS((gps) => {
        if (gps.isAcquired && gps.lat !== null) {
          gpsCoords.textContent = `${gps.lat.toFixed(4)}, ${gps.lon.toFixed(4)}`;
          gpsAccuracy.textContent = `±${gps.accuracy}m`;
          
          if (gps.groundAlt !== null) {
            gpsTerrainAlt.textContent = `DEM: ${gps.groundAlt}m (+${sensorMgr.postureHeight}m)`;
          } else if (gps.gpsAlt !== null) {
            gpsTerrainAlt.textContent = `GPS: ${gps.gpsAlt}m`;
          }

          // Sincronizar posición de observador con el motor 3D
          if (typeof Terrain3DView !== 'undefined') {
            Terrain3DView.updateObserverPosition(gps.lat, gps.lon, gps.groundAlt, sensorMgr.postureHeight);
          }
        }
      });
    } catch (e) {
      gpsCoords.textContent = 'GPS no soportado';
    }

    // 2. Sensores de Orientación sincronizados con vsync (requestAnimationFrame)
    let hudFrameScheduled = false;
    let latestHudReadings = null;

    sensorMgr.startOrientation((readings) => {
      latestHudReadings = readings;

      // Actualizar cámara 3D de inmediato
      if (typeof Terrain3DView !== 'undefined') {
        Terrain3DView.updateOrientation(readings.azimuthTrue, readings.pitchDeg, readings.rollDeg);
      }

      if (!hudFrameScheduled) {
        hudFrameScheduled = true;
        requestAnimationFrame(() => {
          hudFrameScheduled = false;
          if (!latestHudReadings) return;
          const r = latestHudReadings;

          // Actualizar métricas HUD
          if (currentAngleUnit === 'deg') {
            hudAzimuth.textContent = `${r.azimuthTrue.toFixed(1).padStart(5, '0')}°`;
            hudPitch.textContent = `${r.pitchDeg > 0 ? '+' : ''}${r.pitchDeg.toFixed(1)}°`;
          } else {
            // Notación militar en milésimas (6400)
            hudAzimuth.textContent = `${r.azimuthMils} ₥`;
            hudPitch.textContent = `${r.pitchMils > 0 ? '+' : ''}${r.pitchMils} ₥`;
          }
          hudRoll.textContent = `${r.rollDeg > 0 ? '+' : ''}${r.rollDeg.toFixed(1)}°`;

          // Cinta de brújula superior deslizante
          const compassOffset = -(r.azimuthTrue * 1.5) % 360;
          compassTape.style.transform = `translateX(${compassOffset}px)`;

          // Horizonte artificial rotativo con el Roll de gravedad filtrado
          if (artificialHorizon) {
            artificialHorizon.style.transform = `rotate(${-r.rollDeg}deg)`;
          }
        });
      }
    }).catch(err => {
      console.warn('Sensores de orientación:', err.message);
      showToast('Toca la pantalla para autorizar sensores de movimiento');
    });
  }

  // Selectores de Postura (Altura del observador)
  document.getElementById('posture-selector').addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON') {
      document.querySelectorAll('#posture-selector .pill-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      const h = parseFloat(e.target.dataset.height);
      sensorMgr.setPostureHeight(h);
      if (sensorMgr.gps.groundAlt !== null) {
        gpsTerrainAlt.textContent = `DEM: ${sensorMgr.gps.groundAlt}m (+${h}m)`;
      }
      if (typeof Terrain3DView !== 'undefined') {
        Terrain3DView.updateObserverPosition(
          sensorMgr.gps.lat || -33.5888,
          sensorMgr.gps.lon || -70.7064,
          sensorMgr.gps.groundAlt || 485,
          h
        );
      }
      showToast(`Altura observador: ${h}m`);
    }
  });

  // Selector de Unidades (Grados vs Mils)
  document.getElementById('unit-selector').addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON') {
      document.querySelectorAll('#unit-selector .pill-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      currentAngleUnit = e.target.dataset.unit;
      showToast(`Unidad angular: ${currentAngleUnit === 'deg' ? 'Grados' : 'Milésimas artilleras'}`);
    }
  });

  // Calibración Rápida de Nivel (Cero / Tara de inclinación)
  const btnTarePitch = document.getElementById('btn-tare-pitch');
  const btnResetPitch = document.getElementById('btn-reset-pitch');

  if (btnTarePitch) {
    btnTarePitch.addEventListener('click', () => {
      sensorMgr.calibrateHorizon();
      showToast('Nivel calibrado a 0 ₥ (horizonte fijado)');
    });
  }

  if (btnResetPitch) {
    btnResetPitch.addEventListener('click', () => {
      sensorMgr.resetCalibration();
      showToast('Calibración restablecida');
    });
  }

  // Modo Pantalla Completa Táctico
  const btnFullscreen = document.getElementById('btn-fullscreen');
  if (btnFullscreen) {
    btnFullscreen.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });
    document.addEventListener('fullscreenchange', () => {
      btnFullscreen.textContent = document.fullscreenElement ? '✕' : '⛶';
    });
  }

  // ==========================================================
  // MANEJADOR DE IMPACTO POR TOQUE DIRECTO 3D AR
  // ==========================================================
  function handleTargetAcquired(metrics) {
    playLaserSound();
    if (navigator.vibrate) navigator.vibrate([45, 30, 45]);

    resSlantRange.textContent = metrics.slantRange.toLocaleString();
    resHorizontalDist.textContent = metrics.horizontalDistance.toLocaleString();
    resDeltaAlt.textContent = `${metrics.deltaHeight > 0 ? '+' : ''}${metrics.deltaHeight}`;
    
    if (currentAngleUnit === 'deg') {
      resPitch.textContent = `${metrics.pitchDeg > 0 ? '+' : ''}${metrics.pitchDeg.toFixed(1)}°`;
      resAzimuth.textContent = `${metrics.azimuthDeg.toFixed(1)}° Verdadero`;
    } else {
      const pMils = Math.round((metrics.pitchDeg / 360.0) * 6400);
      const aMils = Math.round((metrics.azimuthDeg / 360.0) * 6400);
      resPitch.textContent = `${pMils > 0 ? '+' : ''}${pMils} ₥`;
      resAzimuth.textContent = `${aMils} ₥ Verdadero (${metrics.azimuthDeg.toFixed(1)}°)`;
    }

    resTargetCoords.textContent = `${metrics.targetCoords.lat.toFixed(5)}, ${metrics.targetCoords.lon.toFixed(5)}`;
    resTargetAlt.textContent = `${metrics.targetCoords.alt} m MSL`;

    lastHitCoords = metrics.targetCoords;

    const obsAlt = (sensorMgr.gps.effectiveAlt || 486.6);
    const syntheticProfile = [
      { distance: 0, terrainAlt: (sensorMgr.gps.groundAlt || 485), rayAlt: obsAlt },
      { distance: Math.round(metrics.slantRange * 0.5), terrainAlt: Math.round(((sensorMgr.gps.groundAlt || 485) + metrics.targetCoords.alt) / 2), rayAlt: Math.round((obsAlt + metrics.targetCoords.alt) / 2) },
      { distance: metrics.slantRange, terrainAlt: metrics.targetCoords.alt, rayAlt: metrics.targetCoords.alt }
    ];
    lastProfileData = { profile: syntheticProfile, obsAlt: obsAlt, hitDistance: metrics.slantRange };
    drawTerrainProfile(syntheticProfile, obsAlt, metrics.slantRange);

    telemetrySheet.classList.add('open');
    showToast(`Blanco fijado: ${metrics.slantRange}m (Cota: ${metrics.targetCoords.alt}m MSL)`, 3500);

    // Enviar a Firebase para auditoría y telemetría de campo
    if (typeof TelemetryLogger !== 'undefined') {
      const readings = sensorMgr.getReadings();
      TelemetryLogger.sendTelemetry({
        mode: '3d_ar_touch',
        camera3D: {
          azimuthTrue: metrics.azimuthDeg,
          pitch: metrics.pitchDeg,
          roll: readings.rollDeg
        },
        gps: {
          lat: readings.gps.lat || -33.5888,
          lon: readings.gps.lon || -70.7064,
          groundAlt: readings.gps.groundAlt || 485,
          effectiveAlt: obsAlt
        },
        result: {
          hasHit: true,
          slantRange: metrics.slantRange,
          horizontalDistance: metrics.horizontalDistance,
          deltaHeight: metrics.deltaHeight,
          targetCoords: metrics.targetCoords,
          message: 'Impacto 3D por toque directo en terreno AR'
        }
      });
    }
  }

  // ==========================================================
  // CONMUTADOR DE MODOS: LÁSER vs 3D AR
  // ==========================================================
  if (btnModeLaser && btnModeSvs) {
    btnModeLaser.addEventListener('click', () => {
      activeOperatingMode = 'laser';
      btnModeLaser.classList.add('active');
      btnModeSvs.classList.remove('active');
      document.body.classList.remove('mode-svs');
      if (svsToolbar) svsToolbar.style.display = 'none';
      if (btnMeasure) {
        btnMeasure.querySelector('.trigger-text').textContent = 'MEDIR DISTANCIA (LÁSER)';
      }
      showToast('Modo Láser Activo (Cámara + Trazado Raymarching)');
    });

    btnModeSvs.addEventListener('click', () => {
      activeOperatingMode = 'svs';
      btnModeSvs.classList.add('active');
      btnModeLaser.classList.remove('active');
      document.body.classList.add('mode-svs');
      if (svsToolbar) svsToolbar.style.display = 'flex';
      if (btnMeasure) {
        btnMeasure.querySelector('.trigger-text').textContent = '🎯 MEDIR CENTRO / TOCA EL CERRO';
      }
      if (typeof Terrain3DView !== 'undefined') {
        Terrain3DView.resize();
        if (!sensorMgr.gps.lat) {
          // Si el GPS aún no tiene posición, precargar cerro de referencia para pruebas
          Terrain3DView.updateObserverPosition(-33.5888, -70.7064, 485, sensorMgr.postureHeight);
        }
      }
      showToast('Modo 3D AR Activo: Toca el cerro o fija el mapa para calibrar silueta', 4500);
    });
  }

  // ==========================================================
  // BARRA DE HERRAMIENTAS Y CALIBRACIÓN 3D AR
  // ==========================================================
  if (btnSvsFreeze) {
    btnSvsFreeze.addEventListener('click', () => {
      if (typeof Terrain3DView === 'undefined') return;
      const isFrozen = Terrain3DView.toggleFrozen();
      if (isFrozen) {
        btnSvsFreeze.classList.add('frozen');
        if (svsFreezeIcon) svsFreezeIcon.textContent = '🔒';
        if (svsFreezeText) svsFreezeText.textContent = 'Fijado';
        if (svsStatusBanner) svsStatusBanner.classList.add('calibrating');
        if (svsBannerText) svsBannerText.textContent = 'Modo Calibración: Arrastra la pantalla para hacer coincidir la silueta con el cerro real';
        showToast('Mapa 3D fijado. Arrastra con el dedo para alinear con el cerro real', 4000);
      } else {
        btnSvsFreeze.classList.remove('frozen');
        if (svsFreezeIcon) svsFreezeIcon.textContent = '🔓';
        if (svsFreezeText) svsFreezeText.textContent = 'Fijar Mapa';
        if (svsStatusBanner) svsStatusBanner.classList.remove('calibrating');
        if (svsBannerText) svsBannerText.textContent = 'Mapa en vivo: Gira el teléfono hacia el cerro o toca un punto para medir';
        showToast('Mapa 3D móvil en vivo');
      }
    });
  }

  if (sliderSvsOpacity) {
    sliderSvsOpacity.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      if (valSvsOpacity) valSvsOpacity.textContent = `${val}%`;
      if (typeof Terrain3DView !== 'undefined') {
        Terrain3DView.setOpacity(val / 100.0);
      }
    });
  }

  if (btnSvsZoomIn && btnSvsZoomOut) {
    btnSvsZoomIn.addEventListener('click', () => {
      if (typeof Terrain3DView === 'undefined') return;
      Terrain3DView.zoomBy(0.9);
      svsZoomLevel = Number((svsZoomLevel * 1.11).toFixed(1));
      if (valSvsZoom) valSvsZoom.textContent = `${svsZoomLevel}x`;
    });

    btnSvsZoomOut.addEventListener('click', () => {
      if (typeof Terrain3DView === 'undefined') return;
      Terrain3DView.zoomBy(1.1);
      svsZoomLevel = Math.max(0.5, Number((svsZoomLevel / 1.11).toFixed(1)));
      if (valSvsZoom) valSvsZoom.textContent = `${svsZoomLevel}x`;
    });
  }

  // Alternar Estilo de Textura (Satélite Fotorrealista vs Topográfico)
  if (btnSvsMapStyle) {
    btnSvsMapStyle.addEventListener('click', () => {
      if (typeof Terrain3DView === 'undefined') return;
      const newMode = Terrain3DView.toggleVisualMode();
      if (newMode === 'satellite') {
        btnSvsMapStyle.textContent = '📸';
        btnSvsMapStyle.title = 'Modo: Fotografía Satelital Realista (Google Earth / Esri)';
        showToast('Textura: Fotografía Satelital Realista (Google Earth / Esri)', 3000);
      } else {
        btnSvsMapStyle.textContent = '🗺️';
        btnSvsMapStyle.title = 'Modo: Relieve Topográfico Hipsométrico';
        showToast('Textura: Relieve Topográfico Hipsométrico Militar', 3000);
      }
    });
  }

  if (btnSvsWireframe) {
    let wireframeOn = true;
    btnSvsWireframe.addEventListener('click', () => {
      if (typeof Terrain3DView === 'undefined') return;
      wireframeOn = !wireframeOn;
      Terrain3DView.setWireframe(wireframeOn);
      btnSvsWireframe.style.color = wireframeOn ? 'var(--hud-cyan)' : 'var(--text-muted)';
      showToast(`Malla de crestas: ${wireframeOn ? 'Activada' : 'Oculta'}`);
    });
  }

  if (btnSvsReset) {
    btnSvsReset.addEventListener('click', () => {
      if (typeof Terrain3DView === 'undefined') return;
      Terrain3DView.resetCalibration();
      svsZoomLevel = 1.0;
      if (valSvsZoom) valSvsZoom.textContent = '1.0x';
      showToast('Calibración y zoom restablecidos a valores por defecto');
    });
  }

  // Botón Disparador Láser / Medición Telemetría
  btnMeasure.addEventListener('click', async () => {
    // Si estamos en Modo 3D AR, disparar raycast al centro exacto de la retícula
    if (activeOperatingMode === 'svs' && typeof Terrain3DView !== 'undefined') {
      const centerHit = Terrain3DView.raycastTap(window.innerWidth / 2, window.innerHeight / 2);
      if (centerHit) {
        return; // handleTargetAcquired ya fue invocado por el evento interno
      }
      showToast('Retícula apuntando al cielo. Toca directamente el cerro en pantalla');
    }
    playLaserSound();
    if (navigator.vibrate) navigator.vibrate([40, 30, 40]);

    const readings = sensorMgr.getReadings();

    // Si aún no hay señal de GPS real, permitir posición simulada para pruebas de terreno
    let obsLat = readings.gps.lat;
    let obsLon = readings.gps.lon;
    let obsAlt = readings.gps.effectiveAlt;

    if (obsLat === null || obsLon === null) {
      showToast('GPS aún no fijado. Usando ubicación de prueba en terreno...');
      // Ubicación de prueba: Cerro San Cristóbal (cumbre a 850m)
      obsLat = -33.4253;
      obsLon = -70.6335;
      obsAlt = 850;
    }

    btnMeasure.disabled = true;
    btnMeasure.querySelector('.trigger-text').textContent = 'DISPARANDO LÁSER...';

    try {
      const result = await TerrainEngine.traceRay({
        obsLat: obsLat,
        obsLon: obsLon,
        obsAlt: obsAlt,
        azimuth: readings.azimuthTrue,
        pitch: readings.pitchDeg,
        maxRange: 5000, // Rango máximo configurado en 5km (5000m)
        numSamples: 45, // Alta resolución de muestreo
        postureHeight: readings.postureHeight
      });

      if (result.hasHit) {
        resSlantRange.textContent = result.slantRange.toLocaleString();
        resHorizontalDist.textContent = result.horizontalDistance.toLocaleString();
        resDeltaAlt.textContent = `${result.deltaHeight > 0 ? '+' : ''}${result.deltaHeight}`;
        
        if (currentAngleUnit === 'deg') {
          resPitch.textContent = `${result.pitchDeg > 0 ? '+' : ''}${result.pitchDeg.toFixed(1)}° (${result.slopePercent}%)`;
          resAzimuth.textContent = `${result.azimuthDeg.toFixed(1)}° Verdadero`;
        } else {
          const pMils = Math.round((result.pitchDeg / 360) * 6400);
          const aMils = Math.round((result.azimuthDeg / 360) * 6400);
          resPitch.textContent = `${pMils > 0 ? '+' : ''}${pMils} ₥ (${result.slopePercent}%)`;
          resAzimuth.textContent = `${aMils} ₥ Verdadero (${result.azimuthDeg.toFixed(1)}°)`;
        }

        resTargetCoords.textContent = `${result.targetCoords.lat.toFixed(5)}, ${result.targetCoords.lon.toFixed(5)}`;
        resTargetAlt.textContent = `${result.targetCoords.alt} m MSL`;

        lastHitCoords = result.targetCoords;
        lastProfileData = { profile: result.profile, obsAlt: obsAlt, hitDistance: result.slantRange };
        drawTerrainProfile(result.profile, obsAlt, result.slantRange);

        telemetrySheet.classList.add('open');
      } else {
        if (result.closestApproach && result.closestApproach.clearance < 60) {
          showToast(`Sin impacto: Rayo pasó a +${result.closestApproach.clearance}m del relieve a los ${result.closestApproach.distance}m`, 4500);
        } else {
          showToast(result.message, 4000);
        }
      }

      // Enviar diagnóstico completo a Firebase en segundo plano para análisis del agente
      if (typeof TelemetryLogger !== 'undefined') {
        TelemetryLogger.sendTelemetry({
          rawSensors: readings.rawSensors || {},
          camera3D: {
            azimuthTrue: readings.azimuthTrue,
            azimuthMag: readings.azimuthMag,
            pitch: readings.pitchDeg,
            roll: readings.rollDeg,
            declination: readings.declination,
            vEast: readings.camVector ? readings.camVector.vEast : null,
            vNorth: readings.camVector ? readings.camVector.vNorth : null,
            vUp: readings.camVector ? readings.camVector.vUp : null
          },
          gps: {
            lat: obsLat,
            lon: obsLon,
            accuracy: readings.gps.accuracy,
            groundAlt: sensorMgr.gps.groundAlt,
            postureHeight: readings.postureHeight,
            effectiveAlt: obsAlt
          },
          result: {
            hasHit: result.hasHit,
            slantRange: result.slantRange,
            horizontalDistance: result.horizontalDistance,
            deltaHeight: result.deltaHeight,
            targetCoords: result.targetCoords,
            message: result.message
          }
        });
      }
    } catch (err) {
      console.error('Error al medir:', err);
      showToast('Error al conectar con API topográfica: ' + err.message);
    } finally {
      btnMeasure.disabled = false;
      btnMeasure.querySelector('.trigger-text').textContent = 'MEDIR DISTANCIA (LÁSER)';
    }
  });

  // Redibujar perfil en rotación o cambio de resolución
  function redrawCurrentProfile() {
    if (lastProfileData) {
      drawTerrainProfile(lastProfileData.profile, lastProfileData.obsAlt, lastProfileData.hitDistance);
    }
  }

  window.addEventListener('resize', redrawCurrentProfile);
  window.addEventListener('orientationchange', () => {
    setTimeout(redrawCurrentProfile, 200);
  });

  // Dibujar Gráfico de Corte Transversal del Terreno
  function drawTerrainProfile(profile, obsAlt, hitDistance) {
    if (!profile || profile.length === 0) return;

    // Adaptar dinámicamente la resolución del canvas a su contenedor
    const container = terrainCanvas.parentElement;
    if (container && container.clientWidth > 0 && container.clientHeight > 0) {
      terrainCanvas.width = container.clientWidth;
      terrainCanvas.height = container.clientHeight;
    }

    const ctx = terrainCanvas.getContext('2d');
    const w = terrainCanvas.width;
    const h = terrainCanvas.height;

    ctx.clearRect(0, 0, w, h);

    // Encontrar cotas mínimas y máximas para escalar
    const allAlts = profile.flatMap(p => [p.terrainAlt, p.rayAlt]);
    allAlts.push(obsAlt);
    const minAlt = Math.min(...allAlts) - 20;
    const maxAlt = Math.max(...allAlts) + 20;
    const altRange = maxAlt - minAlt || 1;

    const maxDist = profile[profile.length - 1].distance;

    function toCanvasX(dist) {
      return 40 + (dist / maxDist) * (w - 70);
    }

    function toCanvasY(alt) {
      return h - 35 - ((alt - minAlt) / altRange) * (h - 60);
    }

    // Cuadrícula y cotas
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 3; i++) {
      const y = 25 + (i / 3) * (h - 60);
      ctx.moveTo(35, y);
      ctx.lineTo(w - 20, y);
    }
    ctx.stroke();

    // 1. Dibujar relleno y superficie del terreno (Verde Esmeralda)
    ctx.beginPath();
    ctx.moveTo(toCanvasX(0), h - 35);
    ctx.lineTo(toCanvasX(0), toCanvasY(obsAlt - sensorMgr.postureHeight));

    for (let i = 0; i < profile.length; i++) {
      ctx.lineTo(toCanvasX(profile[i].distance), toCanvasY(profile[i].terrainAlt));
    }
    ctx.lineTo(toCanvasX(maxDist), h - 35);
    ctx.closePath();

    const terrainGrad = ctx.createLinearGradient(0, 0, 0, h);
    terrainGrad.addColorStop(0, 'rgba(16, 185, 129, 0.35)');
    terrainGrad.addColorStop(1, 'rgba(16, 185, 129, 0.02)');
    ctx.fillStyle = terrainGrad;
    ctx.fill();

    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(toCanvasX(0), toCanvasY(obsAlt - sensorMgr.postureHeight));
    for (let i = 0; i < profile.length; i++) {
      ctx.lineTo(toCanvasX(profile[i].distance), toCanvasY(profile[i].terrainAlt));
    }
    ctx.stroke();

    // 2. Dibujar haz láser (Rojo Intenso)
    ctx.strokeStyle = '#ff3366';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 2]);
    ctx.beginPath();
    ctx.moveTo(toCanvasX(0), toCanvasY(obsAlt));
    for (let i = 0; i < profile.length; i++) {
      ctx.lineTo(toCanvasX(profile[i].distance), toCanvasY(profile[i].rayAlt));
      if (profile[i].distance >= hitDistance) break;
    }
    ctx.stroke();
    ctx.setLineDash([]); // Restaurar línea sólida

    // 3. Marcador del Observador (Azul)
    ctx.fillStyle = '#3b82f6';
    ctx.beginPath();
    ctx.arc(toCanvasX(0), toCanvasY(obsAlt), 5, 0, Math.PI * 2);
    ctx.fill();

    // 4. Marcador de Impacto (Ámbar / Diana)
    const hitX = toCanvasX(hitDistance);
    const hitPoint = profile.find(p => p.distance >= hitDistance) || profile[profile.length - 1];
    const hitY = toCanvasY(hitPoint.terrainAlt);

    ctx.fillStyle = '#ffb703';
    ctx.beginPath();
    ctx.arc(hitX, hitY, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(hitX, hitY, 9, 0, Math.PI * 2);
    ctx.stroke();

    // Textos de cotas
    ctx.fillStyle = '#8b949e';
    ctx.font = '10px JetBrains Mono';
    ctx.fillText(`${Math.round(maxAlt)}m`, 5, 25);
    ctx.fillText(`${Math.round(minAlt)}m`, 5, h - 35);
    ctx.fillText('0m', toCanvasX(0) - 5, h - 18);
    ctx.fillText(`${Math.round(hitDistance)}m (Impacto)`, hitX - 35, h - 18);
  }

  // Cerrar Hoja de Telemetría
  btnCloseSheet.addEventListener('click', () => {
    telemetrySheet.classList.remove('open');
  });

  sheetCloseHandle.addEventListener('click', () => {
    telemetrySheet.classList.remove('open');
  });

  // Abrir ubicación del objetivo en Google Maps
  btnOpenMaps.addEventListener('click', () => {
    if (lastHitCoords) {
      const url = `https://www.google.com/maps/search/?api=1&query=${lastHitCoords.lat},${lastHitCoords.lon}`;
      window.open(url, '_blank');
    }
  });

  // Intentar iniciar cámara y sensores al interactuar por primera vez
  document.body.addEventListener('click', () => {
    if (!sensorMgr.orientationActive) {
      initSensors();
    }
  }, { once: true });

  // Redimensionar Three.js en cambio de tamaño o rotación de pantalla
  window.addEventListener('resize', () => {
    redrawCurrentProfile();
    if (typeof Terrain3DView !== 'undefined') Terrain3DView.resize();
  });
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      redrawCurrentProfile();
      if (typeof Terrain3DView !== 'undefined') Terrain3DView.resize();
    }, 250);
  });

  // Inicializar Motor 3D AR y registrar escucha de toque directo
  if (typeof Terrain3DView !== 'undefined' && svsCanvas) {
    Terrain3DView.init(svsCanvas);
    Terrain3DView.onTargetSelected(handleTargetAcquired);
  }

  // Iniciar cámara y sensores
  initCamera();
  initSensors();
});
