/**
 * sensorManager.js - Gestor de sensores móviles (GPS, Brújula, Giroscopio e Inclinómetro)
 * Con detección de estado de conexión GPS (desconectado, conectando, conectado) y suavizado.
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
      // Estado GPS: status = 'disconnected' | 'connecting' | 'connected'
      this.gps = {
        lat: -33.4489,
        lng: -70.6693,
        alt: 600,
        accuracy: null,
        active: false,
        status: 'connecting',
        timestamp: null
      };

      // Estado de Orientación
      this.orientation = {
        heading: 0, // 0..360 (Norte = 0)
        pitch: 0,   // -88..+88 (Horizonte = 0)
        roll: 0,
        active: false
      };

      // Filtro de suavizado (EMA)
      this._smoothHeading = 0;
      this._smoothPitch = 0;
      this._smoothRoll = 0;
      this.filterAlpha = 0.16; // Suavizado equilibrado contra micro-vibración de manos

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
        this.gps.status = 'disconnected';
        if (this.onGpsUpdate) this.onGpsUpdate(this.gps);
        if (this.onError) this.onError('Geolocalización no soportada en este navegador.');
        return;
      }

      this.gps.status = 'connecting';
      if (this.onGpsUpdate) this.onGpsUpdate(this.gps);

      const options = {
        enableHighAccuracy: true,
        timeout: 12000,
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

          // Estado según precisión: verde si <= 25m, amarillo si > 25m
          if (pos.coords.accuracy != null && pos.coords.accuracy <= 25) {
            this.gps.status = 'connected'; // Verde
          } else {
            this.gps.status = 'connecting'; // Amarillo
          }

          if (this.onGpsUpdate) {
            this.onGpsUpdate(this.gps);
          }
        },
        (err) => {
          console.warn('Error GPS:', err.message);
          this.gps.status = 'disconnected'; // Rojo
          if (this.onGpsUpdate) this.onGpsUpdate(this.gps);
          if (this.onError) this.onError(`GPS: ${err.message}`);
        },
        options
      );
    }

    /**
     * Solicita permisos e inicia los sensores de orientación del móvil
     */
    async startOrientation() {
      if (this.orientation.active) return true;

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

      if (event.webkitCompassHeading !== undefined && event.webkitCompassHeading !== null) {
        heading = event.webkitCompassHeading;
      } else if (event.alpha !== null) {
        heading = (360 - event.alpha) % 360;
      }

      const rawBeta = event.beta || 0;
      const rawGamma = event.gamma || 0;

      const screenAngle = this._getScreenOrientationAngle();

      if (screenAngle === 90) {
        pitch = rawGamma;
        heading = (heading + 90) % 360;
      } else if (screenAngle === -90 || screenAngle === 270) {
        pitch = -rawGamma;
        heading = (heading - 90 + 360) % 360;
      } else {
        pitch = rawBeta - 90;
      }

      roll = rawGamma;

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

    _lerpAngle(a, b, t) {
      let diff = (b - a) % 360;
      if (diff > 180) diff -= 360;
      if (diff < -180) diff += 360;
      return (a + diff * t + 360) % 360;
    }

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
      this.orientation.active = false;
    }
  }

  return SensorManager;
});
