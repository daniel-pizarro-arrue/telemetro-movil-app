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
        let compassHeading = null;

        // iOS proporciona webkitCompassHeading (rumbo magnético o verdadero si GPS activo)
        if (typeof event.webkitCompassHeading !== 'undefined') {
          compassHeading = event.webkitCompassHeading;
        } else if (event.alpha !== null) {
          // Android: alpha va en sentido antihorario [0, 360], convertir a azimut horario [0, 360]
          compassHeading = (360 - event.alpha) % 360;
        }

        let pitch = 0;
        let roll = 0;

        // Determinación del pitch del visor de la cámara:
        // Cuando el teléfono se sostiene verticalmente frente a los ojos:
        // beta ≈ 90° al mirar al frente (horizonte = 0°).
        // Si se inclina hacia arriba: beta > 90° o pitch positivo.
        // Si se inclina hacia abajo: beta < 90° o pitch negativo.
        if (event.beta !== null) {
          // Normalizar para que mirando al frente horizonte = 0°
          pitch = event.beta - 90;
        }

        if (event.gamma !== null) {
          roll = event.gamma;
        }

        if (compassHeading !== null) {
          this.currentRaw.azimuth = compassHeading;
          const smoothedMag = this.headingFilter.update(compassHeading);
          this.currentFiltered.azimuthMag = Math.round(smoothedMag * 10) / 10;
          // Aplicar declinación magnética para obtener el Azimut Geográfico (Verdadero)
          let trueHeading = (smoothedMag + this.declination + 360) % 360;
          this.currentFiltered.azimuthTrue = Math.round(trueHeading * 10) / 10;
        }

        this.currentRaw.pitch = pitch;
        this.currentRaw.roll = roll;

        this.currentFiltered.pitch = Math.round(this.pitchFilter.update(pitch) * 10) / 10;
        this.currentFiltered.roll = Math.round(this.rollFilter.update(roll) * 10) / 10;

        if (this.onUpdateCallback) {
          this.onUpdateCallback(this.getReadings());
        }
      };

      window.addEventListener('deviceorientation', handler, true);
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
