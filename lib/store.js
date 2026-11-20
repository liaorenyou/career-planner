/**
 * lib/store.js —— 生涯规划插件的磁盘数据层
 *
 * 设计原则：
 *  1. **纯 Node 内置模块**，零依赖。
 *  2. 所有 JSON 都用「写临时文件 + rename」的原子替换，避免半截文件把数据搞坏
 *     （插件会在 agent 工具调用和定时器里并发写，非原子写迟早会把 tasks.json 写坏）。
 *  3. 每个 load 都做 normalize：字段缺失就补默认值，坏值就回退。
 *     数据是长期积累的，一次版本改动不该让旧文件变成不可读。
 *  4. 时区只在**边界**处理（读盘/排程/展示），内存里一律用各自约定的字符串
 *     （日期 `YYYY-MM-DD`、时刻 `HH:MM`、时间戳 ISO），避免 Date 对象到处乱飞。
 *
 * 数据目录默认 `$DSH_HOME/career-planner`（即 `~/.dsh/career-planner`）：
 *   profile.json / tasks.json / intel.json / push.json / plans/YYYY-MM-DD.json
 */
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_TZ = 'Asia/Shanghai';
export const DEFAULT_PUSH_TIME = '08:00';

/** 每日可用分钟数的默认值（键是 Date.getDay()，0 = 周日） */
export const DEFAULT_WEEKDAY_MINUTES = { '0': 120, '1': 180, '2': 180, '3': 180, '4': 180, '5': 180, '6': 240 };

export const DEFAULT_CONSTRAINTS = {
  dailyMinutes: 180,
  weekdayMinutes: { ...DEFAULT_WEEKDAY_MINUTES },
  quietStart: '23:30',
  quietEnd: '07:00',
  wakeAt: '07:30',
  sleepAt: '23:30',
  daysOff: [0],
};

export const TASK_STATUSES = ['todo', 'doing', 'done', 'skipped', 'blocked'];
export const TASK_KINDS = ['course', 'homework', 'exam', 'practice', 'application', 'research', 'reading', 'other'];
export const GOAL_KINDS = ['postgrad', 'job', 'exam', 'abroad', 'skill', 'other'];
export const RESOURCE_KINDS = ['course', 'skill', 'material', 'contact', 'tool', 'other'];

/**
 * 默认「不关注」的活动关键词。用户是大一工科生，目标是学业与就业，
 * 文艺/娱乐类活动（诗歌散文征文、歌唱舞蹈晚会…）只会变成噪音，
 * 从聊天记录里抽任务时直接滤掉、也不要写进记忆段提醒他。
 * 用户随时可以用 career_profile_set 的 prefs.ignoreTopics 增删。
 */
export const DEFAULT_IGNORE_TOPICS = Object.freeze([
  // 文艺/娱乐
  '诗歌', '散文', '征文', '朗诵', '征稿', '文学', '文艺', '歌唱', '合唱', '歌手',
  '舞蹈', '晚会', '主持', '书法', '绘画', '摄影大赛', '才艺', '脱口秀', '游园',
  '风筝', '短视频大赛', 'vlog', '手抄报', '板报', '表情包', '十佳', '校花', '校草',
  '音乐节', '戏剧', '相声', '风采大赛', '迎新晚会',
  // 体育娱乐（赛事报名，不是体育课）
  '篮球赛', '足球赛', '排球赛', '羽毛球赛', '乒乓球赛', '运动会', '趣味运动',
  '啦啦队', '拔河', '跳绳比赛', '电竞', '游戏比赛',
]);

/**
 * 「这条通知虽然命中了忽略词，但其实跟学业有关」的豁免词。
 * 典型的坑：『乒乓球台值班志愿活动』撞上「乒乓球赛」，但志愿工时可能算第二课堂学分，不能一概滤掉。
 */
export const KEEP_OVERRIDE_TOPICS = Object.freeze([
  '志愿', '工时', '学分', '必修', '选修', '考试', '补考', '体测', '实验', '作业', '答辩',
]);

// ---------------------------------------------------------------- 路径

/** DSH 的 home 目录；插件所有数据都放这下面（和 im-bridge 的约定一致） */
export function dshHome(env = process.env) {
  const fromEnv = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : '';
  return fromEnv || join(homedir(), '.dsh');
}

export function paths(dataDir) {
  const base = dataDir && String(dataDir).trim() ? String(dataDir).trim() : join(dshHome(), 'career-planner');
  return {
    base,
    plansDir: join(base, 'plans'),
    profile: join(base, 'profile.json'),
    tasks: join(base, 'tasks.json'),
    intel: join(base, 'intel.json'),
    push: join(base, 'push.json'),
    state: join(base, 'state.json'),
  };
}

export async function ensureDirs(p) {
  await mkdir(p.base, { recursive: true });
  await mkdir(p.plansDir, { recursive: true });
}

// ---------------------------------------------------------------- 原子读写

/** 读 JSON；文件不存在 / 解析失败都返回 fallback（坏文件备份一份，不静默丢数据） */
export async function readJson(file, fallback) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch {
    // 坏文件留个证据，然后按空数据处理
    try {
      await writeFile(`${file}.corrupt-${Date.now()}`, text, 'utf8');
    } catch {
      /* 备份失败就算了，不能因为备份把主流程搞挂 */
    }
    return fallback;
  }
}

/** 原子写：先写同目录临时文件，再 rename（同分区 rename 是原子的） */
export async function writeJson(file, value) {
  const dir = file.replace(/\/[^/]+$/, '');
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    await rename(tmp, file);
  } catch (error) {
    try {
      await unlink(tmp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

// ---------------------------------------------------------------- 默认值与 normalize

export function nowIso() {
  return new Date().toISOString();
}

export function nextId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function emptyProfile() {
  return {
    version: 1,
    identity: { name: '', school: '', major: '', grade: '', gradYear: null },
    goals: [],
    constraints: { ...DEFAULT_CONSTRAINTS, weekdayMinutes: { ...DEFAULT_WEEKDAY_MINUTES } },
    resources: [],
    prefs: { ignoreTopics: [...DEFAULT_IGNORE_TOPICS], focusTopics: [] },
    updatedAt: nowIso(),
  };
}

export function emptyTasks() {
  return { tasks: [], updatedAt: nowIso() };
}

export function emptyIntel() {
  return { items: [], updatedAt: nowIso() };
}

export function emptyPush(tz = DEFAULT_TZ) {
  return {
    enabled: true,
    time: DEFAULT_PUSH_TIME,
    timeZone: tz,
    channels: ['qq', 'wechat'],
    lastPushAt: '',
    lastResult: {},
  };
}

/** 'HH:MM' 合法性；不合法返回 null */
export function parseHHMM(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(mi) || h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function str(value, fallback = '') {
  return typeof value === 'string' ? value : value === null || value === undefined ? fallback : String(value);
}

export function normalizeGoal(raw, index = 0) {
  const g = raw && typeof raw === 'object' ? raw : {};
  return {
    id: str(g.id) || nextId('g'),
    kind: GOAL_KINDS.includes(g.kind) ? g.kind : 'other',
    title: str(g.title).trim() || `目标 ${index + 1}`,
    target: str(g.target).trim(),
    targetDate: /^\d{4}-\d{2}-\d{2}$/.test(str(g.targetDate)) ? str(g.targetDate) : '',
    priority: clampInt(g.priority, 1, 5, 3),
    notes: str(g.notes),
  };
}

export function normalizeResource(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    id: str(r.id) || nextId('r'),
    kind: RESOURCE_KINDS.includes(r.kind) ? r.kind : 'other',
    title: str(r.title).trim(),
    detail: str(r.detail),
    tags: Array.isArray(r.tags) ? r.tags.map((t) => str(t)).filter(Boolean).slice(0, 20) : [],
    updatedAt: str(r.updatedAt) || nowIso(),
  };
}

export function normalizeConstraints(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const weekday = {};
  for (let d = 0; d < 7; d += 1) {
    const key = String(d);
    const source = c.weekdayMinutes && typeof c.weekdayMinutes === 'object' ? c.weekdayMinutes[key] : undefined;
    weekday[key] = clampInt(source, 0, 900, DEFAULT_WEEKDAY_MINUTES[key]);
  }
  const daysOff = Array.isArray(c.daysOff)
    ? [...new Set(c.daysOff.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
    : [...DEFAULT_CONSTRAINTS.daysOff];
  return {
    dailyMinutes: clampInt(c.dailyMinutes, 0, 900, DEFAULT_CONSTRAINTS.dailyMinutes),
    weekdayMinutes: weekday,
    quietStart: parseHHMM(c.quietStart) || DEFAULT_CONSTRAINTS.quietStart,
    quietEnd: parseHHMM(c.quietEnd) || DEFAULT_CONSTRAINTS.quietEnd,
    wakeAt: parseHHMM(c.wakeAt) || DEFAULT_CONSTRAINTS.wakeAt,
    sleepAt: parseHHMM(c.sleepAt) || DEFAULT_CONSTRAINTS.sleepAt,
    daysOff,
  };
}

export function normalizeTopicList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const text = str(raw).trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text.slice(0, 40));
  }
  return out.slice(0, 100);
}

export function normalizePrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  // 老数据没有 prefs 时给默认忽略清单；显式传空数组表示「什么都关注」，
  // 所以只对「字段不存在」兜默认，不能对空数组兜默认。
  const ignoreTopics = 'ignoreTopics' in p ? normalizeTopicList(p.ignoreTopics) : [...DEFAULT_IGNORE_TOPICS];
  return {
    ignoreTopics,
    focusTopics: normalizeTopicList(p.focusTopics),
  };
}

/**
 * 这段文本命中了用户「不关注」的口径吗？
 * 用于抽群消息任务时过滤文艺/娱乐类活动，也用于判断某条通知该不该提醒。
 */
export function isIgnoredText(text, prefs) {
  const ignore = prefs && Array.isArray(prefs.ignoreTopics) ? prefs.ignoreTopics : [];
  const hay = str(text).toLowerCase();
  if (!hay.trim()) return false;
  const hitIgnore = ignore.some((topic) => {
    const needle = str(topic).trim().toLowerCase();
    return needle.length >= 2 && hay.includes(needle);
  });
  if (!hitIgnore) return false;
  // 命中忽略词但带学业豁免（志愿工时/学分/考试/作业…）的，不算无关活动
  const keep = KEEP_OVERRIDE_TOPICS.some((word) => hay.includes(word.toLowerCase()));
  return !keep;
}

export function normalizeProfile(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const identity = p.identity && typeof p.identity === 'object' ? p.identity : {};
  const goals = Array.isArray(p.goals) ? p.goals.map(normalizeGoal) : [];
  const resources = Array.isArray(p.resources) ? p.resources.map(normalizeResource).filter((r) => r.title) : [];
  return {
    version: 1,
    identity: {
      name: str(identity.name),
      school: str(identity.school),
      major: str(identity.major),
      grade: str(identity.grade),
      gradYear: Number.isFinite(Number(identity.gradYear)) && Number(identity.gradYear) > 1900 ? Number(identity.gradYear) : null,
    },
    goals,
    constraints: normalizeConstraints(p.constraints),
    resources,
    prefs: normalizePrefs(p.prefs),
    updatedAt: str(p.updatedAt) || nowIso(),
  };
}

/**
 * 去重指纹：标题（去空白、小写）+ 截止时间（精确到分钟）。
 * 用途：同一份作业从聊天记录里被抓两次、或者老师改了个错别字重发，都不要变成两条。
 */
export function fingerprintOf({ title, dueAt, course, startAt } = {}) {
  const norm = (v) => str(v).replace(/\s+/g, '').toLowerCase();
  const due = str(dueAt).trim() ? str(dueAt).trim().slice(0, 16) : '';
  // 固定时段的课程/预约没有 dueAt，若不把 startAt 算进去，周课展开出来的几条会互相打架、
  // 被去重成一条。同一门课不同周次的时间不同 → 指纹不同 → 各自独立。
  const start = str(startAt).trim() ? str(startAt).trim().slice(0, 16) : '';
  return createHash('sha1').update(`${norm(course)}|${norm(title)}|${due}|${start}`).digest('hex').slice(0, 16);
}

export function normalizeTask(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const title = str(t.title).trim();
  const status = TASK_STATUSES.includes(t.status) ? t.status : 'todo';
  const task = {
    id: str(t.id) || nextId('t'),
    title,
    kind: TASK_KINDS.includes(t.kind) ? t.kind : 'other',
    course: str(t.course),
    startAt: str(t.startAt) || '',
    endAt: str(t.endAt) || '',
    dueAt: str(t.dueAt) || '',
    estMinutes: clampInt(t.estMinutes, 5, 600, 30),
    priority: clampInt(t.priority, 1, 5, 3),
    goalId: str(t.goalId),
    status,
    source: t.source && typeof t.source === 'object'
      ? { type: str(t.source.type) || 'manual', ref: str(t.source.ref) }
      : { type: 'manual', ref: '' },
    notes: str(t.notes),
    breakdown: Array.isArray(t.breakdown)
      ? t.breakdown
        .map((b) => (b && typeof b === 'object'
          ? { title: str(b.title).trim(), minutes: clampInt(b.minutes, 5, 240, 20), done: b.done === true }
          : null))
        .filter((b) => b && b.title)
        .slice(0, 20)
      : [],
    createdAt: str(t.createdAt) || nowIso(),
    updatedAt: str(t.updatedAt) || nowIso(),
    completedAt: str(t.completedAt),
  };
  task.fingerprint = str(t.fingerprint) || fingerprintOf(task);
  return task;
}

export function normalizeIntelItem(raw) {
  const i = raw && typeof raw === 'object' ? raw : {};
  return {
    id: str(i.id) || nextId('i'),
    title: str(i.title).trim(),
    summary: str(i.summary).trim(),
    url: str(i.url),
    source: str(i.source),
    fetchedAt: str(i.fetchedAt) || nowIso(),
    tags: Array.isArray(i.tags) ? i.tags.map((t) => str(t)).filter(Boolean).slice(0, 12) : [],
    goalIds: Array.isArray(i.goalIds) ? i.goalIds.map((g) => str(g)).filter(Boolean).slice(0, 12) : [],
  };
}

export function normalizePush(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const channels = Array.isArray(p.channels)
    ? [...new Set(p.channels.map((c) => str(c)).filter((c) => c === 'qq' || c === 'wechat' || c === 'file'))]
    : ['qq', 'wechat'];
  return {
    enabled: p.enabled !== false,
    time: parseHHMM(p.time) || DEFAULT_PUSH_TIME,
    timeZone: str(p.timeZone) || DEFAULT_TZ,
    channels: channels.length ? channels : ['qq'],
    lastPushAt: str(p.lastPushAt),
    lastResult: p.lastResult && typeof p.lastResult === 'object' ? p.lastResult : {},
  };
}

// ---------------------------------------------------------------- 时区/日期工具

function wallParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const out = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  // 某些 ICU 版本在午夜返回 '24'
  if (out.hour === '24') out.hour = '00';
  return out;
}

/** 把某一刻换成指定时区的墙钟：{ date:'YYYY-MM-DD', time:'HH:MM', minutes, weekday } */
export function wallClock(date = new Date(), timeZone = DEFAULT_TZ) {
  const p = wallParts(date, timeZone);
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  const dk = `${p.year}-${p.month}-${p.day}`;
  return { date: dk, time: `${p.hour}:${p.minute}`, minutes, weekday: weekdayOf(dk) };
}

export function dateKeyIn(date = new Date(), timeZone = DEFAULT_TZ) {
  return wallClock(date, timeZone).date;
}

export function timeOfDayIn(date = new Date(), timeZone = DEFAULT_TZ) {
  return wallClock(date, timeZone).time;
}

export function weekdayOf(dateKey) {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

/** 给 `YYYY-MM-DD` 加减天数（纯日历运算，不涉及时区） */
export function addDays(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** 两个日期键相差多少天（b - a） */
export function diffDays(a, b) {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.round((tb - ta) / 86400000);
}

/** 某时区在某一刻的 UTC 偏移（分钟） */
export function tzOffsetMinutes(date, timeZone = DEFAULT_TZ) {
  const p = wallParts(date, timeZone);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return (asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000;
}

/** 把「某时区的某天某时刻」换成真实 UTC 时刻（两轮迭代足够覆盖夏令时边界） */
export function zonedToUtc(dateKey, hhmm, timeZone = DEFAULT_TZ) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [hh, mi] = hhmm.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mi, 0);
  let guess = naive - tzOffsetMinutes(new Date(naive), timeZone) * 60000;
  guess = naive - tzOffsetMinutes(new Date(guess), timeZone) * 60000;
  return new Date(guess);
}

/** 下一次 `HH:MM`（严格晚于 from，最多等一天）在什么时刻 */
export function nextDailyOccurrence(hhmm, timeZone = DEFAULT_TZ, from = new Date()) {
  const today = dateKeyIn(from, timeZone);
  let at = zonedToUtc(today, hhmm, timeZone);
  if (at.getTime() <= from.getTime() + 2000) {
    at = zonedToUtc(addDays(today, 1), hhmm, timeZone);
  }
  return at;
}

// ---------------------------------------------------------------- 聚合读写

/**
 * 一次把全部数据读进来并 normalize。
 * 返回的对象是**可变的工作副本**，调用方改完用 save* 落盘。
 */
export async function loadAll(p, { timeZone = DEFAULT_TZ, recentPlans = 8 } = {}) {
  await ensureDirs(p);
  const [rawProfile, rawTasks, rawIntel, rawPush] = await Promise.all([
    readJson(p.profile, null),
    readJson(p.tasks, null),
    readJson(p.intel, null),
    readJson(p.push, null),
  ]);
  const profile = normalizeProfile(rawProfile);
  const tasks = (Array.isArray(rawTasks?.tasks) ? rawTasks.tasks : []).map(normalizeTask).filter((t) => t.title);
  const intel = (Array.isArray(rawIntel?.items) ? rawIntel.items : []).map(normalizeIntelItem).filter((i) => i.title);
  const push = normalizePush(rawPush ?? emptyPush(timeZone));
  const plans = await recentPlanList(p, recentPlans);
  return { profile, tasks, intel, push, plans, updatedAt: rawTasks?.updatedAt || nowIso() };
}

export async function saveProfile(p, profile) {
  const next = normalizeProfile({ ...profile, updatedAt: nowIso() });
  await writeJson(p.profile, next);
  return next;
}

export async function saveTasks(p, tasks) {
  const normalized = (Array.isArray(tasks) ? tasks : []).map(normalizeTask).filter((t) => t.title);
  await writeJson(p.tasks, { tasks: normalized, updatedAt: nowIso() });
  return normalized;
}

export async function saveIntel(p, intel) {
  const items = (Array.isArray(intel) ? intel : []).map(normalizeIntelItem).filter((i) => i.title).slice(0, 400);
  await writeJson(p.intel, { items, updatedAt: nowIso() });
  return items;
}

export async function savePush(p, push) {
  const next = normalizePush(push);
  await writeJson(p.push, next);
  return next;
}

// ---------------------------------------------------------------- 计划文件

export function planFile(p, date) {
  return join(p.plansDir, `${date}.json`);
}

export async function readPlan(p, date) {
  const raw = await readJson(planFile(p, date), null);
  return raw && typeof raw === 'object' && Array.isArray(raw.blocks) ? raw : null;
}

export async function savePlan(p, plan) {
  if (!plan || typeof plan !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(str(plan.date))) {
    throw new Error('savePlan: plan.date 必须是 YYYY-MM-DD');
  }
  await ensureDirs(p);
  await writeJson(planFile(p, plan.date), plan);
  return plan;
}

/** 最近 N 天的计划（新→旧），用于前端历史/连续天数统计 */
export async function recentPlanList(p, limit = 8) {
  let names = [];
  try {
    names = await readdir(p.plansDir);
  } catch {
    return [];
  }
  const dates = names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
    .map((n) => n.slice(0, 10))
    .sort()
    .reverse()
    .slice(0, Math.max(1, limit));
  const out = [];
  for (const date of dates) {
    const plan = await readPlan(p, date);
    if (plan) out.push(plan);
  }
  return out;
}

/** 已有计划的日期集合（旧的在前），用于连续天数统计 */
export async function listPlanDates(p) {
  try {
    const names = await readdir(p.plansDir);
    return names.filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).map((n) => n.slice(0, 10)).sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- 统计

export function computeStats({ tasks = [], plan = null, plans = [], today, now = new Date() }) {
  const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'skipped');
  const dueToday = open.filter((t) => t.dueAt && dateKeyIn(new Date(t.dueAt), DEFAULT_TZ) === today);
  const overdue = open.filter((t) => t.dueAt && new Date(t.dueAt).getTime() < now.getTime());
  const doneToday = tasks.filter((t) => t.status === 'done' && t.completedAt && dateKeyIn(new Date(t.completedAt), DEFAULT_TZ) === today);
  // 连续天数：从今天（或昨天）往回数，连续有「计划且至少完成一个块」的天数
  let streakDays = 0;
  const byDate = new Map(plans.map((pl) => [pl.date, pl]));
  for (let i = 0; i < 365; i += 1) {
    const key = addDays(today, -i);
    const pl = byDate.get(key);
    const hit = Boolean(pl && Array.isArray(pl.blocks) && pl.blocks.some((b) => b.done));
    if (hit) {
      streakDays += 1;
      continue;
    }
    if (i === 0) continue; // 今天还没做完不算断
    break;
  }
  return {
    tasksOpen: open.length,
    tasksDueToday: dueToday.length,
    overdue: overdue.length,
    minutesToday: plan && Number.isFinite(plan.totalMinutes) ? plan.totalMinutes : 0,
    doneToday: doneToday.length,
    streakDays,
  };
}

// ---------------------------------------------------------------- 小工具

/** 毫秒 -> 「x 小时 y 分钟」中文 */
export function humanDuration(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h && rest) return `${h} 小时 ${rest} 分钟`;
  if (h) return `${h} 小时`;
  return `${rest} 分钟`;
}

/** 日期键 -> 「11月21日」 */
export function humanDate(dateKey) {
  const [, m, d] = String(dateKey || '').split('-');
  if (!m || !d) return String(dateKey || '');
  return `${Number(m)}月${Number(d)}日`;
}

export function exists(file) {
  try {
    return existsSync(file);
  } catch {
    return false;
  }
}

export { readFile, writeFile };
