// A single viewport pane: its camera, framing, and world/screen conversions.
import * as THREE from 'three';
import type { V3 } from '../core/types';
import type { Shading } from './scene';

export type ViewKind = 'persp' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

export const VIEW_LABELS: Record<ViewKind, string> = {
  persp: 'Perspective', top: 'Top', bottom: 'Bottom', front: 'Front', back: 'Back', left: 'Left', right: 'Right',
};

/** Turning speed while orbiting: Blender's turntable default, 0.4 degrees per pixel. */
export const ORBIT_PER_PIXEL = (0.4 * Math.PI) / 180;

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

const ORTHO: Record<Exclude<ViewKind, 'persp'>, { dir: V3; up: V3 }> = {
  top: { dir: [0, 1, 0], up: [0, 0, -1] },
  bottom: { dir: [0, -1, 0], up: [0, 0, 1] },
  front: { dir: [0, 0, 1], up: [0, 1, 0] },
  back: { dir: [0, 0, -1], up: [0, 1, 0] },
  right: { dir: [1, 0, 0], up: [0, 1, 0] },
  left: { dir: [-1, 0, 0], up: [0, 1, 0] },
};

/** An orthographic view's directions in world space: its screen right and up, and toward the viewer. */
export function viewBasis(kind: Exclude<ViewKind, 'persp'>): { right: THREE.Vector3; up: THREE.Vector3; dir: THREE.Vector3 } {
  const up = new THREE.Vector3(...ORTHO[kind].up), dir = new THREE.Vector3(...ORTHO[kind].dir);
  return { right: new THREE.Vector3().crossVectors(up, dir), up, dir };
}

export class Pane {
  x = 0; y = 0; w = 100; h = 100;
  kind: ViewKind;
  shading: Shading;
  target = new THREE.Vector3(0, 0.5, 0);
  yaw = 0.7; pitch = 0.45; bankAngle = 0; dist = 6;
  orthoHeight = 6;
  persp = new THREE.PerspectiveCamera(45, 1, 0.01, 2000);
  ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 2000);
  private vp = new THREE.Matrix4();
  header?: HTMLElement;
  nav?: HTMLElement;

  constructor(kind: ViewKind, shading: Shading) {
    this.kind = kind;
    this.shading = shading;
    this.update();
  }

  get camera(): THREE.Camera { return this.kind === 'persp' ? this.persp : this.ortho; }
  get isOrtho() { return this.kind !== 'persp'; }

  /** The orthographic view this pane last showed, for switching back from perspective. */
  lastOrtho: Exclude<ViewKind, 'persp'> = 'front';

  setKind(k: ViewKind) {
    if (k !== 'persp') this.lastOrtho = k;
    this.kind = k;
    this.update();
  }

  /**
   * Switch to perspective looking the way this pane's orthographic view does, so the change doesn't jump: as Blender
   * does when you orbit out of a front or side view.
   */
  perspFromOrtho() {
    if (this.kind === 'persp') return;
    const d = ORTHO[this.kind].dir;
    this.pitch = Math.asin(Math.max(-1, Math.min(1, d[1])));
    // Straight above or below, the heading comes from the view's up instead.
    const up = ORTHO[this.kind].up;
    this.yaw = Math.abs(d[1]) > 0.99 ? Math.atan2(-up[0] * d[1], -up[2] * d[1]) : Math.atan2(d[0], d[2]);
    this.dist = Math.max(0.05, this.orthoHeight * 1.2);
    this.setKind('persp');
  }

  /** Whether the perspective view is past a pole, so the world's up points down the screen. */
  get upsideDown() { return this.kind === 'persp' && Math.cos(this.pitch) < 0; }

  update() {
    const aspect = Math.max(1, this.w) / Math.max(1, this.h);
    if (this.kind === 'persp') {
      const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      this.persp.position.set(
        this.target.x + this.dist * cp * Math.sin(this.yaw),
        this.target.y + this.dist * sp,
        this.target.z + this.dist * cp * Math.cos(this.yaw),
      );
      // Up comes from the pitch itself, so the view rolls smoothly over the poles as Blender's turntable does,
      // rather than world up, which can't say which way is up when looking straight down.
      this.persp.up.set(-sp * Math.sin(this.yaw), cp, -sp * Math.cos(this.yaw));
      this.persp.aspect = aspect;
      this.persp.near = Math.max(0.001, this.dist / 1000);
      this.persp.far = Math.max(100, this.dist * 200);
      this.persp.lookAt(this.target);
      this.persp.rotateZ(this.bankAngle);
      this.persp.updateProjectionMatrix();
      this.persp.updateMatrixWorld();
    } else {
      const o = ORTHO[this.kind];
      const hh = this.orthoHeight / 2;
      this.ortho.left = -hh * aspect; this.ortho.right = hh * aspect; this.ortho.top = hh; this.ortho.bottom = -hh;
      this.ortho.position.set(this.target.x + o.dir[0] * 500, this.target.y + o.dir[1] * 500, this.target.z + o.dir[2] * 500);
      this.ortho.up.set(...o.up);
      this.ortho.lookAt(this.target);
      this.ortho.updateProjectionMatrix();
      this.ortho.updateMatrixWorld();
    }
    const cam = this.camera as THREE.PerspectiveCamera;
    this.vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  }

  contains(px: number, py: number) {
    return px >= this.x && py >= this.y && px < this.x + this.w && py < this.y + this.h;
  }

  /** Project to stage pixels. z in NDC: outside -1..1 means clipped. */
  project(x: number, y: number, z: number): { x: number; y: number; z: number; w: number } {
    const e = this.vp.elements;
    const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
    const nx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / cw;
    const ny = (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw;
    const nz = (e[2] * x + e[6] * y + e[10] * z + e[14]) / cw;
    return { x: this.x + ((nx + 1) / 2) * this.w, y: this.y + ((1 - ny) / 2) * this.h, z: nz, w: cw };
  }

  ray(px: number, py: number): THREE.Ray {
    const nx = ((px - this.x) / this.w) * 2 - 1;
    const ny = 1 - ((py - this.y) / this.h) * 2;
    const cam = this.camera;
    const a = new THREE.Vector3(nx, ny, -1).unproject(cam);
    const b = new THREE.Vector3(nx, ny, 1).unproject(cam);
    return new THREE.Ray(a, b.sub(a).normalize());
  }

  /** World units per pixel at a point; used to size free drags. */
  unitsPerPixel(at: THREE.Vector3): number {
    if (this.isOrtho) return this.orthoHeight / this.h;
    const d = at.distanceTo(this.persp.position);
    return (2 * d * Math.tan((this.persp.fov * Math.PI) / 360)) / this.h;
  }

  /** Camera-facing direction, from the scene towards the viewer. */
  viewDir(at?: THREE.Vector3): THREE.Vector3 {
    if (this.kind === 'persp') return this.persp.position.clone().sub(at ?? this.target).normalize();
    const d = ORTHO[this.kind].dir;
    return new THREE.Vector3(d[0], d[1], d[2]);
  }

  /** Screen-plane axes in world space. */
  screenAxes(): { right: THREE.Vector3; up: THREE.Vector3 } {
    const m = this.camera.matrixWorld.elements;
    return { right: new THREE.Vector3(m[0], m[1], m[2]).normalize(), up: new THREE.Vector3(m[4], m[5], m[6]).normalize() };
  }

  /** Point under the cursor on the drawing plane through `through`. */
  planePoint(px: number, py: number, through: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    const r = this.ray(px, py);
    const normal = this.isOrtho ? this.viewDir() : new THREE.Vector3(0, 1, 0);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, through);
    const hit = r.intersectPlane(plane, new THREE.Vector3());
    if (hit) return hit;
    const alt = new THREE.Plane().setFromNormalAndCoplanarPoint(this.viewDir(), through);
    return r.intersectPlane(alt, new THREE.Vector3()) ?? through.clone();
  }

  gridPlane(): 'xz' | 'xy' | 'zy' {
    if (this.kind === 'front' || this.kind === 'back') return 'xy';
    if (this.kind === 'left' || this.kind === 'right') return 'zy';
    return 'xz';
  }

  gridScale(): number {
    const size = this.isOrtho ? this.orthoHeight : this.dist;
    const raw = size / 8;
    return Math.pow(10, Math.round(Math.log10(Math.max(1e-4, raw))));
  }

  /**
   * Turn the view by a mouse movement, Blender's turntable way: sideways turns about the world's up axis, up and down
   * tilts about the view's own horizontal, with no stop at the poles. `reverse` swaps sideways for a drag that began
   * upside down, so the scene still follows the mouse. With a `pivot`, the camera swings around that point instead of
   * the view's centre, so the point stays put on screen.
   */
  orbit(dx: number, dy: number, pivot?: THREE.Vector3, reverse = false) {
    this.turn(-dx * ORBIT_PER_PIXEL * (reverse ? -1 : 1), dy * ORBIT_PER_PIXEL, pivot);
  }

  /** Turn the view by angles, in radians: about the world's up axis, and tilting about the view's horizontal. */
  turn(dYaw: number, dPitch: number, pivot?: THREE.Vector3) {
    const yaw0 = this.yaw;
    this.yaw = wrapAngle(this.yaw + dYaw);
    this.pitch = wrapAngle(this.pitch + dPitch);
    if (pivot && this.kind === 'persp') {
      // Tilt about the view's horizontal axis, then turn about world up: the same turn the view itself makes.
      const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(-Math.cos(yaw0), 0, Math.sin(yaw0)), dPitch);
      const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dYaw);
      this.target.sub(pivot).applyQuaternion(spin.multiply(tilt)).add(pivot);
    }
    this.update();
  }
  pan(dx: number, dy: number) {
    const { right, up } = this.screenAxes();
    const u = this.unitsPerPixel(this.target);
    this.target.addScaledVector(right, -dx * u).addScaledVector(up, dy * u);
    this.update();
  }
  /** Roll the perspective camera around its view axis. */
  bank(dx: number) {
    this.bankAngle += dx * 0.008;
    this.update();
  }
  /** Perspective pan along the ground: sideways, and nearer or farther on the camera's heading. */
  panGround(dx: number, dy: number) {
    const u = this.unitsPerPixel(this.target);
    const sn = Math.sin(this.yaw), cs = Math.cos(this.yaw);
    this.target.x += -dx * u * cs + dy * u * sn;
    this.target.z += dx * u * sn + dy * u * cs;
    this.update();
  }
  /** Perspective pan straight up or down. */
  panVertical(dy: number) {
    this.target.y += dy * this.unitsPerPixel(this.target);
    this.update();
  }
  /** Move the view along its own screen axes by a world distance. */
  panBy(right: number, up: number) {
    const a = this.screenAxes();
    this.target.addScaledVector(a.right, right).addScaledVector(a.up, up);
    this.update();
  }
  centerOn(point: THREE.Vector3) {
    this.target.copy(point);
    this.update();
  }
  /** Point under the cursor on the plane facing the view through its centre. */
  viewPlanePoint(px: number, py: number): THREE.Vector3 {
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.viewDir(), this.target);
    return this.ray(px, py).intersectPlane(plane, new THREE.Vector3()) ?? this.target.clone();
  }
  zoom(factor: number, px?: number, py?: number) {
    if (this.isOrtho) {
      if (px !== undefined && py !== undefined) {
        const before = this.planePoint(px, py, this.target);
        this.orthoHeight = Math.max(0.01, Math.min(10000, this.orthoHeight * factor));
        this.update();
        const after = this.planePoint(px, py, this.target);
        this.target.add(before.sub(after));
      } else this.orthoHeight = Math.max(0.01, Math.min(10000, this.orthoHeight * factor));
    } else this.dist = Math.max(0.02, Math.min(10000, this.dist * factor));
    this.update();
  }
  frame(center: V3, radius: number) {
    this.target.set(center[0], center[1], center[2]);
    const r = Math.max(radius, 0.05);
    // The field of view is vertical, so a pane narrower than it is tall needs more room to fit the width.
    const fit = Math.max(1, this.h / Math.max(1, this.w));
    this.dist = (r / Math.tan((this.persp.fov * Math.PI) / 360)) * 1.25 * fit;
    this.orthoHeight = r * 2.5 * fit;
    this.update();
  }
}
