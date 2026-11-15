import type { Group, Vector3 } from 'three';
import type { EnvironmentSnapshot, QualityLevel } from '../core/types';

export interface PoemScene {
  readonly group: Group;
  readonly cameraPosition: Vector3;
  readonly cameraTarget: Vector3;
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

export interface PoemDefinition {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly excerpt: string;
  readonly source: string;
  readonly text: string;
  readonly note: string;
  readonly create: (options: SceneOptions) => PoemScene;
}
