# dsh-feishu-channel 设计文档

状态: 已定稿（v1.0）
方法: 依据内部设计方法论 v2.2（Technical Component 设计路径）

## 1. 入口门（Agent Entry Gate）

- 最高在作用域 System: **dsh-feishu-channel 插件**（单一设计主体）
- 主体类型: **Technical Component**（拥有一个内聚的技术能力：飞书消息通道 + 富卡片渲染，及其不变量）
- 抽象层级: 插件 = 完整 System；内部概念为下一层
- 设计阶段: 概念 → 逻辑 → 物理 → 代码边界 → 验证（本交付覆盖全阶段）
- 权威来源: 本文档；DSH 宿主契约（agents/approval/commands/session 事件）；@larksuite/channel v0.5.0 API
- 阻塞问题: 无

## 2. 双边界模型

### 2.1 角色与能力视图（User <-> System <-> External）

```text
飞书聊天参与者（私聊/群聊/话题） <-> dsh-feishu-channel <-> 飞书开放平台（@larksuite/channel）
DSH 运维者（安装/配置/扫码）                          <-> DSH 宿主服务（agents、approval、
                                                          commands、attachments、agentPresets、
                                                          loader、settings、workspaceRegistry）
```

- User: 在飞书里与机器人对话的人；决定通道授权范围的运维者
- System: 本插件。拥有: 消息通道、会话映射、授权、审批、渲染
- External: 飞书平台（消息收发、卡片、事件）；DSH 宿主（agent 运行、审批决策、命令执行、附件存储）

### 2.2 交互与契约视图（Input -> System -> Output）

入站 Input:
| Input | 含义 | 供给者 |
|---|---|---|
| 飞书消息事件（文本/图片/提及/命令） | 用户要驱动 agent 的请求 | 飞书平台 |
| 飞书卡片按钮回调 | 审批决策（允许一次/拒绝） | 飞书平台 |
| session/event（assistant/chunk、assistant/message、tool/call、tool/result、step/start、turn/end） | agent 回合的可观察事实 | DSH 宿主 |
| approval/request | 工具权限问题 | DSH 宿主 |
| 配置（cordis.yml / settings） | 部署决策 | 运维者 |

出站 Output:
| Output | 含义 | 消费方 |
|---|---|---|
| 飞书消息（markdown 答案、失败行） | 回合输出 | 用户 |
| 飞书流式卡片（创建/原地更新/完成态） | 富渲染回合输出 | 用户 |
| 飞书审批卡片（提问/结算回写） | 权限决策面 | 用户 |
| agent.followup/cancel/create/resume | 驱动 agent 回合 | DSH 宿主 |
| approval 决策结算 | 权限问题答案 | DSH 宿主 |
| 控制台行 | 运维可观测性 | 运维者 |

稳定边界承诺:
- 一条入站消息最终产生一次可见回合输出（答案永远可达: 卡片失败降级为消息）
- 审批问题在聊天中可被授权者以按钮决策，决策结果回写卡片并结算宿主
- 会话映射跨重启稳定；/new 与 /reset 创建新一代 session 并退役旧 workspace 绑定
- 拒绝入站保持静默（不向未授权者暴露边界事实）

## 3. 概念全景（逻辑承载概念，每个逻辑恰有一个所有者）

| 概念 | 拥有的逻辑 | 明确不拥有 |
|---|---|---|
| **ChannelTransport 通道传输** | WebSocket 连接生命周期、重连、事件入站分发、发送/更新出口、QR 建应用流程；能力子模块：图片资源下载/校验/入库/失败笔记（images.ts）、应用级斜杠面板 reconcile（slash-panel.ts） | 授权策略（→InboundGate）、回合呈现（→ReplyPresenter） |
| **ConversationIdentity 会话身份** | 将 chat/thread/sender 显式编码为唯一 conversation key；生成并识别带 UUID generation 的当前 session id；捕获不可变回复目标 | agent 生命周期、持久化、渲染 |
| **AgentRegistry Agent 注册表** | 按 conversation key 串行 acquire/reset；从持久化与 workspace 候选恢复；仅管理本插件创建或恢复的 owned handle；/new、/reset 替换代际并退役旧绑定 | 消息内容、回合关联、外部 live agent |
| **InboundGate 入站闸门** | 授权（私聊 allowlist/群白名单/@提及/审批点击者）、bot 与空消息过滤、拒绝日志 | 会话获取（→AgentRegistry） |
| **TurnCoordinator 回合关联** | 一条飞书消息→一个不可变 turn；将 agent 的 host turn 事件按提交顺序关联到准确回复目标；按完整 conversation key 隔离重试与 reset | 授权、渲染、agent 生命周期 |
| **Channel 通道组合** | 返回真实 Promise 的消息处理边界；组合授权、AgentRegistry、TurnCoordinator、命令、模型设置、审批、渲染与 transport 生命周期 | 各子模块内部规则 |
| **ApprovalGate 审批闸门** | 仅应答飞书提交的 active owned turn；按 sessionId + callId + turnId 关联参数；发送前脱敏；按钮同时关联 action ID 与 messageId；决策、abort、reset、卸载均确定结算并回写终态卡 | 授权规则定义（→InboundGate） |
| **ReplyPresenter 回复呈现** | 每个 owned turn 在构造时绑定唯一回复目标；驱动建卡、节流更新、终态、handoff 与一次性原生消息降级；close 幂等并清理 timer | 卡片内部结构规则（→CardComposer）、状态投影（→TurnView） |
| **TurnView 回合视图** | 将单个回合事件投影为卡片实际消费的 answer/steps/tokens/model/duration/error；重复事件幂等；首个终态后冻结；不保存 reasoning 与工具结果正文 | 卡片 JSON 结构（→CardComposer） |
| **CardComposer 卡片组装** | 纯函数渲染规则: markdown 分块（不切断围栏/表格）、表格溢出 compact/truncate、限额巡检（200 元素/5 表/28KB）、header/时间线/footer 组装、工具详情脱敏、语义状态着色与 spinner；交互卡子模块：原语（card-design.ts）、设计令牌（card-tokens.ts）、命令菜单/输入/确认/结果（command-card.ts）、权限设置（permission-card.ts）、模型设置（model-card.ts） | 状态投影（→TurnView）、传输（→ChannelTransport） |

辅助（非概念）: model-catalog.ts —— HostModelDirectory 解析助手（route/catalog/currentModel），命令面与模型设置卡共用，避免两处解析漂移。

关系与依赖方向:
- ConversationIdentity → 无
- AgentRegistry → ConversationIdentity、host 窄契约
- TurnCoordinator → ConversationIdentity、AgentRegistry
- Channel → AgentRegistry、TurnCoordinator、ReplyPresenter、InboundGate、ChannelTransport
- ApprovalGate → ChannelTransport、InboundGate（规则）
- ReplyPresenter → TurnView、CardComposer、ChannelTransport
- 所有宿主服务经 host.ts 窄契约进入（组合边界）

## 4. 逻辑闭包（关键规则）

### 4.1 会话
- 会话面: `chat`（整聊天一个）、`chat-thread`（话题一个，普通群退化为 chat）、`chat-sender`（共享群里按人）
- conversation key 使用显式前缀：`chat:<chatId>`、`thread:<chatId>:<threadId>`、`sender:<chatId>:<senderId>`，各组件 URL 编码
- session generation id = `feishu-` + conversation key + `~` + UUID；不恢复旧版无 generation 后缀的 id
- 获取阶梯: 持久化 header 与 workspace 中当前格式候选按新到旧 resume；候选已被外部 owner 作为 live agent 发布时跳过，绝不接管；无可恢复候选才 create
- /new 与 /reset 为同义操作：AgentRegistry 创建空白 generation、退役旧 workspace 绑定、取消并 dispose 旧 owned agent；Channel 按完整 conversation key 清理 renderer、审批、重试和模型设置状态
- 资源所有权: 只 dispose 本插件创建或恢复得到的 handle；外部 live agent 不接入飞书输出或审批

### 4.2 授权
- 平台可见性 = 外层边界（开发者控制台）；插件只收窄
- 私聊: senderAllowlist 空 = 平台准入者皆可；非空 = 白名单
- 群: groupAllowlist 空 = 任何被拉入的群；非空 = 白名单；成员不单独门控；requireMention 决定什么算"对机器人说话"
- 审批点击: chat 必须匹配卡片所在 chat；approvers 非空时必须是白名单者；否则沿用驱动该 chat 的授权
- 拒绝: 静默 + 运维日志

### 4.3 回合
- 每会话消息由 agent 自身队列串行；不同 conversation key 并发独立
- message handler 返回包含 agent 获取、图片处理和 followup 提交的真实 Promise；transport 完成边界不会提前释放
- 回复定向在入站时冻结到 turn：replyTo 指向触发消息，话题群内 replyInThread；后续消息不能覆盖
- 原生引用边界: `replyTo` 直接使用飞书回复消息接口，引用栏由客户端渲染；接口不提供引用栏的布局、底色、间距或圆角参数，插件不能把引用栏与同一条卡片拆成两个视觉容器。主卡保留回复关系，并用白底顶栏避免在原生白色引用栏和白色正文之间插入独立灰色圆角层
- 命令行（/ 开头）不经过模型。裸命令按宿主 descriptor 进入原生交互卡：`input` 命令使用 CardKit 表单，无 `input` 命令要求确认，`/help` 使用动态命令选择器，模型/推理强度/权限使用宿主数据生成下拉框；显式参数直接执行。`danger-full-access` 必须二次确认。每次回调校验 action id、message id、chat、operator 与当前 session；同会话的新卡使旧命令卡失效。/new 与 /reset 替换会话，/stop 调 agent.cancel。动态宿主命令按当前 DSH `execute(agent, line, images, signal)` 契约执行；飞书文本命令传空附件数组，宿主异常归一为命令失败卡，不伪装成会话启动失败
- 入站异常分类: agent 创建失败 → chat 可见失败行；发送失败 → 运维日志 + 日志

### 4.4 渲染
- 冻结 mockup 中的 `output: card` 与 `title` 字样仅是原设计稿的分组标注，不是运行时配置；为保持 UI/UX 基线不修改该设计资产
- 模型可见内容 = 会话日志可回放: 渲染只消费 session/event，绝不发明内容
- 流式卡片生命周期: step/start 建卡（spinner）→ 增量更新（节流）→ turn/end 终态（completed/failed）
- 答案可达性: 建卡失败（无卡片权限）→ 累积文本以 markdown 消息一次性发出
- 限额: 卡片超 200 元素 / 5 表格 / 28KB → 非终态发 handoff 卡（"内容较长，完成后由原生消息发送"），终态直接原生消息；表格第 6+ 个 compact 为字段列表（或按配置 truncate）
- 分块: 正文按 2400 字符分块，绝不在围栏/表格中间切断（拆代码块时补全围栏，拆表格时复用表头）
- 脱敏: 工具详情中的密钥键（token/secret/password/api-key 等）无论 JSON/Python 字面量/裸文本均替换为 [REDACTED]；模型提供的不信任文本用 plain_text 承载
- 三态卡片（feishu-reply-card-kit mockup 的 JSON 映射）: 一张卡原地更新（patch）贯穿加载中/成功/失败；宽卡片（wide_screen_mode）；body 按状态渲染对应面板——加载面板（任务标题 + 实时步骤）、成功面板（答案 + 折叠分析过程）、失败面板（错误框 + 重试/复制错误按钮）
- 顶栏（时间 + 耗时 + 状态胶囊 + 展开箭头）: body 首行为全宽原生 `collapsible_panel`；标题固定为「时间 · 耗时 · 状态」并使用 `notation` 字号，`header.width` 设置为 `fill`，因此箭头始终贴卡片最右侧且状态行保持单行。状态标题直接继承 card body 的左边界，与飞书原生引用文案对齐；手机端只截断、不换行。展开内容占满整卡宽度，按模型、输入 Token、输出 Token、费用、上下文用量（已用/上限 · 百分比）逐行展示，标签左对齐、数值右对齐且每行 `lines: 1`，不把整行做成按钮，也不依赖 callback 或进程内状态。费用行是纯换算（cost.ts）：单价表默认内置 DeepSeek 官方现行牌价（`DEFAULT_PRICING`，2026-08-17 峰谷方案，覆盖 v4-flash / v4-flash-vision-exp / v4-pro），部署按模型 id 整条覆盖合并；费用 = 未命中输入×`input` + 缓存命中×`cacheHitInput` + 输出×`output`（宿主 `inputTokens` 已扣除缓存命中，二者不相交；未配命中价时按未命中价计，宁高估不低估）。支持分时计价——模型条目声明 `offPeak` 折扣价且 usage 上报时刻（usageAtMs，计费时段锚点）落在 `offPeakWindows` 内时按折扣计并标「·低谷」，窗外按标准价计并标「·高峰」；未声明分时价或窗口禁用时金额不带档位标记，窗口为北京时间 `HH:MM` 半开区间、跨午夜用 end 早于 start 表达，默认取 DeepSeek 官方峰谷表（高峰北京时间 9:00–12:00 与 14:00–18:00，空闲减半），`[]` 关闭；模型无匹配条目时该行整体缺席（空值行不渲染），宿主不提供金额。终态时间冻结为 turn/end 时刻，duration 不重复进入详情，其余终态字段由 footerFields 配置；一条信息只出现一次
- 加载面板: turn/end 前不展示半截模型正文；标题固定为 spinner + **正在分析**，不重复原生引用栏已经展示的用户消息；思考以「思考中」实时行呈现——首个 reasoning-delta 即出现（正文仍不保留），消息落地时合并为「思考」并标注真实耗时；工具步骤固定为 HH:MM:SS + ✓/✕/⠋ 彩色符号 + 一句话标题 + 真实耗时（`· Ns`，起止双时间戳、完成不覆盖开始），到标题结束，不追加命令、工具结果、done/completed 或截断提示（标签优先 presentCall 人类描述，否则工具名；完成时间戳取工具结果到达时刻），超出 maxTimelineItems 折叠为一条灰行，末尾灰色"下一步 · 生成回复"；三条灰色 column_set 静态近似动画骨架
- 成功面板: 结论优先且不丢内容——显式「最终/核心/明确结论」章节提升为 16px 标题与首屏正文，原先的证据进入默认收起的「详细说明」；紧随标题的 `关键事实|值` 两列表格（2–4 行）保留在正文中，作为原生 markdown 表格原样渲染（左列字段名、右列内容，自动对齐、换行不截断；不使用 2×2 指标网格，避免错位与超长内容截断），其余 markdown 按结构块拆分为独立元素原样渲染（表格/清单/代码围栏各一元素）；卡片 body 的 vertical_spacing 固定 12px（`--space-4`），所有兄弟元素之间统一呼吸——表格与后续正文、标题与列表、「详细说明」折叠面板与上方内容一律 12px，不依赖模型输出结构；正文与分析区之间使用飞书原生 `hr` 硬分割线（不携带 margin，间距由 vertical_spacing 提供），避免不受消息接口支持的伪渐变。间距一律取自 `SPACE_*` 常量（design-system.md §3.5）。默认收起、无边框的标题固定为 `🔍 **分析过程**`，右侧保留 14px 原生展开箭头（timelineExpanded 可配置展开）；完成后将加载态已显示的同一条时间线原地冻结并收起，每个时间点仍为一行，仅展示思考状态或人类可读工具动作摘要，不展示原始 reasoning、工具输出或自动省略号；没有时间线条目时展开显示「本轮直接生成回复」。
- 富卡片回答契约: channel scope 向 agent 注入一条最小格式提示——最终回复以 `##` 结论标题开头；有 2–4 条关键事实时紧跟 `关键事实|值` 表（渲染器保持该表为 markdown 表格，不转换为 2×2 网格）；首屏只放结论和下一步，支撑证据放在可选 `### 详细说明` 下；工具轨迹不在正文重复；跨标题延续的有序集合也必须保持连续编号且每项独占一行，禁止用 `·`、`、`、逗号、代码围栏或多栏纯文本压缩。有序清单若仍被模型放进纯文本代码围栏，渲染器仅在所有条目为连续编号的单词项时将其还原为普通 Markdown 列表，真实代码与非连续编号保持原样。渲染器仍接受任意 markdown，未遵守契约时保持内容完整。
- 失败面板: 部分答案（如有）在上，hr 后为"分析失败：<原因截断>"标题 + 红色 column_set 错误框（错误码 + 消息 ≤240 字符 + 灰色 last attempt HH:MM:SS）+ 两个 JSON 2.0 原生 button（callback behavior，按钮组 `flex_mode: none`——真机实测手机端不执行 stretch 堆叠，锁定并排布局，见 design-system.md §5.5）：重试校验操作人后复用该失败卡 messageId，并重放该 chat 最近一条用户消息；复制错误因平台无剪贴板 API，点击以 toast 回显错误文本供手动复制
- 加载态 reasoning 只显示“思考”状态，不展示 reasoning 正文；完成态分析过程不纳入 reasoning
- thinking 标签（<think>）在流式增量中跨块安全剥离

### 4.5 审批
- 只应答本插件拥有且能关联到当前飞书 turn 的 agent approval/request；外部 agent、本插件自有但非飞书触发的 turn 均 next() 委托
- 注册 prepend（Web BFF 会吞掉所有审计请求，顺序注册会被饿死）
- 参数关联: tool/call 以 sessionId + callId + turnId 保存；同名 callId 跨 session/turn 不共享，turn/end 只清除本 turn 参数
- 卡片展示: 工具名、将执行的命令、模型说明均先脱敏和限长，再以 plain_text 承载；允许一次/拒绝按钮保持冻结 UI
- 决策: action ID、card messageId、chat、operator/approver 全部匹配后 settle → 卡片回写（绿/红/灰 + 操作人）→ toast
- 撤销: send 前、send 中、send 后 abort 均返回 cancelled；已发送或稍后完成发送的卡片回写“已撤回”
- reset 按 conversation key 取消；卸载取消全部 sending/pending，并等待终态卡回写

### 4.6 生命周期与失败
- 一切注册位于插件 fiber；卸载时并行等待 transport 断开、ReplyPresenter 收尾、图片/面板任务退出、owned agents dispose 与 approvals cancelled
- 连接进行中卸载时，Channel 先标记 inactive，连接完成后立即 disconnect，不启动面板同步
- 连接中断: 通知行 + 重连事件；中断期间事件不重放（平台无游标）
- 机器人循环: 平台 bot_loop guard 触发时提示运维

## 5. 物理实现

- 语言/运行时: TypeScript ESM，Node ^22.19 || >=24，pnpm 11
- 传输: @larksuite/channel ^0.5.0（WebSocket 长连接，免公网 URL；QR registerApp 来自 @larksuiteoapi/node-sdk 再导出）
- 配置 schema: @deepseek-ai/schemastery（同宿主）
- 构建: tsc（lib/types 声明）+ tsdown（lib/index.js、lib/invariant.js），lib/ 提交进 git（GitHub 安装免构建）
- 包边界: exports 仅 "." 与 "./invariant"（+ ./package.json）；不暴露 ./src/*——源码树仅作调试随包分发，不经导出面可达
- 配置字段: appId/appSecret/domain/cwd/provider/model/preset/sessionScope/showProcess/syncSlashCommands/denyTools/requireMention/senderAllowlist/groupAllowlist/approvers + 渲染参数（footerFields = head-meta 字段选择/maxTimelineItems/tableOverflowMode）
- 凭据路径: 入口配置 → settings 命名空间（优先，可扫码持久化）→ QR 建应用
- 常量（固定安全不变量，不配置化）: FEISHU_MAX_ELEMENTS=200、FEISHU_MAX_TABLES=5、SAFE_CARD_JSON_BYTES=28000、MAIN_CONTENT_CHUNK_CHARS=2400、CARD_ARGUMENTS_MAX_CHARS=600

## 6. 代码边界

| 文件 | 概念归属 | 责任 |
|---|---|---|
| src/index.ts | 组合边界 | name/inject/Config/apply 导出 |
| src/config.ts | 组件校验 | Config schema、默认值解析（组件校验组件不变量） |
| src/host.ts | 协议值 | 宿主服务窄契约（agents/approval/commands/attachments/agentPresets/loader/settings/workspaceRegistry + session 事件类型） |
| src/runtime.ts | 组合边界 | apply: 凭证解析、settings 注册、QR 流程、创建 transport、安装 Channel |
| src/channel.ts | Channel | 消息完成边界、命令/动作分发、owned turn 事件路由、transport 与卸载编排 |
| src/conversation.ts | ConversationIdentity | conversation key、当前 session generation、不可变 TurnTarget |
| src/agent-registry.ts | AgentRegistry | owned agent acquire/resume/create/reset/close 与同键串行 |
| src/turn-coordinator.ts | TurnCoordinator | 飞书消息、host turn 与回复目标的精确关联 |
| src/approval-gate.ts | ApprovalGate | owned turn/call 参数关联、脱敏卡片、send/abort 竞争、点击授权、结算与终态回写 |
| src/authorization.ts | InboundGate 规则 | refuseMessage/refuseApprovalClick/describeAuthorization 纯函数 |
| src/commands.ts | 命令面 | 完整行语法解析与无副作用分类；/new /reset /stop /help、模型/推理强度、宿主命令执行和结果归类 |
| src/onboarding.ts | ChannelTransport 流程 | 可取消的 QR 注册状态循环、过期码最小重发间隔、凭据持久化结果与卸载后副作用封锁 |
| src/images.ts | ChannelTransport 能力子模块 | 图片准入按会话当前模型 inputModalities 判定（与 web 发送路径同语义：已知缺 image 拒绝并提示 /model，未知放行由路由裁决）；流式落临时文件，先按传输计数与磁盘 stat 校验媒体类型/单图/消息预算，再读取合格文件入库；取消及全部出口清理临时文件 |
| src/slash-panel.ts | ChannelTransport 能力子模块 | 分页读取应用命令后执行稳定去重的增删差集；removeUnknown 策略、权限降级与生命周期取消 |
| src/model-catalog.ts | 非概念助手 | HostModelDirectory 解析（route/catalog/currentModel），命令面与模型设置卡共用 |
| src/card-tokens.ts | CardComposer 设计令牌 | 语义色映射（CARD_COLOR/CardTone/toneColor）与间距刻度（SPACE_2..6）——design-system.md 的代码层单一事实源 |
| src/card-design.ts | CardComposer 子模块 | 交互卡原语（interactiveCard/interactiveStatusLine/interactiveDivider/interactiveFieldRow/interactivePlainSection/statusTag/cardKitStatusLine） |
| src/command-card.ts | CardComposer 子模块 | 动态命令选择器、参数表单、动作确认、取消与结果卡组装 |
| src/permission-card.ts | CardComposer 子模块 | 会话权限选择、高风险二次确认、成功与失败卡组装 |
| src/model-card.ts | CardComposer 子模块 | 模型设置卡组装（选项来自 model-catalog） |
| src/presentation/markdown.ts | CardComposer 内容结构 | 显式 prose/list/fence/table 扫描、卡片文本规范化、结构安全分块、表格溢出、流式 think 标签过滤 |
| src/presentation/card-budget.ts | CardComposer 容量边界 | 单次 JSON 深度遍历统计 UTF-8 字节、元素与 Markdown/native table，并拒绝循环或不可序列化值 |
| src/presentation/sensitive-text.ts | 内容安全 | 在截断前识别 JSON、键值文本、CLI 与 URL 中的 credential 字段并替换为 `[REDACTED]` |
| src/presentation/turn-view.ts | TurnView | 最小可渲染状态投影、重复事件幂等与终态冻结；步骤保留起止双时间戳（渲染真实耗时）、思考阶段合并为单行（thinking→completed）、turn/end 强制结算未完成步骤为 stopped；不保存 reasoning/tool result 正文 |
| src/presentation/cost.ts | CardComposer 内容结构 | pricing 价格表 → 费用行值的纯换算：模型 id 精确匹配后回退路由末段、缓存命中/未命中拆分计价、货币符号、金额格式化、北京时间峰谷窗口判定（跨午夜）与「·高峰/·低谷」档位标记（单层定价不标记）；无匹配条目返回空串，由 meta 渲染整体省略该行 |
| src/presentation/feishu-card.ts | CardComposer | 从 TurnView 纯函数组装三态卡片（全宽原生折叠顶栏 + head-meta/加载/成功/失败面板 + JSON 2.0 动作/status/spinner） |
| src/presentation/reply-presenter.ts | ReplyPresenter | 单 turn 不可变目标、串行建卡/更新、终态 handoff、一次性原生降级与幂等关闭 |
| src/invariant.ts | 包不变量（verification-only） | 注册宿主 invariants 服务的 companion；无运行时不变量——会话与 ownership 结构由 conversation/agent-registry/plugin 测试证明，companion 只供诊断组合记账 |

依赖规则: conversation 不依赖 agent；agent-registry 只依赖 conversation 与 host 窄契约；turn-coordinator 依赖前两者；channel/runtime 是组合根；禁止反向依赖。

## 7. 验证矩阵（规则 → 证据）

| 规则 | 证据（测试） |
|---|---|
| 显式 Markdown 结构扫描无数据丢失；分块不切断围栏/表格；超长代码块补围栏 | presentation-markdown.spec |
| 编号清单、纯文本 inventory fence、inline code 与表格溢出 compact/truncate | presentation-markdown.spec、feishu-card.spec、command-card.spec |
| 限额巡检 200/5/28KB；复用 Markdown table 解析；循环、BigInt、function、symbol、NaN 与非普通对象拒绝 | card-budget.spec |
| 脱敏 JSON/Python-like/CLI/URL/普通键值；避免近似词误报；结果严格限长 | sensitive-text.spec |
| 回合投影: chunk→answer、reasoning/tool→最小步骤（思考合并、起止双时间戳）、turn/end→冻结终态并结算未完成步骤为 stopped、重复事件幂等、原始正文不驻留 | turn-view.spec |
| footer 字段选择/格式化/spinner、三态卡片与冻结 UI；费用换算与显隐（pricing 匹配/货币/金额格式） | feishu-card.spec、cost.spec、ui-contract.spec |
| 建卡→节流更新→终态；失败仅降级一次；限额 handoff；回复目标不可变；close 清 timer | reply-presenter.spec、reply-presenter-transport.spec（可控 transport） |
| 交互卡原语结构（状态行/字段行/纯文本承载） | card-design.spec |
| 审批卡片冻结 UI | ui-contract.spec、channel.spec |
| session/call/turn 参数隔离、脱敏、send 前中后 abort、跨 chat 拒绝、按 conversation 取消、close 幂等 | approval-gate.spec、plugin.spec |
| 命令选择/输入/确认/取消/结果卡组装 | command-card.spec、ui-contract.spec |
| 权限选项只取宿主投影、custom 不可写、full access 二次确认与结算卡 | permission-card.spec、plugin.spec |
| 模型设置卡选项/结算卡/失败卡；选项与命令面同源（model-catalog） | model-card.spec |
| 图片按模型能力准入（已知缺 image 拒绝/未知放行）、流式落盘、读前限额、存储/取消出口清理与用户失败笔记 | images.spec、plugin.spec |
| Onboarding 保存结果、过期码节流、卸载后无副作用且不输出 secret | onboarding.spec、plugin.spec |
| 面板分页 reconcile: 增/删/去重/removeUnknown/失败降级/生命周期取消 | slash-panel.spec、plugin.spec |
| 边界承诺组合测试（经 apply 挂载可控 transport 与 host 测试替身）: 当前 generation 建/续、外部 live agent 隔离、消息 Promise、不可变回复目标、授权、命令、审批、富卡片、图片、面板、卸载与扫码 | plugin.spec、harness.ts |
| 授权各分支 | authorization.spec |
| 命令各分支；宿主命令四参数契约；帮助菜单跳转；表单提交；危险权限确认；旧卡失效；越权拒绝；异常失败卡 | commands.spec、plugin.spec、channel-session-command.spec |
| 会话键/当前 generation/无兼容分支 | conversation.spec |
| owned agent 恢复、外部 live 隔离、并发 acquire/reset、close 幂等 | agent-registry.spec |
| queued turn 关联、回复目标冻结、按 conversation key 隔离 reset/retry | turn-coordinator.spec、channel-session-command.spec、plugin.spec |
| 配置默认值、删除字段不进入运行时、根导出面 | config.spec、public-api.spec |
| 真实 Cordis Loader 归一化、组合、启动与卸载 | loader.spec、loader-fixture.ts |
