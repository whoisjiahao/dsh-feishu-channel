# dsh-feishu-channel 设计系统

状态: 统一单一事实源（v1.0）
作用域: 代码层 `src/card-tokens.ts`（令牌）与 `src/card-design.ts`（原语）及预览层 `docs/mockups/ui-current-state.html` 共享的唯一视觉词汇。

## 0. 一句话

一套语义令牌（`neutral / info / success / warning / failure`）贯穿两端——代码层把每个语义映射到飞书枚举色名，预览层把同一语义映射到 oklch 明暗双主题；两端消费同一词汇，值不同只是平台约束。

## 1. 语义令牌（唯一词汇）

代码层以 `CardTone` 为唯一语义集，预览层令牌名与它一一对应。

| CardTone（代码） | 飞书枚举色（代码映射） | 预览令牌（mockup CSS） |
|---|---|---|
| `neutral` | `neutral` | `--tone-neutral` / `--tone-neutral-weak` |
| `info` | `blue` | `--tone-info` / `--tone-info-weak` |
| `success` | `green` | `--tone-success` / `--tone-success-strong` / `--tone-success-weak` |
| `warning` | `orange` | `--tone-warning` / `--tone-warning-weak` |
| `failure` | `red` | `--tone-failure` / `--tone-failure-weak` |

映射实现: `src/card-tokens.ts` 的 `toneColor(tone)`。预览层所有颜色引用只允许使用上表令牌名。

## 2. 色板（oklch 明/暗双主题）

### 明主题

| 令牌 | oklch |
|---|---|
| `--tone-info` | `oklch(58% 0.13 255)` |
| `--tone-info-weak` | `oklch(94% 0.04 255)` |
| `--tone-success` | `oklch(46% 0.15 145)` |
| `--tone-success-strong` | `oklch(40% 0.14 145)` |
| `--tone-success-weak` | `oklch(94% 0.05 145)` |
| `--tone-warning` | `oklch(45% 0.13 70)` |
| `--tone-warning-weak` | `oklch(94% 0.05 70)` |
| `--tone-failure` | `oklch(48% 0.19 25)` |
| `--tone-failure-weak` | `oklch(95% 0.04 25)` |
| `--tone-neutral` | `oklch(47% 0.018 240)` |
| `--tone-neutral-weak` | `oklch(95% 0.006 240)` |

### 暗主题

| 令牌 | oklch |
|---|---|
| `--tone-info` | `oklch(74% 0.12 255)` |
| `--tone-info-weak` | `oklch(31% 0.05 255)` |
| `--tone-success` | `oklch(74% 0.16 145)` |
| `--tone-success-strong` | `oklch(80% 0.13 145)` |
| `--tone-success-weak` | `oklch(33% 0.08 145)` |
| `--tone-warning` | `oklch(72% 0.15 70)` |
| `--tone-warning-weak` | `oklch(32% 0.07 70)` |
| `--tone-failure` | `oklch(70% 0.17 25)` |
| `--tone-failure-weak` | `oklch(32% 0.07 25)` |
| `--tone-neutral` | `oklch(71% 0.016 250)` |
| `--tone-neutral-weak` | `oklch(37% 0.018 250)` |

说明: 暗主题 warning 按兄弟色调（info/success/failure）的明暗提升幅度推导（L ≈ 45 → 72，弱化 ≈ 94 → 32），Hue 保持 70。

## 3. 基础令牌（非语义、跨卡片共享）

| 令牌 | 明主题 | 暗主题 |
|---|---|---|
| `--bg` | `oklch(98% 0.005 250)` | `oklch(23% 0.012 250)` |
| `--chat-bg` | `oklch(96.5% 0.006 250)` | `oklch(21.5% 0.012 250)` |
| `--surface` | `oklch(100% 0 0)` | `oklch(29% 0.014 250)` |
| `--surface-2` | `oklch(97.5% 0.005 250)` | `oklch(33% 0.016 250)` |
| `--surface-3` | `oklch(95% 0.006 240)` | `oklch(37% 0.018 250)` |
| `--fg` | `oklch(22% 0.02 240)` | `oklch(92% 0.012 250)` |
| `--muted` | `oklch(47% 0.018 240)` | `oklch(71% 0.016 250)` |
| `--border` | `oklch(90% 0.008 240)` | `oklch(100% 0 0 / 0.14)` |

字体: `--font-body`（正文）与 `--font-display`（标题）共用系统栈 `-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif`；等宽 `--font-mono` 用 `'JetBrains Mono', 'IBM Plex Mono', ui-monospace, Menlo, monospace`。时间、耗时、数值一律用 tabular-nums。

## 3.5 间距刻度（唯一间距词汇）

区块/元素间的垂直与水平间距只允许使用下表刻度。禁止在卡片渲染代码里写裸 px 字面量（mockup 预览层同样只引用这些变量）。

| 令牌 | 值 | 用途 | 代码常量 |
|---|---|---|---|
| `--space-2` | `4px` | 面板内微距：行距、图标与文字、面板内 vertical_spacing | `SPACE_2`（card-tokens.ts） |
| `--space-3` | `8px` | 面板内常规：面板 padding、水平列间距 | `SPACE_3` |
| `--space-4` | `12px` | 区块间呼吸：标题下方、面板与上一区块之间（如表格 →「详细说明」） | `SPACE_4` |
| `--space-5` | `14px` | 大分隔：hr 上下留白、骨架屏起始 | `SPACE_5` |
| `--space-6` | `16px` | 卡片 body 左右内边距（含出血用的负边距数值） | `SPACE_6` |

规则:

- 层级关系用间距表达：**卡片 body 的 vertical_spacing 固定为 `--space-4`（12px）**，统一作用于所有兄弟元素之间——表格/段落/标题/折叠面板/分隔线一律 12px 呼吸，不依赖模型输出结构
- 正文按 markdown 结构块拆分为独立元素（表格一个、段落一个、列表一个、代码围栏一个），块间间距由 body vertical_spacing 保证，元素自身**不再携带 margin**（避免叠加翻倍）；超大块内部按 `--space-4` 预算再拆
- `hr` 分隔线不携带 margin（呼吸由 vertical_spacing 提供）；大分隔语义由 hr 本身表达
- 面板内 <= `--space-3`（8px）；顶栏 `5px` 顶底为 mockup 既定的状态行内缩，不属于刻度，允许字面量并加注释
- 亚刻度豁免: 头部元信息行距（`1px/3px`）、骨架条厚度（`6px`）等像素级微调不强行归入刻度，允许字面量但必须加注释说明用途；零值（`0px`）和图标尺寸（如 `14px 14px` 的 size）不属于间距，不参与刻度
- 改动流程: 先更新本表，再同步 card.ts 常量与 mockup 的 :root 变量

## 4. 卡片原语

代码层 `src/card-design.ts` 提供可复用原语，预览层用等价结构再现：

- `statusTag(label, tone)` — 状态胶囊，颜色只取 `toneColor(tone)` 的枚举名
- `interactiveStatusLine(title, status, tone)` / `cardKitStatusLine(elementId, title, status, tone)` — 标题 + 状态胶囊单行
- `interactiveCard(elements)` / `interactiveDivider()` / `interactiveFieldRow(label, value)` / `interactivePlainSection(label, value)` — JSON 1.0 结构原语

规则: 层级用字重/字号表达，状态只用一枚小胶囊；正文不重复涂色。

## 5. 平台约束（为什么值被降维）

飞书 `lark_md` 的 `text_tag` 只接受枚举色名（`neutral / grey / blue / green / orange / red / indigo`），传入 hex/oklch 会被忽略。因此:

- 代码层 `CARD_COLOR` 只含枚举名，`toneColor()` 只返回枚举名——这是运行时可执行契约
- oklch 值仅存在于预览层，用于像素级还原明暗双主题
- 两端语义完全一致（同表 §1），改语义只需同步改两处

## 6. 使用规则

- 每张卡最多一个语义色，最多出现两处（如一枚胶囊 + 一处强调）
- 中性 `--tone-neutral` 只用于无状态/默认场景
- `success` 的强色 `--tone-success-strong` 只用于明主题胶囊文字，暗主题用 `--tone-success` 本身
- 胶囊边框用 `color-mix(in oklch, var(--tone-*) 22%, transparent)` 派生，禁止硬编码
- 修改流程: 改语义 → 先更新本文件 §1/§2 映射表，再同步 `card-tokens.ts`/`card-design.ts` 与预览 mockup（`ui-current-state.html`）

## 7. 遗留探索物（不属于统一体系）

早期暗色状态栏候选（`mockup-board.html` 与三张 PNG，独立 hex 调色板）已移除，不在本系统内，不保留追溯。
