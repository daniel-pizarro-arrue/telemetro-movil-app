function multiplyMatrices(A, B) {
  const C = [[0,0,0],[0,0,0],[0,0,0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) {
        C[i][j] += A[i][k] * B[k][j];
      }
    }
  }
  return C;
}

// According to W3C specification:
// The Earth coordinate frame is East (X), North (Y), Up (Z).
// The rotation is: R = Rz(alpha) * Rx(beta) * Ry(gamma)
// where alpha, beta, gamma are in degrees.
function getCameraDirection(alphaDeg, betaDeg, gammaDeg) {
  const degToRad = Math.PI / 180;
  const a = alphaDeg * degToRad;
  const b = betaDeg * degToRad;
  const g = gammaDeg * degToRad;

  // In W3C spec:
  // Alpha is rotation around Z (counter-clockwise looking down from +Z)
  // Beta is rotation around X (tilt forward/back)
  // Gamma is rotation around Y (tilt left/right)
  const Rz = [
    [Math.cos(a), -Math.sin(a), 0],
    [Math.sin(a),  Math.cos(a), 0],
    [0, 0, 1]
  ];
  const Rx = [
    [1, 0, 0],
    [0, Math.cos(b), -Math.sin(b)],
    [0, Math.sin(b),  Math.cos(b)]
  ];
  const Ry = [
    [ Math.cos(g), 0, Math.sin(g)],
    [0, 1, 0],
    [-Math.sin(g), 0, Math.cos(g)]
  ];

  const R = multiplyMatrices(multiplyMatrices(Rz, Rx), Ry);

  // The rear camera of a smartphone points along the -Z axis of the phone: [0, 0, -1]
  // In Earth frame (X = East, Y = North, Z = Up):
  const vEast = -R[0][2];
  const vNorth = -R[1][2];
  const vUp = -R[2][2];

  // Azimuth from North (0° = North, 90° = East, 180° = South, 270° = West)
  let azimuth = Math.atan2(vEast, vNorth) * (180 / Math.PI);
  if (azimuth < 0) azimuth += 360;

  // Pitch (Elevation angle above horizontal, -90° to +90°)
  const horizDist = Math.sqrt(vEast * vEast + vNorth * vNorth);
  const pitch = Math.atan2(vUp, horizDist) * (180 / Math.PI);

  return { azimuth, pitch, vEast, vNorth, vUp };
}

console.log('1. Vertical apuntando al Norte (beta=90, gamma=0, alpha=0):', getCameraDirection(0, 90, 0));
console.log('2. Vertical apuntando al Este (beta=90, gamma=0, alpha=270):', getCameraDirection(270, 90, 0));
console.log('3. Vertical apuntando al Sur (beta=90, gamma=0, alpha=180):', getCameraDirection(180, 90, 0));
console.log('4. Vertical apuntando al Oeste (beta=90, gamma=0, alpha=90):', getCameraDirection(90, 90, 0));
console.log('5. Inclinado 10° hacia arriba al Norte (beta=80, gamma=0, alpha=0):', getCameraDirection(0, 80, 0));
console.log('6. Inclinado 10° hacia abajo al Norte (beta=100, gamma=0, alpha=0):', getCameraDirection(0, 100, 0));
console.log('7. Apuntando a cerro +5° (beta=85, gamma=0, alpha=0):', getCameraDirection(0, 85, 0));
console.log('8. Apuntando a cerro +15° (beta=75, gamma=0, alpha=0):', getCameraDirection(0, 75, 0));
