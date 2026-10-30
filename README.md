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

### 从插件市场装（推荐）

DSH 的插件市场读取你**自己配置的索引地址**。本插件已发布到 npm，索引随包提供，在 设置 → 插件 → 发现（Discover）里添加：

```
https://unpkg.com/dsh-goal-ledger@0.4.1/market-index.json
```

然后在市场里搜索「目标台账」或 `dsh-goal-ledger` 安装即可。

**为什么用 unpkg 而不是 GitHub raw**：实测这台机器访问 `raw.githubusercontent.com` 会被连接重置（curl 与 node 均 `ECONNRESET`，3/3 失败），而 `unpkg.com` 稳定 200。索引地址是用户手动填的，必须给一个真的能打开的。

### 命令行装

```bash
# 从 npm 装（推荐，48 KB，秒级）
dsh plugin --profile desktop add dsh-goal-ledger

# 从 Git 装（固定 commit，不走 npm 缓存）
dsh plugin --profile desktop add git+https://github.com/zhegemingzimeibanquan/dsh-goal-ledger.git#f7669338eae9e15acb3a263890cc88d79e8ef0f1

# 或者从本地目录装（开发用）
dsh plugin --profile desktop add file:C:/Project/dsh-goal-ledger
```

装完重启 DSH 桌面端，设置面板里会出现「目标台账」。

### 系统要求

| 项 | 要求 |
|---|---|
| DSH | **>= 0.2.1-rc.3**（`engines.dsh`，安装前会校验，低于此版本会被拒装） |
| Node.js | >= 22 |
| 网络 | 可选。失败聚类完全离线；只有「向量模型」打分需要网络 |

插件本身**零运行时依赖**，不引入任何第三方包。

## 使用

1. 打开 设置 → 目标台账
2. 点「开始分析」（首次扫描约几十秒；嵌入打分需要 embedding 凭据）
3. 切换六个标签页查看：
   - **漂移场**：光点图，一个光点一个目标，半径 = 平均离目标多远（见下）
   - **失败聚类**：按次数排序，点行展开原始错误与出现位置
   - **目标漂移**：按平均距离排序，标注判定档位
   - **漂移轮次**：单轮最漂移的 10 条
   - **向量模型**：改 embedding 端点 / 模型 / key 变量名，带连通性测试
   - **漂移纠正**：让模型在持续偏离时被提醒拉回（默认关闭，见下）

结果会缓存到 `$DSH_HOME/dsh-goal-ledger/snapshot.json`，下次打开立即显示上次结果。

## 漂移纠正（opt-in）

开启后，当某个目标**连续多轮**偏离时，插件在下一步的系统提示里插入一段提醒：逐字引用你最初的目标，指出当前偏离，并要求模型回到目标继续。

**它不做什么**（这些是刻意的设计边界）：

| 不做 | 为什么 |
|---|---|
| **不修改你的目标** | 自动改写目标会让「判断漂移」的锚点跟着漂移一起动，最后你可能得到一个自己没要求过的目标 |
| **不打断正在跑的轮次** | 只在轮次之间生效，只影响后续步骤 |
| **不调用模型来判断** | 判断完全基于本地已有的距离数据，不额外增加延迟和 token |
| **默认不开启** | 关闭时插件不向提示里写任何东西，行为与没装插件逐字节相同 |

**防误报**：长技术任务天然会偏离最初措辞（上面「已知局限」里就写了这个）。所以只有**连续 N 轮**都超过阈值才提醒，提醒后还有**冷却轮数**静默期，避免模型在「回到目标」和「推进进度」之间来回抖动。

注入的文本明确要求模型：先复述目标要求什么、已完成到哪一步；指出当前哪些工作不是目标要求的；**保留所有已完成的有效工作**，不要重开任务。最后还允许它判断「其实没偏」—— 否则降低距离最省事的做法就是推倒重来，那比漂移更糟。

| 参数 | 默认 | 含义 |
|---|---|---|
| 触发阈值 | 0.55 | 单轮距离 ≥ 此值算一次「偏离」 |
| 连续轮数 | 2 | 连续偏离多少轮才提醒 |
| 冷却轮数 | 3 | 提醒后静默几轮 |

配置写在 `$DSH_HOME/dsh-goal-ledger/correction.json`。实现上它挂在 **agent 作用域**（`agent.ctx`）而不是全局：只影响该会话，agent 销毁时自动解绑，多会话互不干扰。

**实时打分**：正在跑的会话不在缓存快照里（快照只有已落盘的会话），所以纠正用的是 `LiveScorer` —— 它折叠 `session/event` 的实时事件流，事件形状和离线分析器读的是同一套（`turn/start` 开轮、`assistant/message` 累积、`turn/end` 收轮），所以「当场决定要不要提醒」和「事后报表里的距离」不会互相矛盾。锚点优先取 `create_goal` 的 objective，没有则取第一条真实用户消息（同样剥掉宿主注入的样板文本）。每个已打分轮次一次 embed 调用，objective 只 embed 一次。

## 漂移场怎么看

Canvas 2D 实时绘制（无图表库，无动画依赖）：

- **中心亮点** = 「目标锚点（距离 = 0）」。它是一个**标尺原点**，表示「完全命中最初要求」的理想位置，**不是一个会话、也不是某个具体目标**。措辞改过一次：原来叫「最初的目标」，容易被读成「某个会话的目标」，而每个光点本身就已经是一个目标了。
- **一个光点 = 一个目标**（整段会话的那个目标），**不是一轮对话**。轮次级明细去「漂移轮次」Tab 看。
- **半径** = 该目标整段会话里**可计分轮次的平均距离**（`meanDistance`）。明确一句：不是最终值、不是最大值；纯工具调用轮次（无文字输出）不参与平均。
- **虚线圈** = 档位阈值 0.35 / 0.50 / 0.65，数字和档位名（有偏离 / 偏题 / 严重）**直接标在环上**，和表格里的标签是同一套数字。环标签的方位不是写死的，也**不是三环共用**：每个环独立在自己的候选方位里挑代价最小的，并同时避让已放好的环标签 + 严重档的数值标签 + 光点本身 + 12 点接缝。三件事值得记下来：
  - 31 个目标的真实数据下，**59 个候选方位没有一个能完全不碰光点**（最低代价 302）。环面就那么大，光点铺满之后「完全不重叠」不存在，所以这是择优而不是求解。
  - 三环共用同一个方位会让它们挤在一根射线上（实测出现过 99° 和 102°，只差 3°，框不相交但看着是一坨）。所以加了一条**方位间隔下限**（`MIN_CHIP_SEP`，约 22°），低于就重罚，把三个环推向不同方向。
  - **环标签在整张图里最后画**，并且底衬接近不透明（`rgba(8,13,19,.97)` + 阴影）。这是一次真 bug 的修复：标签原本画在连线**之前**，所以每条穿过胶囊的边都压在文字上，`0.50 偏题` 那条最明显。绘制顺序错了，不是底衬不够深。
- **颜色四档**，四种可区分色相，不再有两个几乎同色的档位：纯蓝 = 聚焦，青绿 = 有偏离，橙 = 偏题，亮金 = 严重漂移。颜色只强化档位，不额外编码信息。
- **角度** = 会话开始时间，**顺时针**推进（旧 → 新）。注意是**按开始时间的次序等角分布**，不是按时间间隔比例：真实数据里开始时间跨一周、最小间隔 10ms，按比例映射会把几十个点压在同一根射线上。角度编码**先后顺序**，具体时间点看悬停。12 点方向留了一道**接缝**（虚线楔形），是「最新的点回绕到最旧的点」的地方，图上用 旧 / 新 两个标号标出来了。
- **光点之间的连线 = 目标与目标之间的相似度**：1 − cos(目标A向量, 目标B向量)。细线 = 同一主题（距离 ≤ 0.42）；亮线 = 几乎同一个目标被重复提问（距离 ≤ 0.18）。连线用的向量就是打分时已经算好的目标向量，不额外调用 embedding。选取规则在 `src/distance.js` 的 `buildGoalLinks()`（每个目标最多连 3 条最近的边）。
  - **箭头 = 方向（旧 → 新）**。亮线的含义是「同一个问题问过两次，上次的路径可以复用」，但哪一端是「上次」原来无法从静态图看出来。现在每条有时间戳的边上有一个极淡的箭头，指着**新的那一端**：箭头指向谁，就是「把旧路径复用到谁」。两端只要有一端没有时间戳就不画箭头——**编一个方向比没有方向更糟**。
  - **边数量有预算**。上游已经把每个目标限制在 3 条边，但 3 × N 仍随目标数线性增长：上千个目标时会糊成一团。规则是**亮线永远画**（它们才是可操作的那批），细线只在预算内画、超出的隐藏；悬停某个目标时，它的边**全部展开**（悬停就是「看这个点的上下文」这个手势，在那里藏边等于废掉这个手势）。预算按画布面积缩放（`weakEdgeBudget()`，约 每 2600 px² 一条，下限 12），图例里会写明**藏了多少条**——静默丢边会让人以为数据本身边就少。
- **时间刷选**：角度既然编码了时间，就沿外圈做了一条**时间刷选**。在外圈（半径 0.94–1.22 倍，即标签环之外）按住拖动即可选出一段时间窗，选中的弧会画成一段高亮圆弧 + 两个手柄；窗外的东西**变暗而不是消失**——「这段有 4 个目标、窗外 27 个」才是这个筛选用来看的读数，删掉那 27 个等于回答了另一个问题。另外右上角有 **最近 7 天 / 最近 24 小时 / 全部** 三个快捷按钮。按一下不拖（位移 < 0.02 弧度）等于清除筛选，避免卡在选不掉的选中态。选中的时间窗经由**和坐标轴同一套秩映射**反解（`timeAtAngle()`），所以「弧画在哪」和「谁变亮」不可能对不上。
- **光点与中心之间不再有装饰性螺旋线**。之前那层曲线不编码任何数据，容易被误读成「对话轮次轨迹」，所以移除了；要看真实轮次轨迹请用「漂移轮次」Tab。
- **光点大小** = 该目标的轮次数（取对数，防止单个长会话压掉其他点）。
- **数值标签**：只有严重档（亮金）常驻标数值，其余光点悬停才显示，保证全图规则统一。
- **悬停** = 目标原文、轮次、调用数、失败数。

纯装饰元素（光尘、核心光晕、核心周围的轨道弧、光点周围的喷溅）与语义层（半径 / 角度 / 连线 / 环标签）在代码里是分开的：装饰集中在 `drawField()`，几何布局在 `layoutPoints()`，改观感不碰布局。**连线与环标签属于语义层，不是装饰**。

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
lib/index.js          宿主半侧：HTTP 路由 + 缓存 + 配置读写 + agent 作用域的纠正注入
lib/client.js         客户端半侧：设置页 UI + 漂移场 Canvas 渲染
src/session-reader.js 会话日志解析（zstd 帧拆分、目标/轮次抽取）
src/failure-cluster.js 失败聚类（错误签名归一 + 分类）
src/embed-config.js   embedding 配置校验 / 预设 / 持久化形状
src/distance.js       embedding 打分（余弦距离）+ 连通性探测
src/correction.js     漂移纠正：滞后判定、冷却、实时打分（LiveScorer）、提示文本生成
test/smoke.mjs        冒烟测试：解析 + 聚类，跑真实会话，不需要 DSH 运行
test/client-render.mjs 渲染测试：在 jsdom + 真 React 里挂载设置页组件，断言每个标签页都画出内容
test/correction.mjs   纠正决策逻辑 + 动态配置路由，离线
test/correction-wiring.mjs 接线测试：用形状一致的假 ctx 驱动 apply()，验证纠正文本真的到达提示词
test/render-field.mjs 把漂移场渲染成 PNG，用真实 snapshot 数据
test/full.mjs         全链路：解析 → 聚类 → 真实 embedding 调用
```

### 五个必须知道的实现陷阱

写这个插件时踩到、并已在代码里注释说明的：

1. **会话日志是数千个独立 zstd 帧的串联**。单次 `zstdDecompress` 只返回第一帧（会话头），静默丢掉整个对话。必须按 magic bytes `28 B5 2F FD` 拆帧逐个解。实测 4MB 日志 → 2857 帧 / 13MB JSONL。

2. **失败在 `data.error`，不在 `data.ok`**。`tool/result` 事件带 `data.message` 和一个可选的兄弟字段 `data.error`，没有布尔 `ok`。检查 `ok` 会让每个会话都报告 0 失败 —— 这个 bug 在本项目里真实发生过一次，修复后从 0 变成 81。

3. **`h` 必须是 `React.createElement`，不能是 `react/jsx-runtime` 的 `jsx`**。`jsx(type, props, key)` 的第三个参数是 **key**，不是子节点；而本项目所有调用点都按 `createElement(type, props, ...children)` 变参传子节点。绑错了不会报错、不会告警、宿主日志干净，**设置页只会画出一个空壳** —— 目录里能看到「目标台账」，点进去一片空白。这个 bug 也真实发生过一次，`test/client-render.mjs` 就是为它加的回归测试。

4. **`ctx.systemPrompt.section()` 的 `text()` 拿不到会话身份**。它是个无参 thunk，全局注册时无法知道这次组装是给哪个会话的 —— 只能靠「猜」哪个 pending 最可能，多会话并发时必然错。正确做法是把 section 注册到 **`agent.ctx`（agent 作用域）**，每个 agent 各注册一份，闭包里直接捕获 `sessionId`，销毁时自动解绑。这也正是 agent preset 用的同一个接缝。

5. **DSH 的服务是属性访问，事件 payload 是对象**。写宿主接线时想当然地用了 `ctx.get('agents')` 和 `agents.on('agent/created', agent => …)` —— 两个都是错的：Cordis 里服务挂在 `ctx.agents` / `agent.ctx.systemPrompt` 上（`ctx.get` 在整个 DSH 代码库里不存在），而 `agent/created` 的 payload 是 `{ agent, source }`，`agent/disposed` 是 `{ agent }`。错的结果是**整条纠正链路静默不挂载**：不抛异常、不打日志，功能就是不生效。`test/correction-wiring.mjs` 用形状一致的假 ctx 驱动 `apply()`，把这两处各自注入回去验证过，测试都会红。

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
| GET | `/correction` | 漂移纠正配置 + 各会话的实时状态 |
| PUT | `/correction` | `{enabled?, threshold?, minStreak?, cooldownTurns?, windowSize?}` |

## 开发

```bash
npm install                  # 装 devDependencies（react / react-dom / jsdom）
npm run test:render          # 渲染回归测试，离线，不需要 DSH 运行
npm run test:correction      # 纠正逻辑 + 动态配置路由，离线
npm run test:manifest        # 用 DSH 自己的校验器验证 manifest 与 market-index
npm test                     # 冒烟测试，直接跑真实会话
npm run test:full            # 全链路（会真实调用 embedding API）
npm run check                # 全部文件语法检查
```

改了 `lib/client.js` 之后**务必跑 `npm run test:render`**：宿主路由 200、语法检查通过、界面依然可能是空白，只有真正挂载组件才能发现。这个测试同时验证 Canvas 真的画了东西（jsdom 没有 2D context，测试装了记录型 stub）、悬停能命中光点、向量模型表单的编辑→测试→保存链路，以及纠正面板的开关→保存链路。

想单看漂移场效果，可以把它渲染成 PNG：

```bash
npm install --no-save @napi-rs/canvas
npm run test:render-field    # 读真实 snapshot.json，输出 drift-field.png
```

### 发布新版本

### 发布新版本

顺序很重要：**先提交、再打 tag、最后发布**。反过来的话，npm 上的内容和 tag 指向的代码会对不上，而这件事没有任何工具会报错——`test/published-matches-tag.mjs` 就是为它写的。

`market-index.json` 随包发布，所以索引里记的版本号与 manifest 的版本号必须是同一个事实的两次记录。

```bash
# 1. 同步升版本（package.json 与 market-index.json 一起改，避免只改一处）
node scripts/bump-version.cjs 0.2.3

# 2. 更新 README 里的索引地址（用户要从这里复制）
#    https://unpkg.com/dsh-goal-ledger@0.2.3/market-index.json

# 3. 校验，并跑一遍全量测试
npm run test:manifest
npm test && npm run test:correction && npm run test:render

# 4. 提交，打 tag（与 package.json 版本一致，带 v 前缀）
git add -A && git commit -m "release: v0.2.3"
git tag -a v0.2.3 -m "dsh-goal-ledger v0.2.3"
git push origin master --follow-tags

# 5. 发布，然后断言 npm 上的内容就是 tag 里的内容
npm publish --registry=https://registry.npmjs.org --access public
npm run test:published -- 0.2.3 v0.2.3

# 6. 等 unpkg 同步后确认索引可读（正常 1-5 分钟）
npm run test:published -- 0.2.3 v0.2.3   # 再跑一次即为复查
curl -sS -o /dev/null -w "%{http_code}\n" https://unpkg.com/dsh-goal-ledger@0.2.3/market-index.json
```

`test:published` 会把 npm 上的 tarball 解开，逐文件与 tag 里的 git 内容比对，并核对 `version` / `engines` / `dsh` / `exports` / `files` 字段。**这是「npm 发布的就是这个 tag」的唯一硬证据**。

**索引地址必须带精确版本号**：`unpkg.com/dsh-goal-ledger/market-index.json` 会 302 重定向到最新版，而 DSH 市场**拒绝重定向**（文档明确写「Redirects refused」），所以只能写 `@0.2.3` 这种精确地址。

### 为什么不在 GitHub raw 上托管索引

实测本机访问 `raw.githubusercontent.com` **全部被重置**（curl 与 node 都 `ECONNRESET`，3/3 失败），而同一时刻 `github.com`、`api.github.com`、`npmjs.org`、`unpkg.com` 都正常。索引地址是用户手动配置的，必须给一个真的打得开的——所以索引随 npm 包走 unpkg。

### 测试里两个 jsdom 坑（都真实踩过）

1. **`react-dom` 必须在 jsdom 全局就位之后再 `require`**。它在模块初始化时就固化 `canUseDOM`；提前加载会让它判定「没有 DOM」，整套事件系统都不装，之后合成的 `input` 事件**永远到不了 `onChange`** —— 表现和「受控输入框坏了」一模一样，但插件代码其实是对的。
2. **`act()` 要 await**。`act(() => {...})` 返回 thenable，不 await 会把 React 的 act 队列弄脏，后面的事件派发就静默失效。

安装到 profile 后，改动同步到 `~/.dsh/profiles/desktop/node_modules/dsh-goal-ledger/`（`file:` 依赖装的是副本，不是软链），然后刷新页面；页面没换新代码就重启 DSH 桌面端。

## License

MIT
