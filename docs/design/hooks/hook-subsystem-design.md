# Agent Hook 子系统 · 设计文档

> 2026-07-21 起草 · 状态:**设计提案,待评审**。缘起见 issue #21 讨论线（诊断型 run 耗时归因）与 CC 2.1.88 源码对照。本文档定「是什么/事件集/契约/安全/分期」,评审通过后进 M1 实现。

## 0. 一句话

一个**生命周期确定性拦截平台**:在固定事件点跑注册的检查,可 **block / 注入 context / 改写入参 / 观测**,全程不过模型。它**统一 Mellivora 现在散落写死的一堆拦截**(审批闸、循环守卫、答案校验、6+ 处 system-reminder、压缩、步数预算),并为「确定性纪律」(先探静默、强制委派)提供挂载点。

## 1. 定位与边界

**是**:harness 层、在 agentLoop 的生命周期点确定性执行的拦截机制。
**不是**:策略/编排层。它**不判任务难度、不路由模型、不决定要不要先规划**(那是被否掉的「B 方案」)。Hook 只在「事件发生时」跑「已注册的确定性检查」,不做战略决策。

> 与优化方案的关系:本子系统吸收原方案的 **W0(hook 使能)**,并把 **W2(强制委派)/W4(方法论纪律)** 从「prompt 求模型自觉」升级为「hook 强制」。run 6 已证伪纯 prompt 引导(803ded0 的扇出引导被无视),故这两条必须落在 hook 上。W1(模型分层)、W3(工具覆盖)与本子系统正交。

## 2. 动机:拦截已经存在,只是散落写死

Mellivora **早已在 agentLoop 里手写了大量生命周期拦截**——这正是「该有个统一机制」的实证。现状枚举:

| 现有拦截                           | 位置                                                                                                                   | 本质是哪种 hook                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `permissionGate`（审批闸）         | `agentLoop.ts:539` → `executeToolUses(…, permissionGate, …)`；`permission.ts:createGateForMode`                        | PreToolUse（block/deny）                     |
| `loopGuard`（循环守卫）            | `agentLoop.ts:175` / `executeToolUses(…, loopGuard)`                                                                   | PreToolUse（block）                          |
| `replyVerifier`（答案校验→重试）   | `replyVerifier.ts:verifyReply`；注释自称「Modeled on CC's Stop hook」                                                  | Stop（block→retry）                          |
| `workDigest`（探查摘要）           | `workDigest.ts` seed/record                                                                                            | PostToolUse / context                        |
| **6+ 处 `<system-reminder>` 注入** | `agentLoop.ts:41–89`（步数预算 / 引用代码却零工具 / 声称连接失败却没调数据源 / 声称执行却零工具 / 未记 walkthrough …） | PostToolUse / Stop 的**条件式 context 注入** |
| 自动压缩                           | `agentLoop.ts:260`（compaction）                                                                                       | PreCompact                                   |
| 步数预算收尾                       | `agentLoop.ts:41/43`                                                                                                   | 生命周期 context 注入                        |

**一句话**:上面 10+ 处拦截,现在每加一处就改一次 `agentLoop`。Hook 子系统 = 把它们收进一张注册表,新拦截 = 注册一条,而非再改主循环。

## 3. 事件集

对齐 CC(PreToolUse / PostToolUse / UserPromptSubmit / Stop / SubagentStop / PreCompact / SessionStart / SessionEnd),按 Mellivora 需要裁定:

| 事件                          | 时机                      | 允许的决策                             | 迁入的现有拦截                      |
| ----------------------------- | ------------------------- | -------------------------------------- | ----------------------------------- |
| `PreToolUse`                  | 每个工具执行前            | `block` / `modify`(改 input) / `allow` | permissionGate、loopGuard           |
| `PostToolUse`                 | 每个工具结果回来后        | `injectContext` / 观测                 | workDigest、部分 system-reminder    |
| `UserPromptSubmit`            | 用户消息进来              | `injectContext` / `block`(预检)        | 新                                  |
| `Stop`                        | 模型给出最终答案时        | `block`(逼重试) / `injectContext`      | replyVerifier、多数 system-reminder |
| `SubagentStop`                | spawn_agent 子 agent 结束 | `injectContext` / 观测                 | 新（子 agent 收尾）                 |
| `PreCompact`                  | 触发压缩前                | 观测 / 保锚点                          | compaction / compaction_anchor      |
| `SessionStart` / `SessionEnd` | 会话首尾                  | `injectContext` / 落账                 | 新                                  |

## 4. Hook 契约(输入 → 决策)

```ts
interface IHookInput {
	event: HookEvent;
	toolName?: string; // PreToolUse/PostToolUse
	toolInput?: unknown; // PreToolUse
	toolResult?: unknown; // PostToolUse
	contextDigest: string; // 当前进展摘要(不灌全上下文)
	sessionId: string;
	projectId?: string;
	turn: number;
}

interface IHookDecision {
	decision: 'allow' | 'block' | 'modify';
	reason?: string; // block 时回喂模型(像审批拒绝 / verifier 重试反馈)
	additionalContext?: string; // 注入上下文(像 system-reminder)
	modifiedInput?: unknown; // modify 时改写工具入参
}
```

**组合规则**(一个事件点多个 hook):

- 任一 `block` → 整体 block,`reason` 聚合回喂;
- `additionalContext` **累加**注入;
- `modify` **串行链式**(前一个的 `modifiedInput` 进下一个);
- 顺序:内建 hook 先于用户 hook(内建是安全/正确性底线)。

## 5. 执行模型

- **fire 点**:在 `executeToolUses`(PreToolUse/PostToolUse)、agentLoop 出答案处(Stop)、spawn_agent 收尾(SubagentStop)、compaction 入口(PreCompact)、消息入口(UserPromptSubmit)、run 首尾(SessionStart/End)埋注册表调用。
- **matcher**:每条 hook 声明 `{ event, toolMatcher? }`(如 `event: 'PreToolUse', toolMatcher: 'bash|query_data_source'`),不匹配直接跳过——避免每个工具都跑全部 hook。
- **超时 / 失败**:内建 hook 同步快返;用户 hook 带超时,超时按「fail-open(放行)还是 fail-closed(拦截)」由 hook 自声明,默认 fail-open(不因 hook 挂了卡死主循环)。
- **不递归**:子 agent 内默认**不跑用户 hook**(避免 N 个子 agent × M 个 hook 爆炸;与 CC SubagentStop 边界一致),内建安全 hook(审批/循环守卫)仍跑。

## 6. 两类 hook（唯一的真岔路 → 分期,不二选一）

|      | 内建 hook                      | 用户可配 hook                               |
| ---- | ------------------------------ | ------------------------------------------- |
| 载体 | TS,进程内注册                  | config 声明命令 / 脚本(CC settings.json 式) |
| 优点 | 类型安全、零 shell 安全面、快  | 用户可扩展、对齐 CC 生态                    |
| 用途 | 迁移现有拦截 + 承载 W2/W4 纪律 | 用户自定义(项目专属检查)                    |
| 安全 | 无额外面                       | **重点,见 §8**                              |

> **推荐**:先内建注册层(§10 M1+M2),把现有拦截统一 + 落地 W2/W4;用户可配层(M3)随后,带完整安全模型。

## 7. 迁移现有内建(一套机制取代 N 处写死)

M1 把 §2 的拦截逐一重写为**注册的内建 hook**,**行为等价**(回归测试锁死):

- `permissionGate` → 内建 `PreToolUse`(block/deny);
- `loopGuard` → 内建 `PreToolUse`(block);
- `replyVerifier` → 内建 `Stop`(block→retry,复用 `buildRetryFeedback`);
- 6+ 处 `<system-reminder>` → 各自的内建 `PostToolUse`/`Stop`（`additionalContext`），条件判定从 agentLoop 内联挪进 hook 的 matcher/判据;
- workDigest 记录 → 内建 `PostToolUse`(观测);
- compaction → `PreCompact` 观测位。

迁移完成后 `agentLoop` 主体**只剩「fire 事件」**,所有拦截逻辑住进注册表。

## 8. 安全模型（用户可配层才需要）

用户 hook = 在 Electron app 里跑外部命令 → 真实攻击面。约束:

- **配置分级信任**:`~/.mellivora`(global)默认信任;项目 `.mellivora`(仓库内)**默认不信任**——项目注入的 hook 需用户**显式批准**后才生效(防恶意仓库塞 hook,CC 同款「hook 改动需确认」);
- **改动即失效待批**:hook 配置一变,该 hook 停用直到用户重新批准;
- **命令沙箱 + 超时**;
- **审计**:每次用户 hook 触发/决策进 `agentLog`(§9)。

## 9. 可观测性

每次 hook fire + 决策落 `agentLog`:`{ type: 'hook', event, hookId, toolName?, decision, reason?, durationMs }`。
价值:run 6 那种「prompt 被无视」以后可查证——能看到 hook 是否触发、是否 block、注入了什么。今天日志的一个缺口(看不出跑的哪版 prompt/拦截)由此补上。

## 10. 分期

| 期                    | 内容                                                                                                                                                           | 验收                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **M1 · 内建注册核心** | Hook 注册表 + 契约类型 + 在各生命周期点埋 fire;**迁移 §7 全部现有拦截为内建 hook**                                                                             | 行为等价——现有单测/e2e(审批、verifier、loopGuard、system-reminder、压缩)全绿,agentLoop 主体只剩 fire 调用 |
| **M2 · 挂确定性纪律** | W4:`PreToolUse` 活系统「先探静默」检查(对 bulk diff / 对外查询类工具)；W2 强制半条:`PreToolUse` 诊断类第 N 次单 grep/bash 时 block/注入「该 spawn_agent 扇出」 | 复跑诊断型任务:活系统 diff 前有静默检查;串行探查被拦/被推向委派                                           |
| **M3 · 用户可配层**   | config schema + matcher + 外部命令执行 + §8 安全模型 + 配置 UI                                                                                                 | 用户能声明一条 PreToolUse hook 并被 §8 信任模型正确门控                                                   |

## 11. 风险登记

1. **迁移回归**:现有拦截散落且互有时序(如 verifier 重试 vs 步数预算),重写成 hook 要保时序等价——M1 以现有测试为回归网,先等价再优化。
2. **性能**:每工具跑 matcher + 多 hook。matcher 前置过滤 + 内建 hook 同步快返控制开销;用户 hook 超时兜底。
3. **安全(用户层)**:项目级 hook 是主要面,§8 的「项目 hook 默认不信任 + 改动待批」是硬约束,不可省。
4. **别滑成策略层**:hook 只跑「已注册的确定性检查」,一旦有人想在 hook 里塞「判难度→改模型」就越界了(那是 B 方案)。§1 边界须在评审中守住。

## 12. 开放问题

- **Q1 · 已拍板(2026-07-21)**:M2 的 W2 强制取 **「hook 在第 N 个连续单工具 turn 当场注入强提示」**(计数触发),**不硬 block、不静态 prompt**。理由:硬 block 误伤合理串行链;静态 prompt 重蹈 803ded0 被无视;hook 及时点名注入 = 复用现有 6 条 `<system-reminder>` 的同款有效机制。**数据驱动升级**:先注入 → 量良率 → 仍被无视再升「软 block」(警告+要求确认),不上硬 block。
- **Q2 · 留 M3**:用户 hook 载体(外部命令 CC 式 vs 受限 TS 插件)。只影响用户可配层,M1/M2 用不到——用 M1/M2 真实体感再拍。倾向外部命令对齐 CC + §8 信任模型兜安全。
- **Q3 · 留 M3**:SubagentStop 是否给用户 hook 开放?默认关(§5);「子 agent 结论校验」可能有价值,M3 复议。
