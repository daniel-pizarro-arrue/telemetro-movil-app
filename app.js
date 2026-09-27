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

  // Inicializar Gestor de Sensores (Milésimas 6400 y 1.60m de pie por defecto)
  const sensorMgr = new SensorFusion.SensorManager({
    postureHeight: 1.60,
    angleUnit: 'mils'
  });

  let currentAngleUnit = 'mils';
  let lastHitCoords = null;
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
        }
      });
    } catch (e) {
      gpsCoords.textContent = 'GPS no soportado';
    }

    // 2. Sensores de Orientación
    sensorMgr.startOrientation((readings) => {
      // Actualizar HUD
      if (currentAngleUnit === 'deg') {
        hudAzimuth.textContent = `${readings.azimuthTrue.toFixed(1).padStart(5, '0')}°`;
        hudPitch.textContent = `${readings.pitchDeg > 0 ? '+' : ''}${readings.pitchDeg.toFixed(1)}°`;
      } else {
        // Notación militar en milésimas (6400)
        const azMils = readings.azimuthMils;
        const pitchMils = readings.pitchMils;
        hudAzimuth.textContent = `${azMils} ₥`;
        hudPitch.textContent = `${pitchMils > 0 ? '+' : ''}${pitchMils} ₥`;
      }
      hudRoll.textContent = `${readings.rollDeg > 0 ? '+' : ''}${readings.rollDeg.toFixed(1)}°`;

      // Cinta de brújula superior deslizante (desplazamiento visual simulado)
      const compassOffset = -(readings.azimuthTrue * 1.5) % 360;
      compassTape.style.transform = `translateX(${compassOffset}px)`;

      // Horizonte artificial rotativo con el Roll
      if (artificialHorizon) {
        artificialHorizon.style.transform = `rotate(${-readings.rollDeg}deg)`;
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

  // Botón Disparador Láser / Medición Telemetría
  btnMeasure.addEventListener('click', async () => {
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
        numSamples: 45  // Alta resolución de muestreo
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
        drawTerrainProfile(result.profile, obsAlt, result.slantRange);

        telemetrySheet.classList.add('open');
      } else {
        showToast(result.message, 4000);
      }
    } catch (err) {
      console.error('Error al medir:', err);
      showToast('Error al conectar con API topográfica: ' + err.message);
    } finally {
      btnMeasure.disabled = false;
      btnMeasure.querySelector('.trigger-text').textContent = 'MEDIR DISTANCIA (LÁSER)';
    }
  });

  // Dibujar Gráfico de Corte Transversal del Terreno
  function drawTerrainProfile(profile, obsAlt, hitDistance) {
    if (!profile || profile.length === 0) return;

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

  // Iniciar cámara y sensores
  initCamera();
  initSensors();
});
