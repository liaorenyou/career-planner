# 生涯规划 · @local/career-planner

一个 DSH 插件：把你的**课表、作业、考试、实习/考研信息、聊天记录**变成**每天照着做就行的计划**，
以升学就业为导向，早八点自动推到手机，并且把「你是谁、想干什么、手上有什么」变成助手每轮都记得的长期记忆。

```
聊天（QQ/微信）／截图文字／面板
        │  理解成结构化任务
        ▼
   ~/.dsh/career-planner/  ← 长期记忆（资料 / 任务 / 情报 / 计划）
        │  纯规则排程（确定性、秒级、不花钱）
        ▼
   今天的计划 → 面板可视化 + 早 08:00 推送 QQ/微信
```

## 它解决什么

- **抓取**：课程表、老师群里发的作业、自己在对话里说的截止时间，都能被理解成任务落进本地库。
- **解读**：任务按「截止压力 × 升学就业目标 × 精力曲线」打分，而不是先到先排。
- **安排**：每次生成都保证——固定课程先占位、截止近的优先、最高优先级目标至少拿 25% 可用时间、
  每周至少 3 个实践/输出块、超过 50 分钟的块之间留 5–10 分钟缓冲、周日加一个复盘块。
  `capacity` 指**当天可自由安排的时间**（默认 180 分钟，可改）：上课和固定训练只占时间轴、
  不占这份预算，所以课多的日子也不会被判成「超载」，计划里照样给你留主线推进块。
- **具体到动作**：计划块不会只写「推进保研」这种空话。目标可带 `nextActions`（每天轮换一条当主线块标题），
  任务可带 `breakdown`（按步骤逐块排，块标题就是那一步，勾块会同步勾步骤）。
  例：`10:45-11:15 高数：第1–2章极限与导数，把课后题做到 2.3 并整理错题（第 1/8 步）`。
- **每日要闻**：每天推送前自动联网抓 2–3 条 AI/科技类大新闻，附在任务列表下面（`career_brief` 可手动取）。
- **记忆**：身份/目标/资源/任务/今日计划会作为一段上下文注入**每一次**模型请求，
  所以换会话、隔几天再来，助手仍然知道你大三、在考研、下周三有高数作业。
- **联网**：`career_research` 走宿主自带的 web 服务检索院校/分数线/招聘要求，存进情报库，
  下次排计划时可以据此生成动作。
- **推送**：每天 `08:00`（可改）自动生成并推送；电脑中午才开机也会在 3 小时内补推一次。
- **回执**：日报里每条都有序号，你在 QQ/微信里回「完成 2」「1 做完了」就能勾掉对应时间块
  （`career_done`），任务会跟着联动完成。
- **课表一次录完**：`career_tasks_add` 的 `repeatWeeks`（1–20）会把「每周同一时段」的课
  一次展开成 N 周的具体日期任务，排程时每天各自命中当周那一天。

## 装法

```bash
# 在 DSH 的插件管理里安装本目录（本地 link 安装）
# 或者用 CLI：
dsh plugin add ~/career-planner
```

装完刷新一次页面（`Cmd+R`），左侧栏多一个「生涯规划」图标，点开就是面板；
中间的对话区不受影响，切回来点会话图标即可。

## 怎么用（对话里）

直接说话就行，助手会自动调用工具：

| 你说 | 发生什么 |
|---|---|
| 「我这学期课表是：周一 8:00-9:40 高数、周三 14:00 英语…」 | `career_tasks_add` 写入固定时段 |
| 「老师布置了第三章习题，下周三前交」 | 落库为带截止时间的作业，并按优先级参与排程 |
| 「我大三，计算机，想考研，目标 2027 年某 985」 | `career_profile_set` 写身份+目标 |
| 「我今天要干什么」 | `career_get` 读今日计划，直接回答 |
| 「现在考研形势怎么样 / 这个岗位要求什么」 | `career_research` 联网检索并存情报 |
| 「把这个作业标成做完了」 | `career_task_update` 改状态 |
| 「重新安排一下，今天只有上午有空」 | `career_plan_generate` 重排 |
| 「完成 2」/「第一个做完了」 | `career_done` 按日报序号勾掉时间块 |
| 「这学期周一 8:00-9:40 高数，排 16 周」 | `career_tasks_add` + `repeatWeeks: 16` 一次展开整学期 |
| 「今天 AI 又有什么大新闻」 | `career_brief` 联网抓今日要闻（也会随早报推送） |
| 「把 XX 群也读一下 / 这个群不用看了」 | `career_groups` 管理要读的 QQ 群白名单 |

也可以让助手读最近的聊天：`career_chat_scan`（读本机 IM 桥接插件的入站消息），
它会把聊天里的作业、课程变更、招聘信息识别出来再落库。

更完整的一路是读 QQ 本地聊天库：`career_chat_import` 会先解密本机 `nt_msg.db`（QQ NT 的 SQLCipher 库），
再按 `career_groups` 的白名单只读你指定的群，抽出像任务的候选（默认只给候选；`apply: true` 才按
「置信度 ≥ 0.85 且 7 天内截止」保守落库），并自动按你的关注口径过滤诗歌/征文/球赛这类无关活动。
解密钥匙是一次性从 QQ 进程里取的，放在 `~/.dsh/career-planner/qq/dbkey.txt`（600 权限），说明见 `SECURITY.md`。

## 面板

- 顶部：日期、今日重点、容量进度（已排 / 上限分钟）、`重新生成`、`立即推送`、推送时间设置。
- 时间轴：每块显示时段、标题、类型徽标、为什么排它、完成标准，点一下勾选完成。
- 下方：待办任务（可勾选）、升学就业目标（带倒计时）、联网情报、推送状态。

## 换成你自己的（所有个人信息都是可替换的）

仓库里**没有任何人的真实身份、学校、群号、机器人凭据或聊天内容**——这些都在运行时数据里，
换成你自己的方式如下：

| 要替换的东西 | 放哪 / 怎么改 | 示例 |
|---|---|---|
| 时区、推送时刻、通道、数据目录 | `cordis.patch.yml` 的 `config`（`timeZone` / `pushTime` / `channels` / `dataDir`），或面板里的推送设置 | `timeZone: 'Asia/Shanghai'` |
| 每日要闻的检索方向 | `config.briefQueries`（不填用默认的科技/AI 三条） | `briefQueries: ['考研 政策 变化']` |
| 你的身份 / 目标 / 时间约束 | `career_profile_set` 工具（推荐），或照 `examples/profile.example.json` 手写 `profile.json` | `school: 'YOUR_SCHOOL'` |
| 要读的 QQ 群 | `career_groups` 工具增删（`groups.json`），或照 `examples/groups.example.json` 手写 | `code: 100000001` |
| 机器人凭据（QQ/微信） | 由 DSH 的 IM 桥接插件管理（`im-bridge/bot` 凭据记录、`~/.dsh/im-bridge-weixin.json`），本插件只读不写 | 不要把 AppID/Secret 提交进仓库 |
| QQ 库解密钥匙 | 本机自己跑 `python3 tools/extract_key.py` 取到 `qq/dbkey.txt`（600 权限），`qq/` 整个目录已进 `.gitignore` | — |

`examples/` 下两个文件就是占位模板：复制改名后把 `YOUR_*`、`1000000xx` 换成你自己的即可。

## 数据文件（都是普通 JSON，可自己备份/手改）

```
~/.dsh/career-planner/
├── profile.json      身份 / 目标 / 时间约束 / 已有资源
├── tasks.json        任务库（含指纹去重、子步骤）
├── intel.json        联网情报
├── push.json         推送开关、时刻、通道、上次结果
├── plans/YYYY-MM-DD.json   每天的计划（勾选状态也在这）
├── groups.json       要读的 QQ 群白名单（可增删）
├── qq/               QQ 库副本与解密钥匙（dbkey.txt，600 权限）
├── state.json        面板/扫描的元信息
└── outbox/           本地留档通道写出的日报文本
```

## 推送通道

- **QQ**：读 DSH 凭据记录 `im-bridge/bot` 里的 `QQ_BOT_APPID` / `QQ_BOT_SECRET`，
  openid 从 IM 桥接插件的状态日志里学（用户先给机器人发一条消息即可）。
- **微信**：读 `~/.dsh/im-bridge-weixin.json` 的令牌调用 iLink。**该令牌经常过期**
  （errcode -14 session timeout），过期时这一通道会在推送结果里如实报失败，不影响 QQ 和本地留档。
- **本地**：`outbox/` 下写一份日报，作为排障兜底。

### 8 点推送的两条腿

1. **DSH 进程内的定时器**（主）：插件自己算下一次 08:00（`Asia/Shanghai`），到点生成日报并推送；
   电脑中午才开机时，只要距 08:00 不超过 3 小时就补推一次。
2. **launchd 兜底**（备）：DSH 没开着的时候由 macOS 在 **08:02** 拉起 `bin/push-cron.mjs`
   （错开 2 分钟，避免两个调度器同分钟抢着推，两边都查 `lastPushAt` 保证一天只推一次）。

```bash
./launchd/install.sh              # 装兜底任务（已装，重复跑是幂等的）
./launchd/install.sh --uninstall  # 不想要就卸掉
node bin/push-cron.mjs --dry      # 只看会推什么，不真发
node bin/push-cron.mjs --force    # 立刻真发一次（自检通道）
tail -n 5 ~/.dsh/career-planner/push-cron.log
```

> launchd 按系统本地时区触发；系统时区不是 `Asia/Shanghai` 时请改 plist 或系统时区。

推送失败会在 `push.json.lastResult` 和面板里显示具体原因（凭据失效 / 频率限制 / 没绑微信），
不会谎报成功。

## 排障

- 面板显示「宿主接口不可达」：插件没激活或宿主版本过旧（需要 `webServer` 服务）。
- 面板能开但没推送：看 `push.json.lastResult`；QQ 通道需要用户先给机器人发过消息（才拿得到 openid）。
- 想看插件日志：`GET /career-planner/api/health` 返回最近的内部事件环和当前记忆段，
  以及 `~/.dsh/career-planner/debug.log`（含 `ready` / `scheduler-armed` / `pushed` 等事件）。
- 8 点没收到：先看 `launchctl print gui/$(id -u)/com.local.career-planner.push` 的
  `next fire`，再看 `push-cron.log` 最后一行；DSH 开着的话则由进程内定时器负责，
  见 `debug.log` 里的 `scheduler-armed`。

## 开发自测

```bash
node --test test/*.mjs    # 排程引擎 / 推送纯函数 / 聊天日志解析 / 宿主整体自检
node --check index.js && node --check client.js
```

`test/host.test.mjs` 会用假的 Cordis ctx 把整插件跑一遍：工具注册、落库、生成计划、
系统提示词记忆、HTTP 接口、定时器排程都在里面断言。
