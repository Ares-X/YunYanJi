import { createSnowWorld } from './snow/createSnowWorld';
import type { PoemDefinition } from './types';

export const poems: readonly PoemDefinition[] = [{
  id: 'yongxue',
  title: '咏雪',
  subtitle: '第一境',
  excerpt: '未若柳絮因风起',
  source: '《世说新语·言语》',
  text: '谢太傅寒雪日内集，与儿女讲论文义。俄而雪骤，公欣然曰：“白雪纷纷何所似？”兄子胡儿曰：“撒盐空中差可拟。”兄女曰：“未若柳絮因风起。”公大笑乐。即公大兄无奕女，左将军王凝之妻也。',
  note: '眼前是雪。风穿过林间，轻轻托起雪片，让人想起春日的柳絮。此境借雪中山林演绎原文的比喻，并非对谢家庭院的复原。',
  create: createSnowWorld,
}];

export function getPoem(id = 'yongxue'): PoemDefinition {
  return poems.find((poem) => poem.id === id) ?? poems[0]!;
}
