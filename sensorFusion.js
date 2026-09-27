/**
 * sensorFusion.js - Fusión sensorial de alta precisión, estabilización de ángulos
 * y corrección geodésica para el Telémetro Móvil.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SensorFusion = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Aproximación de declinación magnética para corregir rumbo magnético a rumbo verdadero
   * según coordenadas geográficas y año de referencia.
   */
  function estimateMagneticDeclination(lat, lon, year = 2026) {
    // Aproximación polinómica simplificada para corrección rápida en terreno
    // Precisión suficiente para compensar la discrepancia regional (típicamente ±1-2°)
    const latRad = (lat * Math.PI) / 180.0;
    const lonRad = (lon * Math.PI) / 180.0;
    // Estimación base con dipolo geomagnético inclinado
    const g10 = -29404.8 + (year - 2020) * 5.7;
    const g11 = -1450.9 + (year - 2020) * 7.4;
    const h11 = 4652.5 - (year - 2020) * 25.9;

    const x = -g10 * Math.cos(latRad) - (g11 * Math.cos(lonRad) + h11 * Math.sin(lonRad)) * Math.sin(latRad);
    const y = -g11 * Math.sin(lonRad) + h11 * Math.cos(lonRad);

    const declinationDeg = (Math.atan2(y, x) * 180.0) / Math.PI;
    return Math.round(declinationDeg * 10) / 10;
  }

  /**
   * Filtro de suavizado circular para ángulos (evita discontinuidades en 0°/360°)
   */
  class CircularEMA {
    constructor(alpha = 0.2) {
      this.alpha = alpha;
      this.sinSum = 0;
      this.cosSum = 0;
      this.initialized = false;
    }

    update(deg) {
      const rad = (deg * Math.PI) / 180.0;
      const s = Math.sin(rad);
      const c = Math.cos(rad);

      if (!this.initialized) {
        this.sinSum = s;
        this.cosSum = c;
        this.initialized = true;
      } else {
        this.sinSum = this.alpha * s + (1 - this.alpha) * this.sinSum;
        this.cosSum = this.alpha * c + (1 - this.alpha) * this.cosSum;
      }

      let avgRad = Math.atan2(this.sinSum, this.cosSum);
      if (avgRad < 0) avgRad += 2 * Math.PI;
      return (avgRad * 180.0) / Math.PI;
    }

    reset() {
      this.initialized = false;
      this.sinSum = 0;
      this.cosSum = 0;
    }
  }

  /**
   * Filtro lineal EMA para valores continuos (como la inclinación / pitch)
   */
  class LinearEMA {
    constructor(alpha = 0.2) {
      this.alpha = alpha;
      this.value = null;
    }

    update(val) {
      if (this.value === null) {
        this.value = val;
      } else {
        this.value = this.alpha * val + (1 - this.alpha) * this.value;
      }
      return this.value;
    }

    reset() {
      this.value = null;
    }
  }

  /**
   * Calcula el vector 3D real de la cámara trasera y extrae el Azimut y Pitch
   * independientemente de la inclinación del teléfono (evita el gimbal lock a 90°).
   */
  function calculateCameraOrientation(alphaDeg, betaDeg, gammaDeg) {
    const degToRad = Math.PI / 180.0;
    const a = (alphaDeg || 0) * degToRad;
    const b = (betaDeg || 0) * degToRad;
    const g = (gammaDeg || 0) * degToRad;

    // Componentes del vector de la cámara trasera en coordenadas terrestres (East, North, Up):
    // La cámara trasera apunta en la dirección -Z del teléfono.
    // Usando la matriz de rotación W3C R = Rz(alpha) * Rx(beta) * Ry(gamma):
    const sinA = Math.sin(a), cosA = Math.cos(a);
    const sinB = Math.sin(b), cosB = Math.cos(b);
    const sinG = Math.sin(g), cosG = Math.cos(g);

    // Vector de la cámara:
    const vEast = -(sinA * sinG + cosA * sinB * cosG);
    const vNorth = -( -cosA * sinG + sinA * sinB * cosG );
    const vUp = cosB * cosG; // Positivo hacia arriba (mirando a un cerro/cielo)

    // Azimut verdadero desde el Norte (0° = N, 90° = E, 180° = S, 270° = W)
    let azimuth = Math.atan2(vEast, vNorth) * (180.0 / Math.PI);
    if (azimuth < 0) azimuth += 360.0;

    // Pitch: ángulo de elevación respecto al plano horizontal (-90° a +90°)
    const horizDist = Math.sqrt(vEast * vEast + vNorth * vNorth);
    const pitch = Math.atan2(vUp, horizDist) * (180.0 / Math.PI);

    return {
      azimuth: azimuth,
      pitch: pitch,
      vEast: vEast,
      vNorth: vNorth,
      vUp: vUp
    };
  }

  /**
   * Gestor de Sensores Móviles
   */
  class SensorManager {
    constructor(options = {}) {
      this.postureHeight = options.postureHeight || 1.60; // Metros
      this.angleUnit = options.angleUnit || 'deg';        // 'deg' o 'mils'
      
      this.headingFilter = new CircularEMA(0.18);
      this.pitchFilter = new LinearEMA(0.20);
      this.rollFilter = new LinearEMA(0.20);

      this.currentRaw = {
        azimuth: 0,
        pitch: 0,
        roll: 0
      };

      this.currentFiltered = {
        azimuthTrue: 0,
        azimuthMag: 0,
        pitch: 0,
        roll: 0
      };

      this.gps = {
        lat: null,
        lon: null,
        gpsAlt: null,
        accuracy: null,
        groundAlt: null,
        effectiveAlt: null,
        timestamp: null,
        isAcquired: false
      };

      this.declination = 0;
      this.watchId = null;
      this.orientationActive = false;
      this.onUpdateCallback = null;
    }

    setPostureHeight(heightMeters) {
      this.postureHeight = Number(heightMeters);
      this.recalculateEffectiveAlt();
    }

    recalculateEffectiveAlt() {
      if (this.gps.groundAlt !== null) {
        this.gps.effectiveAlt = this.gps.groundAlt + this.postureHeight;
      } else if (this.gps.gpsAlt !== null) {
        this.gps.effectiveAlt = this.gps.gpsAlt;
      }
    }

    /**
     * Inicia el rastreo continuo de geolocalización de alta precisión
     */
    startGPS(onGpsUpdate) {
      if (!('geolocation' in navigator)) {
        throw new Error('Geolocalización no soportada en este navegador');
      }

      const options = {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      };

      this.watchId = navigator.geolocation.watchPosition(
        async (position) => {
          const { latitude, longitude, altitude, accuracy } = position.coords;
          this.gps.lat = latitude;
          this.gps.lon = longitude;
          this.gps.gpsAlt = altitude !== null ? Math.round(altitude * 10) / 10 : null;
          this.gps.accuracy = Math.round(accuracy * 10) / 10;
          this.gps.timestamp = position.timestamp;
          this.gps.isAcquired = true;

          // Actualizar declinación magnética estimada según la posición
          this.declination = estimateMagneticDeclination(latitude, longitude);

          // Si aún no tenemos la cota de terreno o nos hemos movido considerablemente, consultar DEM
          if (this.gps.groundAlt === null) {
            await this.refreshGroundElevation();
          }

          if (onGpsUpdate) onGpsUpdate(this.gps);
        },
        (error) => {
          console.warn('Error en GPS:', error.message);
        },
        options
      );
    }

    /**
     * Consulta la cota exacta de terreno del DEM para la posición horizontal actual
     */
    async refreshGroundElevation() {
      if (this.gps.lat === null || this.gps.lon === null) return;
      try {
        const url = `https://api.open-meteo.com/v1/elevation?latitude=${this.gps.lat.toFixed(5)}&longitude=${this.gps.lon.toFixed(5)}`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          if (data && data.elevation !== undefined) {
            const ground = Array.isArray(data.elevation) ? data.elevation[0] : data.elevation;
            this.gps.groundAlt = Math.round(ground * 10) / 10;
            this.recalculateEffectiveAlt();
          }
        }
      } catch (e) {
        console.warn('No se pudo obtener cota de terreno DEM:', e);
      }
    }

    /**
     * Inicia los sensores de orientación del teléfono (Inclinómetro y Brújula)
     */
    async startOrientation(onOrientationUpdate) {
      this.onUpdateCallback = onOrientationUpdate;

      // Soporte para permisos en iOS 13+
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission !== 'granted') {
          throw new Error('Permiso denegado para sensores de orientación');
        }
      }

      const handler = (event) => {
        const alpha = event.alpha;
        const beta = event.beta;
        const gamma = event.gamma;

        if (beta === null || gamma === null) return;

        // Calcular orientación 3D exacta del eje óptico de la cámara
        const cam = calculateCameraOrientation(alpha, beta, gamma);

        let measuredAzimuth = cam.azimuth;

        // En iOS, si webkitCompassHeading está disponible, proporciona rumbo magnético calibrado
        if (typeof event.webkitCompassHeading !== 'undefined' && event.webkitCompassHeading !== null) {
          measuredAzimuth = event.webkitCompassHeading;
        }

        // Suavizar azimut con filtro circular (evita saltos en 0°/360°)
        const smoothedAz = this.headingFilter.update(measuredAzimuth);
        this.currentFiltered.azimuthMag = Math.round(smoothedAz * 10) / 10;

        // Aplicar declinación magnética para asegurar Azimut Verdadero
        let trueHeading = smoothedAz;
        if (!event.absolute || typeof event.webkitCompassHeading !== 'undefined') {
          trueHeading = (smoothedAz + this.declination + 360) % 360;
        }
        this.currentFiltered.azimuthTrue = Math.round(trueHeading * 10) / 10;

        // Pitch del visor de la cámara (-90° a +90°, positivo hacia arriba al apuntar cerros)
        const smoothedPitch = this.pitchFilter.update(cam.pitch);
        this.currentFiltered.pitch = Math.round(smoothedPitch * 10) / 10;

        // Roll (alabeo / inclinación lateral)
        const smoothedRoll = this.rollFilter.update(gamma);
        this.currentFiltered.roll = Math.round(smoothedRoll * 10) / 10;

        if (this.onUpdateCallback) {
          this.onUpdateCallback(this.getReadings());
        }
      };

      // Preferir deviceorientationabsolute en Android si está disponible para mayor precisión
      if ('ondeviceorientationabsolute' in window) {
        window.addEventListener('deviceorientationabsolute', handler, true);
      } else {
        window.addEventListener('deviceorientation', handler, true);
      }
      this.orientationActive = true;
    }

    /**
     * Retorna una copia instantánea de todas las lecturas filtradas y calibradas
     */
    getReadings() {
      const azTrue = this.currentFiltered.azimuthTrue;
      const pitch = this.currentFiltered.pitch;

      return {
        azimuthTrue: azTrue,
        azimuthMag: this.currentFiltered.azimuthMag,
        azimuthMils: Math.round((azTrue / 360.0) * 6400), // Milésimas artilleras (6400 mils/círculo)
        pitchDeg: pitch,
        pitchMils: Math.round((pitch / 360.0) * 6400),
        rollDeg: this.currentFiltered.roll,
        declination: this.declination,
        postureHeight: this.postureHeight,
        gps: { ...this.gps }
      };
    }

    stop() {
      if (this.watchId !== null) {
        navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null;
      }
    }
  }

  return {
    estimateMagneticDeclination,
    CircularEMA,
    LinearEMA,
    SensorManager
  };
});
