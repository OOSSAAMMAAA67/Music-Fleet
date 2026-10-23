'use strict';

// The reference motion does not map the raw pointer linearly to the final angle.
// At the physical edge of the artwork the response starts gently, grows through
// the inner band, then relaxes again as the pointer approaches the centre. This
// avoids the old 'full tilt on entry' snap while keeping the measured ~8° peak.
function fitPointerToReferenceBoundary(rawX, rawY) {
  const x = Math.max(-1, Math.min(1, Number(rawX) || 0));
  const y = Math.max(-1, Math.min(1, Number(rawY) || 0));
  const radius = Math.max(Math.abs(x), Math.abs(y));
  if (radius < 1e-5) return { x: 0, y: 0, strength: 0 };

  // A square-distance band matches the rectangular artwork boundary. The
  // smoothstep entrance prevents the old edge snap; the centre fade creates the
  // reference's rise-then-return response while the pointer remains on the art.
  const smoothstep = (a, b, value) => {
    const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const penetration = 1 - radius;
  const edgeRamp = smoothstep(0, .42, penetration);
  const centreFade = smoothstep(0, .48, radius);
  const edgeShoulder = .075 * (radius ** 1.6);
  const strength = Math.min(1, edgeShoulder + .93 * edgeRamp * centreFade);
  const gain = strength / radius;
  return { x: x * gain, y: y * gain, strength };
}

// The 60 Hz reference trace gives an approximately eight-degree peak tilt, a
// camera distance of 1.4 cover widths, and an underdamped response (k≈96,c≈14).
// A fixed scene light is transformed into the moving surface's coordinates.
function createCoverPhysics() {
  const radians = Math.PI / 180;
  const light = [-.22, -.56, Math.sqrt(1 - .22 ** 2 - .56 ** 2)];
  const halfLength = Math.hypot(light[0], light[1], light[2] + 1);
  const half = [light[0] / halfLength, light[1] / halfLength, (light[2] + 1) / halfLength];
  const model = {
    x: 0, y: 0, vx: 0, vy: 0,
    perspectiveRatio: 1.4,
    targetX: 0, targetY: 0, last: null,
    setPointer(x, y) {
      const fitted = fitPointerToReferenceBoundary(x, y);
      this.targetX = fitted.x;
      this.targetY = fitted.y;
    },
    release() { this.targetX = 0; this.targetY = 0; },
    reset() {
      this.x = this.y = this.vx = this.vy = 0;
      this.release(); this.last = null;
    },
    tick(now) {
      const dt = this.last === null ? 0 : Math.max(0, Math.min(0.04, (now - this.last) / 1000));
      this.last = now;
      const steps = Math.max(1, Math.ceil(dt / 0.002));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        // The small overshoot is part of the reference's soft return motion.
        this.vx += ((this.targetX - this.x) * 96 - this.vx * 14) * h;
        this.vy += ((this.targetY - this.y) * 96 - this.vy * 14) * h;
        this.x += this.vx * h;
        this.y += this.vy * h;
      }
      const rx = Math.max(-8.6, Math.min(8.6, -this.y * 8));
      const ry = Math.max(-8.6, Math.min(8.6, this.x * 8));

      // Let the reflection lead the mechanical spring by ~42 ms. It remains
      // surface-derived, but visually reacts a little faster like the reference.
      const lightModelX = Math.max(-1.08, Math.min(1.08, this.x + this.vx * .042));
      const lightModelY = Math.max(-1.08, Math.min(1.08, this.y + this.vy * .042));
      const lightRx = Math.max(-8.8, Math.min(8.8, -lightModelY * 8));
      const lightRy = Math.max(-8.8, Math.min(8.8, lightModelX * 8));
      const sx = Math.sin(lightRx * radians), cx = Math.cos(lightRx * radians);
      const sy = Math.sin(lightRy * radians), cy = Math.cos(lightRy * radians);
      const nx = sy, ny = -sx * cy, nz = cx * cy;
      const halfX = cy * half[0] + sx * sy * half[1] - cx * sy * half[2];
      const halfY = cx * half[1] + sx * half[2];
      const diffuse = Math.max(0, nx * light[0] + ny * light[1] + nz * light[2]);
      const specular = Math.max(0, nx * half[0] + ny * half[1] + nz * half[2]) ** 24;
      const fresnel = .035 + .965 * (1 - Math.max(0, nz)) ** 5;
      return {
        rx, ry,
        lightX: Math.max(8, Math.min(92, 50 + halfX * 70 - nx * 88)),
        lightY: Math.max(8, Math.min(92, 50 + halfY * 82 - ny * 76)),
        glow: Math.max(.35, Math.min(.56, .37 + specular * .13 + fresnel * .16 + (diffuse - .8) * .07)),
      };
    },
  };
  return model;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createCoverPhysics, fitPointerToReferenceBoundary };
if (typeof window !== 'undefined') window.createCoverPhysics = createCoverPhysics;
