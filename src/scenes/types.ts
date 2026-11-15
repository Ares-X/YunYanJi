import type { Group, Vector3 } from 'three';
import type { EnvironmentSnapshot, QualityLevel } from '../core/types';
import type { SceneDepthField } from '../render/SurfaceOcclusion';

export interface LandscapeScene {
  readonly group: Group;
  readonly cameraPosition: Vector3;
  readonly cameraTarget: Vector3;
  /** Optional composition authored for narrow screens, in scene world units. */
  readonly portraitCameraPosition?: Vector3;
  readonly portraitCameraTarget?: Vector3;
  /** The actual ground beneath static geometry, used by local light occlusion. */
  readonly groundHeightAt?: (x: number, z: number) => number;
  /** Renderer-owned opaque depth, valid only for the main view. */
  setSceneDepth?(field: SceneDepthField): void;
  /** Refresh scene-owned generated render caches after context restoration. */
  invalidateRenderCaches?(): void;
  diagnostics?(): Record<string, number>;
  update(frame: EnvironmentSnapshot): void;
  setQuality(quality: QualityLevel): void;
  dispose(): void;
}

export interface SceneOptions { readonly seed: string; readonly quality: QualityLevel }

/** Kept for the archived snow experiment's reusable geometry modules. */
export type PoemScene = LandscapeScene;

export interface LandscapeDefinition {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly description: string;
  readonly create: (options: SceneOptions) => LandscapeScene;
}
