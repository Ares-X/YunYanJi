# 云烟集 · YunYanJi

**独处的风景。**

Procedural places to sit with rain, wind and fire.

第一处风景叫「雨歇之前」。在林边的遮雨处，近旁有一堆还在燃烧的柴火，雨水沿棚边落下，湿地映着火光，远处的树林隐在雨雾里。可以转动视线、听雨，或者收起文字停留一会儿。

项目已从古诗场景转向孤独的自然风景。当前只做这一处雨夜篝火，持续校准空间、材料、火焰和声音；画面与听感仍需实际体验验收，构建和测试通过不代表达到摄影写实。

## 运行

使用 Node.js 24：

```bash
npm ci
npm run dev
```

生产构建与本地预览：

```bash
npm run build
npm run preview
```

Vite 使用相对基础路径，可部署在静态网站子目录。无需后端、账号或 API key。

## 体验

- 拖动画面，向四周看；较大的横向拖动也会带起一阵风。
- 「听雨」开启合成的风、雨、滴水和柴火声；声音默认关闭。
- 「入境」收起文字，「显字」或 Escape 返回。
- 「暂停」同时暂停画面和声音；「继续」或「起风」恢复。
- 「设置」调整雨量、声音和画质，也可以重看或分享相同种子的风景。
- 画面获得焦点时，空格起风，P 暂停。系统偏好减少动态效果时，从静止画面开始。

## 全部由代码生成

项目不使用固定贴图、模型、HDRI、天空盒、音频采样、视频或远程字体。树木、地形、木柴、石块和棚沿由种子生成；材质、火焰、雨线、涟漪和天空由几何与 shader 计算。环境光、反射和针叶覆盖需要的 GPU 纹理在运行时生成。声音通过 Web Audio 播放程序合成的 PCM。

固定的种子和同一模拟时间可以重现风景。通过 `?seed=林间-02` 生成另一处；分享只保留风景种子，不带调试状态。

## 当前实现

| 部分 | 做法 |
| --- | --- |
| 空间 | 连续湿土地形、松林、风化石块、粗木棚边缘、火旁高起的土丘 |
| 火 | 劈柴与炭床、三维体积火舌、稀疏火星、共享风场驱动的微动和暖光 |
| 雨 | 斜向雨线、地面溅水与水面涟漪，棚下遮挡范围与几何一致 |
| 水 | 低洼积水，捕获实际场景的平面倒影；静止视角下缓存反射 |
| 光 | 程序阴云环境、冷天光、局部火光、接触遮蔽和克制的 HDR 辉光 |
| 声音 | 远近雨层、地面与棚沿滴水、林间风、近处柴火爆裂和余烬气流 |
| 生命周期 | 静止重绘、后台暂停、上下文恢复、画质切换、资源释放 |

旧雪景模块保留为已归档的试作和部分程序树木的实现来源，未注册为可选择场景。项目不再按风、花、雪、月的十二诗境计划推进。

## 本地检查和截图

```bash
npm run check
npx playwright install chromium
npm run capture
npm run test:browser
```

已有 Chrome 时可以直接使用：

```bash
PLAYWRIGHT_CHROMIUM_CHANNEL=chrome npm run capture
```

也可设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指向现有 Chromium。截图输出到 `test-results/captures/`，不上传或触发 GitHub Actions。先在本地反复看画面，完成一轮修改后再推送一次质量门。

本地无 GPU 时可使用默认 SwiftShader；真实设备复核可设置 `PLAYWRIGHT_SOFTWARE_RENDERING=0`，并检查报告中的实际 WebGL renderer。软件截图不能证明手机或电脑的实际帧率。

完整说明见 [浏览器验收](docs/browser-validation.md)。

## 代码结构

```text
src/
  core/       种子、时间与共享天气
  scenes/     场景协议、注册表、雨夜篝火与可复用几何
  render/     光照、相机、后处理、画质及 WebGL 生命周期
  audio/      合成算法、声场与 AudioContext 生命周期
  ui/         安静的文字与原生交互
```

开发约束见 [AGENTS.md](AGENTS.md)，具体分工见 [架构](docs/architecture.md)，当前构图与验收目标见 [美术方向](docs/art-direction.md)。

开启 `?debug=1` 才会暴露只用于本地诊断的 `window.__YUNYANJI__`，正常界面没有技术面板。
