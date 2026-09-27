// Inicialización y detección de sensores para el Telémetro Móvil
document.addEventListener('DOMContentLoaded', () => {
  const angleReadout = document.getElementById('angle-readout');
  const sensorsStatus = document.getElementById('sensors-status');
  const cameraStatus = document.getElementById('camera-status');
  const deviceModel = document.getElementById('device-model');
  const btnActivateSensors = document.getElementById('btn-activate-sensors');
  const btnTestCamera = document.getElementById('btn-test-camera');
  const cameraWrapper = document.getElementById('camera-wrapper');
  const cameraFeed = document.getElementById('camera-feed');

  // Detectar tipo de dispositivo
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  deviceModel.textContent = isMobile ? 'Móvil detectado' : 'Escritorio / Emulador';

  // Manejador de sensores de orientación (giroscopio/inclinómetro)
  async function requestSensors() {
    sensorsStatus.textContent = 'Solicitando...';
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission === 'granted') {
          bindOrientation();
        } else {
          sensorsStatus.textContent = 'Permiso denegado';
          sensorsStatus.style.color = 'var(--accent-danger)';
        }
      } else if ('DeviceOrientationEvent' in window) {
        bindOrientation();
      } else {
        sensorsStatus.textContent = 'No soportado';
        sensorsStatus.style.color = 'var(--accent-danger)';
      }
    } catch (err) {
      console.error('Error al solicitar sensores:', err);
      sensorsStatus.textContent = 'Error: ' + err.message;
      sensorsStatus.style.color = 'var(--accent-danger)';
    }
  }

  function bindOrientation() {
    window.addEventListener('deviceorientation', (event) => {
      const pitch = event.beta; // Inclinación adelante/atrás en grados [-180, 180]
      if (pitch !== null) {
        angleReadout.textContent = pitch.toFixed(1);
        sensorsStatus.textContent = 'Activo';
        sensorsStatus.style.color = 'var(--accent-green)';
      }
    });
  }

  btnActivateSensors.addEventListener('click', requestSensors);

  // Manejador de prueba de cámara
  btnTestCamera.addEventListener('click', async () => {
    cameraStatus.textContent = 'Iniciando...';
    try {
      const constraints = {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      cameraFeed.srcObject = stream;
      cameraWrapper.style.display = 'block';
      cameraStatus.textContent = 'Activa (Trasera)';
      cameraStatus.style.color = 'var(--accent-green)';
    } catch (err) {
      console.error('Error de cámara:', err);
      cameraStatus.textContent = 'Error: ' + err.name;
      cameraStatus.style.color = 'var(--accent-danger)';
      alert('No se pudo acceder a la cámara: ' + err.message);
    }
  });
});
