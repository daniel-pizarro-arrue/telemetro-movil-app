/**
 * telemetryLogger.js - Módulo de telemetría y diagnóstico en tiempo real con Firebase RTDB
 * Envía datos crudos de sensores, GPS, vector 3D de la cámara y resultados de raymarching
 * para análisis y depuración remota directa por parte del agente Antigravity.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TelemetryLogger = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FIREBASE_API_KEY = "AIzaSyC-26ZaTDMapEJXciLRP-mhWERlsjZjyTw";
  const RTDB_BASE_URL = "https://chatin-e31ea-default-rtdb.firebaseio.com";
  const SESSIONS_PATH = "sessions/telemetro_debug";

  let cachedIdToken = null;
  let tokenExpiryTime = 0;

  /**
   * Obtiene o renueva el token anónimo de Firebase Authentication vía REST
   */
  async function getIdToken() {
    const now = Date.now();
    if (cachedIdToken && now < tokenExpiryTime) {
      return cachedIdToken;
    }

    try {
      const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true })
      });

      if (!response.ok) {
        throw new Error(`Auth failed with status ${response.status}`);
      }

      const data = await response.json();
      cachedIdToken = data.idToken;
      // Expira típicamente en 3600 segundos (guardar con 5 min de holgura)
      tokenExpiryTime = now + (parseInt(data.expiresIn || '3600', 10) - 300) * 1000;
      return cachedIdToken;
    } catch (err) {
      console.warn('Error en autenticación anónima de Firebase:', err);
      return null;
    }
  }

  /**
   * Envía un paquete completo de telemetría a Firebase RTDB
   * @param {Object} payload - Objeto con datos de sensores, GPS, cálculo e impacto
   */
  async function sendTelemetry(payload) {
    try {
      const token = await getIdToken();
      if (!token) return false;

      const record = {
        ...payload,
        clientTimestamp: new Date().toISOString(),
        clientEpoch: Date.now(),
        userAgent: navigator.userAgent
      };

      // 1. Guardar como 'latest' para inspección instantánea por el agente
      const latestUrl = `${RTDB_BASE_URL}/${SESSIONS_PATH}/latest.json?auth=${token}`;
      fetch(latestUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record)
      }).catch(e => console.warn('Error guardando latest telemetry:', e));

      // 2. Guardar en histórico para trazar mediciones consecutivas
      const historyUrl = `${RTDB_BASE_URL}/${SESSIONS_PATH}/history.json?auth=${token}`;
      fetch(historyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record)
      }).catch(e => console.warn('Error guardando history telemetry:', e));

      return true;
    } catch (err) {
      console.warn('Error enviando telemetría a Firebase:', err);
      return false;
    }
  }

  return {
    getIdToken,
    sendTelemetry
  };
});
