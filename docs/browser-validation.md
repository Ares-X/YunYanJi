# 本地截图与浏览器验收

视觉调整先在本地完成，不需要为了看一张截图推送提交或使用远程浏览器服务。截图工具与完整测试共用 Playwright，浏览器由当前电脑运行；本地执行的截图命令不会上传图片到 GitHub。需要 Node.js 24。

## 第一次准备

```bash
npm ci
npx playwright install chromium
```

Linux 缺少浏览器系统库时，可按 Playwright 官方方式安装浏览器及依赖：

```bash
npx playwright install --with-deps chromium
```

已有可用 Chromium 或 Chrome 时，可以直接选择它，见下文；无需再次下载。Playwright 自带版本与项目依赖匹配，是默认选择。Playwright 本身采用 Apache-2.0 许可证，本地运行不需要购买截图服务。[官方安装说明](https://playwright.dev/docs/browsers) · [Playwright 许可证](https://github.com/microsoft/playwright/blob/main/LICENSE)

## 日常调整：只生成截图

```bash
npm run capture
```

命令先用 Vite 生成当前生产构建，再由同一个 Node 进程启动本地预览和 Chromium，截图完成或出错后释放浏览器和预览服务。预览仅监听 `127.0.0.1`，使用系统分配的空闲端口，不依赖已有的开发服务器。

默认输出在已被 Git 忽略的 `test-results/captures/`：

- `desktop.png`：1440 × 900 的桌面视口。
- `mobile.png`：390 × 844 的手机视口，采用 Pixel 7 触摸／DPR 参数。
- `capture.json`：浏览器版本、请求的渲染模式、实际 WebGL renderer 字符串、种子、视口、天气／火势／添柴要求、实际运行状态与浏览器错误。

截图默认采用首景种子 `yunyanji-rainfire-01`，模拟系统的减少动态效果偏好，在初始静止画面捕获；截图尺寸按 CSS 像素保存。脚本会等待真实 WebGL 首帧就绪，浏览器报错会使命令失败。每次覆盖同目录中的同名文件；需要前后对比时指定不同输出目录：

```bash
npm run capture -- --device desktop --output test-results/captures/before
npm run capture -- --device mobile --seed 林间-02 --output test-results/captures/after
```

如果刚刚完成构建且源码未再变化，可用 `npm run capture -- --skip-build` 复用 `dist/`。默认总是重新构建，避免看到旧画面。截图命令不运行完整单元测试与交互测试；它用于快速检查构图和材质。

动态形态也需要实拍。`npm run capture -- --seconds 4 --output test-results/captures/after-motion` 通过真实的继续／暂停操作，在模拟时间达到 4 秒后冻结并截图。脚本会等最后一帧实际提交，避免捕获 GPU 仍在绘制的旧状态；报告同时记录请求时间和实际暂停时间。该选项允许 0–30 秒，不通过修改系统时间或伪造帧推进来取得图片。

天气和火堆同样通过真实控件选择。脚本等待 `renderedWeatherRevision` 与 `renderedFireRevision` 对应当前操作后才截图，避免暂停时多个操作具有相同时间、却捕获到尚未更新的画面：

```bash
npm run capture -- --weather clear --fire out --output test-results/captures/clear-out
npm run capture -- --weather snow --fire small --wood 2 --panel --output test-results/captures/snow-fire
npm run capture -- --weather downpour --fire roaring --seconds 4 --output test-results/captures/storm-fire
```

| 参数 | 可用值与作用 |
| --- | --- |
| `--weather` | `clear` 晴天、`overcast` 阴天、`drizzle` 小雨、`rain` 大雨、`downpour` 暴雨、`snow` 下雪 |
| `--fire` | `out` 熄灭、`embers` 余烬、`small` 小火、`steady` 中火、`roaring` 旺火 |
| `--wood` | 0–4，依次点击添柴；冷柴堆仍保持熄灭，余烬添柴会转为小火 |
| `--panel` | 保留「天候与柴火」面板，便于检查桌面和手机布局 |

天气／火势选择发生在静止预览状态；`--seconds` 再启动真实时间推进。雪预览会显示薄层覆盖，当前没有有厚度的雪层几何。暴雨的自动雷声首先等待一段模拟时间，4 秒的截图不应被当作雷电时序验证；雷电由交互测试及下方音频信号检查单独验收。

检查高像素密度显示器时，可加 `--dpr 2`。它模拟浏览器的显示像素比，允许 1–3，默认沿用所选设备参数。`--scale css` 是默认选项，PNG 保持 CSS 视口尺寸；`--scale device` 保留浏览器的设备像素，便于放大检查细枝、表面高光与边缘：

```bash
npm run capture -- --device desktop --dpr 2 --scale device --output test-results/captures/retina
```

该命令的视口仍是 1440 × 900，PNG 为 2880 × 1800。截图的设备像素数不等同于场景实际渲染像素数：WebGL 画质仍限制 DPR 和总像素预算，报告中的 `drawingWidth` / `drawingHeight` 才是实际画布绘制尺寸。

| 画质 | DPR 上限 | 绘制像素预算 |
| --- | --- | --- |
| 低 | 1 | 850,000 |
| 中 | 1.25 | 1,500,000 |
| 高 | 2 | 8,294,400（3840 × 2160） |

例如 4K 视口在高档、DPR 1 时可以按 3840 × 2160 绘制；更大的视口或更高的 DPR 会在预算内缩放。手机自动选择中档，即使以设备像素保存 PNG，也不会自行切换到高档。较大的截图用于细节检查，不构成实时性能或摄影写实的验收结论。

## 使用已安装的 Chrome 或现有 Chromium

选择本机 Chrome 稳定版，无需注册账号或安装远程服务：

```bash
PLAYWRIGHT_CHROMIUM_CHANNEL=chrome npm run capture
```

也可指定已有浏览器的绝对路径：

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chromium npm run capture
```

这两个环境变量互斥，也适用于 `npm run test:browser`。PowerShell 可先运行 `$env:PLAYWRIGHT_CHROMIUM_CHANNEL = "chrome"`，再运行命令。项目不绑定任何临时路径或第三方 Chromium 打包依赖。

Playwright 官方支持已安装的 Chrome channel；任意自选 Chromium 二进制与 Playwright 的兼容性则不保证，更新浏览器后应重跑完整测试。[浏览器选择](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge) · [executablePath 兼容性说明](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-executable-path)

本地截图与 CI 默认请求 SwiftShader 软件渲染，以便在无 GPU 的机器上运行。Mac 上使用本机 Chrome 复核时，可以取消强制软件渲染；在有独立显卡的电脑上也可使用同一个开关：

```bash
PLAYWRIGHT_CHROMIUM_CHANNEL=chrome PLAYWRIGHT_SOFTWARE_RENDERING=0 npm run capture
```

`PLAYWRIGHT_SOFTWARE_RENDERING=0` 只取消强制 SwiftShader 的启动参数，由浏览器和驱动选择实际后端；它不保证启用硬件加速。脚本把请求模式和实测的 WebGL renderer 字符串分别写入 `capture.json`：优先读取 `WEBGL_debug_renderer_info`，不可用时回退到标准 `RENDERER`，不会为获取信息修改浏览器隐私或安全设置。

截图能检查画面和 shader，不代表设备帧率，也不能替代真实手机、耳机或扬声器的验收。换用本机 Chrome 或取消强制软件渲染，都不会自动成为性能测试。

## 提交前：完整质量门

完成一轮本地调整后再执行：

```bash
npm run check
npm run test:browser
```

若使用自选浏览器，为第二条命令设置上述同一个环境变量。完整测试覆盖桌面与手机、六种天气、火势与添柴、雷声延迟、声音状态、输入、设置、减少动态效果、WebGL 恢复和资源释放。测试输出单独放在 `test-results/browser/`，不会清掉 `test-results/captures/` 中的视觉对比图。检查实际截图后再集中推送，不把截图、报告或 `dist/` 提交为项目素材。

完整测试先以减少动态效果模式截取静止首帧，再切回正常动态，验证实际帧推进、起风、拖动和暂停。这能避免先积累动画绘制任务，再等待软件 GPU 完成整页截图回读；交互和动态覆盖仍然保留。恢复测试会对比同一静止场景恢复前后的中央画面颜色，防止环境光缓存丢失只通过计数断言。

桌面和手机分别运行四组独立用例：画面与动态交互、设置与资源释放、上下文恢复、天气与柴火。天气用例检查实际图像变化与渲染 revision，而不只断言按钮文字；添柴验证可见木柴数量及上限，雷电检查闪光事件之后的声传播延迟。将行为分开可避免长流程在最后耗尽总预算；原有的网络、错误、交互和恢复断言继续保留。

天气与火势的多轮矩阵在中画质下运行，保留阴影、AO 与泛光；桌面最终添柴雪景另以高画质捕获。默认／高画质的动态、设置切换与恢复仍由其他用例覆盖。

第一组通过指针操作起风、声音与设置；第二组使用按钮的原生 Enter 激活，再检查声音预览和静止画质切换，同时覆盖键盘访问。键盘路径不依赖软件 GPU 合成期间用于鼠标稳定性检查的连续两帧。普通用例总预算为 120 秒；上下文恢复用例包含两次世界初始化、一次画质切换和两次像素回读，单独使用 180 秒总预算；天气与柴火用例包含多轮状态检查与截图，使用 300 秒。输入仍限 15 秒，每次 GPU 等待和截图仍限 45 秒。

2026-11-15 的本轮验证已通过 `npm run check`：17 个文件内的 60 项单元测试及生产构建通过。Chromium 153／SwiftShader 的完整桌面、手机浏览器测试为 8/8 通过，耗时 7.7 分钟；已检查实际晴雨、薄雪、添柴及手机面板截图。该结果验证功能和当前渲染输出，不代表真实设备帧率、照片级画质或主观听感验收。

## 已完成的程序音频信号验证

22 项音频单元测试通过，覆盖实际 PCM 的确定性、有限幅度、静默边界、雷声频谱与尾声，以及事件传播、晚开启、静音、重置和节点释放。另在 Chromium 153 的实际 `OfflineAudioContext` 中运行完整音频图，以 24 kHz、双声道检查输出；没有用 mock 代替该图，也没有下载音频。

同一验证配置中，火堆熄灭，音量为 0.45。下表为 PCM 均方根幅度（RMS），显示到小数点后八位，不是扬声器声压：

| 信号 | 左声道 RMS | 右声道 RMS |
| --- | --- | --- |
| 暴雨 | 0.05345536 | 0.05021749 |
| 下雪 | 0.00936699 | 0.00734472 |
| 雷声滚动阶段 | 0.03430268 | 0.01449479 |
| 音量设为零 | 0 | 0 |
| 雷声期间静音，衰减结束后 | 0 | 0 |

全部样本均为有限值。雪天的左声道一阶差分能量／信号能量比为 0.09793771，暴雨为 0.91669350，反映两者频率分布的区别；雪声使用更柔和的独立声层。熄灭状态的火焰与余烬增益均为零。零音量与静音衰减完成后的左右声道峰值也严格为零。

传播检查在模拟 1 秒触发闪电，设定 2 秒声传播延迟：2.9 秒时尚无雷声事件，3 秒时恰好开始一个。活动雷声使节点数由 30 增至 34，静音后回到 30。图包含 9 个循环声源，短事件最多 2 段雷声加 2 段添柴声；测试验证结束、暂停、重置和重复释放不遗留节点。实际音频报告和 8 秒雷声／静音 WAV 留在本地忽略目录 `test-results/audio-qa/`，不作为应用资源提交。

这些结果验证信号、同步与资源生命周期。耳机／扬声器上的音色、空间感和长期听感仍需真人体验，不能由 PCM 指标或浏览器测试宣称通过主观声音验收。

## CI 什么时候运行

| 事件 | 静态检查、单元测试、构建 | 完整浏览器测试 |
| --- | --- | --- |
| 草稿 PR 有代码变更 | 执行 | 跳过，开发时在本地检查 |
| PR 转为可审阅状态 | 执行 | 执行 |
| 正式 PR 的后续代码变更或重新打开 | 执行 | 执行 |
| `main` 有代码变更 | 执行 | 执行 |
| 纯文档 PR / `main` 纯文档推送 | 不触发 | 不触发 |
| 手动运行工作流 | 执行 | 执行 |

`ready_for_review` 已显式加入触发事件，因此草稿转为正式 PR 后不会漏掉浏览器验收。同一分支的新运行会取消尚未完成的旧运行。

CI 只安装测试实际使用的 Chromium Headless Shell 与所需系统依赖，不再额外下载完整桌面 Chrome。截图单独允许 45 秒完成像素回读和编码，按 CSS 像素保存；交互动作仍使用 15 秒限制，不随截图预算放宽。

八组浏览器测试及最终审阅截图共用 20 分钟的工作流硬上限，以免新增天气流程在完整质量门尾部被旧的 15 分钟总上限截断；它不是等待时长，完成后立即结束。每项交互、像素回读与各用例仍有独立超时，失败不自动重跑。

GPU 提交采用非阻塞 fence，上一帧未完成时不继续积压绘制；诊断中的 `frames` 只增加于实际提交。动画活性检查仍要求产生至少三个动画帧，但使用与像素回读相同的 45 秒软件 GPU 等待预算。它验证画面持续推进，不代表流畅度或真实设备帧率。初次与恢复后的第一帧已经直接提交，因此不再重复安排相同静态帧；取消减少动态效果偏好也保留已有暂停状态和待处理设置更新。

GitHub 的 PR 路径过滤基于整个 PR 的差异：一个已经包含代码的正式 PR，即使最新提交只修改文档，也仍可能触发检查。这里保留正式检查，避免在没有核实前一版本通过的情况下跳过质量门。单独的文档 PR 和主分支纯文档推送可以完全跳过。若未来把本工作流设为必需状态检查，应同步评估路径过滤：GitHub 可能让未触发的必需检查保持 Pending；本次不修改仓库保护设置。[路径过滤规则](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore)

正式 PR 在完整浏览器测试通过后，会复用当前生产构建，以默认首景种子、静止首帧和 DPR 1 分别实拍桌面与手机画面，保存到 `test-results/visual-review/`。CI 随后将这组审阅截图及其 `capture.json` 与 `playwright-report/` 中的 HTML 报告一起上传为 `browser-evidence` artifact；成功的正式 PR 也会保存这些证据。草稿 PR 仍跳过完整浏览器测试和这组截图，日常视觉迭代继续使用本地 `npm run capture`。

其他运行在失败时上传已有的 HTML 报告；手动运行勾选 `upload_evidence` 也会保存成功报告。报告与审阅证据统一保留 3 天，不额外重复上传 HTML 报告中已有的截图和 trace 附件。手动入口需要工作流文件先存在于默认分支，尚未合并的首个 PR 应通过正式 PR 触发完成验收。[工作流事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)

## GitHub 计费边界

按 2026-11-15 查阅的 GitHub 官方文档，公开仓库使用标准 GitHub 托管 runner（本工作流的 `ubuntu-latest`）免费且不扣 included compute；larger runner 即使在公开仓库也收费。因此减少本项目运行主要是在减少等待和重复工作，不能把之前标准 runner 的时长说成已经产生了费用。[标准 runner](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job#standard-github-hosted-runners-for-public-repositories)

存储有独立规则：Actions artifacts 与 GitHub Packages 共用套餐存储额度，cache 另有每仓库 10 GB；计费存储按 GB-Hours 累积，删除只停止后续累积，不回退已累积用量。不能从标准 runner 免费推导出所有存储都无限免费。当前官方文档也已把 included compute 写成金额，而不是统一的固定分钟数；不应把搜索引擎中的旧版“每月 2,000 分钟”套用到公开仓库。本项目没有读取或修改账户账单、付费预算、缓存扩容或套餐。[GitHub Actions 计费](https://docs.github.com/en/billing/concepts/product-billing/github-actions) · [套餐额度](https://docs.github.com/en/billing/reference/product-usage-included)
