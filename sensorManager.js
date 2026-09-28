/**
 * sensorManager.js - Gestor de sensores móviles (GPS, Brújula, Giroscopio e Inclinómetro)
 * Con bloqueo inteligente de coordenadas GPS (fijación certera, una sola vez, sin saltos posteriores)
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
      // Estado GPS: status = 'connecting' (amarillo) | 'connected' (verde) | 'disconnected' (rojo)
      this.gps = {
        lat: -33.4489,
        lng: -70.6693,
        alt: 600,
        accuracy: null,
        active: false,
        status: 'connecting',
        timestamp: null
      };

      this.isGpsLocked = false;
      this._gpsCandidates = [];
      this._gpsTimeoutTimer = null;
      this._watchId = null;

      // Estado de Orientación
      this.orientation = {
        heading: 0,
        pitch: 0,
        roll: 0,
        active: false
      };

      this._smoothHeading = 0;
      this._smoothPitch = 0;
      this._smoothRoll = 0;
      this.filterAlpha = 0.16;

      this._orientationHandler = null;

      // Callbacks
      this.onGpsUpdate = null;   // (gps) => {}
      this.onGpsLocked = null;   // (gps) => {} Llamado exactamente UNA vez al fijar posición
      this.onOrientationUpdate = null;
      this.onError = null;
    }

    /**
     * Inicia el rastreo GPS y recopila lecturas hasta estar SEGURO de la posición real
     */
    startGps() {
      if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
        this.gps.status = 'disconnected';
        if (this.onGpsUpdate) this.onGpsUpdate(this.gps);
        if (this.onError) this.onError('Geolocalización no soportada en este navegador.');
        return;
      }

      this.isGpsLocked = false;
      this._gpsCandidates = [];
      this.gps.status = 'connecting';
      if (this.onGpsUpdate) this.onGpsUpdate(this.gps);

      // Verificar si el permiso ya fue denegado explícitamente en el navegador
      if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: 'geolocation' }).then((permissionStatus) => {
          if (permissionStatus.state === 'denied') {
            this.gps.status = 'disconnected';
            if (this.onGpsUpdate) this.onGpsUpdate(this.gps);
            if (this.onError) this.onError('Permiso de GPS bloqueado en el navegador.');
          }
        }).catch(() => {});
      }

      const options = {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      };

      // Temporizador de respaldo: si tras 9 segundos tenemos lecturas con precisión aceptable (< 60m), fijar la mejor
      this._gpsTimeoutTimer = setTimeout(() => {
        if (!this.isGpsLocked && this._gpsCandidates.length > 0) {
          const best = this._getBestCandidate();
          if (best && best.accuracy <= 65) {
            console.log(`[GPS] Fijando mejor posición acumulada (precisión ±${Math.round(best.accuracy)}m)`);
            this._lockGps(best);
          }
        }
      }, 9000);

      this._watchId = navigator.geolocation.watchPosition(
        (pos) => {
          if (this.isGpsLocked) return;

          const candidate = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            alt: (pos.coords.altitude != null && !isNaN(pos.coords.altitude)) ? pos.coords.altitude : 600,
            accuracy: pos.coords.accuracy || 999,
            timestamp: Date.now()
          };

          this._gpsCandidates.push(candidate);
          this.gps.accuracy = candidate.accuracy;
          this.gps.timestamp = candidate.timestamp;

          // Criterios estrictos para estar SEGUROS de que son las coordenadas reales del dispositivo:
          // 1. Precisión satelital alta (<= 25m) -> Bloqueo inmediato
          // 2. O acumulación de al menos 2 lecturas consistentes con precisión <= 40m
          if (candidate.accuracy <= 25) {
            this._lockGps(candidate);
          } else if (candidate.accuracy <= 40 && this._gpsCandidates.length >= 2) {
            this._lockGps(this._getBestCandidate());
          } else {
            // Aún buscando o refinando satélites
            this.gps.status = 'connecting';
            if (this.onGpsUpdate) this.onGpsUpdate(this.gps);
          }
        },
        (err) => {
          if (this.isGpsLocked) return;

          console.warn('Error GPS:', err.code, err.message);
          // Si falló pero ya teníamos candidatos aceptables, fijamos el mejor
          if (this._gpsCandidates.length > 0) {
            const best = this._getBestCandidate();
            if (best && best.accuracy <= 70) {
              this._lockGps(best);
              return;
            }
          }

          this.gps.status = 'disconnected';
          if (this.onGpsUpdate) this.onGpsUpdate(this.gps);

          let errorMsg = 'Error buscando señal GPS.';
          if (err.code === 1) errorMsg = 'Permiso de ubicación denegado en el navegador.';
          else if (err.code === 2) errorMsg = 'Ubicación no disponible. Verifica que el GPS esté activo.';
          else if (err.code === 3) errorMsg = 'Tiempo de espera agotado buscando satélites GPS.';

          if (this.onError) this.onError(errorMsg);
        },
        options
      );
    }

    _getBestCandidate() {
      if (this._gpsCandidates.length === 0) return null;
      return this._gpsCandidates.reduce((best, curr) => (curr.accuracy < best.accuracy ? curr : best), this._gpsCandidates[0]);
    }

    /**
     * Fija la posición de forma definitiva, apaga el rastreo GPS y notifica
     */
    _lockGps(candidate) {
      if (this.isGpsLocked) return;

      this.isGpsLocked = true;
      this.gps.lat = candidate.lat;
      this.gps.lng = candidate.lng;
      this.gps.alt = candidate.alt;
      this.gps.accuracy = candidate.accuracy;
      this.gps.active = true;
      this.gps.status = 'connected'; // VERDE DEFINITIVO
      this.gps.timestamp = candidate.timestamp;

      // Detener el rastreo para no recibir más eventos ni cambiar la ubicación
      this.stopGps();

      if (this.onGpsUpdate) {
        this.onGpsUpdate(this.gps);
      }

      if (this.onGpsLocked) {
        this.onGpsLocked(this.gps);
      }
    }

    /**
     * Detiene el rastreador de GPS para evitar cualquier cambio posterior
     */
    stopGps() {
      if (this._gpsTimeoutTimer) {
        clearTimeout(this._gpsTimeoutTimer);
        this._gpsTimeoutTimer = null;
      }
      if (this._watchId != null && typeof navigator !== 'undefined' && navigator.geolocation) {
        navigator.geolocation.clearWatch(this._watchId);
        this._watchId = null;
      }
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

      if (typeof window !== 'undefined') {
        if ('ondeviceorientationabsolute' in window) {
          window.addEventListener('deviceorientationabsolute', this._orientationHandler, true);
        } else if ('ondeviceorientation' in window) {
          window.addEventListener('deviceorientation', this._orientationHandler, true);
        } else {
          if (this.onError) this.onError('Sensores de orientación no disponibles en este dispositivo.');
          return false;
        }
      }

      this.orientation.active = true;
      return true;
    }

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
      if (typeof window !== 'undefined') {
        if (window.screen && window.screen.orientation && window.screen.orientation.angle !== undefined) {
          return window.screen.orientation.angle;
        }
        if (typeof window.orientation === 'number') {
          return window.orientation;
        }
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
      this.stopGps();
      if (this._orientationHandler && typeof window !== 'undefined') {
        window.removeEventListener('deviceorientationabsolute', this._orientationHandler, true);
        window.removeEventListener('deviceorientation', this._orientationHandler, true);
        this._orientationHandler = null;
      }
      this.orientation.active = false;
    }
  }

  return SensorManager;
});
