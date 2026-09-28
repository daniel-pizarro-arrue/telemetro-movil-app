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

      this.onTargetMeasured = null;
      this.onStatusChange = null;
      this.onOrientationChanged = null; // (heading, pitch) => {}
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

        this.tileset.maximumScreenSpaceError = 24;
        this.tileset.skipLevelOfDetail = true;
        this.tileset.baseScreenSpaceError = 1024;
        this.tileset.skipScreenSpaceErrorFactor = 16;
        this.tileset.cullRequestsWhileMoving = true;
        this.tileset.cullRequestsWhileMovingMultiplier = 60.0;
        this.tileset.dynamicScreenSpaceError = true;
        this.tileset.preloadFlightCamera = true;
        this.tileset.maximumMemoryUsage = 384;

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

    _setupInteraction() {
      const Cesium = window.Cesium;
      const canvas = this.viewer.scene.canvas;

      // Variables de arrastre táctil para rotar la cámara in-place (horizontal y vertical)
      let isDragging = false;
      let startX = 0;
      let startY = 0;
      let startHeading = 0;
      let startPitch = 0;
      let movedDist = 0;

      canvas.addEventListener('pointerdown', (e) => {
        if (this.controlMode !== 'first_person_free') return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startHeading = this.heading;
        startPitch = this.pitch;
        movedDist = 0;
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      });

      canvas.addEventListener('pointermove', (e) => {
        if (!isDragging || this.controlMode !== 'first_person_free') return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        movedDist += Math.abs(dx) + Math.abs(dy);

        // Sensibilidad táctil: rotación horizontal (rumbo) y vertical (inclinación)
        const sensitivity = 0.22;
        this.heading = (startHeading + dx * sensitivity + 360) % 360;
        this.pitch = Math.max(-88, Math.min(88, startPitch - dy * sensitivity));

        this.updateCameraOrientation();

        if (this.onOrientationChanged) {
          this.onOrientationChanged(this.heading, this.pitch);
        }
      });

      const onPointerEnd = (e) => {
        if (isDragging) {
          isDragging = false;
          try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}

          // Si fue un toque sin arrastre significativo (< 8px), medir el objetivo
          if (movedDist < 8 && this.controlMode !== 'aerial') {
            const rect = canvas.getBoundingClientRect();
            const pos = new Cesium.Cartesian2(e.clientX - rect.left, e.clientY - rect.top);
            this.measureAtScreenPosition(pos);
          }
        }
      };

      canvas.addEventListener('pointerup', onPointerEnd);
      canvas.addEventListener('pointercancel', onPointerEnd);
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
     * Obtiene las coordenadas geográficas exactas del punto al centro de la pantalla
     */
    getCenterCoordinates() {
      if (!this.viewer || !this.viewer.scene) return { lat: this.userLat, lng: this.userLng, alt: this.userAlt };
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
        return {
          lat: Cesium.Math.toDegrees(carto.latitude),
          lng: Cesium.Math.toDegrees(carto.longitude),
          alt: carto.height
        };
      }

      return { lat: this.userLat, lng: this.userLng, alt: this.userAlt };
    }

    /**
     * Desciende suavemente la cámara desde la vista aérea hacia el suelo y se inclina mirando al horizonte
     */
    async descendToGround(confirmedLat, confirmedLng, postureHeight = 1.6) {
      if (!this.viewer) return;
      const Cesium = window.Cesium;

      this.userLat = confirmedLat;
      this.userLng = confirmedLng;
      this.postureHeight = postureHeight;

      this._notifyStatus('Descendiendo a posición en tierra...');

      // Muestrear o aproximar cota del suelo
      let groundH = this.userAlt;
      try {
        const carto = Cesium.Cartographic.fromDegrees(this.userLng, this.userLat);
        const sampled = this.viewer.scene.sampleHeight(carto);
        if (typeof sampled === 'number' && !isNaN(sampled) && sampled > -200) {
          groundH = sampled;
        }
      } catch (e) {}

      this.groundAltitudeLocked = groundH;
      this.userAlt = groundH;

      const totalCamAlt = this.groundAltitudeLocked + this.postureHeight;
      this._cachedDestination = Cesium.Cartesian3.fromDegrees(this.userLng, this.userLat, totalCamAlt);

      // Transición cinemática suave: descenso con tilt hacia el horizonte (-2 grados)
      return new Promise((resolve) => {
        this.viewer.camera.flyTo({
          destination: this._cachedDestination,
          orientation: {
            heading: Cesium.Math.toRadians(0),
            pitch: Cesium.Math.toRadians(-2.0),
            roll: 0.0
          },
          duration: 3.0,
          complete: () => {
            this.setControlMode('first_person_free');
            resolve();
          }
        });
      });
    }

    /**
     * Cambia la postura del observador (De pie: 1.6m, Arrodillado: 0.9m, Tendido: 0.3m)
     */
    setPostureHeight(heightMeters) {
      this.postureHeight = heightMeters;
      if (this.controlMode === 'aerial') return;

      const Cesium = window.Cesium;
      const baseGround = this.groundAltitudeLocked !== null ? this.groundAltitudeLocked : this.userAlt;
      const totalCamAlt = baseGround + this.postureHeight;
      this._cachedDestination = Cesium.Cartesian3.fromDegrees(this.userLng, this.userLat, totalCamAlt);

      this.updateCameraOrientation();
    }

    /**
     * Modifica el modo de control: 'aerial', 'first_person_free' (tactil), 'first_person_sensor' (brújula)
     */
    setControlMode(mode) {
      this.controlMode = mode;
      const controller = this.viewer?.scene?.screenSpaceCameraController;
      if (!controller) return;

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
