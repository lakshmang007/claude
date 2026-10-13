import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { FrontFrame, MeshResult } from '../core/types';

export type Shading = 'lit' | 'unlit' | 'clay';

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
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(2, 3, 2.5);
    this.scene.add(key);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 0.4));

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
      lit: new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0, envMapIntensity: 0.9 }),
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
    this.needsRender = true;
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

  resetView() {
    const size = new THREE.Vector3();
    this.mesh?.geometry.boundingBox?.getSize(size);
    const radius = Math.max(size.x, size.y, size.z, 0.5) * 0.75;
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2)) * 1.1;
    const dir = new THREE.Vector3(0.45, 0.2, 1).normalize();
    this.persp.position.copy(this.center).addScaledVector(dir, dist);
    this.controls.target.copy(this.center);
    this.controls.update();
    this.grid.position.y = 0;
    this.needsRender = true;
  }

  /** Line up with the photo's camera and show the photo on top with a wipe at `split` (0..1). */
  setCompare(on: boolean) {
    this.comparing = on && !!this.frame;
    this.overlay.classList.toggle('visible', this.comparing);
    this.controls.enabled = !this.comparing;
    this.grid.visible = !this.comparing;
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
    const margin = 0.9;
    const scale = Math.min(W / fw, H / fh) * margin;
    const cx = (f.left + f.right) / 2;
    const cy = (f.top + f.bottom) / 2;
    // Frustum bounds are relative to the camera, which sits on the frame centre.
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
      top: `${(H - ph) / 2}px`,
      width: `${pw}px`,
      height: `${ph}px`,
    });
  }

  screenshot(): string {
    this.renderer.render(this.scene, this.comparing ? this.ortho : this.persp);
    return this.renderer.domElement.toDataURL('image/png');
  }
}
