// A paper plane that leads the camera between chapters: it glides a little ahead of the camera, along the direction
// the camera is travelling, and folds away when the camera settles.
import * as THREE from 'three';

export class PaperPlane {
  readonly mesh: THREE.Mesh;
  private readonly last = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private shown = 0;

  constructor() {
    // a classic dart: two wings meeting at the nose, and a keel folded down under them
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const nose = v(0, 0, 1.3);
    const left = v(-0.75, 0.05, -0.65);
    const right = v(0.75, 0.05, -0.65);
    const back = v(0, 0, -0.65);
    const keel = v(0, -0.28, -0.65);
    const tris = [nose, left, back, nose, back, right, nose, back, keel];
    const g = new THREE.BufferGeometry().setFromPoints(tris);
    g.computeVertexNormals();
    this.mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xf6f1e8, side: THREE.DoubleSide, flatShading: true }));
    this.mesh.castShadow = true;
    this.mesh.scale.setScalar(0.001);
  }

  /** Call once a frame in story mode with the camera's position and where it looks. */
  update(camera: THREE.Camera, look: THREE.Vector3, dt: number, time: number, active: boolean): void {
    this.velocity.subVectors(camera.position, this.last).divideScalar(Math.max(dt, 1e-3));
    this.last.copy(camera.position);
    const speed = this.velocity.length();
    const want = active && speed > 2.5 ? 1 : 0;
    this.shown += (want - this.shown) * (1 - Math.exp(-dt * (want ? 3 : 1.5)));
    const forward = new THREE.Vector3().subVectors(look, camera.position).normalize();
    const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
    const pos = camera.position.clone().addScaledVector(forward, 14).addScaledVector(right, 2.6).addScaledVector(camera.up, -1.2 + 0.3 * Math.sin(time * 2));
    this.mesh.position.lerp(pos, 1 - Math.exp(-dt * 6));
    const heading = speed > 0.1 ? this.velocity.clone().normalize().lerp(forward, 0.5).normalize() : forward;
    this.mesh.lookAt(this.mesh.position.clone().add(heading));
    this.mesh.rotateZ(0.25 * Math.sin(time * 1.3));
    this.mesh.scale.setScalar(Math.max(0.001, this.shown * 0.55));
    this.mesh.visible = this.shown > 0.01;
  }
}
