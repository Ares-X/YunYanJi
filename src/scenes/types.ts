import type { Group, Vector3 } from 'three';
import type { EnvironmentSnapshot, QualityLevel } from '../core/types';

export interface PoemScene {
  readonly group: Group;
  readonly cameraPosition: Vector3;
  readonly cameraTarget: Vector3;
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
