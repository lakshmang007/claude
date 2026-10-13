/** Plain RGBA raster, layout-compatible with the DOM ImageData. */
export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Single-channel float raster (depth, heights, weights ...). */
export interface FloatField {
  width: number;
  height: number;
  data: Float32Array;
}

/** Single-channel 8-bit raster. For masks 0 = background, 255 = object (soft values allowed). */
export interface ByteField {
  width: number;
  height: number;
  data: Uint8Array;
}

export type ViewName = 'back' | 'left' | 'right' | 'top';
export const VIEW_NAMES: ViewName[] = ['back', 'left', 'right', 'top'];

/** One photograph of the object together with everything derived from it. */
export interface ViewInput {
  image: RGBAImage;
  /** Object alpha at the image's resolution. */
  mask: ByteField;
  /** Relative inverse depth (larger = closer), any resolution, covering `depthRect` of the image. */
  depth?: FloatField;
  /** Image rectangle covered by `depth` (defaults to the whole image). */
  depthRect?: { x: number; y: number; width: number; height: number };
  /** Mirror the reference horizontally before use (web photos rarely follow a convention). */
  flip?: boolean;
  /** Use this view for shape (thickness) only, not for texture: set when it is unknown which side of the object it shows. */
  geometryOnly?: boolean;
}

export type BackShape = 'auto' | 'mirror' | 'round' | 'flat' | 'reference';
export type BackTexture = 'auto' | 'reference' | 'mirror' | 'tone';

export interface ReconstructSettings {
  /** Vertices along the longest side of the geometry grid. */
  resolution: number;
  /** Multiplier on how deep the object is (1 = automatic estimate). */
  thickness: number;
  /** Multiplier on relief coming from the depth map. */
  depthStrength: number;
  /** 0 = trust the depth map only, 1 = fully rounded silhouette inflation. */
  roundness: number;
  /** Keep the camera tilt captured by the depth map (otherwise the rim is made planar). */
  keepTilt: boolean;
  /** Extra relief from image shading (0 = off). */
  shadingDetail: number;
  /** Gaussian smoothing of the front relief in grid pixels. */
  smoothing: number;
  backShape: BackShape;
  backTexture: BackTexture;
  /** 0..1 how strongly reference photos are colour-matched to the input. */
  colorMatch: number;
  /** 0..1 how much side/top references replace stretched texels at grazing angles. */
  sideBlend: number;
  /** Maximum width of the texture atlas in pixels. */
  textureSize: number;
}

export const DEFAULT_SETTINGS: ReconstructSettings = {
  resolution: 256,
  thickness: 1,
  depthStrength: 1,
  roundness: 0.3,
  keepTilt: true,
  shadingDetail: 0,
  smoothing: 1,
  backShape: 'auto',
  backTexture: 'auto',
  colorMatch: 0.5,
  sideBlend: 1,
  textureSize: 4096,
};

export interface ReconstructInput {
  front: ViewInput;
  refs: Partial<Record<ViewName, ViewInput>>;
  settings: ReconstructSettings;
}

/** World-space rectangle covered by the cropped front photo (for the photo-match camera). */
export interface FrontFrame {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

export interface MeshResult {
  positions: Float32Array;
  /** Smooth per-vertex normals from the height fields (not from triangle orientation). */
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  atlas: RGBAImage;
  /** The cropped front photo, exactly as projected onto the model. */
  frontPhoto: RGBAImage;
  frame: FrontFrame;
  stats: {
    vertices: number;
    triangles: number;
    gridWidth: number;
    gridHeight: number;
    usedDepth: boolean;
    /** References used for texture (and shape). */
    usedRefs: ViewName[];
    /** References used for shape only (`geometryOnly`). */
    shapeOnlyRefs: ViewName[];
    backShape: Exclude<BackShape, 'auto'>;
    backTexture: Exclude<BackTexture, 'auto'>;
    watertight: boolean;
  };
}
