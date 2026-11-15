import type { Group, PointLight, Vector3 } from 'three';
import type { EnvironmentSnapshot, QualityLevel } from '../core/types';

export interface LandscapeScene {
  readonly group: Group;
  readonly cameraPosition: Vector3;
  readonly cameraTarget: Vector3;
  /** The same radiance source lights surfaces, smoke and the surrounding mist. */
  readonly fireLight?: PointLight;
  readonly movingCanopy?: boolean;
  /** Optional composition authored for narrow screens, in scene world units. */
  readonly portraitCameraPosition?: Vector3;
  readonly portraitCameraTarget?: Vector3;
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
