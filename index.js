/**
 * @local/career-planner —— 升学就业导向的每日计划插件（Host 侧）
 *
 * 它做的事（一句话）：把「课程表 / 作业 / 聊天里提到的待办」收进本地库，
 * 按升学就业的目标排出每天的计划，早八点通过 QQ / 微信推给用户，
 * 并在 Web 面板里可视化；同时把用户的现状当作长期记忆注入每一轮对话。
 *
 * ── 各模块边界（都是本包内的相对路径）──────────────────────────────
 *   lib/store.js     磁盘数据层（profile/tasks/intel/push/plans），原子写 + 时区工具
 *   lib/planner.js   纯函数排程引擎（planDay），无 IO
 *   lib/push.js      推送适配器（QQ 官方主动消息 / 微信 iLink / 本地落盘）+ 日报文案
 *   lib/imsource.js  读 im-bridge 的本地痕迹（QQ openid、入站聊天记录）
 *   client.js        前端面板（sidebar.panellist + main 配对注册）
 *
 * ── 设计取舍 ───────────────────────────────────────────────────
 *  1. **不硬注入 webServer / systemPrompt / credentials / web / timer**：
 *     Cordis 4.0.5+ 对未注入的服务属性是 fail-closed 的（访问直接 throw），
 *     而硬写进 inject 又会让整包在缺服务时永远停在等待态。所以统一用 soft()
 *     探测，缺哪个就少哪个功能，插件本体照常激活。
 *  2. **每日计划由纯函数生成，不经过 LLM**：早八点没人值守，LLM 可能超时/花钱；
 *     排程规则是确定性的，稳定可复现。LLM 负责的是“理解”——把聊天记录/课表
 *     理解成结构化任务（通过 career_* 工具写库），交给纯函数去排。
 *  3. 数据放 `~/.dsh/career-planner/`，和 im-bridge 的约定一致，用户可以自己看/备份。
 */
import { join } from 'node:path';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import * as store from './lib/store.js';
import { planDay } from './lib/planner.js';
import { formatPlanMessage, planDisplayIndex, pushAll } from './lib/push.js';
import { defaultPaths as imPaths, readStatusLog, readImBridgeMessages } from './lib/imsource.js';

// 行 id 与 cordis.patch.yml 对齐；改名会让已存的配置失效。
export const name = 'career-planner';

// tools 是硬依赖：没有工具服务就没有 agent 入口，插件等于没用。
// 其余服务一律 soft() 探测（见文件头第 1 条）。
export const inject = ['tools'];

/**
 * 配置 schema —— Cordis 走 Standard Schema 的 `~standard.validate`，
 * 所以必须手写这一个极小的对象（**不要** import zod：DSH 是打包安装的，
 * asar 里的路径不稳定，社区插件踩过这个坑）。
 */
const ConfigSchema = {
  '~standard': {
    version: 1,
    vendor: 'career-planner',
    validate(value) {
      const input = value !== null && typeof value === 'object' ? value : {};
      const issues = [];
      const isStr = (v) => typeof v === 'string';
      if (input.timeZone !== undefined && !isStr(input.timeZone)) issues.push({ message: 'timeZone 必须是字符串' });
      if (input.pushTime !== undefined && !isStr(input.pushTime)) issues.push({ message: 'pushTime 必须是字符串 HH:MM' });
      if (input.dataDir !== undefined && !isStr(input.dataDir)) issues.push({ message: 'dataDir 必须是字符串' });
      if (input.channels !== undefined && !Array.isArray(input.channels)) issues.push({ message: 'channels 必须是数组' });
      if (issues.length > 0) return { issues };
      const channels = Array.isArray(input.channels)
        ? input.channels.map((c) => String(c)).filter((c) => c === 'qq' || c === 'wechat' || c === 'file')
        : ['qq', 'wechat'];
      return {
        value: {
          timeZone: isStr(input.timeZone) && input.timeZone.trim() ? input.timeZone.trim() : store.DEFAULT_TZ,
          pushTime: store.parseHHMM(input.pushTime) || store.DEFAULT_PUSH_TIME,
          channels: channels.length ? channels : ['qq', 'wechat'],
          dataDir: isStr(input.dataDir) ? input.dataDir.trim() : '',
        },
      };
    },
  },
};

export const Config = ConfigSchema;

const DAY_MS = 86400000;

/** json-schema 片段：工具参数的公共写法 */
const SCHEMA_STRING = { type: 'string' };
const SCHEMA_STRING_ARRAY = { type: 'array', items: SCHEMA_STRING };

export function apply(ctx, config = {}) {
  // ---------------------------------------------------------------- 服务探测
  //
  // ⚠ 必须先读 `ctx.xxx` 再退回 `ctx.get('xxx')`：cordis 的 ctx 代理会把服务方法
  //   绑到正确的 this 上，裸实例上直接调方法有丢 this 的风险；而访问未注入的属性
  //   在 cordis 4.0.5+ 会抛错，所以两处都要 try/catch。
  const soft = (key) => {
    try {
      const value = ctx[key];
      if (value !== undefined) return value;
    } catch {
      /* 未注入：视为不存在 */
    }
    try {
      return typeof ctx.get === 'function' ? ctx.get(key) : undefined;
    } catch {
      return undefined;
    }
  };
  const methodOf = (service, method) => (
    service && typeof service[method] === 'function' ? service[method].bind(service) : null
  );

  const tools = soft('tools');
  const webServer = soft('webServer');
  const systemPrompt = soft('systemPrompt');
  const credentials = soft('credentials');
  const web = soft('web');

  const registerTool = methodOf(tools, 'register');

  // ---------------------------------------------------------------- 配置与路径
  const cfg = (() => {
    const validated = ConfigSchema['~standard'].validate(config);
    return validated && 'value' in validated ? validated.value : { timeZone: store.DEFAULT_TZ, pushTime: store.DEFAULT_PUSH_TIME, channels: ['qq', 'wechat'], dataDir: '' };
  })();

  const p = store.paths(cfg.dataDir);

  // ---------------------------------------------------------------- QQ 群白名单与本地聊天记录
  //
  // 官方机器人接口读不到普通群（只会收到「@机器人」那条），所以读群消息走「本机 QQ 库」这条路：
  //   qq/nt_msg.db 副本 --(lib/ntdb.js, 16 字节密钥)--> 明文 SQLite --(lib/chatlog.js)--> 候选任务
  // 白名单存 groups.json，用户随时可增删（career_groups 工具 / 面板）。
  // 密钥由 tools/extract_key.py 一次性从 QQ 进程内存里取，之后不再需要 QQ 重签。
  const groupsPath = join(p.base, 'groups.json');
  const qqDir = join(p.base, 'qq');
  const qqKeyPath = join(qqDir, 'dbkey.txt');
  let groupsCache = null;

  async function loadGroups() {
    if (groupsCache) return groupsCache;
    const raw = await store.readJson(groupsPath, []);
    groupsCache = Array.isArray(raw)
      ? raw
        .filter((g) => g && Number.isFinite(Number(g.code)) && String(g.name || '').trim())
        .map((g) => ({
          code: Number(g.code),
          name: String(g.name).trim(),
          enabled: g.enabled !== false,
          addedAt: typeof g.addedAt === 'string' ? g.addedAt : '',
        }))
      : [];
    return groupsCache;
  }

  async function saveGroups(next) {
    groupsCache = next;
    await store.writeJson(groupsPath, next);
    refreshDigest();
    return next;
  }

  /** 找本机 QQ 的 nt_db 目录（容器 / 非容器两种安装位置都看；没有 FDA 权限会自动跳过） */
  function liveQQDbDirs() {
    const home = process.env.HOME || '';
    if (!home) return [];
    const roots = [
      join(home, 'Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ'),
      join(home, 'Library/Application Support/QQ'),
    ];
    const out = [];
    for (const root of roots) {
      try {
        if (!existsSync(root)) continue;
        for (const entry of readdirSync(root)) {
          if (!entry.startsWith('nt_qq_')) continue;
          const dir = join(root, entry, 'nt_db');
          if (existsSync(join(dir, 'nt_msg.db'))) out.push({ dir, at: statSync(join(dir, 'nt_msg.db')).mtimeMs });
        }
      } catch {
        /* 没权限就跳过 */
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /**
   * 把本机最新的 QQ 库复制一份到插件目录（用户可能不给插件读容器的权限，
   * 也可能 QQ 正在写；复制失败就退回上一次的副本）。
   */
  async function refreshQQCopies() {
    const dirs = liveQQDbDirs();
    if (!dirs.length) return { ok: false, copied: false, message: '没找到本机 QQ 的 nt_db（可能没装 QQ，或没给完全磁盘访问权限）' };
    const src = dirs[0].dir;
    const names = ['nt_msg.db', 'nt_msg.db-wal', 'group_info.db'];
    try {
      mkdirSync(qqDir, { recursive: true });
      let copied = 0;
      for (const name of names) {
        const from = join(src, name);
        if (!existsSync(from)) continue;
        const to = join(qqDir, name);
        const fresh = !existsSync(to) || statSync(from).mtimeMs > statSync(to).mtimeMs;
        if (!fresh) continue;
        copyFileSync(from, to);
        copied += 1;
      }
      return { ok: true, copied: copied > 0, source: src, message: copied ? `已刷新 ${copied} 个库文件` : '副本已是最新' };
    } catch (error) {
      return { ok: false, copied: false, message: `复制 QQ 库失败：${error.message}` };
    }
  }

  function qqHistoryStatus() {
    const db = join(qqDir, 'nt_msg.db');
    const key = existsSync(qqKeyPath);
    return {
      keyReady: key,
      dbReady: existsSync(db),
      dbPath: db,
      keyPath: qqKeyPath,
      liveDirs: liveQQDbDirs().length,
      hint: key
        ? (existsSync(db) ? '' : '缺少库副本：跑一次 career_chat_import（会自动刷新）')
        : '缺少密钥：需要跑一次 tools/extract_key.py（见 README「读 QQ 群记录」）',
    };
  }

  // 日志：写内存环 + 追加到 debug.log（桌面端 stdout 不落盘，出问题只有这个文件能查）
  const logRing = [];
  const debugLogPath = join(p.base, 'debug.log');
  let debugLogBytes = 0;
  function log(event, detail) {
    const entry = { at: new Date().toISOString(), event, ...(detail === undefined ? {} : { detail: normalizeLogDetail(detail) }) };
    logRing.push(entry);
    if (logRing.length > 80) logRing.shift();
    if (event.endsWith('-failed') || event.endsWith('-error')) {
      console.error(`[career-planner] ${event}: ${entry.detail?.error || entry.detail?.message || ''}`);
    }
    appendDebugLine(entry);
    return entry;
  }
  function appendDebugLine(entry) {
    // 只做尽力而为：日志失败绝不影响主流程；超过 2MB 就重开一个文件，避免无限增长
    try {
      mkdirSync(p.base, { recursive: true });
      const line = `${JSON.stringify(entry)}\n`;
      if (debugLogBytes > 2 * 1024 * 1024) {
        writeFileSync(debugLogPath, '');
        debugLogBytes = 0;
      }
      appendFileSync(debugLogPath, line);
      debugLogBytes += Buffer.byteLength(line);
    } catch {
      /* 忽略：日志不是功能 */
    }
  }
  function normalizeLogDetail(detail) {
    if (detail instanceof Error) return { error: detail.message, stack: String(detail.stack || '').split('\n').slice(0, 3).join(' | ') };
    if (typeof detail === 'object' && detail !== null) {
      const out = {};
      for (const [k, v] of Object.entries(detail)) out[k] = v instanceof Error ? v.message : v;
      return out;
    }
    return detail;
  }

  // ---------------------------------------------------------------- 内存缓存 + 串行写锁
  //
  // 插件被“agent 工具调用 / HTTP 面板 / 定时器”三条路并发访问同一批 JSON，
  // 所以所有写操作串行化；读走内存副本，写成功后原地更新副本。
  let data = null;
  let loadPromise = null;
  let digest = '';
  let meta = { lastScanAt: '', lastScanCount: 0, lastPushText: '', lastPushDate: '', lastPushIndex: [], lastChatImportAt: '', lastChatImportCount: 0 };
  let writeChain = Promise.resolve();

  function withLock(fn) {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function ensureData() {
    if (data) return data;
    if (!loadPromise) {
      loadPromise = (async () => {
        const loaded = await store.loadAll(p, { timeZone: cfg.timeZone, recentPlans: 10 });
        const savedMeta = await store.readJson(p.state, null);
        if (savedMeta && typeof savedMeta === 'object') {
          meta = {
            lastScanAt: typeof savedMeta.lastScanAt === 'string' ? savedMeta.lastScanAt : '',
            lastScanCount: Number(savedMeta.lastScanCount) || 0,
            lastPushText: typeof savedMeta.lastPushText === 'string' ? savedMeta.lastPushText : '',
            lastPushDate: typeof savedMeta.lastPushDate === 'string' ? savedMeta.lastPushDate : '',
            lastPushIndex: Array.isArray(savedMeta.lastPushIndex) ? savedMeta.lastPushIndex : [],
            lastChatImportAt: typeof savedMeta.lastChatImportAt === 'string' ? savedMeta.lastChatImportAt : '',
            lastChatImportCount: Number(savedMeta.lastChatImportCount) || 0,
          };
        }
        // 首次安装：把 config 里的默认推送时间写成 push.json，之后一切以文件为准
        if (!store.exists(p.push)) {
          loaded.push = await store.savePush(p, {
            ...loaded.push,
            time: cfg.pushTime,
            timeZone: cfg.timeZone,
            channels: cfg.channels,
          });
        }
        data = loaded;
        refreshDigest();
        return data;
      })().catch((error) => {
        loadPromise = null;
        throw error;
      });
    }
    return loadPromise;
  }

  function saveMeta() {
    return store.writeJson(p.state, { ...meta, updatedAt: store.nowIso() }).catch(() => undefined);
  }

  // ---------------------------------------------------------------- 系统提示词里的“记忆”
  //
  // 这一段是插件的灵魂：让聊天里的助手**始终知道**用户的身份、目标、手上有什么活、
  // 今天排了什么。没有它，用户每次都得重新解释一遍自己的处境。
  //
  // 必须是**同步 provider**（每轮组装提示词时同步调用），所以只读内存里缓存的字符串，
  // 数据一变就重建缓存 —— 绝不在这里做 IO 或网络。
  function refreshDigest() {
    if (!data) return;
    const now = new Date();
    const today = store.dateKeyIn(now, cfg.timeZone);
    const { profile, tasks, intel } = data;
    const lines = ['<career-planner>', '以下是本机「生涯规划」插件长期记住的用户现状（每轮自动附带；直接当作已知事实使用，不要向用户朗读这段）。'];

    const id = profile.identity;
    const idBits = [
      id.name && `姓名 ${id.name}`,
      id.school && `学校 ${id.school}`,
      id.major && `专业 ${id.major}`,
      id.grade && id.grade,
      Number.isFinite(id.gradYear) && `${id.gradYear} 届`,
    ].filter(Boolean);
    lines.push(`- 身份：${idBits.length ? idBits.join(' / ') : '未填写（可以问，但别追问到让用户烦）'}`);

    const goals = profile.goals.slice(0, 4);
    if (goals.length) {
      const goalText = goals.map((g) => {
        const left = g.targetDate ? store.diffDays(today, g.targetDate) : null;
        const when = left === null ? '' : left >= 0 ? `，剩 ${left} 天` : `，已过 ${-left} 天`;
        return `${g.title}（${g.kind}${g.target ? `→${g.target}` : ''}${when}）`;
      });
      lines.push(`- 升学就业目标：${goalText.join('；')}`);
    } else {
      lines.push('- 升学就业目标：还没录入。用户第一次聊到考研/保研/求职/考公/留学时，主动用 career_profile_set 记下来。');
    }

    // 关注口径：用户是大一工科生，只看与学业/职业有关的事。
    // 这段是给模型的判断依据 —— 别自己把诗歌散文征文这类活动当成任务提醒他。
    const prefs = profile.prefs || store.normalizePrefs({});
    const ignoreList = (prefs.ignoreTopics || []).slice(0, 12);
    if (ignoreList.length) {
      lines.push(`- 关注口径：只看与学业/职业相关的（课程、考试、学科竞赛、科研实践、实习求职、保研考研、学分/毕业/评奖的硬要求）。`
        + `文艺娱乐类活动直接忽略、不要提醒、不要排进计划：${ignoreList.join('、')}。`
        + '判断不确定时问一句，别默默塞进计划（用户可以用 career_profile_set 的 prefs 改这个口径）。');
    }
    if ((prefs.focusTopics || []).length) {
      lines.push(`- 额外关注：${prefs.focusTopics.slice(0, 8).join('、')}。`);
    }

    const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'skipped');
    const overdue = open.filter((t) => t.dueAt && new Date(t.dueAt).getTime() < now.getTime());
    if (open.length) {
      const urgent = [...open]
        .sort((a, b) => {
          const da = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
          const db = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
          return da - db || a.priority - b.priority || a.id.localeCompare(b.id);
        })
        .slice(0, 5)
        .map((t) => {
          const due = t.dueAt ? `，截止 ${store.humanDate(store.dateKeyIn(new Date(t.dueAt), cfg.timeZone))}` : '';
          return `${t.title}${due}`;
        });
      lines.push(`- 手上任务 ${open.length} 个${overdue.length ? `（${overdue.length} 个已逾期）` : ''}：${urgent.join('；')}`);
    } else {
      lines.push('- 手上任务：空。');
    }

    const plan = data.plans.find((x) => x.date === today) || null;
    if (plan) {
      const done = plan.blocks.filter((b) => b.done).length;
      lines.push(`- 今日计划（${today}）：${plan.theme ? `${plan.theme}，` : ''}${plan.blocks.length} 个块已完成 ${done} 个，计划 ${plan.totalMinutes} 分钟。`);
      // 把接下来 3 个未完成块直接列出来：用户问「今天干什么」时不必再查库就能直接答。
      const upcoming = plan.blocks
        .filter((b) => !b.done && b.kind !== 'buffer' && b.kind !== 'break')
        .slice(0, 3)
        .map((b) => `${b.start}-${b.end} ${b.title}`);
      if (upcoming.length) lines.push(`  接下来：${upcoming.join('；')}`);
    } else {
      lines.push(`- 今日计划（${today}）：尚未生成（用户问起可以用 career_plan_generate 生成）。`);
    }
    const pushInfo = data.push || {};
    const pushChannels = (pushInfo.channels || []).filter(Boolean);
    if (pushInfo.lastPushAt) {
      const tz = pushInfo.timeZone || cfg.timeZone;
      const lastLocal = (() => {
        const at = Date.parse(pushInfo.lastPushAt);
        if (!Number.isFinite(at)) return String(pushInfo.lastPushAt).slice(0, 16);
        const wc = store.wallClock(new Date(at), tz);
        return `${wc.date} ${wc.time}`;
      })();
      lines.push(`- 每日推送：${pushInfo.time || '08:00'}（${tz}），通道 ${pushChannels.join('/') || '未设置'}；最近一次 ${lastLocal}（${tz}）。`);
    } else {
      lines.push(`- 每日推送：${pushInfo.time || '08:00'}（${pushInfo.timeZone || cfg.timeZone}），通道 ${pushChannels.join('/') || '未设置'}；还没推过。`);
    }

    if (profile.resources.length) {
      const titles = profile.resources.slice(0, 3).map((r) => r.title).filter(Boolean);
      lines.push(`- 已有资源 ${profile.resources.length} 条：${titles.join('、')}`);
    }
    if (intel.length) {
      const latest = intel[0];
      if (latest && latest.title) lines.push(`- 最近一条联网情报：${latest.title}`);
    }

    if (groupsCache && groupsCache.length) {
      const names = groupsCache.filter((g) => g.enabled !== false).map((g) => g.name).slice(0, 4);
      const status = qqHistoryStatus();
      lines.push(`- QQ 群记录：白名单 ${groupsCache.length} 个（${names.join('、')}${groupsCache.length > names.length ? ' 等' : ''}）；`
        + `${status.keyReady && status.dbReady ? '本地库可读' : `本地库不可读（${status.hint}）`}${meta.lastChatImportAt ? `；上次导入 ${String(meta.lastChatImportAt).slice(5, 16)}` : '；还没导入过'}。`
        + '有新群消息时用 career_chat_import 抽任务（用户问「群里有作业吗」也用它）。');
    }
    lines.push('- 你的职责：把用户提到的课程表/作业/考试/实习/科研/求职信息**先落库**（career_tasks_add、career_profile_set），再据此安排每日计划（career_plan_generate），需要时联网核实（career_research），日程变化就重排。用户问「今天干什么」直接答计划，不要反问。');
    lines.push('- 用户回「完成 2」「第 1 个做完了」「取消 3」时用 career_done（n 是日报里的显示序号）；改任务状态用 career_task_update；课程表这类每周固定的时段用 career_tasks_add + repeatWeeks。');
    lines.push('</career-planner>');
    digest = lines.join('\n');
  }

  const registerSection = methodOf(systemPrompt, 'section');
  const registerContext = methodOf(systemPrompt, 'context');

  if (registerContext) {
    ctx.effect(
      () => registerContext({ name: 'career-planner-memory', order: 60, text: () => digest, required: false }),
      'career-planner.memoryContext()',
    );
  } else if (registerSection) {
    // 老宿主没有 context()：退回 section()，语义上等价（都是每轮必带的一段）
    ctx.effect(
      () => registerSection({ name: 'career-planner-memory', order: 60, text: () => digest }),
      'career-planner.memorySection()',
    );
  } else {
    log('prompt-section-skipped', { reason: '拿不到 systemPrompt.context/section' });
  }

  // ---------------------------------------------------------------- 计划生成
  async function generatePlan({ date, reason = 'manual', hints = '' } = {}) {
    const d = await ensureData();
    const now = new Date();
    const target = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : store.dateKeyIn(now, cfg.timeZone);
    const previous = await store.readPlan(p, target);
    const plan = planDay({
      date: target,
      now,
      profile: d.profile,
      tasks: d.tasks,
      intel: d.intel,
      history: d.plans.filter((x) => x.date < target).slice(0, 7),
      seed: 0,
    });
    if (hints && typeof hints === 'string') {
      plan.warnings = [...(plan.warnings || []), `生成时的额外提示：${hints.slice(0, 200)}`];
    }
    // 勾选状态要跨“重排”保留：任务没变、时间块没变的项不该被重置成未完成。
    if (previous && Array.isArray(previous.blocks)) {
      const byId = new Map(previous.blocks.map((b) => [b.id, b]));
      const byKey = new Map(previous.blocks.map((b) => [blockKey(b), b]));
      for (const block of plan.blocks) {
        const old = byId.get(block.id) || byKey.get(blockKey(block));
        if (old && old.done === true) block.done = true;
      }
    }
    await store.savePlan(p, plan);
    d.plans = [plan, ...d.plans.filter((x) => x.date !== target)].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 10);
    refreshDigest();
    log('plan-generated', { date: target, reason, blocks: plan.blocks.length, minutes: plan.totalMinutes });
    return { plan, previous };
  }

  function blockKey(block) {
    const taskId = Array.isArray(block?.taskIds) && block.taskIds.length ? block.taskIds[0] : '';
    return `${block?.start || ''}|${taskId || block?.title || ''}`;
  }

  // ---------------------------------------------------------------- 推送
  async function readQQCredentials() {
    if (!credentials || typeof credentials.readRecord !== 'function') return null;
    try {
      const record = await credentials.readRecord('im-bridge/bot');
      if (!record) return null;
      // im-bridge 用 ApiKeyRecord 的 env 装两个平台字段
      const env = record.kind === 'api-key' && record.env && typeof record.env === 'object' ? record.env : null;
      const appId = String(env?.QQ_BOT_APPID || record.key || '').trim();
      const secret = String(env?.QQ_BOT_SECRET || '').trim();
      if (!appId || !secret) return null;
      return { appId, secret };
    } catch (error) {
      log('qq-credentials-failed', error);
      return null;
    }
  }

  async function readImTraces() {
    try {
      const traces = await readStatusLog({ path: imPaths().statusLog, limit: 400 });
      return traces;
    } catch (error) {
      log('im-trace-failed', error);
      return { entries: [], inbound: [], lastQQOpenid: null, lastWeixinOpenid: null };
    }
  }

  async function resolvePushTargets() {
    const d = await ensureData();
    const channels = Array.isArray(d.push.channels) ? d.push.channels : ['qq'];
    const traces = await readImTraces();
    const creds = await readQQCredentials();
    const openid = traces.lastQQOpenid || '';
    return {
      qq: {
        enabled: channels.includes('qq') && Boolean(openid) && Boolean(creds),
        openid,
        appId: creds?.appId || '',
        secret: creds?.secret || '',
      },
      wechat: {
        enabled: channels.includes('wechat'),
        tokenPath: imPaths().weixinToken,
      },
      file: { dir: join(p.base, 'outbox') },
    };
  }

  async function doPush({ plan, text, reason = 'manual' }) {
    const d = await ensureData();
    const now = new Date();
    const date = plan?.date || store.dateKeyIn(now, cfg.timeZone);
    const message = typeof text === 'string' && text.trim()
      ? text.trim()
      : formatPlanMessage({ plan, profile: d.profile, date });
    const targets = await resolvePushTargets();
    const results = await pushAll({ text: message, plan, targets });
    const byChannel = {};
    for (const r of results) byChannel[r.channel] = { ok: Boolean(r.ok), detail: String(r.detail || '').slice(0, 300) };
    d.push = await store.savePush(p, { ...d.push, lastPushAt: store.nowIso(), lastResult: byChannel });
    // 记住这次推送的「显示序号 → blockId」映射：用户按日报里的「完成 2」回复时，
    // 要从这里反查，否则编号跟 plan.blocks 的下标对不上（buffer/break 不展示）。
    const displayIndex = plan ? planDisplayIndex(plan) : [];
    meta.lastPushText = message;
    meta.lastPushDate = date;
    meta.lastPushIndex = displayIndex;
    await saveMeta();
    log('pushed', { reason, channels: Object.keys(byChannel), ok: results.filter((r) => r.ok).map((r) => r.channel) });
    return { results, text: message };
  }

  const okAny = (results) => Array.isArray(results) && results.some((r) => r.ok);

  // ---------------------------------------------------------------- 定时器
  function scheduleTimer(callback, delay) {
    const timer = soft('timer');
    if (timer && typeof timer.timeout === 'function') {
      try {
        const dispose = timer.timeout(callback, delay);
        return typeof dispose === 'function' ? dispose : () => undefined;
      } catch (error) {
        log('timer-service-failed', error);
      }
    }
    const handle = setTimeout(callback, delay);
    if (typeof handle.unref === 'function') handle.unref();
    return () => clearTimeout(handle);
  }

  async function fireDaily() {
    let plan = null;
    try {
      const generated = await withLock(() => generatePlan({ date: store.dateKeyIn(new Date(), cfg.timeZone), reason: 'daily' }));
      plan = generated.plan;
    } catch (error) {
      log('daily-plan-failed', error);
    }
    const d = await ensureData();
    if (!d.push.enabled) {
      log('daily-push-disabled', { time: d.push.time });
      return;
    }
    if (await pushAlreadyDoneToday()) {
      log('daily-push-skipped', { reason: 'already-pushed-today' });
      return;
    }
    try {
      const { results } = await withLock(() => doPush({ plan, reason: 'daily' }));
      if (!okAny(results)) log('daily-push-failed', { results });
    } catch (error) {
      log('daily-push-failed', error);
    }
  }

  // 每天到了 push.time 就触发一次；触发后重新计算下一次（不依赖固定 24h，抗系统休眠）
  ctx.effect(() => {
    let stopped = false;
    let dispose = null;
    const arm = async () => {
      if (stopped) return;
      try {
        const d = await ensureData();
        const time = store.parseHHMM(d.push?.time) || cfg.pushTime;
        const timeZone = d.push?.timeZone || cfg.timeZone;
        const next = store.nextDailyOccurrence(time, timeZone, new Date());
        const delay = Math.max(1000, Math.min(next.getTime() - Date.now(), 2 ** 31 - 1));
        dispose = scheduleTimer(() => {
          void (async () => {
            try {
              await fireDaily();
            } finally {
              void arm();
            }
          })();
        }, delay);
        log('scheduler-armed', { at: next.toISOString(), time, timeZone });
      } catch (error) {
        log('scheduler-failed', error);
        dispose = scheduleTimer(() => void arm(), 60000);
      }
    };
    void arm();
    return () => {
      stopped = true;
      try {
        dispose?.();
      } catch {
        /* ignore */
      }
    };
  }, 'career-planner.dailyPush()');

  // 启动自检：今天没计划就补生成；如果启动时已过推送时间、今天还没推过且离推送时间
  // 不超过 3 小时，补推一次（电脑中午才开机也能收到）。超过 3 小时就不再补，避免半夜被打扰。
  ctx.effect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await ensureData();
        if (cancelled) return;
        const now = new Date();
        const today = store.dateKeyIn(now, cfg.timeZone);
        const existing = d.plans.find((x) => x.date === today) || null;
        if (!existing) {
          await withLock(() => generatePlan({ date: today, reason: 'startup' }));
        }
        if (cancelled || !d.push.enabled) return;
        if (await pushAlreadyDoneToday()) return;
        const lastAt = d.push.lastPushAt ? store.dateKeyIn(new Date(d.push.lastPushAt), cfg.timeZone) : '';
        if (lastAt === today) return;
        const timeZone = d.push.timeZone || cfg.timeZone;
        const pushTime = store.parseHHMM(d.push.time) || cfg.pushTime;
        const nowMinutes = store.wallClock(now, timeZone).minutes;
        const pushMinutes = Number(pushTime.slice(0, 2)) * 60 + Number(pushTime.slice(3, 5));
        if (nowMinutes >= pushMinutes && nowMinutes - pushMinutes <= 180) {
          const plan = data?.plans.find((x) => x.date === today) || null;
          await withLock(() => doPush({ plan, reason: 'catch-up' }));
        }
      } catch (error) {
        log('startup-failed', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, 'career-planner.startup()');

  // ---------------------------------------------------------------- 任务 / 资料写入
  // 课程表是「每周同一时段」，但排程引擎按具体日期命中固定时段块。与其让引擎支持 recurrence，
  // 不如在写入时就把一条周课展开成 N 条不同日期的条目：引擎不用改，digest/查询也都是普通任务。
  function expandWeekly(tasks, repeatWeeks) {
    const weeks = Math.max(1, Math.min(20, Math.round(Number(repeatWeeks) || 1)));
    if (weeks <= 1) return tasks;
    const out = [];
    for (const task of tasks) {
      const startMs = task?.startAt ? Date.parse(task.startAt) : NaN;
      if (!Number.isFinite(startMs)) {
        // 没有固定时段的任务展开没有意义，原样保留
        out.push(task);
        continue;
      }
      const endMs = task?.endAt ? Date.parse(task.endAt) : NaN;
      const dueMs = task?.dueAt ? Date.parse(task.dueAt) : NaN;
      for (let w = 0; w < weeks; w += 1) {
        const shift = w * 7 * DAY_MS;
        out.push({
          ...task,
          // 周的序号写进标题太丑，用 notes 记，标题保持和用户课表一致
          notes: w === 0 ? task.notes : `${task.notes ? `${task.notes} ` : ''}（第 ${w + 1} 周）`.trim(),
          startAt: new Date(startMs + shift).toISOString(),
          ...(Number.isFinite(endMs) ? { endAt: new Date(endMs + shift).toISOString() } : {}),
          ...(Number.isFinite(dueMs) ? { dueAt: new Date(dueMs + shift).toISOString() } : {}),
        });
      }
    }
    return out;
  }

  function mergeIncomingTasks(incoming, { sourceType = 'agent', sourceRef = '' } = {}) {
    const d = data;
    const existing = d.tasks;
    const byFingerprint = new Map(existing.map((t) => [t.fingerprint, t]));
    const added = [];
    const merged = [];
    for (const raw of Array.isArray(incoming) ? incoming : []) {
      const task = store.normalizeTask({
        ...raw,
        source: raw?.source && typeof raw.source === 'object' ? raw.source : { type: sourceType, ref: sourceRef },
      });
      if (!task.title) continue;
      const hit = byFingerprint.get(task.fingerprint);
      if (hit) {
        // 同一条任务又出现：只补齐空字段，不覆盖用户已经改过的状态/时间
        if (hit.id !== task.id) {
          let changed = false;
          for (const key of ['course', 'dueAt', 'startAt', 'endAt', 'goalId', 'notes']) {
            if (!hit[key] && task[key]) {
              hit[key] = task[key];
              changed = true;
            }
          }
          if (task.estMinutes > hit.estMinutes && hit.status !== 'done') {
            hit.estMinutes = task.estMinutes;
            changed = true;
          }
          if (changed) {
            hit.updatedAt = store.nowIso();
            merged.push(hit);
          }
        }
        continue;
      }
      existing.push(task);
      byFingerprint.set(task.fingerprint, task);
      added.push(task);
    }
    d.tasks = existing;
    return { added, merged };
  }

  async function persistTasks() {
    const d = await ensureData();
    d.tasks = await store.saveTasks(p, d.tasks);
    refreshDigest();
    replanTodaySoon('tasks-changed');
  }

  // 任务/资料一变，今天的计划就该跟着变，否则面板和记忆里的「今日计划」会停在旧版本。
  // 这里不能直接 await generatePlan：调用方通常已经持有写锁（withLock 不是可重入的，
  // 嵌套会死锁）。所以排队到当前锁释放之后再跑，并做 500ms 合并（连续加 10 条任务只重排一次）。
  let replanTimer = null;
  function replanTodaySoon(reason) {
    if (replanTimer) return;
    replanTimer = setTimeout(() => {
      replanTimer = null;
      void (async () => {
        try {
          const today = store.dateKeyIn(new Date(), cfg.timeZone);
          await withLock(() => generatePlan({ date: today, reason }));
        } catch (error) {
          log('auto-replan-failed', error);
        }
      })();
    }, 500);
    if (typeof replanTimer.unref === 'function') replanTimer.unref();
  }

  // 推送前从磁盘重读 push.json：另一条推送通道（bin/push-cron.mjs 由 launchd 每天 08:00 触发）
  // 可能已经推过，内存里的 lastPushAt 是启动时的旧值，不重读就会一天推两次。
  async function pushAlreadyDoneToday() {
    const d = await ensureData();
    const fresh = await store.readJson(p.push, null);
    if (!fresh || typeof fresh !== 'object' || !fresh.lastPushAt) return false;
    d.push = { ...d.push, lastPushAt: fresh.lastPushAt, lastResult: fresh.lastResult || d.push.lastResult };
    const today = store.dateKeyIn(new Date(), cfg.timeZone);
    return store.dateKeyIn(new Date(fresh.lastPushAt), cfg.timeZone) === today;
  }

  function applyProfilePatch(patch = {}, { replaceGoals = false, replaceResources = false } = {}) {
    const d = data;
    const current = d.profile;
    const next = { ...current };
    if (patch.identity && typeof patch.identity === 'object') {
      next.identity = { ...current.identity, ...patch.identity };
    }
    if (patch.constraints && typeof patch.constraints === 'object') {
      next.constraints = { ...current.constraints, ...patch.constraints };
    }
    if (Array.isArray(patch.goals)) {
      const incoming = patch.goals.map(store.normalizeGoal);
      next.goals = replaceGoals ? incoming : [...current.goals, ...incoming];
    } else if (replaceGoals) {
      next.goals = [];
    }
    if (Array.isArray(patch.resources)) {
      const incoming = patch.resources.map(store.normalizeResource).filter((r) => r.title);
      next.resources = replaceResources ? incoming : [...current.resources, ...incoming];
    } else if (replaceResources) {
      next.resources = [];
    }
    if (patch.prefs && typeof patch.prefs === 'object') {
      const base = current.prefs || store.normalizePrefs({});
      const merged = { ...base };
      if ('ignoreTopics' in patch.prefs) merged.ignoreTopics = store.normalizeTopicList(patch.prefs.ignoreTopics);
      if ('focusTopics' in patch.prefs) merged.focusTopics = store.normalizeTopicList(patch.prefs.focusTopics);
      next.prefs = merged;
    }
    return next;
  }

  /**
   * 这条候选任务跟用户的学业/职业有关吗？
   * 用户是大一工科生、目标是升学就业，明确说过「诗歌散文这类不要再关注」。
   * 命中 ignoreTopics 的直接滤掉；也认一批硬性信号（课程/考试/学分/作业/实习…）作正向依据。
   * 纯启发式，宁可漏掉一条也不要把文艺活动塞进计划 —— 用户自己可以随时改 ignoreTopics。
   */
  function isIgnoredCandidate(candidate, prefs) {
    const haystack = `${candidate?.title || ''} ${candidate?.sourceText || candidate?.evidence?.text || ''}`;
    return store.isIgnoredText(haystack, prefs);
  }

  function selectTasks(tasks) {
    const open = tasks
      .filter((t) => t.status !== 'done' && t.status !== 'skipped')
      .sort((a, b) => {
        const da = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
        const db = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
        return da - db || a.priority - b.priority || a.title.localeCompare(b.title);
      });
    const done = tasks
      .filter((t) => t.status === 'done')
      .sort((a, b) => Date.parse(b.completedAt || b.updatedAt || 0) - Date.parse(a.completedAt || a.updatedAt || 0))
      .slice(0, 5);
    return [...open, ...done];
  }

  async function buildState(requestedDate) {
    const d = await ensureData();
    const now = new Date();
    const today = store.dateKeyIn(now, cfg.timeZone);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(requestedDate || '')) ? requestedDate : today;
    let plan = d.plans.find((x) => x.date === date) || null;
    if (!plan && date === today) {
      // 面板打开时今天没计划就顺手生成，别让用户面对空白页
      try {
        plan = (await withLock(() => generatePlan({ date: today, reason: 'lazy' }))).plan;
      } catch (error) {
        log('lazy-plan-failed', error);
      }
    }
    const traces = await readImTraces();
    const creds = await readQQCredentials();
    const inbound24h = (traces.inbound || []).filter((m) => {
      const at = Date.parse(m.at);
      return Number.isFinite(at) && now.getTime() - at <= DAY_MS;
    });
    // 微信「可用」的判据不能只是令牌文件存在：iLink 主动发消息还需要 to_user_id 与那条入站消息的
    // context_token，缺了就会被服务端拒（errcode -14）。面板要如实显示「未绑定 / 需重新扫码」。
    const weixinBound = (() => {
      try {
        const file = imPaths().weixinToken;
        if (!store.exists(file)) return false;
        const raw = store.readJson(file, null);
        if (!raw || typeof raw !== 'object') return false;
        const hasTo = Boolean(raw.to_user_id || raw.toUserId || raw.user_id);
        const hasCtx = Boolean(raw.context_token || raw.contextToken);
        return hasTo && hasCtx;
      } catch {
        return false;
      }
    })();
    return {
      date,
      today,
      now: now.toISOString(),
      profile: d.profile,
      tasks: selectTasks(d.tasks),
      plan,
      intel: d.intel.slice(0, 20),
      push: {
        enabled: d.push.enabled,
        time: d.push.time,
        timeZone: d.push.timeZone,
        channels: d.push.channels,
        lastPushAt: d.push.lastPushAt,
        lastResult: d.push.lastResult,
        targets: {
          qq: { known: Boolean(traces.lastQQOpenid), openid: traces.lastQQOpenid || '', canSend: Boolean(creds && traces.lastQQOpenid) },
          wechat: { bound: weixinBound },
        },
      },
      chat: {
        lastScanAt: meta.lastScanAt,
        inboundCount24h: inbound24h.length,
        available: Boolean(traces && (traces.inbound?.length || traces.lastQQOpenid)),
        history: {
          ...qqHistoryStatus(),
          groups: (await loadGroups()),
          lastImportAt: meta.lastChatImportAt,
          lastImportCount: meta.lastChatImportCount,
        },
      },
      stats: store.computeStats({ tasks: d.tasks, plan, plans: d.plans, today, now }),
    };
  }

  // ---------------------------------------------------------------- HTTP 接口（给面板用）
  const API_PREFIX = '/career-planner/api/';
  // 注意：prefix 路由的匹配规则是 `pathname === path || pathname.startsWith(path + '/')`，
  // 所以注册时**不能**带尾部斜杠，否则 /career-planner/api//health 才算命中（实测 404）。
  const API_ROUTE = '/career-planner/api';

  if (webServer && typeof webServer.register === 'function') {
    try {
      ctx.effect(() => webServer.register({
        kind: 'prefix',
        path: API_ROUTE,
        handler: apiHandler,
      }), 'career-planner.api()');
    } catch (error) {
      log('api-register-failed', error);
    }
  } else {
    log('api-skipped', { reason: '没有 webServer 服务（面板不可用，工具仍可用）' });
  }

  async function apiHandler(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const route = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname;
      if (req.method === 'GET' && route === 'health') {
        sendJson(res, 200, { ok: true, data: { dataDir: p.base, logs: logRing.slice(-40), digest } });
        return;
      }
      if (req.method === 'GET' && route === 'state') {
        const state = await buildState(url.searchParams.get('date'));
        sendJson(res, 200, { ok: true, data: state });
        return;
      }
      if (req.method === 'POST' && route === 'act') {
        const raw = await readBody(req);
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
          return;
        }
        const result = await handleAction(body);
        const state = await buildState(body.date || result?.date);
        sendJson(res, result.ok === false ? 400 : 200, { ok: result.ok !== false, data: state, result });
        return;
      }
      sendJson(res, 404, { ok: false, error: `未知接口 ${req.method} ${url.pathname}` });
    } catch (error) {
      log('api-error', error);
      sendJson(res, 500, { ok: false, error: String(error?.message || error) });
    }
  }

  function sendJson(res, status, value) {
    const body = JSON.stringify(value, null, 1);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  function readBody(req, limit = 512 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new Error('请求体过大'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  /** 面板的所有写操作都走这里；返回 { ok, message, date } */
  // 勾选/取消一个时间块（面板点一下、工具 career_done、聊天「完成 2」都走这里）
  async function toggleBlockCore(date, blockId, done) {
    const d = await ensureData();
    const plan = d.plans.find((x) => x.date === date) || (await store.readPlan(p, date));
    if (!plan) return { ok: false, message: '这一天的计划还不存在', date };
    const block = (plan.blocks || []).find((b) => b.id === blockId);
    if (!block) return { ok: false, message: '找不到这个时间块', date };
    block.done = done === undefined ? !block.done : Boolean(done);
    // 时间块勾上 = 它关联的任务也完成（一个任务可能拆成多个块，全部块完成才置为 done）
    if (Array.isArray(block.taskIds) && block.taskIds.length) {
      for (const taskId of block.taskIds) {
        const task = d.tasks.find((t) => t.id === taskId);
        if (!task) continue;
        const related = (plan.blocks || []).filter((b) => Array.isArray(b.taskIds) && b.taskIds.includes(taskId));
        const allDone = related.length > 0 && related.every((b) => b.done === true);
        if (allDone && task.status !== 'done') {
          task.status = 'done';
          task.completedAt = store.nowIso();
          task.updatedAt = store.nowIso();
        } else if (!allDone && task.status === 'done') {
          task.status = 'doing';
          task.completedAt = '';
          task.updatedAt = store.nowIso();
        }
      }
      await persistTasks();
    }
    await store.savePlan(p, plan);
    d.plans = [plan, ...d.plans.filter((x) => x.date !== date)];
    refreshDigest();
    log('block-toggled', { date, blockId, done: block.done });
    return { ok: true, message: `${block.done ? '完成' : '取消'} 了 ${block.title}`, date, block: { id: block.id, title: block.title, done: block.done } };
  }

  async function handleAction(body) {
    const d = await ensureData();
    const action = String(body?.action || '');
    const now = new Date();

    if (action === 'toggleBlock') {
      const date = String(body.date || store.dateKeyIn(now, cfg.timeZone));
      return toggleBlockCore(date, String(body.blockId || ''), body.done);
    }

    if (action === 'toggleTask') {
      const taskId = String(body.taskId || '');
      const task = d.tasks.find((t) => t.id === taskId);
      if (!task) return { ok: false, message: '找不到这个任务' };
      const done = body.done === undefined ? task.status !== 'done' : Boolean(body.done);
      task.status = done ? 'done' : 'todo';
      task.completedAt = done ? store.nowIso() : '';
      task.updatedAt = store.nowIso();
      await persistTasks();
      return { ok: true, message: done ? '任务已完成' : '任务已恢复', date: body.date };
    }

    if (action === 'regenerate') {
      const date = String(body.date || store.dateKeyIn(now, cfg.timeZone));
      const { plan } = await withLock(() => generatePlan({ date, reason: 'panel' }));
      return { ok: true, message: `已重排 ${date}`, date: plan.date };
    }

    if (action === 'pushNow') {
      const date = String(body.date || store.dateKeyIn(now, cfg.timeZone));
      const plan = d.plans.find((x) => x.date === date) || (await store.readPlan(p, date)) || null;
      const { results } = await withLock(() => doPush({ plan, reason: 'panel' }));
      const okCount = results.filter((r) => r.ok).length;
      return {
        ok: okCount > 0,
        message: okCount > 0
          ? `已推送：${results.filter((r) => r.ok).map((r) => r.channel).join('、')}`
          : `推送失败：${results.map((r) => `${r.channel} ${r.detail || '未知原因'}`).join('；')}`,
        date,
      };
    }

    if (action === 'savePush') {
      const patch = { ...d.push };
      if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
      if (body.time !== undefined) {
        const time = store.parseHHMM(body.time);
        if (!time) return { ok: false, message: '时间格式应为 HH:MM' };
        patch.time = time;
      }
      if (Array.isArray(body.channels)) patch.channels = body.channels;
      d.push = await store.savePush(p, patch);
      log('push-config-saved', { enabled: d.push.enabled, time: d.push.time, channels: d.push.channels });
      return { ok: true, message: '推送设置已保存（下次生效：重启后按新时间重排定时器）', date: body.date };
    }

    if (action === 'saveProfile') {
      const patch = body.profile && typeof body.profile === 'object' ? body.profile : {};
      const next = applyProfilePatch(patch, {
        replaceGoals: body.replaceGoals === true,
        replaceResources: body.replaceResources === true,
      });
      d.profile = await store.saveProfile(p, next);
      refreshDigest();
      replanTodaySoon('profile-changed');
      return { ok: true, message: '资料已保存', date: body.date };
    }

    if (action === 'addTask') {
      const task = body.task && typeof body.task === 'object' ? body.task : null;
      if (!task || !String(task.title || '').trim()) return { ok: false, message: '任务标题不能为空' };
      const { added } = mergeIncomingTasks([task], { sourceType: 'manual' });
      await persistTasks();
      return { ok: true, message: added.length ? '任务已添加' : '已存在同一条任务', date: body.date };
    }

    return { ok: false, message: `未知 action: ${action}` };
  }

  // ---------------------------------------------------------------- Agent 工具
  if (!registerTool) {
    log('tools-skipped', { reason: '拿不到 tools.register()，插件只剩 HTTP/定时功能' });
    return;
  }

  const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true };
  const renderJson = (args, value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return [{ type: 'text', text: text.length > 24000 ? `${text.slice(0, 24000)}\n…(已截断)` : text }];
  };

  function defineCareerTool(definition) {
    try {
      registerTool({ ...definition, output: { schema: OUTPUT_SCHEMA, render: renderJson } });
      return true;
    } catch (error) {
      log('tool-register-failed', { tool: definition?.name, error });
      return false;
    }
  }

  // ---- career_get
  defineCareerTool({
    name: 'career_get',
    description:
      '读取「生涯规划」插件记住的用户现状：身份、升学就业目标、手上的任务、今日计划、联网情报、推送状态。'
      + '用户问「我今天要干什么」「我的目标还剩多久」「还有哪些作业没做」时用它，不要靠猜。'
      + '只读，不产生副作用。',
    parameters: {
      type: 'object',
      properties: {
        sections: {
          type: 'array',
          description: '要看哪几块，默认全部。可选 profile/tasks/plan/intel/push/stats',
          items: { type: 'string', enum: ['profile', 'tasks', 'plan', 'intel', 'push', 'stats', 'all'] },
        },
        date: { type: 'string', description: '要看哪天的计划，YYYY-MM-DD，默认今天' },
      },
    },
    async execute(args) {
      const sections = Array.isArray(args?.sections) && args.sections.length && !args.sections.includes('all')
        ? new Set(args.sections)
        : new Set(['profile', 'tasks', 'plan', 'intel', 'push', 'stats']);
      const state = await buildState(args?.date);
      const out = { ok: true, today: state.today, date: state.date };
      for (const key of sections) out[key] = state[key];
      out.digest = digest;
      return out;
    },
  });

  // ---- career_profile_set
  defineCareerTool({
    name: 'career_profile_set',
    description:
      '写入用户的升学就业画像：身份（姓名/学校/专业/年级/毕业年份）、目标（考研/保研/求职/考公/留学/技能）、'
      + '可用时间约束（每天多少分钟、作息）、已有资源（课程、证书、项目、人脉、资料）。'
      + '这是插件的长期记忆，一旦用户说出这类信息就先落库，不要只在回答里复述。'
      + '已存在的目标/资源按传入内容追加；传 replaceGoals=true 可整体替换目标列表。',
    parameters: {
      type: 'object',
      properties: {
        identity: {
          type: 'object',
          description: '身份字段：name/school/major/grade/gradYear',
          properties: {
            name: { type: 'string' },
            school: { type: 'string' },
            major: { type: 'string' },
            grade: { type: 'string' },
            gradYear: { type: 'number' },
          },
        },
        goals: {
          type: 'array',
          description: '目标列表。kind 取 postgrad|job|exam|abroad|skill|other；priority 1-5（1 最高）',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: store.GOAL_KINDS },
              title: { type: 'string' },
              target: { type: 'string' },
              targetDate: { type: 'string', description: 'YYYY-MM-DD' },
              priority: { type: 'number' },
              notes: { type: 'string' },
            },
            required: ['title'],
          },
        },
        replaceGoals: { type: 'boolean', description: 'true = 用传入的目标整体替换已有目标' },
        constraints: {
          type: 'object',
          description: '时间约束：dailyMinutes、wakeAt、quietStart、quietEnd、weekdayMinutes{"0".."6": 分钟}、daysOff',
          properties: {
            dailyMinutes: { type: 'number' },
            wakeAt: { type: 'string' },
            sleepAt: { type: 'string' },
            quietStart: { type: 'string' },
            quietEnd: { type: 'string' },
            daysOff: { type: 'array', items: { type: 'number' } },
            weekdayMinutes: { type: 'object', additionalProperties: true },
          },
        },
        resources: {
          type: 'array',
          description: '已有资源：课程/技能/证书/项目/人脉/资料',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: store.RESOURCE_KINDS },
              title: { type: 'string' },
              detail: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['title'],
          },
        },
        replaceResources: { type: 'boolean', description: 'true = 用传入的资源整体替换已有资源' },
        prefs: {
          type: 'object',
          description:
            '关注/不关注口径。ignoreTopics：与学业职业无关、不该被排进计划也不该被提醒的活动关键词'
            + '（如「诗歌」「征文」「晚会」），抽群消息任务时会按它过滤；focusTopics：额外想重点关注的领域。',
          properties: {
            ignoreTopics: { type: 'array', items: { type: 'string' } },
            focusTopics: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    async execute(args) {
      const d = await ensureData();
      const next = applyProfilePatch(args || {}, {
        replaceGoals: args?.replaceGoals === true,
        replaceResources: args?.replaceResources === true,
      });
      d.profile = await withLock(() => store.saveProfile(p, next));
      refreshDigest();
      replanTodaySoon('profile-changed');
      log('profile-updated', { goals: d.profile.goals.length, resources: d.profile.resources.length });
      return {
        ok: true,
        message: `已更新：目标 ${d.profile.goals.length} 条、资源 ${d.profile.resources.length} 条、每日可用 ${d.profile.constraints.dailyMinutes} 分钟。`,
        profile: d.profile,
      };
    },
  });

  // ---- career_tasks_add
  defineCareerTool({
    name: 'career_tasks_add',
    description:
      '把任务写进本地任务库（作业、考试、课程表时段、实践、申请截止等）。'
      + '用户发了课表/老师通知截图文字/聊天里提到的作业，先解析成结构化任务再调用它，别只口头答应。'
      + '同标题同截止的任务会自动去重；startAt+endAt 都有时视为固定时段（排程时先占位）。'
      + '时间一律用带时区的 ISO 字符串，例如 2026-11-23T23:59:00+08:00。',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: '任务列表',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '具体到动作，例如「高数第三章 5-12 题」' },
              kind: { type: 'string', enum: store.TASK_KINDS },
              course: { type: 'string', description: '所属课程/项目，用于去重和归类' },
              startAt: { type: 'string', description: '固定开始时间（课程表）' },
              endAt: { type: 'string', description: '固定结束时间（课程表）' },
              dueAt: { type: 'string', description: '截止时间' },
              estMinutes: { type: 'number', description: '预计耗时（分钟），默认 30' },
              priority: { type: 'number', description: '1 最高 .. 5 最低，默认 3' },
              goalId: { type: 'string', description: '关联的升学就业目标 id' },
              notes: { type: 'string' },
              breakdown: {
                type: 'array',
                description: '拆分子步骤',
                items: {
                  type: 'object',
                  properties: { title: { type: 'string' }, minutes: { type: 'number' } },
                  required: ['title'],
                },
              },
            },
            required: ['title'],
          },
        },
        source: { type: 'string', description: '来源类型：chat|manual|web|syllabus|agent，默认 agent' },
        sourceRef: { type: 'string', description: '来源引用：消息片段、文件路径、URL' },
        repeatWeeks: {
          type: 'number',
          description: '重复周数（1-20，默认 1=不重复）。课程表这类每周固定的条目传 16，'
            + '插件会把带 startAt/endAt 的任务按每周 +7 天展开成 16 条，之后每天排程各自命中当周那一天。',
        },
      },
      required: ['tasks'],
    },
    async execute(args) {
      const raw = Array.isArray(args?.tasks) ? args.tasks : [];
      if (!raw.length) return { ok: false, message: 'tasks 为空，没有可添加的任务' };
      const incoming = expandWeekly(raw, args?.repeatWeeks);
      const { added, merged } = mergeIncomingTasks(incoming, {
        sourceType: String(args?.source || 'agent'),
        sourceRef: String(args?.sourceRef || ''),
      });
      if (added.length || merged.length) await withLock(() => persistTasks());
      return {
        ok: true,
        message: `新增 ${added.length} 条${merged.length ? `，补全 ${merged.length} 条` : ''}${incoming.length - added.length - merged.length > 0 ? `，跳过重复 ${incoming.length - added.length - merged.length} 条` : ''}。`,
        added: added.map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt, estMinutes: t.estMinutes })),
        merged: merged.map((t) => ({ id: t.id, title: t.title })),
      };
    },
  });

  // ---- career_task_update
  defineCareerTool({
    name: 'career_task_update',
    description:
      '更新一条任务：标记完成/跳过、改截止时间、改优先级、补备注、追加子步骤。'
      + '用户说「这个做完了」「推到明天」「加急」时用它，别只回复。需要 id 时先用 career_get 查。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id（t_ 开头）' },
        status: { type: 'string', enum: store.TASK_STATUSES },
        title: { type: 'string' },
        dueAt: { type: 'string', description: '新的截止时间，ISO；传空字符串清除' },
        estMinutes: { type: 'number' },
        priority: { type: 'number' },
        notes: { type: 'string' },
        goalId: { type: 'string' },
        addBreakdown: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: { type: 'string' }, minutes: { type: 'number' } },
            required: ['title'],
          },
        },
      },
      required: ['id'],
    },
    async execute(args) {
      const d = await ensureData();
      const task = d.tasks.find((t) => t.id === String(args?.id || ''));
      if (!task) return { ok: false, message: `找不到任务 ${args?.id}，先用 career_get 看看 id` };
      if (args.status !== undefined) {
        if (!store.TASK_STATUSES.includes(args.status)) return { ok: false, message: `status 只能是 ${store.TASK_STATUSES.join('/')}` };
        task.status = args.status;
        task.completedAt = args.status === 'done' ? store.nowIso() : '';
      }
      if (args.title !== undefined && String(args.title).trim()) {
        task.title = String(args.title).trim();
        task.fingerprint = store.fingerprintOf(task);
      }
      if (args.dueAt !== undefined) task.dueAt = String(args.dueAt || '');
      if (args.estMinutes !== undefined) task.estMinutes = Number(args.estMinutes);
      if (args.priority !== undefined) task.priority = Number(args.priority);
      if (args.notes !== undefined) task.notes = String(args.notes || '');
      if (args.goalId !== undefined) task.goalId = String(args.goalId || '');
      if (Array.isArray(args.addBreakdown)) {
        for (const step of args.addBreakdown) {
          const title = String(step?.title || '').trim();
          if (title) task.breakdown = [...(task.breakdown || []), { title, minutes: Number(step?.minutes) || 20, done: false }];
        }
      }
      const normalized = store.normalizeTask(task);
      Object.assign(task, normalized);
      task.updatedAt = store.nowIso();
      await withLock(() => persistTasks());
      return { ok: true, message: `已更新「${task.title}」`, task };
    },
  });

  // ---- career_done：把「完成 N」这种口语映射到具体时间块
  defineCareerTool({
    name: 'career_done',
    description:
      '把早八点推送的日报里的第 N 项标记完成（或取消完成）。用户回复「完成 2」「第 3 个做完了」时用它，'
      + 'N 是日报里的显示序号（1 开始，只数显示出来的条目）。也可以直接传 blockId 或标题片段。'
      + '不带参数调用则返回今天计划里还能勾的条目和序号，方便先给用户确认。',
    parameters: {
      type: 'object',
      properties: {
        n: { type: 'number', description: '日报里的显示序号（1 开始）' },
        blockId: { type: 'string', description: '时间块 id（b_ 开头），知道 id 时优先用它' },
        title: { type: 'string', description: '标题片段，模糊匹配当日计划里唯一的块' },
        date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
        done: { type: 'boolean', description: 'true 完成 / false 取消，默认 true（取消时传 false）' },
      },
    },
    async execute(args) {
      const d = await ensureData();
      const date = String(args?.date || store.dateKeyIn(new Date(), cfg.timeZone));
      const wantDone = args?.done === undefined ? true : Boolean(args.done);
      const plan = d.plans.find((x) => x.date === date) || (await store.readPlan(p, date));
      if (!plan) return { ok: false, message: `还没有 ${date} 的计划，先 career_plan_generate` };

      // 序号 → blockId：优先用上次推送时记下的映射（日报里的序号就是它），
      // 消息丢失/重启后没有映射时，退回按当前计划重算显示序号（规则同 formatPlanMessage）。
      const index = Array.isArray(meta.lastPushIndex) && meta.lastPushIndex.length
        ? meta.lastPushIndex
        : planDisplayIndex(plan);
      let block = null;
      if (args?.blockId) {
        block = (plan.blocks || []).find((b) => b.id === String(args.blockId));
      } else if (Number.isFinite(Number(args?.n))) {
        const hit = index.find((x) => x.n === Number(args.n));
        if (hit) block = (plan.blocks || []).find((b) => b.id === hit.blockId);
      } else if (args?.title) {
        const needle = String(args.title).trim();
        const hits = (plan.blocks || []).filter((b) => String(b.title || '').includes(needle));
        if (hits.length === 1) block = hits[0];
        else if (hits.length > 1) {
          return { ok: false, message: `标题「${needle}」匹配到 ${hits.length} 个块，请给更具体的标题或序号：${hits.map((b) => b.title).join(' / ')}` };
        }
      }
      if (!block) {
        const list = index.map((x) => {
          const b = (plan.blocks || []).find((y) => y.id === x.blockId) || {};
          return `@${x.n} ${b.start || ''} ${b.title || ''}${b.done ? '（已完成）' : ''}`;
        });
        const msg = args?.n === undefined && !args?.title && !args?.blockId
          ? `${date} 可勾选的条目：${list.join('；')}`
          : `找不到对应的时间块。当前可勾选：${list.join('；')}`;
        return { ok: false, message: msg, index };
      }
      const result = await withLock(() => toggleBlockCore(date, block.id, wantDone));
      return {
        ...result,
        n: (index.find((x) => x.blockId === block.id) || {}).n ?? null,
        plan: { date, blocks: (d.plans.find((x) => x.date === date) || plan).blocks, totalMinutes: (d.plans.find((x) => x.date === date) || plan).totalMinutes },
      };
    },
  });

  // ---- career_plan_generate
  defineCareerTool({
    name: 'career_plan_generate',
    description:
      '按当前的资料、任务和联网情报重新排出某一天的计划（默认今天）。纯规则排程，秒级完成、不花钱。'
      + '用户改了任务、加了目标、或者问「重新安排一下」时调用。'
      + '生成结果会覆盖当天的计划（已勾选的完成状态会尽量保留），并自动成为「今日计划」。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
        hints: { type: 'string', description: '额外要求，例如「今天只有上午有空」' },
      },
    },
    async execute(args) {
      const { plan } = await withLock(() => generatePlan({ date: args?.date, reason: 'tool', hints: String(args?.hints || '') }));
      return {
        ok: true,
        message: `已排出 ${plan.date} 的计划：${plan.focus}（${plan.blocks.length} 个时间块，合计 ${plan.totalMinutes} 分钟）`,
        plan,
        text: formatPlanMessage({ plan, profile: data.profile, date: plan.date }),
      };
    },
  });

  // ---- career_chat_scan
  defineCareerTool({
    name: 'career_chat_scan',
    description:
      '读取 QQ / 微信最近收到的聊天消息（来自本机 IM 桥接插件的状态日志），用于从中发现作业、课程变更、'
      + '招聘/考研信息。返回的是原始文本，需要你自己解读，然后把任务用 career_tasks_add 落库。'
      + '只读；解析完了再写库，不要直接把整段聊天贴回给用户。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多多少条入站消息，默认 30' },
        platform: { type: 'string', enum: ['all', 'qq', 'wechat'], description: '默认 all' },
        sinceMinutes: { type: 'number', description: '只看最近多少分钟，默认 1440' },
      },
    },
    async execute(args) {
      const limit = Math.min(200, Math.max(1, Number(args?.limit) || 30));
      const platform = String(args?.platform || 'all');
      const sinceMinutes = Math.min(20160, Math.max(1, Number(args?.sinceMinutes) || 1440));
      const traces = await readImTraces();
      const since = Date.now() - sinceMinutes * 60000;
      let inbound = Array.isArray(traces.inbound) ? traces.inbound : [];
      if (platform !== 'all') inbound = inbound.filter((m) => m.platform === platform);
      inbound = inbound.filter((m) => {
        const at = Date.parse(m.at);
        return !Number.isFinite(at) || at >= since;
      });
      const picked = inbound.slice(-limit);
      meta.lastScanAt = store.nowIso();
      meta.lastScanCount = picked.length;
      await saveMeta();
      return {
        ok: true,
        message: picked.length
          ? `读到 ${picked.length} 条入站消息。请从中识别作业/课程/截止信息，并用 career_tasks_add 落库。`
          : '最近没有读到新的入站消息（IM 桥接可能没收到消息，或状态日志还没写入）。',
        count: picked.length,
        messages: picked,
        lastQQOpenid: traces.lastQQOpenid || '',
        hint: '微信侧往往拿不到上下文令牌，能读到的可能不完整；QQ 侧较完整。',
      };
    },
  });

  // ---- career_groups
  defineCareerTool({
    name: 'career_groups',
    description:
      '管理「读聊天记录」的 QQ 群白名单：列出当前白名单与本地库是否可读、按群名搜索群号（从本机 QQ 群列表里找）、'
      + '把群加入/移出白名单。用户说「把 XX 群也读一下」「这个群不用看了」时用它。白名单可随时增删。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'search', 'add', 'remove', 'enable', 'disable'], description: '默认 list' },
        query: { type: 'string', description: 'search 时的群名关键词' },
        code: { type: 'number', description: 'add/remove/enable/disable 的群号' },
        name: { type: 'string', description: 'add 时可省略；省略则从本机群列表里按群号补全' },
        groups: {
          type: 'array',
          description: 'add 时一次加多个：[{code, name}]',
          items: { type: 'object', properties: { code: { type: 'number' }, name: { type: 'string' } } },
        },
      },
    },
    async execute(args) {
      const action = String(args?.action || 'list');
      const groups = await loadGroups();
      const status = qqHistoryStatus();

      async function discoverGroups() {
        try {
          const chatlog = await import('./lib/chatlog.js');
          if (typeof chatlog.readGroupList !== 'function') return { ok: false, list: [], message: 'chatlog 还没提供群列表接口' };
          await refreshQQCopies();
          const list = await chatlog.readGroupList({
            groupInfoPath: join(qqDir, 'group_info.db'),
            keyPath: qqKeyPath,
            plainDir: join(qqDir, 'plain'),
          });
          return { ok: true, list: Array.isArray(list) ? list : [], message: '' };
        } catch (error) {
          return { ok: false, list: [], message: `读群列表失败：${error.message}` };
        }
      }

      if (action === 'list') {
        return { ok: true, groups, status, count: groups.length, enabled: groups.filter((g) => g.enabled !== false).length };
      }

      if (action === 'search') {
        const q = String(args?.query || '').trim();
        const found = await discoverGroups();
        if (!found.ok) return { ok: false, message: found.message, groups, status };
        const hits = q
          ? found.list.filter((g) => String(g.name || '').includes(q) || String(g.code).includes(q))
          : found.list;
        return { ok: true, query: q, matches: hits.slice(0, 40), total: found.list.length, groups };
      }

      const incoming = [];
      if (Array.isArray(args?.groups)) {
        for (const g of args.groups) {
          const code = Number(g?.code);
          if (Number.isFinite(code)) incoming.push({ code, name: String(g?.name || '').trim() });
        }
      }
      const oneCode = Number(args?.code);
      if (Number.isFinite(oneCode)) incoming.push({ code: oneCode, name: String(args?.name || '').trim() });

      if (action === 'add') {
        if (!incoming.length) return { ok: false, message: '要给 code 或 groups' };
        let discovered = null;
        const next = [...groups];
        const added = [];
        for (const item of incoming) {
          const hit = next.find((g) => g.code === item.code);
          if (hit) {
            if (!hit.enabled) {
              hit.enabled = true;
              added.push(hit);
            }
            continue;
          }
          let name = item.name;
          if (!name) {
            if (!discovered) discovered = await discoverGroups();
            const match = (discovered.list || []).find((g) => Number(g.code) === item.code);
            name = match ? String(match.name) : '';
          }
          const entry = { code: item.code, name: name || `群 ${item.code}`, enabled: true, addedAt: store.nowIso() };
          next.push(entry);
          added.push(entry);
        }
        await saveGroups(next);
        log('groups-added', { added: added.map((g) => `${g.name}(${g.code})`) });
        return { ok: true, added, groups: next, message: added.length ? `已加入白名单：${added.map((g) => g.name).join('、')}` : '这些群已经在白名单里' };
      }

      if (action === 'remove' || action === 'enable' || action === 'disable') {
        if (!incoming.length) return { ok: false, message: '要给 code' };
        const codes = new Set(incoming.map((g) => g.code));
        let next;
        if (action === 'remove') {
          next = groups.filter((g) => !codes.has(g.code));
        } else {
          next = groups.map((g) => (codes.has(g.code) ? { ...g, enabled: action === 'enable' } : g));
        }
        await saveGroups(next);
        return { ok: true, groups: next, message: action === 'remove' ? '已移出白名单' : (action === 'enable' ? '已启用' : '已暂停') };
      }

      return { ok: false, message: `未知 action: ${action}` };
    },
  });

  // ---- career_chat_import
  defineCareerTool({
    name: 'career_chat_import',
    description:
      '读本机 QQ 库里白名单群的聊天记录（默认最近 30 天），抽成「候选任务」，高置信度的自动落库。'
      + '用户说「群里有作业/通知吗」「把群里的安排加进计划」时用它；每日扫描也可以直接调用。'
      + '先刷新库副本 → 解密 → 抽候选 → apply=true 时写入 tasks.json。',
    parameters: {
      type: 'object',
      properties: {
        apply: { type: 'boolean', description: '默认 false：只返回候选让人确认；true 时把「未来 7 天内截止 + 置信度 ≥0.85」的候选自动落库' },
        sinceDays: { type: 'number', description: '看最近多少天，默认 30' },
        limitPerGroup: { type: 'number', description: '每个群最多读多少条，默认 400' },
        refresh: { type: 'boolean', description: '默认 true：先从本机 QQ 库复制最新副本' },
        groupCodes: { type: 'array', items: { type: 'number' }, description: '只读这些群（默认读白名单里 enabled 的）' },
      },
    },
    async execute(args) {
      const apply = args?.apply === true;
      const sinceDays = Math.min(365, Math.max(1, Number(args?.sinceDays) || 30));
      const limitPerGroup = Math.min(2000, Math.max(20, Number(args?.limitPerGroup) || 400));
      const refresh = args?.refresh !== false;
      const status = qqHistoryStatus();
      if (!status.keyReady) {
        return { ok: false, message: '还没有 QQ 库密钥，读不了群记录。', status, next: '按 README「读 QQ 群记录」跑一次 tools/extract_key.py（一次性），或改用 career_chat_scan 读机器人私聊。' };
      }
      if (refresh) await refreshQQCopies();
      const all = await loadGroups();
      const wanted = Array.isArray(args?.groupCodes) && args.groupCodes.length
        ? all.filter((g) => args.groupCodes.map(Number).includes(g.code))
        : all.filter((g) => g.enabled !== false);
      if (!wanted.length) {
        return { ok: false, message: '白名单是空的：先用 career_groups 加群（会先搜群名/群号）。', status, groups: all };
      }
      const chatlog = await import('./lib/chatlog.js');
      let messages = [];
      let readError = '';
      try {
        messages = await chatlog.readQQMessages({
          dbPath: join(qqDir, 'nt_msg.db'),
          groupInfoPath: join(qqDir, 'group_info.db'),
          keyPath: qqKeyPath,
          plainDir: join(qqDir, 'plain'),
          groups: wanted.map((g) => ({ code: g.code, name: g.name })),
          sinceMs: Date.now() - sinceDays * DAY_MS,
          limit: limitPerGroup,
        });
      } catch (error) {
        readError = error?.message || String(error);
        log('chat-import-failed', { error: readError });
        return { ok: false, message: `读群记录失败：${readError}`, status };
      }
      const list = Array.isArray(messages) ? messages : (messages?.messages || []);
      const raw = typeof chatlog.extractTaskCandidates === 'function'
        ? chatlog.extractTaskCandidates(list, { now: Date.now() })
        : [];
      const candidates0 = typeof chatlog.dedupeCandidates === 'function' ? chatlog.dedupeCandidates(raw) : raw;
      // 按用户的关注口径过滤：诗歌/散文/晚会这类与学业职业无关的活动不进候选，
      // 免得每天在计划里提醒他「诗歌散文大赛今晚截止」。
      const prefs = (await ensureData()).profile?.prefs || store.normalizePrefs({});
      const dropped = [];
      const candidates = candidates0.filter((c) => {
        if (!isIgnoredCandidate(c, prefs)) return true;
        dropped.push({ title: c.title, dueAt: c.dueAt || '' });
        return false;
      });
      meta.lastChatImportAt = store.nowIso();
      meta.lastChatImportCount = candidates.length;
      await saveMeta();

      // 自动落库必须保守：群消息里「有意向的同学填表」这类没截止时间的先只给候选，
      // 只有「未来 7 天内截止 + 高置信度」的才直接进任务库，避免一次灌进上百条噪音。
      const soon = Date.now() + 7 * DAY_MS;
      const auto = candidates.filter((c) => {
        const conf = Number(c.confidence || 0);
        const at = c.dueAt ? Date.parse(c.dueAt) : NaN;
        return conf >= 0.85 && Number.isFinite(at) && at >= Date.now() - DAY_MS && at <= soon;
      });
      let added = [];
      if (apply && auto.length) {
        const incoming = auto.map((c) => ({
          title: c.title,
          course: c.course || '',
          dueAt: c.dueAt || '',
          kind: c.kind || 'other',
          priority: c.priority || 2,
          notes: `来自 ${c.evidence?.groupName || '群'} ${String(c.evidence?.text || '').slice(0, 120)}`.trim(),
          source: { type: 'qq-group', ref: `${c.evidence?.groupCode || ''}#${c.evidence?.ts || ''}` },
        }));
        ({ added } = mergeIncomingTasks(incoming, { sourceType: 'qq-group' }));
        if (added.length) {
          await persistTasks();
        }
      }
      // 只把「像个任务」的候选给用户看：低置信度的多是「5-6节签到码：89636622」
      // 这类聊天碎句，混在候选里只会让人不想看。
      const shown = candidates.filter((c) => Number(c.confidence || 0) >= 0.7);
      const weak = candidates.length - shown.length;
      log('chat-imported', { groups: wanted.length, messages: list.length, candidates: candidates.length, shown: shown.length, dropped: dropped.length, added: added.length });
      return {
        ok: true,
        message: list.length
          ? `读了 ${list.length} 条群消息，抽出 ${shown.length} 条像任务的候选`
            + `${dropped.length ? `（已按你的关注口径过滤掉 ${dropped.length} 条无关活动）` : ''}`
            + `${weak ? `（另有 ${weak} 条聊天碎句置信度太低没列）` : ''}`
            + `${apply ? `，自动落库 ${added.length} 条` : ''}。`
          : '这个时间窗里没有读到白名单群的消息。',
        groups: wanted.map((g) => g.name),
        scanned: list.length,
        filteredOut: dropped.slice(0, 10),
        weakCandidates: weak,
        candidates: shown.slice(0, 25),
        autoApplied: added.map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt })),
        status,
      };
    },
  });

  // ---- career_research
  defineCareerTool({
    name: 'career_research',
    description:
      '联网检索与升学就业相关的及时信息（院校/专业/分数线/考试报名/招聘岗位/行业趋势），把结果存进情报库，'
      + '后续排计划时会把情报里的动作纳入考虑。用户问「现在考研形势」「这个岗位要求什么」时用它，'
      + '不要凭记忆回答有时效性的信息。结果会返回标题+摘要+链接，需要时再对具体 URL 抓正文。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词，越具体越好' },
        urls: { type: 'array', items: { type: 'string' }, description: '直接抓取这些链接的正文（最多 3 个）' },
        goalId: { type: 'string', description: '把情报关联到某个目标' },
        maxResults: { type: 'number', description: '检索条数，默认 6，最多 10' },
      },
      required: ['query'],
    },
    async execute(args) {
      if (!web || typeof web.search !== 'function') {
        return { ok: false, message: '宿主没有可用的联网检索服务，无法获取实时信息。' };
      }
      const query = String(args?.query || '').trim();
      if (!query) return { ok: false, message: 'query 不能为空' };
      const maxResults = Math.min(10, Math.max(1, Number(args?.maxResults) || 6));
      const goalId = String(args?.goalId || '');
      const d = await ensureData();
      const items = [];
      let searchError = '';
      try {
        const result = await web.search({ query, maxResults }, AbortSignal.timeout(30000));
        for (const source of result?.sources || []) {
          items.push(store.normalizeIntelItem({
            title: source.title || source.url || query,
            summary: source.summary || source.snippet || (result?.content ? String(result.content).slice(0, 400) : ''),
            url: source.url || '',
            source: 'web-search',
            fetchedAt: store.nowIso(),
            tags: [query.slice(0, 40)],
            goalIds: goalId ? [goalId] : [],
          }));
        }
      } catch (error) {
        searchError = String(error?.message || error);
        log('research-search-failed', error);
      }

      const urls = (Array.isArray(args?.urls) ? args.urls : []).map((u) => String(u || '').trim()).filter(Boolean).slice(0, 3);
      if (typeof web.fetch === 'function') {
        for (const url of urls) {
          try {
            const page = await web.fetch({ url }, AbortSignal.timeout(30000));
            const text = String(page?.body?.content || '')
              .replace(/<script[\s\S]*?<\/script>/gi, ' ')
              .replace(/<style[\s\S]*?<\/style>/gi, ' ')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
            items.push(store.normalizeIntelItem({
              title: `正文：${url}`,
              summary: text.slice(0, 1200),
              url,
              source: 'web-fetch',
              fetchedAt: store.nowIso(),
              tags: ['fetch'],
              goalIds: goalId ? [goalId] : [],
            }));
          } catch (error) {
            log('research-fetch-failed', { url, error });
          }
        }
      }

      if (items.length) {
        // 按 url 去重，新的覆盖旧的
        const seen = new Set();
        const merged = [];
        for (const item of [...items, ...d.intel]) {
          const key = item.url || item.id;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(item);
        }
        d.intel = await withLock(() => store.saveIntel(p, merged.slice(0, 400)));
        refreshDigest();
      }

      return {
        ok: items.length > 0,
        message: items.length
          ? `已存入 ${items.length} 条情报（共 ${d.intel.length} 条）。可以用 career_plan_generate 把情报里的动作排进计划。`
          : `没有检索到结果${searchError ? `（${searchError}）` : ''}，可以换个更具体的关键词。`,
        items,
        searchError,
      };
    },
  });

  // ---- career_push
  defineCareerTool({
    name: 'career_push',
    description:
      '推送到用户手机：默认把当天计划整理成日报，通过 QQ / 微信发给用户（早八点会自动推一次，这里是手动补发）。'
      + '也用来改推送设置：传 enabled/time/channels 就只改设置不发消息。'
      + '推送失败会返回每个通道的具体原因（凭据失效/没绑微信/频率限制），不要谎报成功。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '推哪天的计划，默认今天' },
        text: { type: 'string', description: '自定义推送文案；不传则自动生成当日日报' },
        enabled: { type: 'boolean', description: '开/关每日定时推送' },
        time: { type: 'string', description: '定时推送时刻 HH:MM' },
        channels: { type: 'array', items: { type: 'string', enum: ['qq', 'wechat', 'file'] }, description: '推送通道' },
      },
    },
    async execute(args) {
      const d = await ensureData();
      const hasConfig = args && (args.enabled !== undefined || args.time !== undefined || Array.isArray(args.channels));
      if (hasConfig) {
        const patch = { ...d.push };
        if (args.enabled !== undefined) patch.enabled = Boolean(args.enabled);
        if (args.time !== undefined) {
          const time = store.parseHHMM(args.time);
          if (!time) return { ok: false, message: 'time 格式应为 HH:MM' };
          patch.time = time;
        }
        if (Array.isArray(args.channels) && args.channels.length) patch.channels = args.channels;
        d.push = await withLock(() => store.savePush(p, patch));
        log('push-config-saved', { via: 'tool', enabled: d.push.enabled, time: d.push.time, channels: d.push.channels });
        if (!args.text && !args.date) {
          return {
            ok: true,
            message: `推送设置已更新：${d.push.enabled ? '开启' : '关闭'}，每天 ${d.push.time}（${d.push.timeZone}），通道 ${d.push.channels.join('/')}。`,
            push: d.push,
          };
        }
      }
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args?.date || '')) ? args.date : store.dateKeyIn(new Date(), cfg.timeZone);
      let plan = d.plans.find((x) => x.date === date) || (await store.readPlan(p, date)) || null;
      if (!plan && !args?.text) {
        plan = (await withLock(() => generatePlan({ date, reason: 'tool-push' }))).plan;
      }
      const { results, text } = await withLock(() => doPush({ plan, text: String(args?.text || ''), reason: 'tool' }));
      const okChannels = results.filter((r) => r.ok).map((r) => r.channel);
      return {
        ok: okChannels.length > 0,
        message: okChannels.length
          ? `已推送（${okChannels.join('、')}）。${results.filter((r) => !r.ok).length ? `未成功：${results.filter((r) => !r.ok).map((r) => `${r.channel}(${r.detail})`).join('；')}` : ''}`
          : `全部通道都失败了：${results.map((r) => `${r.channel} ${r.detail || ''}`).join('；') || '没有可用通道'}`,
        results,
        text,
      };
    },
  });

  log('ready', { dataDir: p.base, timeZone: cfg.timeZone, pushTime: cfg.pushTime, hasWebServer: Boolean(webServer), hasSystemPrompt: Boolean(systemPrompt), hasWeb: Boolean(web) });

  // 暴露一个只读快照给 /health 之外的宿主侧排查用（不注册路由，只挂在 ctx 上不影响别人）
  try {
    ctx.set?.('career-planner-debug', {
      dataDir: p.base,
      logs: () => logRing.slice(),
      digest: () => digest,
    });
  } catch {
    /* 老宿主没有 ctx.set，忽略 */
  }
}
