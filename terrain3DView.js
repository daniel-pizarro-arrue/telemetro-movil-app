/**
 * terrain3DView.js - Motor de Visión Sintética 3D y Calibración AR
 * Renderiza el relieve topográfico en 3D (DEM Copernicus / Terrarium) alineado con los sensores
 * y permite calibración manual semitransparente ("Modo Fantasma") y telemetría por toque directo.
 */

(function(root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(['three'], factory);
  } else if (typeof module === 'object' && module.exports) {
    const THREE = require('./three.min.js');
    module.exports = factory(THREE);
  } else {
    root.Terrain3DView = factory(root.THREE);
  }
}(typeof self !== 'undefined' ? self : this, function(THREE) {
  'use strict';

  // Constantes Geodésicas
  const METERS_PER_DEG_LAT = 111139.0;
  const TILE_ZOOM = 12; // Zoom 12: ~7.6 km x 7.6 km por tile, resolución óptima (~30m)
  const TERRAIN_SIZE_METERS = 18000; // 18 km x 18 km alrededor del observador
  const MESH_SEGMENTS = 120; // 120x120 = 14,400 vértices para 60 FPS fluidos en móvil

  // Estado del Motor 3D
  let scene = null;
  let camera = null;
  let renderer = null;
  let canvas = null;
  let terrainMesh = null;
  let wireframeMesh = null;
  let targetBeacon = null;
  let compassHeadingArrow = null;
  let raycaster = null;

  let isInitialized = false;
  let isFrozen = false;
  let currentOpacity = 0.70; // Por defecto semitransparente sobre la cámara
  let isWireframeActive = true;
  let baseFov = 55.0; // Campo de visión base aproximado de cámara de celular
  let currentFov = 55.0;

  // Calibración manual acumulada (arrastre táctil en modo congelado)
  let offsetYaw = 0.0;   // Grados de desvío horizontal (azimut)
  let offsetPitch = 0.0; // Grados de desvío vertical (elevación)

  // Lecturas sensoriales en tiempo real
  let sensorAzimuth = 0.0;
  let sensorPitch = 0.0;
  let sensorRoll = 0.0;

  // Datos del Observador
  let observer = {
    lat: null,
    lon: null,
    groundAlt: 0,
    eyeHeight: 1.6,
    hasPosition: false
  };

  // Modo visual de relieve: 'satellite' (fotorrealista estilo Google Earth / Esri) o 'topographic' (militar hipsométrico)
  let currentVisualMode = 'satellite';
  let satelliteTexture = null;
  const satelliteImageCache = new Map();

  // Cache de tiles de elevación decodificadas: clave "z/x/y" -> Float32Array (256x256)
  const tileElevationCache = new Map();
  let isMeshLoading = false;
  let lastLoadedCoords = null;
  let onTargetSelectedCb = null;

  // Seguimiento de interacción táctil (distinguir arrastre de toque)
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;
  let isDragging = false;

  // ==========================================================
  // FUNCIONES MATEMÁTICAS Y GEODÉSICAS AUXILIARES
  // ==========================================================

  function latLonToTileFraction(lat, lon, zoom) {
    const x = (lon + 180.0) / 360.0 * Math.pow(2, zoom);
    const latRad = lat * Math.PI / 180.0;
    const y = (1.0 - Math.log(Math.tan(latRad) + 1.0 / Math.cos(latRad)) / Math.PI) / 2.0 * Math.pow(2, zoom);
    return { x, y };
  }

  function tileToLatLon(x, y, zoom) {
    const lon = x / Math.pow(2, zoom) * 360.0 - 180.0;
    const n = Math.PI - 2.0 * Math.PI * y / Math.pow(2, zoom);
    const lat = 180.0 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lat, lon };
  }

  function decodeTerrarium(r, g, b) {
    // Fórmula Mapzen / AWS Terrarium:
    // elevation = (red * 256 + green + blue / 256) - 32768
    return (r * 256.0 + g + b / 256.0) - 32768.0;
  }

  function latLonToLocalMeters(lat, lon, obsLat, obsLon) {
    const cosLat = Math.cos(obsLat * Math.PI / 180.0);
    const x = (lon - obsLon) * METERS_PER_DEG_LAT * cosLat;
    const z = -(lat - obsLat) * METERS_PER_DEG_LAT; // En Three.js: -Z es Norte, +X es Este
    return { x, z };
  }

  function localMetersToLatLon(x, z, obsLat, obsLon) {
    const cosLat = Math.cos(obsLat * Math.PI / 180.0);
    const lat = obsLat - (z / METERS_PER_DEG_LAT);
    const lon = obsLon + (x / (METERS_PER_DEG_LAT * cosLat));
    return { lat, lon };
  }

  function calculateTargetMetrics(hitPoint, obsLat, obsLon, obsAlt, eyeHeight = 1.6) {
    // hitPoint está en coordenadas locales de Three.js relativas al observador
    const hx = hitPoint.x;
    const hy = hitPoint.y - eyeHeight; // Altura relativa al suelo del observador
    const hz = hitPoint.z;

    const slantRange = Math.round(Math.sqrt(hx * hx + hy * hy + hz * hz));
    const horizDist = Math.round(Math.sqrt(hx * hx + hz * hz));
    const deltaAlt = Math.round(hy);
    const targetAlt = Math.round(obsAlt + hy);

    const geoCoords = localMetersToLatLon(hx, hz, obsLat, obsLon);
    const hitAzimuth = (Math.atan2(hx, -hz) * 180.0 / Math.PI + 360.0) % 360.0;
    const hitPitch = Math.atan2(hy, Math.max(1, horizDist)) * 180.0 / Math.PI;

    return {
      slantRange,
      horizontalDistance: horizDist,
      deltaHeight: deltaAlt,
      targetAlt,
      targetCoords: {
        lat: Number(geoCoords.lat.toFixed(5)),
        lon: Number(geoCoords.lon.toFixed(5)),
        alt: targetAlt
      },
      azimuthDeg: Number(hitAzimuth.toFixed(1)),
      pitchDeg: Number(hitPitch.toFixed(1)),
      hitPointLocal: { x: hx, y: hy, z: hz }
    };
  }

  // ==========================================================
  // CARGA Y DECODIFICACIÓN DE TILES TERRARIUM (AWS S3)
  // ==========================================================

  async function loadTileElevation(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (tileElevationCache.has(key)) {
      return tileElevationCache.get(key);
    }

    // Si estamos en entorno Node (testing sin navegador)
    if (typeof Image === 'undefined') {
      const dummy = new Float32Array(256 * 256);
      dummy.fill(500.0);
      tileElevationCache.set(key, dummy);
      return dummy;
    }

    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

      const timeoutId = setTimeout(() => {
        // En caso de timeout en red móvil lenta, devolver plano base
        const fallback = new Float32Array(256 * 256);
        fallback.fill(observer.groundAlt || 500.0);
        tileElevationCache.set(key, fallback);
        resolve(fallback);
      }, 5000);

      img.onload = () => {
        clearTimeout(timeoutId);
        try {
          const offCanvas = document.createElement('canvas');
          offCanvas.width = 256;
          offCanvas.height = 256;
          const ctx = offCanvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);
          const imgData = ctx.getImageData(0, 0, 256, 256).data;

          const elevations = new Float32Array(256 * 256);
          for (let i = 0, p = 0; i < imgData.length; i += 4, p++) {
            elevations[p] = decodeTerrarium(imgData[i], imgData[i + 1], imgData[i + 2]);
          }

          tileElevationCache.set(key, elevations);
          resolve(elevations);
        } catch (err) {
          console.warn('Error decodificando tile Terrarium:', err);
          const fallback = new Float32Array(256 * 256);
          fallback.fill(observer.groundAlt || 500.0);
          resolve(fallback);
        }
      };

      img.onerror = () => {
        clearTimeout(timeoutId);
        const fallback = new Float32Array(256 * 256);
        fallback.fill(observer.groundAlt || 500.0);
        tileElevationCache.set(key, fallback);
        resolve(fallback);
      };

      img.src = url;
    });
  }

  // Muestrea la cota exacta para cualquier (lat, lon) usando las tiles en memoria
  function sampleElevationFromTiles(lat, lon, zoom = TILE_ZOOM) {
    const frac = latLonToTileFraction(lat, lon, zoom);
    const tileX = Math.floor(frac.x);
    const tileY = Math.floor(frac.y);
    const key = `${zoom}/${tileX}/${tileY}`;

    const tileData = tileElevationCache.get(key);
    if (!tileData) return null;

    const px = Math.min(255, Math.max(0, Math.floor((frac.x - tileX) * 256.0)));
    const py = Math.min(255, Math.max(0, Math.floor((frac.y - tileY) * 256.0)));
    const idx = py * 256 + px;
    return tileData[idx];
  }

  // ==========================================================
  // CARGA DE FOTOGRAFÍA SATELITAL FOTORREALISTA (ESRI WORLD IMAGERY)
  // ==========================================================

  async function loadTileSatelliteImage(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (satelliteImageCache.has(key)) {
      return satelliteImageCache.get(key);
    }

    if (typeof Image === 'undefined') {
      return null;
    }

    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      // URL de mosaico satelital global de alta definición (abierto y sin API Key)
      const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

      const timeoutId = setTimeout(() => {
        resolve(null);
      }, 6000);

      img.onload = () => {
        clearTimeout(timeoutId);
        satelliteImageCache.set(key, img);
        resolve(img);
      };

      img.onerror = () => {
        clearTimeout(timeoutId);
        resolve(null);
      };

      img.src = url;
    });
  }

  // ==========================================================
  // GENERACIÓN DE MALLA TOPOGRÁFICA 3D Y MATERIAL TÁCTICO
  // ==========================================================

  // Coloreado topográfico hipsométrico militar
  function getElevationColor(altMsl) {
    // Gradiente:
    // < 400m: Verde Oscuro Valle (#064e3b)
    // 400m - 700m: Verde Esmeralda Táctico (#10b981)
    // 700m - 1100m: Amarillo / Ámbar Falda (#f59e0b)
    // 1100m - 1600m: Naranja Cresta (#ea580c)
    // > 1600m: Blanco / Nieve Cumbre (#f8fafc)
    if (altMsl < 400) return new THREE.Color(0x064e3b);
    if (altMsl < 700) return new THREE.Color(0x10b981);
    if (altMsl < 1100) return new THREE.Color(0xf59e0b);
    if (altMsl < 1600) return new THREE.Color(0xea580c);
    return new THREE.Color(0xf8fafc);
  }

  async function generateTerrainMesh(obsLat, obsLon, obsAlt) {
    if (isMeshLoading) return;
    isMeshLoading = true;

    try {
      // 1. Determinar cuadrícula 3x3 de tiles requeridas
      const centerFrac = latLonToTileFraction(obsLat, obsLon, TILE_ZOOM);
      const centerTileX = Math.floor(centerFrac.x);
      const centerTileY = Math.floor(centerFrac.y);

      const minTileX = centerTileX - 1;
      const maxTileX = centerTileX + 2; // exclusivo
      const minTileY = centerTileY - 1;
      const maxTileY = centerTileY + 2; // exclusivo

      // Esquinas geodésicas extremas del bloque 3x3 para proyección UV exacta
      const nw = tileToLatLon(minTileX, minTileY, TILE_ZOOM);
      const se = tileToLatLon(maxTileX, maxTileY, TILE_ZOOM);

      const tilePromises = [];
      const satPromises = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const tx = centerTileX + dx;
          const ty = centerTileY + dy;
          tilePromises.push(loadTileElevation(TILE_ZOOM, tx, ty));
          satPromises.push(loadTileSatelliteImage(TILE_ZOOM, tx, ty));
        }
      }
      const [elevResults, satImages] = await Promise.all([
        Promise.all(tilePromises),
        Promise.all(satPromises)
      ]);

      // Si no tenemos cota del observador calibrada, muestrearla del centro
      const sampledCenterAlt = sampleElevationFromTiles(obsLat, obsLon);
      if (sampledCenterAlt !== null && (!obsAlt || obsAlt === 0)) {
        obsAlt = sampledCenterAlt;
        observer.groundAlt = sampledCenterAlt;
      }

      // 2. Componer la textura satelital 3x3 (768x768)
      if (typeof document !== 'undefined') {
        try {
          const satCanvas = document.createElement('canvas');
          satCanvas.width = 3 * 256;
          satCanvas.height = 3 * 256;
          const satCtx = satCanvas.getContext('2d');

          // Fondo neutro tierra/montaña
          satCtx.fillStyle = '#223028';
          satCtx.fillRect(0, 0, satCanvas.width, satCanvas.height);

          let satIdx = 0;
          for (let dy = 0; dy < 3; dy++) {
            for (let dx = 0; dx < 3; dx++) {
              const img = satImages[satIdx++];
              if (img) {
                satCtx.drawImage(img, dx * 256, dy * 256, 256, 256);
              }
            }
          }

          if (satelliteTexture) {
            satelliteTexture.dispose();
          }
          satelliteTexture = new THREE.CanvasTexture(satCanvas);
          satelliteTexture.minFilter = THREE.LinearFilter;
          satelliteTexture.magFilter = THREE.LinearFilter;
          satelliteTexture.wrapS = THREE.ClampToEdgeWrapping;
          satelliteTexture.wrapT = THREE.ClampToEdgeWrapping;
        } catch (texErr) {
          console.warn('Error componiendo textura satelital:', texErr);
        }
      }

      // 3. Crear Geometría de Plano (XZ)
      const geometry = new THREE.PlaneGeometry(
        TERRAIN_SIZE_METERS,
        TERRAIN_SIZE_METERS,
        MESH_SEGMENTS,
        MESH_SEGMENTS
      );
      // Girar para que quede en el plano horizontal XZ
      geometry.rotateX(-Math.PI / 2);

      const posAttr = geometry.attributes.position;
      const uvAttr = geometry.attributes.uv;
      const count = posAttr.count;
      const colors = new Float32Array(count * 3);

      for (let i = 0; i < count; i++) {
        const vx = posAttr.getX(i);
        const vz = posAttr.getZ(i);

        // Convertir posición local en metros a coordenadas geodésicas (lat, lon)
        const geo = localMetersToLatLon(vx, vz, obsLat, obsLon);
        let vertexAlt = sampleElevationFromTiles(geo.lat, geo.lon);

        if (vertexAlt === null) {
          // Si la tile aún no cargó o está fuera de rango, interpolación suave
          const dist = Math.sqrt(vx * vx + vz * vz);
          vertexAlt = obsAlt + Math.sin(vx / 1200.0) * 150.0 + Math.cos(vz / 1200.0) * 150.0;
        }

        // El observador está en el origen (Y=0 a nivel de sus pies)
        const relY = vertexAlt - obsAlt;
        posAttr.setY(i, relY);

        // Mapeo UV geodésico exacto a la fotografía satelital de 3x3 tiles
        const u = (geo.lon - nw.lon) / (se.lon - nw.lon);
        const v = (geo.lat - se.lat) / (nw.lat - se.lat);
        uvAttr.setXY(i, Math.max(0.0, Math.min(1.0, u)), Math.max(0.0, Math.min(1.0, v)));

        // Color hipsométrico de respaldo para modo topográfico
        const col = getElevationColor(vertexAlt);
        colors[i * 3] = col.r;
        colors[i * 3 + 1] = col.g;
        colors[i * 3 + 2] = col.b;
      }

      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.computeVertexNormals();

      // 4. Crear o reemplazar la malla del terreno
      if (terrainMesh) {
        scene.remove(terrainMesh);
        terrainMesh.geometry.dispose();
      }

      const useSat = currentVisualMode === 'satellite' && satelliteTexture !== null;
      const terrainMaterial = new THREE.MeshLambertMaterial({
        map: useSat ? satelliteTexture : null,
        vertexColors: !useSat,
        transparent: true,
        opacity: currentOpacity,
        wireframe: false,
        depthWrite: true,
        side: THREE.DoubleSide
      });

      terrainMesh = new THREE.Mesh(geometry, terrainMaterial);
      terrainMesh.name = 'TerrainSolidMesh';
      scene.add(terrainMesh);

      // 5. Crear o reemplazar la malla de contorno wireframe (para silueta)
      if (wireframeMesh) {
        scene.remove(wireframeMesh);
        wireframeMesh.geometry.dispose();
      }

      const wireframeMaterial = new THREE.MeshBasicMaterial({
        color: 0x00f2fe, // Cyan táctico para silueta de crestas
        wireframe: true,
        transparent: true,
        opacity: Math.min(1.0, currentOpacity * 0.40) // Más sutil para destacar la foto satelital
      });

      wireframeMesh = new THREE.Mesh(geometry, wireframeMaterial);
      wireframeMesh.name = 'TerrainWireframeMesh';
      wireframeMesh.visible = isWireframeActive;
      scene.add(wireframeMesh);

      lastLoadedCoords = { lat: obsLat, lon: obsLon };
      console.log('Malla 3D Fotorrealista generada:', count, 'vértices | Modo:', currentVisualMode);
    } catch (e) {
      console.error('Error generando malla de terreno 3D:', e);
    } finally {
      isMeshLoading = false;
    }
  }

  function setVisualMode(mode) {
    if (mode !== 'satellite' && mode !== 'topographic') return;
    currentVisualMode = mode;
    if (terrainMesh && terrainMesh.material) {
      const useSat = currentVisualMode === 'satellite' && satelliteTexture !== null;
      terrainMesh.material.map = useSat ? satelliteTexture : null;
      terrainMesh.material.vertexColors = !useSat;
      terrainMesh.material.needsUpdate = true;
    }
  }

  function getVisualMode() {
    return currentVisualMode;
  }

  function toggleVisualMode() {
    const newMode = currentVisualMode === 'satellite' ? 'topographic' : 'satellite';
    setVisualMode(newMode);
    return newMode;
  }

  // ==========================================================
  // BALIZA TÁCTICA 3D (TARGET BEACON / RETICLE)
  // ==========================================================

  function createTargetBeacon() {
    const group = new THREE.Group();

    // 1. Haz de luz vertical (Cilindro luminoso)
    const beamGeo = new THREE.CylinderGeometry(4, 18, 180, 16, 1, true);
    beamGeo.translate(0, 90, 0); // Base en el suelo
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xff3366, // Rojo láser intenso
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide
    });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    group.add(beam);

    // 2. Anillo de pulso táctico en la base
    const ringGeo = new THREE.RingGeometry(15, 30, 32);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffb703, // Ámbar diana
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 1.0;
    group.add(ring);

    // 3. Esfera central de impacto
    const pipGeo = new THREE.SphereGeometry(6, 16, 16);
    const pipMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const pip = new THREE.Mesh(pipGeo, pipMat);
    pip.position.y = 5.0;
    group.add(pip);

    group.visible = false;
    return group;
  }

  function setTargetBeaconPosition(pos) {
    if (!targetBeacon) return;
    targetBeacon.position.copy(pos);
    targetBeacon.visible = true;
  }

  // ==========================================================
  // INICIALIZACIÓN DE LA ESCENA THREE.JS
  // ==========================================================

  function init(targetCanvas, options = {}) {
    if (isInitialized) return;
    canvas = targetCanvas;

    // 1. Escena
    scene = new THREE.Scene();
    // Niebla táctica de distancia: funde montañas lejanas a 18 km suavemente
    scene.fog = new THREE.FogExp2(0x05070a, 0.00012);

    // 2. Cámara de Perspectiva
    const aspect = canvas.clientWidth > 0 ? (canvas.clientWidth / canvas.clientHeight) : (window.innerWidth / window.innerHeight);
    camera = new THREE.PerspectiveCamera(currentFov, aspect, 1.0, 35000.0);
    camera.rotation.order = 'YXZ'; // Clave: rotación yaw (azimut) -> pitch -> roll
    camera.position.set(0, observer.eyeHeight, 0); // A la altura de los ojos del observador
    scene.add(camera);

    // 3. Iluminación Topográfica Realista (Hillshading)
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambientLight);

    // Luz solar dirigida para marcar sombras y relieves en faldas de cerros
    const sunLight = new THREE.DirectionalLight(0xfff5e6, 0.85);
    sunLight.position.set(5000, 7000, 3000);
    scene.add(sunLight);

    // 4. Baliza táctica
    targetBeacon = createTargetBeacon();
    scene.add(targetBeacon);

    // 5. Renderizador WebGL con fondo transparente (para superponer a la cámara)
    renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance'
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    resize();

    // 6. Raycaster
    raycaster = new THREE.Raycaster();

    // 7. Eventos de Arrastre y Toque (Touch / Pointer)
    setupInteractionEvents();

    // 8. Bucle de Renderizado
    isInitialized = true;
    startAnimationLoop();

    // Si ya teníamos posición antes de inicializar canvas, generar malla
    if (observer.hasPosition) {
      generateTerrainMesh(observer.lat, observer.lon, observer.groundAlt);
    }
  }

  function resize() {
    if (!renderer || !canvas) return;
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  function startAnimationLoop() {
    function animate() {
      requestAnimationFrame(animate);
      if (!isInitialized || !renderer || !scene || !camera) return;

      // Animar suavemente el anillo de la baliza de impacto
      if (targetBeacon && targetBeacon.visible) {
        const ring = targetBeacon.children[1];
        if (ring) {
          ring.rotation.z += 0.03;
          const s = 1.0 + Math.sin(Date.now() * 0.006) * 0.15;
          ring.scale.set(s, s, s);
        }
      }

      renderer.render(scene, camera);
    }
    animate();
  }

  // ==========================================================
  // CONTROL DE ORIENTACIÓN, CALIBRACIÓN Y CONGELAMIENTO
  // ==========================================================

  function updateOrientation(azimuthDeg, pitchDeg, rollDeg) {
    sensorAzimuth = azimuthDeg;
    sensorPitch = pitchDeg;
    sensorRoll = rollDeg;

    if (isFrozen) {
      // Cuando el mapa está congelado, la orientación de la cámara no sigue al celular,
      // permitiendo al usuario mover el teléfono y calibrar la silueta contra la cámara real
      return;
    }

    applyCameraRotation();
  }

  function applyCameraRotation() {
    if (!camera) return;

    // Ángulos totales = sensores del teléfono + offset manual de calibración
    const totalAzimuth = (sensorAzimuth + offsetYaw + 360.0) % 360.0;
    const totalPitch = Math.max(-89.0, Math.min(89.0, sensorPitch + offsetPitch));
    const totalRoll = sensorRoll;

    // Mapeo exacto a Three.js Euler ('YXZ'):
    // Azimut: rotación horaria alrededor de +Y (Norte es -Z, Este es +X) => -azimuth
    camera.rotation.y = -totalAzimuth * Math.PI / 180.0;
    camera.rotation.x = totalPitch * Math.PI / 180.0;
    camera.rotation.z = -totalRoll * Math.PI / 180.0;
  }

  function setFrozen(frozen) {
    isFrozen = !!frozen;
    if (!isFrozen) {
      // Al descongelar, volver a sincronizar de inmediato con los sensores reales
      applyCameraRotation();
    }
    return isFrozen;
  }

  function toggleFrozen() {
    return setFrozen(!isFrozen);
  }

  function setOpacity(val) {
    currentOpacity = Math.max(0.05, Math.min(1.0, val));
    if (terrainMesh && terrainMesh.material) {
      terrainMesh.material.opacity = currentOpacity;
      terrainMesh.material.needsUpdate = true;
    }
    if (wireframeMesh && wireframeMesh.material) {
      wireframeMesh.material.opacity = Math.min(1.0, currentOpacity * 0.85);
      wireframeMesh.material.needsUpdate = true;
    }
  }

  function setWireframe(enabled) {
    isWireframeActive = !!enabled;
    if (wireframeMesh) {
      wireframeMesh.visible = isWireframeActive;
    }
  }

  function setFov(newFov) {
    currentFov = Math.max(20.0, Math.min(95.0, newFov));
    if (camera) {
      camera.fov = currentFov;
      camera.updateProjectionMatrix();
    }
  }

  function zoomBy(deltaRatio) {
    setFov(currentFov * deltaRatio);
  }

  function resetCalibration() {
    offsetYaw = 0.0;
    offsetPitch = 0.0;
    currentFov = baseFov;
    if (camera) {
      camera.fov = currentFov;
      camera.updateProjectionMatrix();
    }
    applyCameraRotation();
  }

  // ==========================================================
  // GESTIÓN DE EVENTOS TÁCTILES: ARRASTRE vs TOQUE DIRECTO
  // ==========================================================

  function setupInteractionEvents() {
    if (!canvas) return;

    let prevPointerX = 0;
    let prevPointerY = 0;
    let hasMovedSignificantly = false;

    const onPointerDown = (e) => {
      touchStartX = e.clientX;
      touchStartY = e.clientY;
      prevPointerX = e.clientX;
      prevPointerY = e.clientY;
      touchStartTime = Date.now();
      hasMovedSignificantly = false;
      isDragging = true;
    };

    const onPointerMove = (e) => {
      if (!isDragging) return;

      const dx = e.clientX - prevPointerX;
      const dy = e.clientY - prevPointerY;
      prevPointerX = e.clientX;
      prevPointerY = e.clientY;

      const totalDist = Math.hypot(e.clientX - touchStartX, e.clientY - touchStartY);
      if (totalDist > 8) {
        hasMovedSignificantly = true;
      }

      // Si está congelado O en modo calibración, permitir arrastrar el mapa 3D con el dedo
      if (isFrozen) {
        const degPerPixelX = (camera.fov * camera.aspect) / (canvas.clientWidth || window.innerWidth);
        const degPerPixelY = camera.fov / (canvas.clientHeight || window.innerHeight);

        // Arrastrar horizontalmente gira el azimut del mapa
        offsetYaw += dx * degPerPixelX;
        // Arrastrar verticalmente inclina la elevación
        offsetPitch += dy * degPerPixelY;

        applyCameraRotation();
      }
    };

    const onPointerUp = (e) => {
      if (!isDragging) return;
      isDragging = false;

      const elapsed = Date.now() - touchStartTime;

      // Si fue un toque rápido y no se arrastró significativamente => TOQUE DE TELEMETRÍA
      if (!hasMovedSignificantly && elapsed < 450) {
        handleTapToMeasure(e.clientX, e.clientY);
      }
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', () => { isDragging = false; });
  }

  // ==========================================================
  // TELEMETRÍA POR TOQUE DIRECTO (RAYCASTING EN EL RELIEVE)
  // ==========================================================

  function handleTapToMeasure(clientX, clientY) {
    if (!terrainMesh || !camera || !raycaster) return null;

    const rect = canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2.0 - 1.0,
      -((clientY - rect.top) / rect.height) * 2.0 + 1.0
    );

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(terrainMesh);

    if (intersects.length > 0) {
      const hit = intersects[0];
      setTargetBeaconPosition(hit.point);

      const metrics = calculateTargetMetrics(
        hit.point,
        observer.lat,
        observer.lon,
        observer.groundAlt,
        observer.eyeHeight
      );

      console.log('Impacto 3D por toque en terreno:', metrics);

      if (onTargetSelectedCb) {
        onTargetSelectedCb(metrics);
      }
      return metrics;
    } else {
      console.log('El rayo no impactó la superficie del relieve visible.');
      return null;
    }
  }

  // ==========================================================
  // ACTUALIZACIÓN DE POSICIÓN DEL OBSERVADOR (GPS / DEM)
  // ==========================================================

  function updateObserverPosition(lat, lon, groundAlt, eyeHeight = 1.6) {
    observer.lat = lat;
    observer.lon = lon;
    if (groundAlt !== null && groundAlt !== undefined) {
      observer.groundAlt = groundAlt;
    }
    observer.eyeHeight = eyeHeight;
    observer.hasPosition = true;

    if (camera) {
      camera.position.set(0, observer.eyeHeight, 0);
    }

    // Comprobar si se ha movido más de 400 metros para regenerar la malla de relieve
    let needsRegen = false;
    if (!lastLoadedCoords) {
      needsRegen = true;
    } else {
      const dLat = Math.abs(lat - lastLoadedCoords.lat) * METERS_PER_DEG_LAT;
      const dLon = Math.abs(lon - lastLoadedCoords.lon) * METERS_PER_DEG_LAT * Math.cos(lat * Math.PI / 180.0);
      const dist = Math.hypot(dLat, dLon);
      if (dist > 400.0) {
        needsRegen = true;
      }
    }

    if (needsRegen && scene) {
      generateTerrainMesh(lat, lon, observer.groundAlt);
    }
  }

  function onTargetSelected(cb) {
    onTargetSelectedCb = cb;
  }

  function getStatus() {
    return {
      isInitialized,
      isFrozen,
      opacity: currentOpacity,
      wireframe: isWireframeActive,
      fov: currentFov,
      offsetYaw: Number(offsetYaw.toFixed(2)),
      offsetPitch: Number(offsetPitch.toFixed(2)),
      observerLat: observer.lat,
      observerLon: observer.lon,
      observerAlt: observer.groundAlt
    };
  }

  // ==========================================================
  // API PÚBLICA
  // ==========================================================

  return {
    init,
    resize,
    updateObserverPosition,
    updateOrientation,
    setFrozen,
    toggleFrozen,
    isFrozen: () => isFrozen,
    setOpacity,
    getOpacity: () => currentOpacity,
    setWireframe,
    setFov,
    getFov: () => currentFov,
    zoomBy,
    resetCalibration,
    raycastTap: handleTapToMeasure,
    onTargetSelected,
    setVisualMode,
    getVisualMode,
    toggleVisualMode,
    getStatus,
    // Métodos utilitarios expuestos para tests
    latLonToTileFraction,
    tileToLatLon,
    decodeTerrarium,
    latLonToLocalMeters,
    localMetersToLatLon,
    calculateTargetMetrics
  };
}));
