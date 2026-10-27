# dsh-goal-ledger

A DeepSeek Harness plugin that audits your own sessions: **which goals drifted from what you asked**, and **where tool calls actually failed**. Everything renders in DSH's settings panel under 「目标台账」.

只读分析本机会话日志，不修改任何会话，不上传除 embedding 文本外的任何数据。

## 它解决什么问题

DSH 把每个会话完整记录在 `$DSH_HOME/sessions/` 下（目标、每轮输入输出、每次工具调用与报错）。这些数据一直在，但**没有入口让你看见模式**。本插件把它变成两张表：

1. **失败聚类** —— 硬事实。工具报错按错误特征聚簇，告诉你「最常因为什么失败」。
2. **目标漂移** —— 排序信号。用 embedding 算每轮输出离最初目标有多远，帮你挑出值得复查的会话。

## 为什么失败聚类比距离更可靠

在真实数据上跑出来的对比（27 个目标 / 203 轮 / 6105 次调用 / 81 次失败）：

| 信号 | 可靠性 | 原因 |
|---|---|---|
| 工具失败聚类 | **高** | `data.error` 要么存在要么不存在，是客观事实 |
| 轮次与调用比 | 中 | 长轨迹+少产出通常意味着在工具调用里打转 |
| embedding 距离 | **低** | 见下方「已知局限」 |

所以界面上把「失败聚类」放在第一个标签页，距离放在后面。

## 已知局限（请务必读）

embedding 距离衡量的是「目标与输出的字面语义分离度」，有两种已实测的误判：

- **「词相近但答错了」** —— 自信但错误的输出，距离照样很低。
- **长技术任务天然漂移** —— 实现细节、文件路径、报错文本都会把输出推离最初的措辞，距离升高但没有任何问题。

因此距离**只用于排序候选，不用于判定对错**。距离分档（0.35 / 0.50 / 0.65）是启发式初值，跑几批后应按你自己的分布调整（`lib/client.js` 的 `band()`）。

纯工具调用轮次（无文字输出）已被标记 `scorable: false` 并排除在均值外 —— 它们的向量没有意义，算进去会显示为「最大漂移」。

## 安装

```bash
# 从本地目录装进 desktop profile
dsh plugin --profile desktop add file:C:/Project/dsh-goal-ledger
```

装完重启 DSH 桌面端，设置面板里会出现「目标台账」。

## 使用

1. 打开 设置 → 目标台账
2. 点「开始分析」（首次扫描约几十秒；嵌入打分需要 embedding 凭据）
3. 切换五个标签页查看：
   - **漂移场**：光点图，半径 = 离目标多远（见下）
   - **失败聚类**：按次数排序，点行展开原始错误与出现位置
   - **目标漂移**：按平均距离排序，标注判定档位
   - **漂移轮次**：单轮最漂移的 10 条
   - **向量模型**：改 embedding 端点 / 模型 / key 变量名，带连通性测试

结果会缓存到 `$DSH_HOME/dsh-goal-ledger/snapshot.json`，下次打开立即显示上次结果。

## 漂移场怎么看

灰蓝底、金色光点，Canvas 2D 实时绘制（无图表库，无动画依赖）：

- **中心亮点** = 「最初的目标」。它是标尺的原点，不是一个会话。
- **每个光点** = 一个目标。**半径就是距离** —— 越靠外，整段会话偏离最初措辞越远。
- **虚线圈** = 档位阈值 0.35 / 0.50 / 0.65，和表格里的标签是同一套数字，图和数不会互相矛盾。
- **颜色**：灰蓝 = 聚焦，浅金 = 有偏离，橙金 = 偏题，亮金 = 严重漂移。颜色只强化档位，不额外编码信息。
- **光点大小** = 该目标经历的轮次数（取对数，防止单个长会话压掉其他点）。
- **角度没有含义** —— 黄金角螺旋 + 按 goalId 哈希的抖动，只为了不让点叠在一起，并保证同一目标每次渲染位置一致。
- **悬停**看目标原文、轮次、调用数、失败数。

纯装饰元素（光尘、核心光晕、轨道弧、光点周围的喷溅）都在 `drawField()` 里，和几何布局分开：改观感不用碰布局，改布局不用碰观感。

## Embedding 配置

默认复用你已有的火山 coding plan 凭据，无需额外配置；也可以在设置页的「向量模型」标签里改，或直接编辑配置文件：

| 项 | 默认值 |
|---|---|
| base URL | `https://ark.cn-beijing.volces.com/api/coding/v3` |
| model | `doubao-embedding-vision`（2048 维） |
| key 环境变量 | `VOLCENGINE_CODING_PLAN_API_KEY` |
| 批量大小 | 4（上限 10） |

任何兼容 OpenAI `POST {baseUrl}/embeddings` 的端点都能用，内置火山方舟 / OpenAI / 硅基流动 / 阿里百炼四个预设，也可自定义。

**配置里只存 key 的变量名，不存 key 本身**。key 解析顺序：环境变量 → `$DSH_HOME/.credentials.yaml` 的 `refs:`。所以 `config.json` 可以放心备份或分享。

配置文件：`$DSH_HOME/dsh-goal-ledger/config.json`（`PUT /config` 写入，非法值整体拒绝、不落盘）。

没有 key 时插件仍可用：失败聚类不需要网络，界面会标注「嵌入：未配置」。

### 供应商限制（已内置处理）

- 单次请求最多 **10** 条文本（超了返回 400）
- 大批量在本机偶发响应截断（`IncompleteRead` / aborted）→ 自动重试 3 次并逐次减半 batch

## 架构

```
lib/index.js          宿主半侧：HTTP 路由 + 缓存 + 配置读写
lib/client.js         客户端半侧：设置页 UI + 漂移场 Canvas 渲染
src/session-reader.js 会话日志解析（zstd 帧拆分、目标/轮次抽取）
src/failure-cluster.js 失败聚类（错误签名归一 + 分类）
src/embed-config.js   embedding 配置校验 / 预设 / 持久化形状
src/distance.js       embedding 打分（余弦距离）+ 连通性探测
test/smoke.mjs        冒烟测试：解析 + 聚类，跑真实会话，不需要 DSH 运行
test/client-render.mjs 渲染测试：在 jsdom + 真 React 里挂载设置页组件，断言三个标签页都画出内容
test/full.mjs         全链路：解析 → 聚类 → 真实 embedding 调用
```

### 三个必须知道的实现陷阱

写这个插件时踩到、并已在代码里注释说明的：

1. **会话日志是数千个独立 zstd 帧的串联**。单次 `zstdDecompress` 只返回第一帧（会话头），静默丢掉整个对话。必须按 magic bytes `28 B5 2F FD` 拆帧逐个解。实测 4MB 日志 → 2857 帧 / 13MB JSONL。

2. **失败在 `data.error`，不在 `data.ok`**。`tool/result` 事件带 `data.message` 和一个可选的兄弟字段 `data.error`，没有布尔 `ok`。检查 `ok` 会让每个会话都报告 0 失败 —— 这个 bug 在本项目里真实发生过一次，修复后从 0 变成 81。

3. **`h` 必须是 `React.createElement`，不能是 `react/jsx-runtime` 的 `jsx`**。`jsx(type, props, key)` 的第三个参数是 **key**，不是子节点；而本项目所有调用点都按 `createElement(type, props, ...children)` 变参传子节点。绑错了不会报错、不会告警、宿主日志干净，**设置页只会画出一个空壳** —— 目录里能看到「目标台账」，点进去一片空白。这个 bug 也真实发生过一次，`test/client-render.mjs` 就是为它加的回归测试。

另外客户端沙箱有两点约束：`fetch` 被替换成 trap（须用 `window.fetch`），且动态 client realm 没有全局 timer（需 `inject: ['timer']`）。动画这里用 `requestAnimationFrame`，页面自己提供，不受这条限制。

## HTTP API

宿主在 `/dsh-goal-ledger-7821` 前缀下暴露：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/status` | 缓存快照 + embedding 配置状态 |
| GET | `/config` | 解析后的配置 + 预设（**不含 key**，只有变量名） |
| PUT | `/config` | `{baseUrl?, model?, keyEnv?, batchSize?, enabled?}`，非法值整体拒绝 |
| POST | `/probe` | 用一条短文本探测端点，返回是否连通 + 维度 |
| POST | `/analyze` | `{cwdFilter?, limit?, embed?}` 运行分析 |
| GET | `/clusters` | 仅失败聚类（不调 embedding，快速免费） |

## 开发

```bash
npm install                  # 装 devDependencies（react / react-dom / jsdom）
npm run test:render          # 渲染回归测试，离线，不需要 DSH 运行
npm test                     # 冒烟测试，直接跑真实会话
npm run test:full            # 全链路（会真实调用 embedding API）
npm run check                # 全部文件语法检查
```

改了 `lib/client.js` 之后**务必跑 `npm run test:render`**：宿主路由 200、语法检查通过、界面依然可能是空白，只有真正挂载组件才能发现。这个测试同时验证 Canvas 真的画了东西（jsdom 没有 2D context，测试装了记录型 stub）、悬停能命中光点、以及向量模型表单的编辑→测试→保存链路。

想单看漂移场效果，可以把它渲染成 PNG：

```bash
npm install --no-save @napi-rs/canvas
node .tmp-render-field.mjs   # 读真实 snapshot.json，输出 drift-field.png
```

### 测试里两个 jsdom 坑（都真实踩过）

1. **`react-dom` 必须在 jsdom 全局就位之后再 `require`**。它在模块初始化时就固化 `canUseDOM`；提前加载会让它判定「没有 DOM」，整套事件系统都不装，之后合成的 `input` 事件**永远到不了 `onChange`** —— 表现和「受控输入框坏了」一模一样，但插件代码其实是对的。
2. **`act()` 要 await**。`act(() => {...})` 返回 thenable，不 await 会把 React 的 act 队列弄脏，后面的事件派发就静默失效。

安装到 profile 后，改动同步到 `~/.dsh/profiles/desktop/node_modules/dsh-goal-ledger/`（`file:` 依赖装的是副本，不是软链），然后刷新页面；页面没换新代码就重启 DSH 桌面端。

## License

MIT
