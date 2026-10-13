import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { FrontFrame, MeshResult } from '../core/types';

export type Shading = 'lit' | 'unlit' | 'clay';

/**
 * A photo texture already contains the studio lighting it was shot in, so on
 * it the lights only add shape cues: about as much light as they take away,
 * for an average shading near 1 (brighter washes out deep colours, a red
 * bottle turning salmon). The environment is much brighter toward the front,
 * so it is turned down and a fill light from behind evens it out. Bare clay
 * has no light of its own and gets a stronger key.
 */
const LIT_RIG = { env: 0.3, key: 0.7, fill: 1.2, hemi: 2.5 };
const CLAY_RIG = { env: 0.55, key: 1.6, fill: 1, hemi: 1 };

/**
 * three.js viewer. Besides orbiting, it can line up an orthographic camera
 * with the original photo and wipe between photo and render, to check the
 * model reproduces the picture.
 */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private persp: THREE.PerspectiveCamera;
  private ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  private controls: OrbitControls;
  private mesh: THREE.Mesh | null = null;
  private wire: THREE.LineSegments | null = null;
  private texture: THREE.Texture | null = null;
  private materials: Record<Shading, THREE.Material> | null = null;
  private shading: Shading = 'lit';
  private frame: FrontFrame | null = null;
  private comparing = false;
  private overlay: HTMLDivElement;
  private overlayImg: HTMLImageElement;
  private grid: THREE.GridHelper;
  private resizeObserver: ResizeObserver;
  private needsRender = true;
  private center = new THREE.Vector3(0, 0.5, 0);
  /** Explicit orbit centre set by a caller; null means the model's bounding-box centre. */
  private orbitTarget: THREE.Vector3 | null = null;
  private gridWanted = true;
  private key = new THREE.DirectionalLight(0xffffff, 1);
  private fill = new THREE.DirectionalLight(0xffffff, 1);
  private hemi = new THREE.HemisphereLight(0xffffff, 0x404040, 1);
  /** How far other UI reaches into the view from the top and bottom (px); compare mode keeps the photo clear of it. */
  compareInsets: () => { top: number; bottom: number } = () => ({ top: 0, bottom: 0 });

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add('viewer-canvas');

    this.persp = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    this.persp.position.set(1.2, 0.9, 2.4);
    this.controls = new OrbitControls(this.persp, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.copy(this.center);
    this.controls.addEventListener('change', () => (this.needsRender = true));

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.key.position.set(2, 3, 2.5);
    this.fill.position.set(-2, 2, -2.5);
    this.scene.add(this.key, this.fill, this.hemi);
    this.applyRig();

    this.grid = new THREE.GridHelper(4, 40, 0x5a6478, 0x343b48);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(this.grid);

    this.overlay = document.createElement('div');
    this.overlay.className = 'compare-overlay';
    this.overlayImg = document.createElement('img');
    this.overlayImg.alt = 'Original photo';
    this.overlay.appendChild(this.overlayImg);
    container.appendChild(this.overlay);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    if (this.comparing) this.layoutCompare();
    this.needsRender = true;
  }

  private tick() {
    if (!this.comparing && this.controls.update()) this.needsRender = true;
    if (this.controls.autoRotate && !this.comparing) this.needsRender = true;
    if (!this.needsRender) return;
    this.needsRender = false;
    this.renderer.render(this.scene, this.comparing ? this.ortho : this.persp);
  }

  setModel(result: MeshResult, atlas: HTMLCanvasElement) {
    this.clearModel();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(result.normals, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(result.uvs, 2));
    g.setIndex(new THREE.BufferAttribute(result.indices, 1));
    g.computeBoundingBox();

    const tex = new THREE.CanvasTexture(atlas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.texture = tex;
    this.materials = {
      // No specular: the photo's own highlights are in the texture already.
      lit: new THREE.MeshPhysicalMaterial({ map: tex, roughness: 1, metalness: 0, specularIntensity: 0 }),
      unlit: new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
      clay: new THREE.MeshStandardMaterial({ color: 0xc9c4bc, roughness: 0.7, metalness: 0 }),
    };
    this.mesh = new THREE.Mesh(g, this.materials[this.shading]);
    this.scene.add(this.mesh);
    this.frame = result.frame;

    const box = g.boundingBox!;
    box.getCenter(this.center);
    const photoCanvas = document.createElement('canvas');
    photoCanvas.width = result.frontPhoto.width;
    photoCanvas.height = result.frontPhoto.height;
    photoCanvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(result.frontPhoto.data), result.frontPhoto.width, result.frontPhoto.height), 0, 0);
    this.overlayImg.src = photoCanvas.toDataURL('image/png');
    this.resetView();
  }

  private clearModel() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    if (this.wire) {
      this.scene.remove(this.wire);
      this.wire.geometry.dispose();
      this.wire = null;
    }
    if (this.materials) for (const m of Object.values(this.materials)) m.dispose();
    this.texture?.dispose();
    this.mesh = null;
    this.materials = null;
    this.texture = null;
  }

  get hasModel() {
    return !!this.mesh;
  }

  setShading(s: Shading) {
    this.shading = s;
    if (this.mesh && this.materials) this.mesh.material = this.materials[s];
    this.applyRig();
    this.needsRender = true;
  }

  private applyRig() {
    const rig = this.shading === 'clay' ? CLAY_RIG : LIT_RIG;
    // Materials lit by scene.environment take its intensity, not their own envMapIntensity.
    this.scene.environmentIntensity = rig.env;
    this.key.intensity = rig.key;
    this.fill.intensity = rig.fill;
    this.hemi.intensity = rig.hemi;
  }

  setWireframe(on: boolean) {
    if (!this.mesh) return;
    if (on && !this.wire) {
      const wg = new THREE.WireframeGeometry(this.mesh.geometry);
      this.wire = new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.25 }));
      this.scene.add(this.wire);
    } else if (!on && this.wire) {
      this.scene.remove(this.wire);
      this.wire.geometry.dispose();
      this.wire = null;
    }
    this.needsRender = true;
  }

  setAutoRotate(on: boolean) {
    this.controls.autoRotate = on;
    this.controls.autoRotateSpeed = 1.5;
    this.needsRender = true;
  }

  /** Camera distance that fits the whole model in the perspective view. */
  private fitDistance(): number {
    const size = new THREE.Vector3();
    this.mesh?.geometry.boundingBox?.getSize(size);
    const radius = Math.max(size.x, size.y, size.z, 0.5) * 0.75;
    return (radius / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2))) * 1.1;
  }

  resetView() {
    this.orbitTarget = null;
    const dir = new THREE.Vector3(0.45, 0.2, 1).normalize();
    this.persp.position.copy(this.center).addScaledVector(dir, this.fitDistance());
    this.controls.target.copy(this.center);
    this.controls.update();
    this.grid.position.y = 0;
    this.needsRender = true;
  }

  /**
   * Place the perspective camera on a sphere around the orbit target. Azimuth 0 is
   * the photo's viewpoint (in front of the model, looking along -z); positive
   * azimuth moves the camera toward +x. Elevation is degrees above the horizontal.
   * Without a distance, the camera is placed where the whole model fits.
   */
  setOrbit(azimuthDeg: number, elevationDeg: number, distance?: number) {
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const target = this.orbitTarget ?? this.center;
    const d = distance ?? this.fitDistance();
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    this.persp.position.copy(target).addScaledVector(dir, d);
    this.controls.target.copy(target);
    this.persp.lookAt(target);
    this.controls.update();
    this.needsRender = true;
  }

  /** Orbit around an explicit point instead of the model's centre; null goes back to the centre. */
  setOrbitTarget(target: { x: number; y: number; z: number } | null) {
    this.orbitTarget = target ? new THREE.Vector3(target.x, target.y, target.z) : null;
    // Keep the camera's offset so the view does not jump.
    const next = this.orbitTarget ?? this.center;
    this.persp.position.add(next.clone().sub(this.controls.target));
    this.controls.target.copy(next);
    this.controls.update();
    this.needsRender = true;
  }

  setFov(deg: number) {
    this.persp.fov = THREE.MathUtils.clamp(deg, 1, 170);
    this.persp.updateProjectionMatrix();
    this.needsRender = true;
  }

  /** Solid background colour for the render, or null for the transparent default (the page shows through). */
  setBackground(color: THREE.ColorRepresentation | null) {
    this.scene.background = color === null ? null : new THREE.Color(color);
    this.needsRender = true;
  }

  setGridVisible(on: boolean) {
    this.gridWanted = on;
    this.grid.visible = on && !this.comparing;
    this.needsRender = true;
  }

  /** The model's axis-aligned bounds in world units, for framing shots. */
  bounds(): { min: THREE.Vector3; max: THREE.Vector3; center: THREE.Vector3 } | null {
    const box = this.mesh?.geometry.boundingBox;
    return box ? { min: box.min.clone(), max: box.max.clone(), center: this.center.clone() } : null;
  }

  /** Line up with the photo's camera and show the photo on top with a wipe at `split` (0..1). */
  setCompare(on: boolean) {
    this.comparing = on && !!this.frame;
    this.overlay.classList.toggle('visible', this.comparing);
    this.controls.enabled = !this.comparing;
    this.grid.visible = this.gridWanted && !this.comparing;
    if (this.comparing) this.layoutCompare();
    this.needsRender = true;
  }

  setSplit(split: number) {
    this.overlayImg.style.clipPath = `inset(0 0 0 ${(split * 100).toFixed(2)}%)`;
  }

  private layoutCompare() {
    const f = this.frame;
    if (!f) return;
    const W = this.container.clientWidth;
    const H = this.container.clientHeight;
    const fw = f.right - f.left;
    const fh = f.top - f.bottom;
    let { top, bottom } = this.compareInsets();
    // On short views the overlays may cover the photo's edges rather than shrink it too far.
    if (H - top - bottom < H * 0.55) top = bottom = 0;
    const margin = top || bottom ? 0.96 : 0.9;
    const scale = Math.min(W / fw, (H - top - bottom) / fh) * margin;
    // Centre the photo in the free band; the camera moves the other way so the render stays on it.
    const shift = (top - bottom) / 2;
    const cx = (f.left + f.right) / 2;
    const cy = (f.top + f.bottom) / 2 + shift / scale;
    // Frustum bounds are relative to the camera.
    this.ortho.left = -W / (2 * scale);
    this.ortho.right = W / (2 * scale);
    this.ortho.top = H / (2 * scale);
    this.ortho.bottom = -H / (2 * scale);
    this.ortho.position.set(cx, cy, 20);
    this.ortho.lookAt(cx, cy, 0);
    this.ortho.updateProjectionMatrix();
    const pw = fw * scale;
    const ph = fh * scale;
    Object.assign(this.overlayImg.style, {
      left: `${(W - pw) / 2}px`,
      top: `${(H - ph) / 2 + shift}px`,
      width: `${pw}px`,
      height: `${ph}px`,
    });
  }

  screenshot(): string {
    this.renderer.render(this.scene, this.comparing ? this.ortho : this.persp);
    return this.renderer.domElement.toDataURL('image/png');
  }
}
