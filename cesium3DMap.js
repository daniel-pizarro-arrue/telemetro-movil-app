/**
 * cesium3DMap.js - Controlador del visor 3D fotorrealista de CesiumJS con Google Photorealistic 3D Tiles
 * Optimizado para estabilidad máxima: anclaje de posición anti-jitter, bloqueo de altitud y suavizado.
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

      // Estado del observador (con anclaje anti-jitter)
      this.userLat = options.initialLat || -33.4489;
      this.userLng = options.initialLng || -70.6693;
      this.userAlt = options.initialAlt || 600;
      this.deviceHeight = 1.6; // Altura a nivel de ojos

      // Anclaje de posición y altitud estable
      this._anchorLat = null;
      this._anchorLng = null;
      this._groundAltitudeLocked = null;
      this._cachedDestination = null;

      // Orientación del dispositivo
      this.heading = 0; // Rumbo brújula 0..360
      this.pitch = 0;   // Inclinación -88..+88
      this.roll = 0;

      // Modo de operación: 'sensor' (sigue brújula) o 'free' (órbita/táctil)
      this.viewMode = 'sensor';

      // Instancias Cesium
      this.viewer = null;
      this.tileset = null;
      this.targetEntity = null;
      this.sightLineEntity = null;

      // Callbacks
      this.onTargetMeasured = null;
      this.onStatusChange = null;
    }

    /**
     * Inicializa el visor CesiumJS con Google Photorealistic 3D Tiles
     */
    async init() {
      if (!window.Cesium) {
        throw new Error('CesiumJS no está disponible en la ventana.');
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

        this._notifyStatus('✅ Mapa 3D fotorrealista activo');
      } catch (err) {
        console.error('Error cargando Google 3D Tiles:', err);
        this._notifyStatus('⚠️ Error cargando 3D Tiles. Verifique conexión.');
      }

      this._setupInteraction();

      // Configurar modo inicial
      this.setViewMode(this.viewMode);

      // Calcular anclaje inicial
      this._updateAnchor(this.userLat, this.userLng, this.userAlt, true);
      this.updateCameraOrientation();

      return this;
    }

    _notifyStatus(msg) {
      if (this.onStatusChange) {
        this.onStatusChange(msg);
      }
    }

    _setupInteraction() {
      const Cesium = window.Cesium;
      const handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);

      handler.setInputAction((movement) => {
        this.measureAtScreenPosition(movement.position);
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      this._eventHandler = handler;
    }

    /**
     * Actualiza la ubicación del usuario con filtro de umbral anti-jitter (Deadband)
     */
    updateUserPosition(lat, lng, alt) {
      if (this._anchorLat === null) {
        this._updateAnchor(lat, lng, alt, true);
        return;
      }

      // Calcular desplazamiento respecto al ancla actual con fórmula rápida Haversine
      const dLat = (lat - this._anchorLat) * 111139;
      const dLng = (lng - this._anchorLng) * 111139 * Math.cos((this._anchorLat * Math.PI) / 180);
      const dist = Math.sqrt(dLat * dLat + dLng * dLng);

      // Si el desplazamiento es menor a 3.5 metros, se considera ruido de GPS y se ignora
      if (dist < 3.5) {
        return;
      }

      // Si se movió más de 3.5 metros, actualizamos el anclaje suavemente
      const smoothLat = this._anchorLat * 0.7 + lat * 0.3;
      const smoothLng = this._anchorLng * 0.7 + lng * 0.3;
      this._updateAnchor(smoothLat, smoothLng, alt, false);
    }

    _updateAnchor(lat, lng, alt, force = false) {
      this._anchorLat = lat;
      this._anchorLng = lng;
      this.userLat = lat;
      this.userLng = lng;

      // Si no tenemos altitud del suelo bloqueada o nos movimos más de 50m, muestrear del terreno
      if (this._groundAltitudeLocked === null || force) {
        if (alt != null && !isNaN(alt) && alt > -200) {
          this.userAlt = alt;
        }
        this._sampleGroundAltitudeUnderUser();
      }

      const Cesium = window.Cesium;
      const totalCamAlt = (this._groundAltitudeLocked !== null ? this._groundAltitudeLocked : this.userAlt) + this.deviceHeight;
      this._cachedDestination = Cesium.Cartesian3.fromDegrees(this.userLng, this.userLat, totalCamAlt);

      if (this.viewMode === 'sensor') {
        this.updateCameraOrientation();
      }
    }

    /**
     * Muestrea una sola vez la elevación del suelo bajo el usuario para fijar la altitud
     */
    _sampleGroundAltitudeUnderUser() {
      if (!this.viewer || !this.viewer.scene) return;
      const Cesium = window.Cesium;
      try {
        const carto = Cesium.Cartographic.fromDegrees(this.userLng, this.userLat);
        const sampled = this.viewer.scene.sampleHeight(carto);
        if (typeof sampled === 'number' && !isNaN(sampled) && sampled > -200) {
          // Altitud del terreno real detectada y bloqueada: NUNCA más saltará
          this._groundAltitudeLocked = sampled;
          this.userAlt = sampled;
          const totalCamAlt = this._groundAltitudeLocked + this.deviceHeight;
          this._cachedDestination = Cesium.Cartesian3.fromDegrees(this.userLng, this.userLat, totalCamAlt);
        }
      } catch (e) {}
    }

    /**
     * Actualiza la orientación del dispositivo sin reconstruir la posición de destino
     */
    updateDeviceOrientation(headingDeg, pitchDeg, rollDeg) {
      this.heading = headingDeg;
      this.pitch = pitchDeg;
      this.roll = rollDeg || 0;

      if (this.viewMode === 'sensor') {
        this.updateCameraOrientation();
      }
    }

    /**
     * Cambia entre 'sensor' (primera persona con brújula) y 'free' (navegación libre táctil)
     */
    setViewMode(mode) {
      this.viewMode = mode;
      const controller = this.viewer?.scene?.screenSpaceCameraController;
      if (!controller) return;

      if (mode === 'sensor') {
        // En modo sensor, desactivar inputs del ratón/táctil para la cámara para evitar conflictos
        controller.enableRotate = false;
        controller.enableTranslate = false;
        controller.enableZoom = false;
        controller.enableTilt = false;
        controller.enableLook = false;
        this.updateCameraOrientation();
      } else {
        // En modo libre, permitir rotar, orbitar y hacer zoom con los dedos
        controller.enableRotate = true;
        controller.enableTranslate = true;
        controller.enableZoom = true;
        controller.enableTilt = true;
        controller.enableLook = true;
      }
    }

    /**
     * Rota la cámara en su lugar manteniendo la posición anclada (Cero Saltos)
     */
    updateCameraOrientation() {
      if (!this.viewer || !this.viewer.camera) return;
      const Cesium = window.Cesium;

      if (!this._cachedDestination) {
        const totalCamAlt = (this._groundAltitudeLocked !== null ? this._groundAltitudeLocked : this.userAlt) + this.deviceHeight;
        this._cachedDestination = Cesium.Cartesian3.fromDegrees(this.userLng, this.userLat, totalCamAlt);
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

    /**
     * Realiza un raycast / pick 3D en la pantalla y calcula la telemetría táctica
     */
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
        this._notifyStatus('⚠️ No se detectó superficie u objeto en la mira.');
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

      const userAltTotal = (this._groundAltitudeLocked !== null ? this._groundAltitudeLocked : this.userAlt) + this.deviceHeight;

      if (GeoMath) {
        horizDistance = GeoMath.haversineDistance(this.userLat, this.userLng, targetLat, targetLng);
        directDistance = GeoMath.calculate3DDistance(horizDistance, userAltTotal, targetAlt);
        bearing = GeoMath.calculateBearing(this.userLat, this.userLng, targetLat, targetLng);
        elevAngle = GeoMath.calculateElevationAngle(horizDistance, userAltTotal, targetAlt);
        utm = GeoMath.latLonToUTM(targetLat, targetLng);
      } else {
        const userCartesian = Cesium.Cartesian3.fromDegrees(this.userLng, this.userLat, userAltTotal);
        directDistance = Cesium.Cartesian3.distance(userCartesian, cartesianPicked);
        horizDistance = directDistance;
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

    /**
     * Dibuja marcador visual 3D táctico y línea láser hacia el objetivo
     */
    drawTargetMarker(targetCartesian, telemetryData) {
      if (!this.viewer) return;
      const Cesium = window.Cesium;
      const entities = this.viewer.entities;

      this.clearTarget();

      const userAltTotal = (this._groundAltitudeLocked !== null ? this._groundAltitudeLocked : this.userAlt) + this.deviceHeight;
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
