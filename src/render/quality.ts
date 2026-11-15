import type { QualityLevel, QualityPreference } from '../core/types';

export const QUALITY = {
  low: { pixelRatio: 1, shadowSize: 512, shadows: false },
  medium: { pixelRatio: 1.25, shadowSize: 1024, shadows: true },
  high: { pixelRatio: 2, shadowSize: 2048, shadows: true },
} as const;

export function resolveQuality(preference: QualityPreference, width: number, coarsePointer: boolean): QualityLevel {
  if (preference !== 'auto') return preference;
  return width < 760 || coarsePointer ? 'medium' : 'high';
}

export function drawingSize(width: number, height: number, dpr: number, quality: QualityLevel) {
  const limit = quality === 'high' ? 8_294_400 : quality === 'medium' ? 1_500_000 : 850_000;
  const ratio = Math.min(Math.max(1, dpr), QUALITY[quality].pixelRatio, Math.sqrt(limit / Math.max(1, width * height)));
  return { width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)) };
}
