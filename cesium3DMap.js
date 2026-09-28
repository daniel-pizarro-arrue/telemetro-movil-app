/**
 * cesium3DMap.js - Controlador del visor 3D fotorrealista de CesiumJS con Google Photorealistic 3D Tiles
 * Optimizado para dispositivos móviles, telemetría y medición táctica en tiempo real.
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

      // Estado del usuario
      this.userLat = options.initialLat || -33.4489;
      this.userLng = options.initialLng || -70.6693;
      this.userAlt = options.initialAlt || 600; // metros sobre nivel del mar
      this.deviceHeight = 1.6; // Altura de los ojos del usuario con el teléfono en mano

      // Orientación del dispositivo
      this.heading = 0; // Grados 0..360 (Norte = 0)
      this.pitch = 0;   // Grados -90..+90 (Horizonte = 0, Arriba = +90, Abajo = -90)
      this.roll = 0;
      this.headingOffset = 0; // Ajuste fino manual de calibración de brújula

      // Modo de operación: 'sensor' (primera persona siguiendo brújula) o 'free' (órbita/tactil)
      this.viewMode = 'sensor';
      this.isFrozen = false; // Permite congelar la vista para apuntar con calma

      // Instancias de Cesium
      this.viewer = null;
      this.tileset = null;
      this.targetEntity = null;
      this.sightLineEntity = null;
      this.userEntity = null;

      // Callbacks
      this.onTargetMeasured = null;
      this.onStatusChange = null;
    }

    /**
     * Inicializa el visor CesiumJS con Google Photorealistic 3D Tiles
     */
    async init() {
      if (!window.Cesium) {
        throw new Error('CesiumJS no está cargado en el documento.');
      }
      const Cesium = window.Cesium;

      this._notifyStatus('Iniciando motor 3D Cesium...');

      const container = typeof this.containerId === 'string'
        ? document.getElementById(this.containerId)
        : this.containerId;

      // Desactivar controles y widgets innecesarios para máximo rendimiento táctil y FPS móvil
      this.viewer = new Cesium.Viewer(container, {
        globe: false, // Google 3D Tiles incluye la superficie y atmósfera completa
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
        creditContainer: document.createElement('div'), // Ocultar créditos en UI principal
        contextOptions: {
          webgl: {
            preserveDrawingBuffer: false,
            powerPreference: 'high-performance'
          }
        }
      });

      const scene = this.viewer.scene;
      scene.backgroundColor = Cesium.Color.fromCssColorString('#020617');

      // Optimizar antialiasing y renderizado móvil
      if (scene.postProcessStages?.fxaa) {
        scene.postProcessStages.fxaa.enabled = true;
      }
      this.viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 1.5);
      this.viewer.targetFrameRate = 60;

      // Configurar reintentos robustos ante microcortes móviles
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

      this._notifyStatus('Conectando a Google Photorealistic 3D Tiles...');

      try {
        if (Cesium.GoogleMaps) {
          Cesium.GoogleMaps.defaultApiKey = this.googleApiKey;
        }

        this.tileset = await Cesium.createGooglePhotorealistic3DTileset(this.googleApiKey);
        scene.primitives.add(this.tileset);

        // Ajustes de rendimiento y nitidez probados para 3D Tiles en móviles
        this.tileset.maximumScreenSpaceError = 24; // Balance óptimo entre nitidez y descarga rápida
        this.tileset.skipLevelOfDetail = true;
        this.tileset.baseScreenSpaceError = 1024;
        this.tileset.skipScreenSpaceErrorFactor = 16;
        this.tileset.cullRequestsWhileMoving = true;
        this.tileset.cullRequestsWhileMovingMultiplier = 60.0;
        this.tileset.dynamicScreenSpaceError = true;
        this.tileset.preloadFlightCamera = true;
        this.tileset.maximumMemoryUsage = 384; // 384 MB de caché GPU para no saturar navegadores móviles

        this._notifyStatus('✅ Mapa 3D fotorrealista activo');
      } catch (err) {
        console.error('Error cargando Google Photorealistic 3D Tiles:', err);
        this._notifyStatus('⚠️ Error cargando 3D Tiles de Google. Verifique conexión.');
      }

      // Configurar interacción táctil
      this._setupInteraction();

      // Posicionar cámara inicial
      this.updateCamera();

      return this;
    }

    _notifyStatus(msg) {
      if (this.onStatusChange) {
        this.onStatusChange(msg);
      }
    }

    /**
     * Configura controladores de eventos de clic y toque en pantalla para medición
     */
    _setupInteraction() {
      const Cesium = window.Cesium;
      const handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);

      // Medir al hacer clic o tap directo sobre el mapa
      handler.setInputAction((movement) => {
        this.measureAtScreenPosition(movement.position);
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      // Guardar referencia para destruirlo al limpiar
      this._eventHandler = handler;
    }

    /**
     * Actualiza la ubicación del usuario (recibida desde GPS)
     */
    updateUserPosition(lat, lng, alt) {
      this.userLat = lat;
      this.userLng = lng;
      if (alt != null && !isNaN(alt) && alt > -500) {
        this.userAlt = alt;
      }

      // Si el tileset ya cargó, muestrear altura precisa del suelo bajo el usuario
      this._sampleGroundAltitudeUnderUser();

      if (this.viewMode === 'sensor' && !this.isFrozen) {
        this.updateCamera();
      }
    }

    /**
     * Muestrea la elevación exacta del terreno bajo los pies del usuario
     */
    _sampleGroundAltitudeUnderUser() {
      if (!this.viewer || !this.viewer.scene) return;
      const Cesium = window.Cesium;
      try {
        const carto = Cesium.Cartographic.fromDegrees(this.userLng, this.userLat);
        const sampled = this.viewer.scene.sampleHeight(carto);
        if (typeof sampled === 'number' && !isNaN(sampled) && sampled > -200) {
          // Altura real del suelo detectada por la fotogrametría 3D
          this.userAlt = sampled;
        }
      } catch (e) {
        // En caso de que las teselas aún no estén en memoria
      }
    }

    /**
     * Actualiza la orientación del dispositivo (Brújula + Inclinación)
     * @param {number} headingDeg - Rumbo brújula (0..360)
     * @param {number} pitchDeg - Inclinación (-90..90)
     * @param {number} rollDeg - Balanceo (-90..90)
     */
    updateDeviceOrientation(headingDeg, pitchDeg, rollDeg) {
      this.heading = headingDeg;
      this.pitch = pitchDeg;
      this.roll = rollDeg || 0;

      if (this.viewMode === 'sensor' && !this.isFrozen) {
        this.updateCamera();
      }
    }

    /**
     * Modifica el offset de calibración de azimut (ej. ±15° para alinear con el cerro real)
     */
    setHeadingOffset(deg) {
      this.headingOffset = deg;
      if (this.viewMode === 'sensor') {
        this.updateCamera();
      }
    }

    /**
     * Cambia entre 'sensor' (sigue orientación del celular) y 'free' (navegación libre táctil)
     */
    setViewMode(mode) {
      this.viewMode = mode;
      const controller = this.viewer?.scene?.screenSpaceCameraController;
      if (!controller) return;

      if (mode === 'sensor') {
        // En modo sensor, bloquear rotación táctil para que manden los sensores
        controller.enableRotate = false;
        controller.enableTranslate = false;
        controller.enableZoom = true;
        controller.enableTilt = false;
        controller.enableLook = false;
        this.updateCamera();
      } else {
        // En modo libre, permitir interacción completa táctil
        controller.enableRotate = true;
        controller.enableTranslate = true;
        controller.enableZoom = true;
        controller.enableTilt = true;
        controller.enableLook = true;
      }
    }

    /**
     * Congela o descongela la orientación de la cámara
     */
    setFrozen(frozen) {
      this.isFrozen = frozen;
    }

    /**
     * Aplica la posición y orientación del usuario a la cámara de Cesium
     */
    updateCamera() {
      if (!this.viewer || !this.viewer.camera) return;
      const Cesium = window.Cesium;

      // Altura total de la cámara: cota del terreno + altura de ojos
      const totalCamAlt = this.userAlt + this.deviceHeight;
      const dest = Cesium.Cartesian3.fromDegrees(this.userLng, this.userLat, totalCamAlt);

      // Rumbo compensado por la calibración manual
      const effectiveHeading = (this.heading + this.headingOffset + 360) % 360;

      // Cesium: Heading (0 = Norte, 90 = Este, rad), Pitch (-90 = Nadir, 0 = Horizonte, 90 = Cenit, rad)
      const headingRad = Cesium.Math.toRadians(effectiveHeading);
      // Limitamos el pitch para evitar singularidades en el cenit exacto
      const pitchRad = Cesium.Math.toRadians(Math.max(-89.0, Math.min(89.0, this.pitch)));

      this.viewer.camera.setView({
        destination: dest,
        orientation: {
          heading: headingRad,
          pitch: pitchRad,
          roll: 0.0
        }
      });
    }

    /**
     * Mide el objetivo en el centro de la retícula de la pantalla (disparo táctico)
     */
    measureCenterReticle() {
      if (!this.viewer || !this.viewer.scene) return null;
      const Cesium = window.Cesium;
      const canvas = this.viewer.scene.canvas;
      const centerPos = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
      return this.measureAtScreenPosition(centerPos);
    }

    /**
     * Realiza un raycast / pick 3D en la pantalla y calcula la telemetría completa
     * @param {Cesium.Cartesian2} screenPosition
     */
    measureAtScreenPosition(screenPosition) {
      if (!this.viewer || !this.viewer.scene) return null;
      const Cesium = window.Cesium;
      const scene = this.viewer.scene;

      // Obtener posición 3D real sobre la malla fotorrealista de Google 3D Tiles
      let cartesianPicked = null;
      try {
        cartesianPicked = scene.pickPosition(screenPosition);
      } catch (err) {
        console.warn('Error en pickPosition:', err);
      }

      // Si no impacta la malla directa, intentar con el elipsoide como respaldo
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

      // Convertir a coordenadas geodésicas (Lat, Lng, Altitud)
      const carto = Cesium.Cartographic.fromCartesian(cartesianPicked);
      const targetLat = Cesium.Math.toDegrees(carto.latitude);
      const targetLng = Cesium.Math.toDegrees(carto.longitude);
      const targetAlt = carto.height;

      // Cálculos geodésicos con GeoMath
      const GeoMath = window.GeoMath || (typeof require !== 'undefined' ? require('./geoMath.js') : null);
      let horizDistance = 0;
      let directDistance = 0;
      let bearing = 0;
      let elevAngle = 0;

      if (GeoMath) {
        horizDistance = GeoMath.haversineDistance(this.userLat, this.userLng, targetLat, targetLng);
        directDistance = GeoMath.calculate3DDistance(horizDistance, this.userAlt + this.deviceHeight, targetAlt);
        bearing = GeoMath.calculateBearing(this.userLat, this.userLng, targetLat, targetLng);
        elevAngle = GeoMath.calculateElevationAngle(horizDistance, this.userAlt + this.deviceHeight, targetAlt);
      } else {
        // Fallback básico
        const userCartesian = Cesium.Cartesian3.fromDegrees(this.userLng, this.userLat, this.userAlt + this.deviceHeight);
        directDistance = Cesium.Cartesian3.distance(userCartesian, cartesianPicked);
        horizDistance = directDistance;
      }

      const deltaElevation = targetAlt - (this.userAlt + this.deviceHeight);

      const result = {
        target: {
          lat: targetLat,
          lng: targetLng,
          alt: targetAlt,
          cartesian: cartesianPicked
        },
        user: {
          lat: this.userLat,
          lng: this.userLng,
          alt: this.userAlt + this.deviceHeight
        },
        directDistance,
        horizDistance,
        deltaElevation,
        bearing,
        elevAngle,
        timestamp: new Date().toISOString()
      };

      // Representar el objetivo visualmente en 3D
      this.drawTargetMarker(cartesianPicked, result);

      if (this.onTargetMeasured) {
        this.onTargetMeasured(result);
      }

      return result;
    }

    /**
     * Dibuja marcador visual 3D táctico y línea de visión hacia el objetivo
     */
    drawTargetMarker(targetCartesian, telemetryData) {
      if (!this.viewer) return;
      const Cesium = window.Cesium;
      const entities = this.viewer.entities;

      // Limpiar objetivo anterior
      this.clearTarget();

      const userCartesian = Cesium.Cartesian3.fromDegrees(
        this.userLng,
        this.userLat,
        this.userAlt + this.deviceHeight
      );

      const distLabel = telemetryData?.directDistance != null
        ? (telemetryData.directDistance < 1000
            ? `${Math.round(telemetryData.directDistance)} m`
            : `${(telemetryData.directDistance / 1000).toFixed(2)} km`)
        : 'OBJETIVO';

      // 1. Marcador puntual en el objetivo
      this.targetEntity = entities.add({
        position: targetCartesian,
        point: {
          pixelSize: 12,
          color: Cesium.Color.fromCssColorString('#00ffcc'),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        },
        label: {
          text: `🎯 ${distLabel}\nΔH: ${Math.round(telemetryData.deltaElevation)}m`,
          font: 'bold 13px monospace',
          fillColor: Cesium.Color.fromCssColorString('#00ffcc'),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -28),
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });

      // 2. Línea de visión directa láser (Sight Line)
      this.sightLineEntity = entities.add({
        polyline: {
          positions: [userCartesian, targetCartesian],
          width: 3,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.25,
            color: Cesium.Color.fromCssColorString('#00ffcc')
          }),
          depthFailMaterial: new Cesium.PolylineDashMaterialProperty({
            color: Cesium.Color.fromCssColorString('#ffaa00')
          })
        }
      });
    }

    /**
     * Elimina los marcadores 3D del visor
     */
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

    /**
     * Mueve suavemente la vista hacia un punto
     */
    flyTo(lat, lng, height = 800) {
      if (!this.viewer) return;
      const Cesium = window.Cesium;
      this.viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(lng, lat, height),
        duration: 1.5
      });
    }

    /**
     * Libera memoria y destruye el visor
     */
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
