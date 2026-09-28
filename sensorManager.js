/**
 * sensorManager.js - Gestor de sensores móviles (GPS, Brújula, Giroscopio e Inclinómetro)
 * Soporta orientación de pantalla (vertical / horizontal) y filtro pasa-bajos contra vibración.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SensorManager = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class SensorManager {
    constructor() {
      // Estado GPS
      this.gps = {
        lat: -33.4489,
        lng: -70.6693,
        alt: 600,
        accuracy: null,
        active: false,
        timestamp: null
      };

      // Estado de Orientación
      this.orientation = {
        heading: 0, // 0..360 (Norte = 0)
        pitch: 0,   // -90..+90 (Horizonte = 0)
        roll: 0,
        active: false
      };

      // Filtro de suavizado (EMA)
      this._smoothHeading = 0;
      this._smoothPitch = 0;
      this._smoothRoll = 0;
      this.filterAlpha = 0.25; // 0.25 = buen compromiso entre reactividad y estabilidad

      this._watchId = null;
      this._orientationHandler = null;

      // Callbacks
      this.onGpsUpdate = null;
      this.onOrientationUpdate = null;
      this.onError = null;
    }

    /**
     * Inicia el rastreo GPS de alta precisión
     */
    startGps() {
      if (!('geolocation' in navigator)) {
        if (this.onError) this.onError('Geolocalización no soportada en este navegador.');
        return;
      }

      const options = {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      };

      this._watchId = navigator.geolocation.watchPosition(
        (pos) => {
          this.gps.lat = pos.coords.latitude;
          this.gps.lng = pos.coords.longitude;
          if (pos.coords.altitude != null && !isNaN(pos.coords.altitude)) {
            this.gps.alt = pos.coords.altitude;
          }
          this.gps.accuracy = pos.coords.accuracy;
          this.gps.active = true;
          this.gps.timestamp = Date.now();

          if (this.onGpsUpdate) {
            this.onGpsUpdate(this.gps);
          }
        },
        (err) => {
          console.warn('Error GPS:', err.message);
          if (this.onError) this.onError(`GPS: ${err.message}`);
        },
        options
      );
    }

    /**
     * Solicita permisos e inicia los sensores de orientación del móvil
     */
    async startOrientation() {
      // Soporte para iOS 13+ (requiere gesto del usuario para solicitar permiso)
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
          const permission = await DeviceOrientationEvent.requestPermission();
          if (permission !== 'granted') {
            if (this.onError) this.onError('Permiso de sensores de orientación denegado.');
            return false;
          }
        } catch (e) {
          console.warn('Error solicitando permiso DeviceOrientation:', e);
        }
      }

      this._orientationHandler = (event) => {
        this._processDeviceOrientation(event);
      };

      // Preferir el evento absoluto si está disponible (Chrome Android)
      if ('ondeviceorientationabsolute' in window) {
        window.addEventListener('deviceorientationabsolute', this._orientationHandler, true);
      } else if ('ondeviceorientation' in window) {
        window.addEventListener('deviceorientation', this._orientationHandler, true);
      } else {
        if (this.onError) this.onError('Sensores de orientación no disponibles en este dispositivo.');
        return false;
      }

      this.orientation.active = true;
      return true;
    }

    /**
     * Procesa los eventos de orientación y compensa la rotación de la pantalla (Portrait / Landscape)
     */
    _processDeviceOrientation(event) {
      let heading = 0;
      let pitch = 0;
      let roll = 0;

      // 1. Detectar rumbo de la brújula
      if (event.webkitCompassHeading !== undefined && event.webkitCompassHeading !== null) {
        // iOS Safari entrega rumbo directo respecto al Norte magnético
        heading = event.webkitCompassHeading;
      } else if (event.alpha !== null) {
        // En Android, alpha mide rotación respecto al norte si es evento absoluto
        // Si el teléfono apunta al frente, convertimos a rumbo 360
        heading = (360 - event.alpha) % 360;
      }

      // 2. Inclinación del teléfono (Pitch / Beta)
      // Cuando el usuario sostiene el teléfono vertical frente a sus ojos mirando al frente: beta ≈ 90°.
      // Horizonte = 0°. Por lo tanto, pitch = beta - 90°
      const rawBeta = event.beta || 0;
      const rawGamma = event.gamma || 0;

      // 3. Compensación de orientación de pantalla (0°, 90°, -90°, 180°)
      const screenAngle = this._getScreenOrientationAngle();

      if (screenAngle === 90) {
        // Modo horizontal hacia la izquierda
        pitch = rawGamma;
        heading = (heading + 90) % 360;
      } else if (screenAngle === -90 || screenAngle === 270) {
        // Modo horizontal hacia la derecha
        pitch = -rawGamma;
        heading = (heading - 90 + 360) % 360;
      } else {
        // Modo vertical (Portrait) estándar
        pitch = rawBeta - 90;
      }

      roll = rawGamma;

      // 4. Suavizado de valores angulares (evita salto de 359° a 0°)
      this._smoothHeading = this._lerpAngle(this._smoothHeading, heading, this.filterAlpha);
      this._smoothPitch = this._smoothPitch + (pitch - this._smoothPitch) * this.filterAlpha;
      this._smoothRoll = this._smoothRoll + (roll - this._smoothRoll) * this.filterAlpha;

      this.orientation.heading = (this._smoothHeading + 360) % 360;
      this.orientation.pitch = Math.max(-88, Math.min(88, this._smoothPitch));
      this.orientation.roll = this._smoothRoll;

      if (this.onOrientationUpdate) {
        this.onOrientationUpdate(this.orientation);
      }
    }

    _getScreenOrientationAngle() {
      if (window.screen && window.screen.orientation && window.screen.orientation.angle !== undefined) {
        return window.screen.orientation.angle;
      }
      if (typeof window.orientation === 'number') {
        return window.orientation;
      }
      return 0;
    }

    /**
     * Interpolación lineal angular para evitar discontinuidades en el cruce por el Norte (0/360)
     */
    _lerpAngle(a, b, t) {
      let diff = (b - a) % 360;
      if (diff > 180) diff -= 360;
      if (diff < -180) diff += 360;
      return (a + diff * t + 360) % 360;
    }

    /**
     * Detiene los sensores
     */
    stop() {
      if (this._watchId != null && navigator.geolocation) {
        navigator.geolocation.clearWatch(this._watchId);
        this._watchId = null;
      }
      if (this._orientationHandler) {
        window.removeEventListener('deviceorientationabsolute', this._orientationHandler, true);
        window.removeEventListener('deviceorientation', this._orientationHandler, true);
        this._orientationHandler = null;
      }
    }
  }

  return SensorManager;
});
