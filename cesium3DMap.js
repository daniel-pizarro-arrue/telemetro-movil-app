/**
 * cesium3DMap.js - Controlador 3D con flujo táctico por fases:
 * Vista Aérea -> Ajuste Fino de Posición -> Descenso Suave al Horizonte -> Primera Persona con Posturas
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Cesium3DMap = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_GOOGLE_KEY = 'AIzaSyCqStGr7P7L-kxiklPUsP9zpC7hYh4Chwc';

  class Cesium3DMapController {
    constructor(containerId, options = {}) {
      this.containerId = containerId;
      this.googleApiKey = options.googleApiKey || DEFAULT_GOOGLE_KEY;

      // Ubicación del usuario (anclada)
      this.userLat = options.initialLat || -33.4489;
      this.userLng = options.initialLng || -70.6693;
      this.userAlt = options.initialAlt || 600;
      this.postureHeight = 1.6; // 1.6m de pie, 0.9m arrodillado, 0.3m tendido
      this.groundAltitudeLocked = null;

      // Orientación
      this.heading = 0;
      this.pitch = 0;
      this.roll = 0;

      // Modo de control: 'aerial' | 'first_person_free' | 'first_person_sensor'
      this.controlMode = 'aerial';

      this.viewer = null;
      this.tileset = null;
      this.targetEntity = null;
      this.sightLineEntity = null;
      this._cachedDestination = null;

      // Óptica y zoom (FOV en grados: 60° = 1.0x, 6° = 10.0x)
      this.currentFov = 60.0;

      this.onTargetMeasured = null;
      this.onStatusChange = null;
      this.onOrientationChanged = null; // (heading, pitch) => {}
      this.onZoomChanged = null; // (magnification, fov) => {}
      this.onHeightChanged = null; // (postureHeight, totalCamAlt) => {}
    }

    async init() {
      if (!window.Cesium) {
        throw new Error('CesiumJS no está disponible.');
      }
      const Cesium = window.Cesium;

      this._notifyStatus('Iniciando mapa 3D fotorrealista...');

      const container = typeof this.containerId === 'string'
        ? document.getElementById(this.containerId)
        : this.containerId;

      this.viewer = new Cesium.Viewer(container, {
        globe: false,
        baseLayer: false,
        skyBox: false,
        skyAtmosphere: false,
        animation: false,
        timeline: false,
        sceneModePicker: false,
        baseLayerPicker: false,
        navigationHelpButton: false,
        geocoder: false,
        homeButton: false,
        fullscreenButton: false,
        vrButton: false,
        infoBox: false,
        selectionIndicator: false,
        creditContainer: document.createElement('div'),
        contextOptions: {
          webgl: {
            preserveDrawingBuffer: false,
            powerPreference: 'high-performance'
          }
        }
      });

      const scene = this.viewer.scene;
      scene.backgroundColor = Cesium.Color.fromCssColorString('#020617');

      // Desactivar detección de colisiones de Cesium para evitar que la cámara se teletransporte hacia arriba al rotar
      if (scene.screenSpaceCameraController) {
        scene.screenSpaceCameraController.enableCollisionDetection = false;
      }

      if (scene.postProcessStages?.fxaa) {
        scene.postProcessStages.fxaa.enabled = true;
      }
      this.viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 1.5);
      this.viewer.targetFrameRate = 60;

      if (Cesium.Resource) {
        Cesium.Resource.retryAttempts = 3;
        Cesium.Resource.retryCallback = (resource, error) => {
          if (!error) return false;
          const status = error.statusCode;
          if ([0, 429, 502, 503, 504].includes(status)) {
            return new Promise((res) => setTimeout(() => res(true), 300));
          }
          return false;
        };
      }

      try {
        if (Cesium.GoogleMaps) {
          Cesium.GoogleMaps.defaultApiKey = this.googleApiKey;
        }

        this.tileset = await Cesium.createGooglePhotorealistic3DTileset(this.googleApiKey);
        scene.primitives.add(this.tileset);

        // Optimización agresiva de carga: retención masiva en RAM/GPU (2GB) y sin corte de peticiones
        this.tileset.maximumScreenSpaceError = 16;
        this.tileset.skipLevelOfDetail = true;
        this.tileset.baseScreenSpaceError = 1024;
        this.tileset.skipScreenSpaceErrorFactor = 16;
        this.tileset.skipLevels = 1;
        this.tileset.immediatelyLoadDesiredLevelOfDetail = true;
        this.tileset.loadSiblings = true; // Carga continua de mosaicos adyacentes 360°
        this.tileset.preloadWhenHidden = true;
        this.tileset.preloadFlightCamera = true;
        this.tileset.cullRequestsWhileMoving = false; // NO cancelar peticiones de descarga al girar la cámara
        this.tileset.dynamicScreenSpaceError = true;
        this.tileset.maximumMemoryUsage = 2048; // 2 GB de caché para no descartar texturas ya descargadas

        this._notifyStatus('✅ Mapa 3D cargado');
      } catch (err) {
        console.error('Error cargando 3D Tiles:', err);
        this._notifyStatus('⚠️ Error conectando con Google 3D Tiles');
      }

      this._setupInteraction();

      // Vista inicial aérea fija en la ubicación por defecto o previa
      this.setAerialView(this.userLat, this.userLng, 1400, false);

      return this;
    }

    _notifyStatus(msg) {
      if (this.onStatusChange) {
        this.onStatusChange(msg);
      }
    }

    /**
     * Ajusta el campo de visión (FOV) para zoom óptico tipo telescopio sin desplazar la posición
     */
    setFov(fovDegrees) {
      this.currentFov = Math.max(5.0, Math.min(75.0, fovDegrees));
      if (this.viewer?.camera?.frustum && typeof this.viewer.camera.frustum.fov !== 'undefined') {
        const Cesium = window.Cesium;
        this.viewer.camera.frustum.fov = Cesium.Math.toRadians(this.currentFov);
      }
      const magnification = 60.0 / this.currentFov;
      if (this.onZoomChanged) {
        this.onZoomChanged(magnification, this.currentFov);
      }
      return magnification;
    }

    getZoomMagnification() {
      return 60.0 / this.currentFov;
    }

    _setupInteraction() {
      const Cesium = window.Cesium;
      const canvas = this.viewer.scene.canvas;

      // Variables de control táctil (1 dedo = rotación in-place, 2 dedos = pellizco zoom)
      let isDragging = false;
      let isPinching = false;
      let startX = 0;
      let startY = 0;
      let startHeading = 0;
      let startPitch = 0;
      let movedDist = 0;
      let touchStartTime = 0;
      let startPinchDist = 0;
      let startFovOnPinch = 60;

      // ─── GESTIÓN DE EVENTOS TÁCTILES MÓVILES (TOUCH EVENTS) ───
      canvas.addEventListener('touchstart', (e) => {
        if (this.controlMode !== 'first_person_free') return;

        if (e.touches.length === 1 && !isPinching) {
          isDragging = true;
          startX = e.touches[0].clientX;
          startY = e.touches[0].clientY;
          startHeading = this.heading;
          startPitch = this.pitch;
          movedDist = 0;
          touchStartTime = Date.now();
        } else if (e.touches.length >= 2) {
          // Gesto de pellizco (Pinch to Zoom): BLOQUEO INMEDIATO DE ROTACIÓN
          isDragging = false;
          isPinching = true;
          const p1 = e.touches[0];
          const p2 = e.touches[1];
          startPinchDist = Math.hypot(p1.clientX - p2.clientX, p1.clientY - p2.clientY);
          startFovOnPinch = this.currentFov;
        }
      }, { passive: false });

      canvas.addEventListener('touchmove', (e) => {
        if (this.controlMode !== 'first_person_free') return;
        e.preventDefault(); // Evita scroll y gestos nativos del navegador

        if (isPinching && e.touches.length >= 2) {
          const p1 = e.touches[0];
          const p2 = e.touches[1];
          const currentDist = Math.hypot(p1.clientX - p2.clientX, p1.clientY - p2.clientY);
          if (startPinchDist > 8) {
            const scale = currentDist / startPinchDist;
            // Mayor distancia entre dedos -> mayor acercamiento -> fov menor
            const targetFov = startFovOnPinch / scale;
            this.setFov(targetFov);
          }
          return; // Prohibido rotar mientras existan 2 o más dedos
        }

        if (isDragging && e.touches.length === 1 && !isPinching) {
          const dx = e.touches[0].clientX - startX;
          const dy = e.touches[0].clientY - startY;
          movedDist += Math.abs(dx) + Math.abs(dy);

          // Sensibilidad táctil ajustada al zoom óptico (a mayor aumento, movimiento más suave y fino)
          const fovFactor = this.currentFov / 60.0;
          const sensitivity = 0.22 * Math.max(0.2, fovFactor);

          this.heading = (startHeading + dx * sensitivity + 360) % 360;
          this.pitch = Math.max(-88, Math.min(88, startPitch - dy * sensitivity));

          this.updateCameraOrientation();

          if (this.onOrientationChanged) {
            this.onOrientationChanged(this.heading, this.pitch);
          }
        }
      }, { passive: false });

      const onTouchEnd = (e) => {
        if (this.controlMode !== 'first_person_free') return;

        if (e.touches.length < 2 && isPinching) {
          // Finaliza el pellizco. Si aún queda un dedo, evitar tirón brusco
          isPinching = false;
          isDragging = false;
        }

        if (e.touches.length === 0) {
          // Si fue un toque sin arrastre (< 10px y < 350ms), medir objetivo
          if (isDragging && movedDist < 10 && (Date.now() - touchStartTime) < 350) {
            const rect = canvas.getBoundingClientRect();
            const pos = new Cesium.Cartesian2(startX - rect.left, startY - rect.top);
            this.measureAtScreenPosition(pos);
          }
          isDragging = false;
          isPinching = false;
        }
      };

      canvas.addEventListener('touchend', onTouchEnd);
      canvas.addEventListener('touchcancel', onTouchEnd);

      // ─── GESTIÓN DE EVENTOS DE RATÓN (DESKTOP) ───
      let isMouseDown = false;
      let mouseStartX = 0;
      let mouseStartY = 0;
      let mouseMovedDist = 0;
      let mouseDownTime = 0;

      canvas.addEventListener('mousedown', (e) => {
        if (this.controlMode !== 'first_person_free') return;
        if (e.button !== 0) return;
        isMouseDown = true;
        mouseStartX = e.clientX;
        mouseStartY = e.clientY;
        startHeading = this.heading;
        startPitch = this.pitch;
        mouseMovedDist = 0;
        mouseDownTime = Date.now();
      });

      window.addEventListener('mousemove', (e) => {
        if (!isMouseDown || this.controlMode !== 'first_person_free') return;
        const dx = e.clientX - mouseStartX;
        const dy = e.clientY - mouseStartY;
        mouseMovedDist += Math.abs(dx) + Math.abs(dy);

        const fovFactor = this.currentFov / 60.0;
        const sensitivity = 0.22 * Math.max(0.2, fovFactor);

        this.heading = (startHeading + dx * sensitivity + 360) % 360;
        this.pitch = Math.max(-88, Math.min(88, startPitch - dy * sensitivity));

        this.updateCameraOrientation();

        if (this.onOrientationChanged) {
          this.onOrientationChanged(this.heading, this.pitch);
        }
      });

      window.addEventListener('mouseup', (e) => {
        if (isMouseDown) {
          isMouseDown = false;
          if (mouseMovedDist < 8 && (Date.now() - mouseDownTime) < 350 && this.controlMode !== 'aerial') {
            const rect = canvas.getBoundingClientRect();
            const pos = new Cesium.Cartesian2(e.clientX - rect.left, e.clientY - rect.top);
            this.measureAtScreenPosition(pos);
          }
        }
      });

      // Zoom con rueda de ratón en modo inmersivo
      canvas.addEventListener('wheel', (e) => {
        if (this.controlMode !== 'first_person_free') return;
        e.preventDefault();
        const step = e.deltaY > 0 ? 3.0 : -3.0;
        this.setFov(this.currentFov + step);
      }, { passive: false });
    }

    /**
     * Sitúa la cámara en vista aérea cenital/inclinada para inspección previa
     */
    setAerialView(lat, lng, altitude = 800, animate = true) {
      if (!this.viewer) return;
      const Cesium = window.Cesium;

      this.controlMode = 'aerial';
      const controller = this.viewer.scene.screenSpaceCameraController;
      controller.enableRotate = true;
      controller.enableTranslate = true;
      controller.enableZoom = true;
      controller.enableTilt = true;
      controller.enableLook = false;

      const dest = Cesium.Cartesian3.fromDegrees(lng, lat, altitude);
      const orientation = {
        heading: Cesium.Math.toRadians(0),
        pitch: Cesium.Math.toRadians(-80), // Casi cenital para ver calles y terreno
        roll: 0.0
      };

      if (animate) {
        this.viewer.camera.flyTo({
          destination: dest,
          orientation: orientation,
          duration: 2.2
        });
      } else {
        this.viewer.camera.setView({
          destination: dest,
          orientation: orientation
        });
      }
    }

    /**
     * Obtiene las coordenadas geográficas y cota de superficie exactas bajo el pin central
     */
    getCenterCoordinates() {
      if (!this.viewer || !this.viewer.scene) {
        return { lat: this.userLat, lng: this.userLng, alt: this.userAlt };
      }
      const Cesium = window.Cesium;
      const canvas = this.viewer.scene.canvas;
      const centerScreen = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);

      let cartesian = null;
      try {
        cartesian = this.viewer.scene.pickPosition(centerScreen);
      } catch (e) {}

      if (!cartesian) {
        const ray = this.viewer.scene.camera.getPickRay(centerScreen);
        if (ray) {
          cartesian = this.viewer.scene.globe?.pick(ray, this.viewer.scene) || this.viewer.camera.pickEllipsoid(centerScreen);
        }
      }

      if (cartesian) {
        const carto = Cesium.Cartographic.fromCartesian(cartesian);
        const alt = carto.height;
        return {
          lat: Cesium.Math.toDegrees(carto.latitude),
          lng: Cesium.Math.toDegrees(carto.longitude),
          alt: (typeof alt === 'number' && !isNaN(alt) && Math.abs(alt) > 0.1) ? alt : this.userAlt
        };
      }

      return { lat: this.userLat, lng: this.userLng, alt: this.userAlt };
    }

    /**
     * Desciende suavemente la cámara desde la vista aérea hacia el suelo y se inclina mirando al horizonte
     * Admite firmas: (lat, lng, postureHeight) o (lat, lng, groundAlt, postureHeight)
     */
    async descendToGround(confirmedLat, confirmedLng, groundAlt = null, postureHeight = 1.6) {
      if (!this.viewer) return;
      const Cesium = window.Cesium;

      // Compatibilidad si fue llamado como descendToGround(lat, lng, postureHeight)
      if (typeof groundAlt === 'number' && groundAlt <= 3.0 && postureHeight === 1.6) {
        postureHeight = groundAlt;
        groundAlt = null;
      }

      this.userLat = confirmedLat;
      this.userLng = confirmedLng;
      this.postureHeight = postureHeight;

      this._notifyStatus('Descendiendo a posición en tierra...');

      // Determinar la cota real del suelo
      let groundH = groundAlt;
      if (typeof groundH !== 'number' || isNaN(groundH) || Math.abs(groundH) < 0.1) {
        groundH = null;
      }

      // Si no vino altitud o vino nula, muestrear con pickPosition en el centro de pantalla
      if (groundH == null) {
        try {
          const canvas = this.viewer.scene.canvas;
          const centerScreen = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
          const picked = this.viewer.scene.pickPosition(centerScreen);
          if (picked) {
            const carto = Cesium.Cartographic.fromCartesian(picked);
            if (typeof carto.height === 'number' && !isNaN(carto.height) && Math.abs(carto.height) > 0.1) {
              groundH = carto.height;
            }
          }
        } catch (_) {}
      }

      // Si aún no se detectó, intentar clampToHeight
      if (groundH == null) {
        try {
          const testPos = Cesium.Cartesian3.fromDegrees(this.userLng, this.userLat, 0);
          const clamped = this.viewer.scene.clampToHeight(testPos);
          if (clamped) {
            const carto = Cesium.Cartographic.fromCartesian(clamped);
            if (typeof carto.height === 'number' && !isNaN(carto.height) && Math.abs(carto.height) > 0.1) {
              groundH = carto.height;
            }
          }
        } catch (_) {}
      }

      // Fallback final razonable si no se pudo determinar
      if (groundH == null) {
        groundH = (this.userAlt && this.userAlt !== 600) ? this.userAlt : 560;
      }

      this.groundAltitudeLocked = groundH;
      this.userAlt = groundH;

      // Restablecer zoom inicial a 1.0x (60° fov)
      this.setFov(60.0);

      const totalCamAlt = this.groundAltitudeLocked + this.postureHeight;
      this._cachedDestination = Cesium.Cartesian3.fromDegrees(this.userLng, this.userLat, totalCamAlt);

      this.heading = 0;
      this.pitch = -2.0;
      this.roll = 0.0;

      // Transición cinemática suave: descenso con tilt hacia el horizonte (-2 grados)
      return new Promise((resolve) => {
        this.viewer.camera.flyTo({
          destination: this._cachedDestination,
          orientation: {
            heading: Cesium.Math.toRadians(this.heading),
            pitch: Cesium.Math.toRadians(this.pitch),
            roll: 0.0
          },
          duration: 3.0,
          complete: () => {
            this.setControlMode('first_person_free');
            if (this.onOrientationChanged) {
              this.onOrientationChanged(this.heading, this.pitch);
            }
            if (this.onZoomChanged) {
              this.onZoomChanged(1.0, this.currentFov);
            }
            if (this.onHeightChanged) {
              this.onHeightChanged(this.postureHeight, totalCamAlt);
            }
            // Iniciar precarga de radio 5km en segundo plano automáticamente
            this.preloadRadius5km(this.userLat, this.userLng);
            resolve();
          }
        });
      });
    }

    /**
     * Descarga y precarga en segundo plano la totalidad de la malla 3D en un radio de 5 kilómetros
     */
    preloadRadius5km(lat, lng) {
      if (!this.viewer || !this.viewer.scene) return;
      const Cesium = (typeof window !== 'undefined' && window.Cesium) ? window.Cesium : (typeof globalThis !== 'undefined' ? globalThis.Cesium : null);
      const GeoMath = (typeof window !== 'undefined' && window.GeoMath) ? window.GeoMath : (typeof require === 'function' ? require('./geoMath.js') : null);
      if (!Cesium || !Cesium.Cartographic) return;

      // Anillos concéntricos de muestreo denso hasta 5.000m
      const rings = [
        { dist: 400, count: 8 },
        { dist: 1000, count: 8 },
        { dist: 2000, count: 12 },
        { dist: 3500, count: 16 },
        { dist: 5000, count: 20 }
      ];

      const cartos = [Cesium.Cartographic.fromDegrees(lng, lat)];
      if (GeoMath?.destinationPoint) {
        for (const ring of rings) {
          const step = 360 / ring.count;
          for (let b = 0; b < 360; b += step) {
            const dest = GeoMath.destinationPoint(lat, lng, ring.dist, b);
            cartos.push(Cesium.Cartographic.fromDegrees(dest.lon, dest.lat));
          }
        }
      }

      console.log(`[Cesium3DMap] Precargando ${cartos.length} sectores 3D en radio de 5km...`);

      // Ejecutar de forma no bloqueante en segundo plano
      setTimeout(async () => {
        try {
          this._notifyStatus('📥 Descargando mapa 3D (radio 5 km)...');
          if (this.viewer?.scene?.sampleHeightMostDetailed) {
            await this.viewer.scene.sampleHeightMostDetailed(cartos);
          }
          console.log('[Cesium3DMap] Precarga de radio 5km completada.');
          this._notifyStatus('✅ Malla 3D (5 km) precargada en memoria');
        } catch (err) {
          console.warn('[Cesium3DMap] Precarga 5km parcial:', err);
        }
      }, 500);
    }

    /**
     * Cambia la postura del observador (De pie: 1.6m, Arrodillado: 0.9m, Tendido: 0.3m)
     */
    setPostureHeight(heightMeters) {
      this.postureHeight = heightMeters;
      if (this.controlMode === 'aerial') return;

      const Cesium = (typeof window !== 'undefined' && window.Cesium) ? window.Cesium : (typeof globalThis !== 'undefined' ? globalThis.Cesium : null);
      const baseGround = this.groundAltitudeLocked !== null ? this.groundAltitudeLocked : this.userAlt;
      const totalCamAlt = baseGround + this.postureHeight;
      if (Cesium?.Cartesian3) {
        this._cachedDestination = Cesium.Cartesian3.fromDegrees(this.userLng, this.userLat, totalCamAlt);
      }

      this.updateCameraOrientation();

      if (this.onHeightChanged) {
        this.onHeightChanged(this.postureHeight, totalCamAlt);
      }
    }

    /**
     * Ajusta suavemente la altura de la cámara sumando o restando deltaMeters de forma personalizada
     */
    adjustHeight(deltaMeters) {
      if (this.controlMode === 'aerial') return this.postureHeight;
      const Cesium = (typeof window !== 'undefined' && window.Cesium) ? window.Cesium : (typeof globalThis !== 'undefined' ? globalThis.Cesium : null);
      // Clampear entre 0.05m (ras de suelo) y 50.0m
      this.postureHeight = Math.max(0.05, Math.min(50.0, +(this.postureHeight + deltaMeters).toFixed(2)));

      const baseGround = this.groundAltitudeLocked !== null ? this.groundAltitudeLocked : this.userAlt;
      const totalCamAlt = baseGround + this.postureHeight;
      if (Cesium?.Cartesian3) {
        this._cachedDestination = Cesium.Cartesian3.fromDegrees(this.userLng, this.userLat, totalCamAlt);
      }

      this.updateCameraOrientation();

      if (this.onHeightChanged) {
        this.onHeightChanged(this.postureHeight, totalCamAlt);
      }
      return this.postureHeight;
    }

    setCustomHeight(heightMeters) {
      if (this.controlMode === 'aerial') return this.postureHeight;
      const Cesium = (typeof window !== 'undefined' && window.Cesium) ? window.Cesium : (typeof globalThis !== 'undefined' ? globalThis.Cesium : null);
      this.postureHeight = Math.max(0.05, Math.min(50.0, +heightMeters.toFixed(2)));

      const baseGround = this.groundAltitudeLocked !== null ? this.groundAltitudeLocked : this.userAlt;
      const totalCamAlt = baseGround + this.postureHeight;
      if (Cesium?.Cartesian3) {
        this._cachedDestination = Cesium.Cartesian3.fromDegrees(this.userLng, this.userLat, totalCamAlt);
      }

      this.updateCameraOrientation();

      if (this.onHeightChanged) {
        this.onHeightChanged(this.postureHeight, totalCamAlt);
      }
      return this.postureHeight;
    }

    /**
     * Modifica el modo de control: 'aerial', 'first_person_free' (tactil), 'first_person_sensor' (brújula)
     */
    setControlMode(mode) {
      this.controlMode = mode;
      const controller = this.viewer?.scene?.screenSpaceCameraController;
      if (!controller) return;

      // Desactivar detección de colisiones de Cesium en todos los modos para evitar teletransportes verticales
      controller.enableCollisionDetection = false;

      if (mode === 'first_person_sensor' || mode === 'first_person_free') {
        // En primera persona desactivamos los controles GIS nativos de Cesium para bloquear la posición (CERO DESPLAZAMIENTO)
        controller.enableRotate = false;
        controller.enableTranslate = false;
        controller.enableZoom = false;
        controller.enableTilt = false;
        controller.enableLook = false;
        this.updateCameraOrientation();
      } else {
        // En modo aéreo (aerial) se permiten los controles completos para ajustar y centrar el pin
        controller.enableRotate = true;
        controller.enableTranslate = true;
        controller.enableZoom = true;
        controller.enableTilt = true;
        controller.enableLook = false;
      }
    }

    /**
     * Actualiza la orientación del dispositivo en primera persona
     */
    updateDeviceOrientation(headingDeg, pitchDeg, rollDeg) {
      this.heading = headingDeg;
      this.pitch = pitchDeg;
      this.roll = rollDeg || 0;

      if (this.controlMode === 'first_person_sensor') {
        this.updateCameraOrientation();
      }
    }

    /**
     * Rota la cámara in-place con destino anclado
     */
    updateCameraOrientation() {
      if (!this.viewer || !this.viewer.camera || !this._cachedDestination) return;
      const Cesium = window.Cesium;

      // Asegurar que la detección de colisiones permanezca siempre desactivada
      if (this.viewer?.scene?.screenSpaceCameraController) {
        this.viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
      }

      const headingRad = Cesium.Math.toRadians(this.heading);
      const pitchRad = Cesium.Math.toRadians(Math.max(-88.0, Math.min(88.0, this.pitch)));

      this.viewer.camera.setView({
        destination: this._cachedDestination,
        orientation: {
          heading: headingRad,
          pitch: pitchRad,
          roll: 0.0
        }
      });
    }

    /**
     * Mide el objetivo en el centro de la retícula
     */
    measureCenterReticle() {
      if (!this.viewer || !this.viewer.scene) return null;
      const Cesium = window.Cesium;
      const canvas = this.viewer.scene.canvas;
      const centerPos = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
      return this.measureAtScreenPosition(centerPos);
    }

    measureAtScreenPosition(screenPosition) {
      if (!this.viewer || !this.viewer.scene) return null;
      const Cesium = window.Cesium;
      const scene = this.viewer.scene;

      let cartesianPicked = null;
      try {
        cartesianPicked = scene.pickPosition(screenPosition);
      } catch (err) {
        console.warn('Error en pickPosition:', err);
      }

      if (!cartesianPicked) {
        const ray = scene.camera.getPickRay(screenPosition);
        if (ray) {
          cartesianPicked = scene.globe?.pick(ray, scene) || scene.camera.pickEllipsoid(screenPosition);
        }
      }

      if (!cartesianPicked) {
        this._notifyStatus('⚠️ No se detectó superficie u objeto');
        return null;
      }

      const carto = Cesium.Cartographic.fromCartesian(cartesianPicked);
      const targetLat = Cesium.Math.toDegrees(carto.latitude);
      const targetLng = Cesium.Math.toDegrees(carto.longitude);
      const targetAlt = carto.height;

      const GeoMath = window.GeoMath;
      let horizDistance = 0;
      let directDistance = 0;
      let bearing = 0;
      let elevAngle = 0;
      let utm = { formatted: '---' };

      const userAltTotal = (this.groundAltitudeLocked !== null ? this.groundAltitudeLocked : this.userAlt) + this.postureHeight;

      if (GeoMath) {
        horizDistance = GeoMath.haversineDistance(this.userLat, this.userLng, targetLat, targetLng);
        directDistance = GeoMath.calculate3DDistance(horizDistance, userAltTotal, targetAlt);
        bearing = GeoMath.calculateBearing(this.userLat, this.userLng, targetLat, targetLng);
        elevAngle = GeoMath.calculateElevationAngle(horizDistance, userAltTotal, targetAlt);
        utm = GeoMath.latLonToUTM(targetLat, targetLng);
      }

      const deltaElevation = targetAlt - userAltTotal;

      const result = {
        target: {
          lat: targetLat,
          lng: targetLng,
          alt: targetAlt,
          utm: utm.formatted,
          cartesian: cartesianPicked
        },
        user: {
          lat: this.userLat,
          lng: this.userLng,
          alt: userAltTotal
        },
        directDistance,
        horizDistance,
        deltaElevation,
        bearing,
        elevAngle,
        timestamp: new Date().toISOString()
      };

      this.drawTargetMarker(cartesianPicked, result);

      if (this.onTargetMeasured) {
        this.onTargetMeasured(result);
      }

      return result;
    }

    drawTargetMarker(targetCartesian, telemetryData) {
      if (!this.viewer) return;
      const Cesium = window.Cesium;
      const entities = this.viewer.entities;

      this.clearTarget();

      const userAltTotal = (this.groundAltitudeLocked !== null ? this.groundAltitudeLocked : this.userAlt) + this.postureHeight;
      const userCartesian = Cesium.Cartesian3.fromDegrees(this.userLng, this.userLat, userAltTotal);

      const GeoMath = window.GeoMath;
      const distLabel = telemetryData?.directDistance != null
        ? (GeoMath ? GeoMath.formatDistance(telemetryData.directDistance) : `${Math.round(telemetryData.directDistance)} m`)
        : 'OBJETIVO';

      const milsVal = GeoMath ? GeoMath.degreesToMils(telemetryData.bearing) : Math.round(telemetryData.bearing);

      this.targetEntity = entities.add({
        position: targetCartesian,
        point: {
          pixelSize: 12,
          color: Cesium.Color.fromCssColorString('#00f0ff'),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        },
        label: {
          text: `🎯 ${distLabel}\nΔH: ${Math.round(telemetryData.deltaElevation)}m | Az: ${milsVal} ₥`,
          font: 'bold 12px monospace',
          fillColor: Cesium.Color.fromCssColorString('#00f0ff'),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -28),
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });

      this.sightLineEntity = entities.add({
        polyline: {
          positions: [userCartesian, targetCartesian],
          width: 3,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.25,
            color: Cesium.Color.fromCssColorString('#00f0ff')
          })
        }
      });
    }

    clearTarget() {
      if (!this.viewer) return;
      if (this.targetEntity) {
        this.viewer.entities.remove(this.targetEntity);
        this.targetEntity = null;
      }
      if (this.sightLineEntity) {
        this.viewer.entities.remove(this.sightLineEntity);
        this.sightLineEntity = null;
      }
    }

    destroy() {
      if (this._eventHandler) {
        this._eventHandler.destroy();
        this._eventHandler = null;
      }
      if (this.viewer && !this.viewer.isDestroyed()) {
        this.viewer.destroy();
        this.viewer = null;
      }
    }
  }

  return Cesium3DMapController;
});
