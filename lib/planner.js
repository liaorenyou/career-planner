/**
 * @local/career-planner —— 计划排程引擎（planner-engine 负责的唯一实现文件）
 *
 * 设计目标（对应 CONTRACT.md §2.3 的 11 条规则，逐条落进代码注释）：
 *   1. 时间窗：wakeAt~quietStart 之间排块；总工时 ≤ 当日 capacity；超出进 unscheduled。
 *   2. 固定时段优先：startAt/endAt 齐全的任务（课程表）先占位，kind = 'course'。
 *   3. 截止压力：逾期置顶 + warnings；dueAt 3 天内高权重；排序用 scoreTask。
 *      「今日截止」以**计划日**为准：dueAt 落在 plan.date 当天（Asia/Shanghai，
 *      不依赖宿主时区）或已逾期都算紧急；滚动 24h 只作补充（例如次日凌晨截止）。
 *   4. 目标主线：每个 goal 当天至少一个推进块；最高优先 goal ≥ 25% capacity；
 *      没有命中任务时生成「主线推进」块（kind 依 goal.kind）。
 *      最高优先 goal 的 25% 是**预留给目标的时间**：在固定课程与逾期/今日截止任务之后、
 *      其余普通任务之前先占位成真实块（reserve = max(30, ceil(0.25 * capacity))，
 *      剩余容量不足时取剩余），避免「作业把一天吃满、主线 0 分钟」。
 *   5. 实践/输出：每周（周一起）≥ 3 个 practice|application|research 块；
 *      求职类 goal 当天保证一个 application 块。
 *   6. 精力曲线：上午高认知（study/homework），13:30~17:30 输出型，
 *      晚饭后复习/复盘，睡前不排新块。
 *   7. 固定仪式：晨间 5min 计划（ritual）、日终 10min 复盘（review，含 3 问）、
 *      运动 30min（exercise，可被容量挤掉，但排在低优先学习块之前）。
 *   8. 缓冲：≥ 50min 的块之后插 5~10min buffer（占时间轴，不计入 totalMinutes）。
 *   9. 复习：done 且 completedAt 距今 3 天或 7 天的任务生成 review 块（每天最多 2 个）。
 *  10. 确定性：相同输入输出完全一致（除 generatedAt）；平局按 task.id 字典序
 *      （seed 为 0 时严格如此；非 0 seed 时用确定性哈希决定平局，见 compareEntries）。
 *  11. 周日额外加「周复盘」review 块。
 *
 * 硬约束：块之间不重叠、不越出 wakeAt~quietStart、end > start、
 *         非 buffer/break 块分钟和（totalMinutes）≤ capacity。
 *
 * 实现约定（契约没写死、由本文件定义并在实现中保持一致）：
 *   - 「工时」按 CONTRACT §2.2 的定义 = 所有非 buffer/break 块的分钟和；
 *     因此固定课程块也计入 capacity 预算（课程占掉的时间不能再排自习），
 *     若课程本身已超出 capacity，只告警并保留课程块（用户的课不可能被删）。
 *   - 精力曲线是“偏好窗口”：当偏好窗口都被占满时允许退到其它空闲时段（唯一硬约束是时间窗）。
 *   - intel 参数被接收但当前不参与排程（§2.3 没有对应规则），保留以便后续接入。
 *   - 任务模型 §1 没列 completedAt，但 §2.3.9 引用了它：优先读 completedAt，
 *     缺失时退回 updatedAt（任务完成时宿主会更新 updatedAt）。
 *   - 任务预估超过 90min 会拆成多个块（同一 taskId，标题带 (1/2)），
 *     容量不足时只排剩余容量能容纳的部分，其余分钟数进 unscheduled。
 *   - 排程顺序（= 容量紧张时的挤压顺序）：
 *       固定课程占位 → 固定仪式（晨间 5min / 日终复盘 10min / 周日周复盘 20min）
 *       → 逾期 / 计划日当天截止 / 24h 内截止的任务 → 最高优先目标的主线预留块
 *       → 其余任务（按 score）→ 其它目标的主线推进块（含最高优先目标的补足）
 *       → 间隔复习 → 求职投递保证 → 运动 → 每周实践/输出配额。
 *     固定仪式只有 5~20 分钟且是规则 7/11 要求的“固定”项，所以先占位；
 *     运动、复习、周配额按规则 7/9/5 属于可被挤压的柔性块，放在任务之后。
 */

// ============================================================ 常量与默认值

const MINUTES_PER_DAY = 1440;
/** 计划日按 Asia/Shanghai 解释（§2.1：本地时区 Asia/Shanghai），不依赖宿主时区。 */
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

const DEFAULT_CONSTRAINTS = Object.freeze({
  dailyMinutes: 180,
  weekdayMinutes: Object.freeze({ 1: 180, 2: 180, 3: 180, 4: 180, 5: 180, 6: 240, 0: 120 }),
  quietStart: '23:30',
  quietEnd: '07:00',
  wakeAt: '07:30',
  sleepAt: '23:30',
  daysOff: Object.freeze([0]),
});

const TASK_KINDS = new Set(['course', 'homework', 'exam', 'practice', 'application', 'research', 'reading', 'other']);
const GOAL_KINDS = new Set(['postgrad', 'job', 'exam', 'abroad', 'skill', 'other']);
const STATUS_ACTIVE = new Set(['todo', 'doing']);
const STATUS_KNOWN = new Set(['todo', 'doing', 'done', 'skipped', 'blocked']);
const NON_WORK_KINDS = new Set(['buffer', 'break']);
// 有 startAt/endAt 的固定时段块，kind 跟随任务本身的类型（课程/练习/作业…）；
// 只有任务没给 kind 时才退回 course。否则「晚上 21:30 高数卷子」会被标成课堂、
// 理由写成「课堂吸收是第一遍学习」，跟用户看到的实情不符。
const FIXED_BLOCK_KINDS = new Set(['course', 'homework', 'exam', 'practice', 'application', 'research', 'reading', 'study', 'exercise', 'review', 'other']);
/** 规则 5 的“实践/输出”块；每周配额与求职保证都基于它。 */
const OUTPUT_KINDS = new Set(['practice', 'application', 'research']);

/** 规则 3：score = 1000/(1+hoursUntilDue) + (6-priority)*80 + goalWeight + kindBonus - aging */
const KIND_BONUS = Object.freeze({
  course: 20,
  homework: 25,
  exam: 40,
  practice: 30,
  application: 35,
  research: 20,
  reading: 10,
  other: 0,
});

const DEFAULT_ESTIMATE = Object.freeze({
  course: 45,
  homework: 45,
  exam: 60,
  practice: 45,
  application: 30,
  research: 60,
  reading: 30,
  other: 30,
});

/** 再长的任务也拆块：单个块最多 90min，块最小 15min。 */
const MAX_TASK_CHUNK = 90;
const MIN_TASK_CHUNK = 15;
/** 规则 5：每周至少 3 个实践/输出块（周一起算）。 */
const WEEK_OUTPUT_TARGET = 3;
/** 规则 9：间隔复习块固定 20min，每天最多 2 个。 */
const REVIEW_BLOCK_MINUTES = 20;
const MAX_REVIEW_BLOCKS = 2;
/** buffer 规则的阈值：≥ 80min 给 10min，≥ 50min 给 5min。 */
const LONG_BLOCK_MINUTES = 50;
const VERY_LONG_BLOCK_MINUTES = 80;

// 精力曲线（分钟，规则 6）
const MORNING_END = 11 * 60 + 30; // 11:30
const AFTERNOON_START = 13 * 60 + 30; // 13:30
const AFTERNOON_END = 17 * 60 + 30; // 17:30
const EXERCISE_START = 17 * 60 + 30; // 17:30
const EXERCISE_END = 19 * 60 + 30; // 19:30
const EVENING_START = 19 * 60; // 19:00
const EVENING_END = 22 * 60; // 22:00

// ============================================================ 时间格式工具

/**
 * 'HH:MM' -> 从 0 点起的分钟数；'08:30' -> 510。
 * 容忍 '8:30' / '08:30:00'；非法输入返回 NaN；'24:00' 合法（= 1440）。
 */
export function minutesOfDay(hhmm) {
  if (typeof hhmm !== 'string') return NaN;
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(hhmm.trim());
  if (!match) return NaN;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return NaN;
  if (minute > 59 || hour > 24) return NaN;
  if (hour === 24 && minute !== 0) return NaN;
  return hour * 60 + minute;
}

/** 分钟数 -> 'HH:MM'；510 -> '08:30'。1440 保留为 '24:00'，其余按 24h 环绕。 */
export function fmtClock(minutes) {
  const value = Math.round(Number(minutes));
  if (!Number.isFinite(value)) return '00:00';
  if (value === MINUTES_PER_DAY) return '24:00';
  const wrapped = ((value % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = Math.floor(wrapped / 60);
  const minute = wrapped % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function timeToMinutes(value, fallback) {
  const parsed = minutesOfDay(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ============================================================ 日期工具

function isDateKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function dateKeyToUtcMs(key) {
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/** Date.getDay() 的等价物（0=周日），且不依赖宿主时区。 */
function weekdayOfDateKey(key) {
  return new Date(dateKeyToUtcMs(key)).getUTCDay();
}

function addDaysToDateKey(key, days) {
  return new Date(dateKeyToUtcMs(key) + days * 86400000).toISOString().slice(0, 10);
}

function dayDiffKeys(fromKey, toKey) {
  return Math.round((dateKeyToUtcMs(toKey) - dateKeyToUtcMs(fromKey)) / 86400000);
}

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** 把时刻折算成 Asia/Shanghai 的日历日 'YYYY-MM-DD'。 */
function shanghaiDayKey(date) {
  return new Date(date.getTime() + CHINA_OFFSET_MS).toISOString().slice(0, 10);
}

/** 把时刻折算成 Asia/Shanghai 当天的分钟数（0~1439）。 */
function shanghaiMinutes(date) {
  const shifted = new Date(date.getTime() + CHINA_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

// ============================================================ 通用小工具

/** 字典序比较（code unit，避免 localeCompare 随宿主环境变化而破坏确定性）。 */
function cmpStr(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** FNV-1a 32 位哈希：只给非 0 seed 的确定性平局用。 */
function hash32(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function clampPriority(value, fallback = 3) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(5, Math.max(1, Math.round(number)));
}

function normalizeKind(value) {
  const kind = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return TASK_KINDS.has(kind) ? kind : 'other';
}

function normalizeStatus(value) {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!status) return 'todo';
  // 契约枚举之外的脏数据按 todo 处理，避免整条任务被静默丢掉。
  return STATUS_KNOWN.has(status) ? status : 'todo';
}

function taskTitle(task) {
  const title = task && typeof task.title === 'string' ? task.title.trim() : '';
  return title || '未命名任务';
}

function taskIdOf(task, index) {
  const id = task && typeof task.id === 'string' ? task.id.trim() : '';
  return id || `t_anon_${index}`;
}

function goalIdOf(task) {
  return task && typeof task.goalId === 'string' ? task.goalId.trim() : '';
}

/** 截断到 max 个字符（按 Unicode 码点），超长用省略号收尾。 */
function truncateText(text, max) {
  const chars = Array.from(String(text == null ? '' : text));
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

function normalizeSeed(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.trunc(number);
}

// ============================================================ profile 归一化

function normalizeConstraints(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const weekday = { ...DEFAULT_CONSTRAINTS.weekdayMinutes };
  const providedWeekday = {};
  if (source.weekdayMinutes && typeof source.weekdayMinutes === 'object') {
    for (let day = 0; day < 7; day += 1) {
      const key = String(day);
      const value = Number(source.weekdayMinutes[key]);
      if (Number.isFinite(value) && value >= 0 && value <= MINUTES_PER_DAY) {
        weekday[key] = Math.round(value);
        providedWeekday[key] = true;
      }
    }
  }
  const daily = Number(source.dailyMinutes);
  const providedDaily =
    Number.isFinite(daily) && daily >= 0 && daily <= MINUTES_PER_DAY ? Math.round(daily) : null;
  return {
    dailyMinutes: providedDaily == null ? DEFAULT_CONSTRAINTS.dailyMinutes : providedDaily,
    weekdayMinutes: weekday,
    // 记录“用户真的写过的字段”，决定 capacity 的取值优先级（见 capacityFor）
    providedWeekday,
    providedDaily,
    quietStart: timeOr(source.quietStart, DEFAULT_CONSTRAINTS.quietStart),
    quietEnd: timeOr(source.quietEnd, DEFAULT_CONSTRAINTS.quietEnd),
    wakeAt: timeOr(source.wakeAt, DEFAULT_CONSTRAINTS.wakeAt),
    sleepAt: timeOr(source.sleepAt, DEFAULT_CONSTRAINTS.sleepAt),
    daysOff: Array.isArray(source.daysOff)
      ? [...new Set(source.daysOff.map((day) => Number(day)).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
      : [...DEFAULT_CONSTRAINTS.daysOff],
  };
}

function timeOr(value, fallback) {
  const parsed = minutesOfDay(value);
  return Number.isFinite(parsed) ? fmtClock(parsed) : fallback;
}

function normalizeGoals(raw) {
  if (!Array.isArray(raw)) return [];
  const goals = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    goals.push({
      id,
      kind: GOAL_KINDS.has(item.kind) ? item.kind : 'other',
      title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : '未命名目标',
      target: typeof item.target === 'string' ? item.target : '',
      targetDate: isDateKey(item.targetDate) ? item.targetDate : '',
      priority: clampPriority(item.priority, 3),
      notes: typeof item.notes === 'string' ? item.notes : '',
    });
  }
  return goals;
}

function normalizeProfile(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    identity: source.identity && typeof source.identity === 'object' ? source.identity : {},
    goals: normalizeGoals(source.goals),
    constraints: normalizeConstraints(source.constraints),
    resources: Array.isArray(source.resources) ? source.resources : [],
  };
}

/**
 * 当日 capacity：显式写的 weekdayMinutes[day] 优先，其次显式写的 dailyMinutes，
 * 最后才是默认的 weekdayMinutes 表。§2.3.1 的“weekdayMinutes[day] 或 dailyMinutes”。
 */
function capacityFor(constraints, weekdayIndex) {
  const key = String(weekdayIndex);
  if (constraints.providedWeekday[key]) return constraints.weekdayMinutes[key];
  if (constraints.providedDaily != null) return constraints.providedDaily;
  return constraints.weekdayMinutes[key];
}

// ============================================================ 评分（规则 3）

function makeScoreContext(nowMs, goals, planDate) {
  const goalById = new Map();
  for (const goal of goals) if (goal && goal.id) goalById.set(goal.id, goal);
  // planDate 用于判断 dueAt 是否落在计划日当天（scoreTask 没有日期参数，留空即只用 24h 兜底）。
  return { nowMs, goalById, planDate: isDateKey(planDate) ? planDate : '' };
}

function createScoreContext(now, rawProfile) {
  const profile = normalizeProfile(rawProfile);
  const nowDate = toDate(now) || new Date(0);
  return {
    nowMs: nowDate.getTime(),
    goalById: new Map(profile.goals.map((goal) => [goal.id, goal])),
    planDate: '',
  };
}

/** 规则 3 的 aging：创建超过 7 天后，每多一天扣 5 分（最多扣 150），抑制长期滚动的老任务。 */
function agingPenalty(task, nowMs) {
  const created = toDate(task.createdAt);
  if (!created) return 0;
  const days = Math.floor((nowMs - created.getTime()) / 86400000);
  if (!(days > 7)) return 0;
  return Math.min(150, (days - 7) * 5);
}

/**
 * 单个任务的全部决策因子。score 严格按 §2.3.3：
 *   score = 1000/(1+hoursUntilDue) + (6-priority)*80 + goalWeight + kindBonus - aging
 * 逾期任务 hoursUntilDue 视为 0（dueTerm 取满 1000）；“逾期置顶”由排序里的
 * overdue 主键保证（单看数值时，一个 10 分钟后截止的高优先任务可能比逾期低优先任务更高）。
 */
function readTaskFacts(task, ctx) {
  const dueDate = toDate(task.dueAt);
  const overdue = Boolean(dueDate) && dueDate.getTime() < ctx.nowMs;
  const hoursUntilDue = dueDate ? Math.max(0, (dueDate.getTime() - ctx.nowMs) / 3600000) : Infinity;
  const dueTerm = Number.isFinite(hoursUntilDue) ? 1000 / (1 + hoursUntilDue) : 0;
  const priority = clampPriority(task.priority, 3);
  const priorityTerm = (6 - priority) * 80;
  const goal = ctx.goalById.get(goalIdOf(task)) || null;
  const goalWeight = goal ? (goal.priority === 1 ? 120 : goal.priority === 2 ? 70 : 40) : 0;
  const kindBonus = KIND_BONUS[normalizeKind(task.kind)] || 0;
  const aging = agingPenalty(task, ctx.nowMs);
  return {
    dueDate,
    overdue,
    dueSoon: Boolean(dueDate) && !overdue && hoursUntilDue <= 72, // 规则 3：3 天内高权重
    // 「今日截止」= dueAt 落在计划日当天（Asia/Shanghai 日历日）或已逾期；
    // 滚动 24h 作为补充（覆盖“次日凌晨截止但离 now 不到一天”的情形）。
    // 注意不能用宿主时区判断“当天”，planDay 传入的 planDate 是 'YYYY-MM-DD'。
    dueImminent:
      Boolean(dueDate) &&
      !overdue &&
      ((Boolean(ctx.planDate) && shanghaiDayKey(dueDate) === ctx.planDate) || hoursUntilDue <= 24),
    hoursUntilDue,
    priority,
    goal,
    score: dueTerm + priorityTerm + goalWeight + kindBonus - aging,
  };
}

/** 越大越该先做。逾期任务额外提权，保证“逾期置顶”。 */
export function scoreTask({ task, now, profile } = {}) {
  const ctx = createScoreContext(now, profile);
  const facts = readTaskFacts(task && typeof task === 'object' ? task : {}, ctx);
  return Math.round(facts.score * 100) / 100;
}

/**
 * 任务排序（规则 10 的确定性平局）：
 *   1) 逾期优先；2) scoreTask 降序；3) seed 非 0 时按哈希平局；4) task.id 字典序（升序）。
 * seed 为 0（默认）时严格按 task.id 字典序，符合 §2.3.10。
 */
function compareEntries(a, b, seed) {
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  if (b.score !== a.score) return b.score - a.score;
  if (seed !== 0) {
    const hashA = hash32(`${seed}|${a.taskId}`);
    const hashB = hash32(`${seed}|${b.taskId}`);
    if (hashA !== hashB) return hashA - hashB;
  }
  return cmpStr(a.taskId, b.taskId);
}

// ============================================================ 任务/目标 -> 块语义

function blockKindForTask(taskKind) {
  switch (taskKind) {
    case 'course':
      return 'course';
    case 'homework':
      return 'homework';
    case 'practice':
      return 'practice';
    case 'application':
      return 'application';
    case 'research':
      return 'research';
    default:
      return 'study';
  }
}

/** 规则 4：goal.kind -> 主线块 kind（postgrad→study、job→application、skill→practice）。 */
function blockKindForGoal(goalKind) {
  switch (goalKind) {
    case 'postgrad':
    case 'exam':
      return 'study';
    case 'job':
    case 'abroad':
      return 'application';
    case 'skill':
      return 'practice';
    default:
      return 'study';
  }
}

function goalActionText(goalKind) {
  switch (goalKind) {
    case 'postgrad':
      return '专业课/数学各推进一小节';
    case 'exam':
      return '按考纲刷一节题并订正';
    case 'job':
      return '投 1 个岗位 / 改一版简历';
    case 'abroad':
      return '推进一项申请材料';
    case 'skill':
      return '做一个可展示的小作品';
    default:
      return '推进一个最小可交付步骤';
  }
}

/** 规则 6 的精力曲线偏好窗口；唯一硬约束是 wakeAt~quietStart，偏好被占满时允许退让。 */
function preferredRanges(blockKind) {
  switch (blockKind) {
    case 'study':
    case 'homework':
    case 'course':
      return [
        [0, MORNING_END],
        [AFTERNOON_START, AFTERNOON_END],
        [EVENING_START, EVENING_END],
      ];
    case 'practice':
    case 'application':
    case 'research':
      return [
        [AFTERNOON_START, AFTERNOON_END],
        [0, MORNING_END],
        [EVENING_START, EVENING_END - 30],
      ];
    case 'review':
      return [
        [EVENING_START, EVENING_END],
        [AFTERNOON_START, AFTERNOON_END],
      ];
    case 'exercise':
      return [
        [EXERCISE_START, EXERCISE_END],
        [0, MORNING_END],
      ];
    case 'ritual':
      return [[0, MORNING_END]];
    default:
      return [[0, MINUTES_PER_DAY]];
  }
}

function estimateOf(task) {
  const raw = Number(task && task.estMinutes);
  if (Number.isFinite(raw) && raw > 0) return Math.min(600, Math.round(raw));
  return DEFAULT_ESTIMATE[normalizeKind(task && task.kind)] || 30;
}

/** 超过 90min 的任务拆成均匀小块，保证单个块可执行。 */
function splitEstimate(minutes) {
  const total = Math.max(MIN_TASK_CHUNK, Math.round(Number(minutes) || 0));
  const count = Math.max(1, Math.ceil(total / MAX_TASK_CHUNK));
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  const chunks = [];
  for (let index = 0; index < count; index += 1) chunks.push(base + (index < remainder ? 1 : 0));
  return chunks;
}

// ============================================================ 时间轴工具

/** 从 free 里挖掉 [start,end)，返回仍按 start 升序的空闲区间。 */
function subtractRange(free, start, end) {
  const result = [];
  for (const slot of free) {
    if (end <= slot.start || start >= slot.end) {
      result.push(slot);
      continue;
    }
    if (start > slot.start) result.push({ start: slot.start, end: Math.min(start, slot.end) });
    if (end < slot.end) result.push({ start: Math.max(end, slot.start), end: slot.end });
  }
  return result.filter((slot) => slot.end > slot.start).sort((a, b) => a.start - b.start);
}

function makeTimeline(windowStart, windowEnd, occupied) {
  let free = [{ start: windowStart, end: windowEnd }];
  const sorted = occupied.slice().sort((a, b) => a.start - b.start);
  for (const interval of sorted) free = subtractRange(free, interval.start, interval.end);
  return free;
}

/**
 * 在空闲区间里找一个 duration 长度的位置。
 * ranges 是偏好窗口（升序优先级）；latest=true 时在窗口内取“最靠后”的位置（用于日终复盘）。
 * 偏好窗口放不下时退到任意空闲区间（硬约束只有时间窗）。
 */
function findSlot(free, duration, ranges, latest) {
  if (latest) {
    for (const range of ranges) {
      const from = Math.max(0, Number(range[0]));
      const to = Math.min(MINUTES_PER_DAY, Number(range[1]));
      if (!(to - from >= duration)) continue;
      for (let index = free.length - 1; index >= 0; index -= 1) {
        const slot = free[index];
        const start = Math.min(slot.end, to) - duration;
        if (start >= Math.max(slot.start, from)) return start;
      }
    }
    for (let index = free.length - 1; index >= 0; index -= 1) {
      const slot = free[index];
      if (slot.end - slot.start >= duration) return slot.end - duration;
    }
    return null;
  }
  for (const range of ranges) {
    const from = Math.max(0, Number(range[0]));
    const to = Math.min(MINUTES_PER_DAY, Number(range[1]));
    if (!(to - from >= duration)) continue;
    for (const slot of free) {
      const start = Math.max(slot.start, from);
      if (start + duration <= Math.min(slot.end, to)) return start;
    }
  }
  for (const slot of free) {
    if (slot.end - slot.start >= duration) return slot.start;
  }
  return null;
}

function bufferMinutesFor(blockMinutes) {
  if (blockMinutes >= VERY_LONG_BLOCK_MINUTES) return 10;
  if (blockMinutes >= LONG_BLOCK_MINUTES) return 5;
  return 0;
}

// ============================================================ 固定课程（规则 2）

function collectFixedTodayIds(tasks, dateStr) {
  const ids = new Set();
  tasks.forEach((task, index) => {
    if (!task || typeof task !== 'object') return;
    const start = toDate(task.startAt);
    const end = toDate(task.endAt);
    if (!start || !end || end.getTime() <= start.getTime()) return;
    if (shanghaiDayKey(start) !== dateStr) return;
    ids.add(taskIdOf(task, index));
  });
  return ids;
}

/**
 * 规则 2：startAt/endAt 齐全且落在计划日的任务先占位。
 * 处理跨天、超出时间窗（裁剪并告警）、课程之间重叠（顺延并告警）。
 */
function collectFixedCourses(tasks, dateStr, windowStart, windowEnd, addWarning) {
  const candidates = [];
  const unscheduled = [];
  const seen = new Set();
  tasks.forEach((task, index) => {
    if (!task || typeof task !== 'object') return;
    const taskId = taskIdOf(task, index);
    if (seen.has(taskId)) return;
    seen.add(taskId);
    if (!STATUS_ACTIVE.has(normalizeStatus(task.status))) return;
    const start = toDate(task.startAt);
    const end = toDate(task.endAt);
    if (!start || !end || end.getTime() <= start.getTime()) return;
    if (shanghaiDayKey(start) !== dateStr) return; // 其它日子的固定时段与今天无关
    if (shanghaiDayKey(end) !== dateStr) {
      unscheduled.push({ taskId, reason: '固定时段跨天，未排入今日计划' });
      return;
    }
    candidates.push({ taskId, task, startMin: shanghaiMinutes(start), endMin: shanghaiMinutes(end) });
  });

  candidates.sort((a, b) => a.startMin - b.startMin || cmpStr(a.taskId, b.taskId));

  const items = [];
  let cursor = -1;
  for (const candidate of candidates) {
    const title = taskTitle(candidate.task);
    let start = Math.max(candidate.startMin, windowStart);
    let end = Math.min(candidate.endMin, windowEnd);
    if (end <= start) {
      unscheduled.push({ taskId: candidate.taskId, reason: '固定时段不在可用时间窗内' });
      continue;
    }
    if (candidate.startMin < windowStart || candidate.endMin > windowEnd) {
      addWarning(`固定时段「${title}」超出可用时间窗，已裁剪到时间窗内`);
    }
    if (start < cursor) {
      addWarning(`固定时段「${title}」与前面的块重叠，已顺延`);
      start = cursor;
    }
    if (end <= start) {
      unscheduled.push({ taskId: candidate.taskId, reason: '固定时段与其它课程重叠，未排入今日计划' });
      continue;
    }
    items.push({
      taskId: candidate.taskId,
      task: candidate.task,
      goalId: goalIdOf(candidate.task),
      title,
      startMin: start,
      endMin: end,
    });
    cursor = end;
  }
  return { items, unscheduled };
}

// ============================================================ 任务条目

function buildTaskEntries(tasks, ctx, dateStr, fixedTodayIds) {
  const entries = [];
  const seen = new Set();
  tasks.forEach((task, index) => {
    if (!task || typeof task !== 'object') return;
    const taskId = taskIdOf(task, index);
    if (seen.has(taskId)) return;
    seen.add(taskId);
    const status = normalizeStatus(task.status);
    const kind = normalizeKind(task.kind);
    const facts = readTaskFacts(task, ctx);
    const entry = {
      taskId,
      task,
      status,
      kind,
      title: taskTitle(task),
      estimate: estimateOf(task),
      score: facts.score,
      overdue: facts.overdue,
      dueSoon: facts.dueSoon,
      dueImminent: facts.dueImminent,
      dueDate: facts.dueDate,
      priority: facts.priority,
      goal: facts.goal,
      goalId: facts.goal ? facts.goal.id : '',
      fixed: fixedTodayIds.has(taskId),
      offDay: false,
      schedulable: false,
      reason: '',
    };
    if (entry.fixed) {
      // 固定时段在阶段 A 已处理：成功则已占位，失败原因由 unscheduledMap 记录。
    } else if (status === 'skipped' || status === 'blocked') {
      entry.reason = `状态为 ${status}，不参与今日排程`;
    } else if (status !== 'done') {
      const start = toDate(task.startAt);
      // 固定时段落在别的日期（含未来几周的课表实例）：今天既不排、也不该出现在「未安排」里，
      // 否则 16 周的课程会让每日计划带着上百条噪音。只有「本来就该今天做却排不进」才算 unscheduled。
      if (start && shanghaiDayKey(start) !== dateStr) entry.offDay = true;
    }
    entry.schedulable = !entry.fixed && !entry.offDay && !entry.reason && STATUS_ACTIVE.has(status);
    entries.push(entry);
  });
  return entries;
}

// ============================================================ 文案

function duePhrase(dueDate, dateStr) {
  if (!dueDate) return '';
  const diff = dayDiffKeys(dateStr, shanghaiDayKey(dueDate));
  if (diff <= 0) return '今天';
  if (diff === 1) return '明天';
  return `${diff} 天后`;
}

function whyForEntry(entry, dateStr) {
  if (entry.overdue && entry.dueDate) {
    return `已逾期（${shanghaiDayKey(entry.dueDate)} 截止），今天先清掉，避免越拖越贵。`;
  }
  if (entry.dueSoon && entry.dueDate) {
    return `截止在即（${duePhrase(entry.dueDate, dateStr)}），按截止压力优先处理。`;
  }
  if (entry.goal) return `服务目标「${entry.goal.title}」，越早推进后面越有余量。`;
  if (entry.priority === 1) return '你标了最高优先级，先把最硬的骨头啃下来。';
  return '持续投入抬高水平，比临期补更划算。';
}

function outputForTask(task, blockKind) {
  const title = taskTitle(task);
  switch (blockKind) {
    case 'homework':
      return `交得出去：完成「${title}」并自查 1 遍`;
    case 'practice':
      return '产出 1 个可展示的结果（截图/代码/笔记）';
    case 'application':
      return '投出 1 份，或完成 1 个岗位的简历定制';
    case 'research':
      return '记下 3 条可执行结论';
    case 'course':
      return '课堂笔记 + 1 个待解决问题';
    default:
      return `完成「${title}」的可验收产出（做完可自查）`;
  }
}

function goalThemeLabel(goalKind) {
  switch (goalKind) {
    case 'postgrad':
      return '考研主线';
    case 'exam':
      return '考试冲刺';
    case 'job':
      return '求职投递';
    case 'abroad':
      return '留学申请';
    case 'skill':
      return '技能实践';
    default:
      return '主线推进';
  }
}

// ============================================================ 对外：空计划

export function emptyPlan(date) {
  return {
    date: isDateKey(date) ? date : '',
    generatedAt: new Date().toISOString(),
    focus: '',
    theme: '',
    blocks: [],
    unscheduled: [],
    totalMinutes: 0,
    load: { planned: 0, capacity: 0 },
    warnings: [],
  };
}

// ============================================================ 对外：planDay

/**
 * 生成某一天的计划（纯函数、同步、无 IO、无随机）。
 *
 * input: {
 *   date: 'YYYY-MM-DD',
 *   now: Date,
 *   profile,
 *   tasks,
 *   intel?,    // 可空（当前不参与排程，见文件头说明）
 *   history?,  // 最近 7 天计划，用于规则 5 的每周实践/输出配额
 *   seed?      // 默认 0
 * }
 */
export function planDay(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const nowDate = toDate(raw.now) || new Date();
  const nowMs = nowDate.getTime();
  const dateStr = isDateKey(raw.date) ? raw.date : shanghaiDayKey(nowDate);
  const profile = normalizeProfile(raw.profile);
  const constraints = profile.constraints;
  const weekdayIndex = weekdayOfDateKey(dateStr);
  const capacity = capacityFor(constraints, weekdayIndex);

  // 规则 1：时间窗 wakeAt ~ quietStart；quietStart 不晚于 wakeAt 时按“到当地午夜”处理（块不能跨天）。
  const windowStart = Math.min(MINUTES_PER_DAY - 1, Math.max(0, timeToMinutes(constraints.wakeAt, 450)));
  const quietMinutes = timeToMinutes(constraints.quietStart, 1410);
  const windowEnd =
    quietMinutes > windowStart ? Math.min(MINUTES_PER_DAY, quietMinutes) : MINUTES_PER_DAY;

  const warnings = [];
  const warningSeen = new Set();
  const addWarning = (text) => {
    const message = typeof text === 'string' ? text.trim() : '';
    if (!message || warningSeen.has(message)) return;
    warningSeen.add(message);
    warnings.push(message);
  };

  const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  const history = Array.isArray(raw.history) ? raw.history : [];
  const seed = normalizeSeed(raw.seed);

  // ---- 目标（规则 4）：priority 1 最高；targetDate 已过的目标不硬排主线，只告警 ----
  const orderedGoals = profile.goals
    .slice()
    .sort((a, b) => a.priority - b.priority || cmpStr(a.id, b.id));
  const liveGoals = [];
  for (const goal of orderedGoals) {
    if (goal.targetDate && goal.targetDate < dateStr) {
      addWarning(`目标「${goal.title}」已过目标日期 ${goal.targetDate}，建议更新目标或日期`);
      continue;
    }
    liveGoals.push(goal);
  }
  const topGoal = liveGoals.length ? liveGoals[0] : null;
  // 把计划日交给评分上下文：「今日截止」按计划日判断，而不是滚动 24h。
  const ctx = makeScoreContext(nowMs, profile.goals, dateStr);

  if (capacity <= 0) addWarning('今日容量为 0，未安排任何块');

  // ---- 阶段 A：固定时段先占位（规则 2）------------------------------------
  const unscheduledMap = new Map();
  const setUnscheduled = (taskId, reason) => {
    if (!taskId || unscheduledMap.has(taskId)) return;
    unscheduledMap.set(taskId, reason);
  };

  const fixedTodayIds = collectFixedTodayIds(tasks, dateStr);
  const fixed = collectFixedCourses(tasks, dateStr, windowStart, windowEnd, addWarning);
  for (const item of fixed.unscheduled) setUnscheduled(item.taskId, item.reason);

  const entries = buildTaskEntries(tasks, ctx, dateStr, fixedTodayIds);
  for (const entry of entries) if (entry.reason) setUnscheduled(entry.taskId, entry.reason);

  // 规则 3：逾期任务必须出现在 warnings 里（“已逾期”是面板/推送的关键提示）。
  for (const entry of entries) {
    if (!STATUS_ACTIVE.has(entry.status) || !entry.overdue || !entry.dueDate) continue;
    addWarning(`「${entry.title}」已逾期（${shanghaiDayKey(entry.dueDate)} 截止），已置顶优先处理`);
  }

  // ---- 容量预算：规则 1 的“总工时 ≤ capacity”（见文件头的实现约定）----------
  const courseMinutes = fixed.items.reduce((sum, item) => sum + (item.endMin - item.startMin), 0);
  let budget = capacity - courseMinutes;
  if (budget < 0) {
    addWarning(`固定课程已占 ${courseMinutes} 分钟，超出今日容量 ${capacity} 分钟，其余任务无法安排`);
    budget = 0;
  }

  const state = {
    free: makeTimeline(
      windowStart,
      windowEnd,
      fixed.items.map((item) => ({ start: item.startMin, end: item.endMin })),
    ),
    blocks: [],
    budget,
  };

  /** goalId -> 已排分钟数（用于规则 4 的“每个目标至少一块 / 最高优先 ≥25%） */
  const coverage = new Map();
  const addCoverage = (goalId, minutes) => {
    if (!goalId || !(minutes > 0) || !ctx.goalById.has(goalId)) return;
    coverage.set(goalId, (coverage.get(goalId) || 0) + minutes);
  };

  for (const item of fixed.items) {
    const taskKind = item.task && typeof item.task.kind === 'string' ? item.task.kind : '';
    const blockKind = FIXED_BLOCK_KINDS.has(taskKind) ? taskKind : 'course';
    const minutes = item.endMin - item.startMin;
    state.blocks.push({
      startMin: item.startMin,
      endMin: item.endMin,
      kind: blockKind,
      title: item.title,
      taskIds: [item.taskId],
      why:
        blockKind === 'course'
          ? '固定课程先占位：课堂吸收是第一遍学习，先保住不欠新账。'
          : `固定在今天 ${fmtClock(item.startMin)}-${fmtClock(item.endMin)}：把它当成不可移动的训练，先占住时间。`,
      output: blockKind === 'course' ? '课堂笔记 + 1 个待解决问题' : '',
      minutes,
      done: false,
    });
    addCoverage(item.goalId, minutes);
  }

  // ---- 时间轴放置工具（闭包，直接读写 state）-------------------------------

  /** 规则 8：≥50min 的块之后插 buffer（5~10min，占时间轴但不计入 totalMinutes）。 */
  function maybeAddBufferFor(block) {
    const size = bufferMinutesFor(block.minutes);
    if (!size) return;
    const start = block.endMin;
    const end = start + size;
    if (end > windowEnd) return;
    const slot = state.free.find((item) => item.start <= start && item.end >= end);
    if (!slot) return;
    state.free = subtractRange(state.free, start, end);
    state.blocks.push({
      startMin: start,
      endMin: end,
      kind: 'buffer',
      title: '缓冲：走动、喝水、远眺',
      taskIds: [],
      why: '长时间块之间留缓冲，保护注意力与可持续节奏。',
      output: '',
      minutes: size,
      done: false,
    });
  }

  /**
   * 放一个块：先按时段偏好找位置，再按剩余容量截断。
   * 返回 { ok, block?, minutes?, truncated?, reason?: 'capacity'|'time' }。
   */
  function placeBlock(options) {
    const {
      duration,
      ranges,
      kind,
      title,
      taskIds = [],
      why = '',
      output = '',
      latest = false,
      minMinutes = 5,
      allowPartial = true,
    } = options || {};
    const want = Math.round(Number(duration));
    if (!Number.isFinite(want) || want < minMinutes) return { ok: false, reason: 'capacity' };
    if (state.budget < 5) return { ok: false, reason: 'capacity' };

    let length = Math.min(want, state.budget);
    const truncated = length < want;
    if (truncated && !allowPartial) return { ok: false, reason: 'capacity' };
    // 截断后要仍然有意义：任务块不产生 <15min 的碎片（块标题与产出都失去意义）。
    if (length < Math.min(minMinutes, want)) return { ok: false, reason: 'capacity' };

    // 偏好窗口夹到时间窗内（唯一硬约束）
    const windows = [];
    for (const range of Array.isArray(ranges) && ranges.length ? ranges : [[windowStart, windowEnd]]) {
      const from = Math.max(windowStart, Number(range[0]));
      const to = Math.min(windowEnd, Number(range[1]));
      if (to > from) windows.push([from, to]);
    }
    const start = findSlot(state.free, length, windows.length ? windows : [[windowStart, windowEnd]], latest);
    if (start == null) return { ok: false, reason: 'time' };

    state.free = subtractRange(state.free, start, start + length);
    state.budget -= length;
    const block = {
      startMin: start,
      endMin: start + length,
      kind,
      title,
      taskIds: taskIds.slice(),
      why,
      output,
      minutes: length,
      done: false,
    };
    state.blocks.push(block);
    maybeAddBufferFor(block);
    return { ok: true, block, minutes: length, truncated };
  }

  // 固定课程后的 buffer（规则 8）
  for (const block of state.blocks.slice()) maybeAddBufferFor(block);

  // ---- 规则 7：固定仪式（先占位，保证不被任务挤掉）-------------------------
  const morningRitual = placeBlock({
    duration: 5,
    ranges: [[windowStart, Math.min(windowEnd, windowStart + 120)]],
    kind: 'ritual',
    title: '晨间计划：写下今天 3 件事',
    why: '先定计划再动手，避免一天的注意力被碎片吃掉。',
    output: '写下今日 3 件事与第一件事',
    allowPartial: false,
  });
  if (!morningRitual.ok) addWarning('晨间计划块未能排入（容量/时间不足）');

  // 日终复盘：锚定在睡前（时间窗末尾），含 3 问。
  const eveningReview = placeBlock({
    duration: 10,
    ranges: [[Math.max(windowStart, EVENING_START), windowEnd]],
    kind: 'review',
    title: '日终复盘：完成了什么 / 卡在哪 / 明天第一件事',
    why: '日终复盘把一天的经验沉淀成明天的行动。',
    output: '回答 3 问：完成了什么 / 卡在哪 / 明天第一件事',
    latest: true,
    allowPartial: false,
  });
  if (!eveningReview.ok) addWarning('日终复盘块未能排入（容量/时间不足）');

  // 规则 11：周日额外一个「周复盘」块（放在日终复盘之前）。
  if (weekdayIndex === 0) {
    const weeklyReview = placeBlock({
      duration: 20,
      ranges: [[Math.max(windowStart, 18 * 60 + 30), Math.min(windowEnd, EVENING_END + 30)]],
      kind: 'review',
      title: '周复盘：主线完成度 / 下周 3 个关键动作',
      why: '每周固定复盘，判断主线是否偏航，并把下周动作写具体。',
      output: '写下本周主线完成度 + 下周 3 个关键动作',
      latest: true,
      allowPartial: false,
    });
    if (!weeklyReview.ok) addWarning('周复盘块未能排入（容量/时间不足）');
  }

  // ---- 规则 3：任务排序（逾期 / 计划日当天截止 / 24h 内截止先排；其余按 score）---
  // 顺序即挤压顺序：逾期 & 今日截止 → 主线预留 → 其余任务。
  const placeable = entries
    .filter((entry) => entry.schedulable)
    .sort((a, b) => compareEntries(a, b, seed));
  const urgentEntries = placeable.filter((entry) => entry.overdue || entry.dueImminent);
  const restEntries = placeable.filter((entry) => !entry.overdue && !entry.dueImminent);

  function taskUnscheduledReason(entry, placedMinutes, remaining, failReason) {
    if (capacity <= 0) return '今日容量为 0，未排入';
    if (placedMinutes <= 0) {
      if (failReason === 'capacity') {
        return entry.overdue || entry.dueSoon
          ? '今日容量不足，未能安排（截止压力高，建议手动前移或减量）'
          : '今日容量不足，未排入';
      }
      return '今日时间窗不足（固定时段占满）';
    }
    if (failReason === 'capacity') return `今日容量不足，剩余 ${remaining} 分钟未排`;
    return `今日时间窗不足，剩余 ${remaining} 分钟未排`;
  }

  /**
   * 把一个任务排进时间轴：超过 90min 拆块；容量不足时排能容纳的部分并把剩余分钟数
   * 记进 unscheduled（不静默丢任务）。
   */
  function placeTaskEntry(entry) {
    const blockKind = blockKindForTask(entry.kind);
    const ranges = preferredRanges(blockKind);
    const chunks = splitEstimate(entry.estimate);
    let placed = 0;
    let failReason = '';
    for (let index = 0; index < chunks.length; index += 1) {
      const title = chunks.length > 1 ? `${entry.title}（${index + 1}/${chunks.length}）` : entry.title;
      const result = placeBlock({
        duration: chunks[index],
        ranges,
        kind: blockKind,
        title,
        taskIds: [entry.taskId],
        why: whyForEntry(entry, dateStr),
        output: outputForTask(entry.task, blockKind),
        minMinutes: MIN_TASK_CHUNK,
      });
      if (!result.ok) {
        failReason = result.reason;
        break;
      }
      placed += result.minutes;
      if (result.truncated) {
        failReason = 'capacity';
        break;
      }
    }
    if (placed > 0) addCoverage(entry.goalId, placed);
    const remaining = entry.estimate - placed;
    if (remaining > 0) setUnscheduled(entry.taskId, taskUnscheduledReason(entry, placed, remaining, failReason));
    return placed;
  }

  // 规则 3：逾期 / 今日截止（计划日当天到期，或 24h 内到期）的任务先清，避免越拖越贵。
  let urgentPlacedMinutes = 0;
  for (const entry of urgentEntries) urgentPlacedMinutes += placeTaskEntry(entry);

  // ---- 规则 4：最高优先目标的主线预留块（先于普通任务挤压）-----------------
  // reserve = max(30, ceil(0.25 * capacity))，且只补足“尚未被任务的真实分钟覆盖”的差额；
  // 若 reserve > 剩余容量则取剩余容量。预留块是真实 block，不是只在 warnings 里抱怨。
  const topGoalReserveTarget = topGoal ? Math.max(30, Math.ceil(capacity * 0.25)) : 0;
  const topGoalCoverageBefore = topGoal ? coverage.get(topGoal.id) || 0 : 0;
  const reserveNeeded = Math.max(0, topGoalReserveTarget - topGoalCoverageBefore);
  let reserveMinutes = 0;
  if (topGoal && reserveNeeded > 0) {
    const available = Math.max(0, state.budget);
    const want = Math.min(reserveNeeded, available);
    if (want >= 5) {
      const goalKind = blockKindForGoal(topGoal.kind);
      const result = placeBlock({
        duration: want,
        ranges: preferredRanges(goalKind),
        kind: goalKind,
        title: `主线推进：${topGoal.title}`,
        taskIds: [],
        why: `为升学就业目标「${topGoal.title}」预留 ${want} 分钟：最高优先目标先于一般作业占位，避免一天被杂事吃满。`,
        output: `推进「${topGoal.title}」的一个可交付步骤：${goalActionText(topGoal.kind)}`,
        minMinutes: Math.min(15, want),
      });
      if (result.ok) {
        reserveMinutes = result.minutes;
        addCoverage(topGoal.id, reserveMinutes);
      }
    }
  }

  // ---- 其余任务（按 score）：主线预留之后才使用剩余容量 ---------------------
  for (const entry of restEntries) placeTaskEntry(entry);

  // ---- 规则 4：其它目标至少一个推进块（合成主线块排在真实任务之后）---------
  function mainlineBaseMinutes() {
    return Math.max(20, Math.min(45, Math.round((capacity * 0.18) / 5) * 5));
  }

  for (const goal of liveGoals) {
    if ((coverage.get(goal.id) || 0) > 0) continue;
    const goalKind = blockKindForGoal(goal.kind);
    const isTop = topGoal && goal.id === topGoal.id;
    const duration = Math.min(90, Math.max(mainlineBaseMinutes(), isTop ? topGoalReserveTarget : 0));
    const result = placeBlock({
      duration,
      ranges: preferredRanges(goalKind),
      kind: goalKind,
      title: `主线推进：${goal.title} · ${goalActionText(goal.kind)}`,
      why: `目标「${goal.title}」今天没有可执行任务，先主动推一段主线，保持连续性。`,
      output: '完成一个可检查的最小步骤（笔记/题/投递记录）',
      minMinutes: 15,
    });
    if (result.ok) addCoverage(goal.id, result.minutes);
    // 最高优先目标的告警由下面的「主线预留被挤掉」统一发出，避免同一目标重复抱怨。
    else if (!(topGoal && goal.id === topGoal.id)) addWarning(`目标「${goal.title}」今日未能安排推进块（容量/时间不足）`);
  }

  // 最高优先目标补足到 25%（预留被截断或另有余量时补；已有真实块就不再重复抱怨）。
  if (topGoal && topGoalReserveTarget > 0) {
    let guard = 0;
    while ((coverage.get(topGoal.id) || 0) < topGoalReserveTarget && guard < 4) {
      guard += 1;
      const missing = topGoalReserveTarget - (coverage.get(topGoal.id) || 0);
      const duration = Math.min(45, Math.max(25, Math.ceil(missing / 5) * 5));
      const goalKind = blockKindForGoal(topGoal.kind);
      const result = placeBlock({
        duration,
        ranges: preferredRanges(goalKind),
        kind: goalKind,
        title: `主线加码：${topGoal.title} · ${goalActionText(topGoal.kind)}`,
        why: '最高优先目标今天需要拿到 ≥25% 容量，避免被杂事挤掉。',
        output: '完成一个可检查的主线步骤',
        minMinutes: 15,
      });
      if (!result.ok) break;
      addCoverage(topGoal.id, result.minutes);
    }
    // 只有“预留彻底没排进来、该目标今天 0 分钟”才告警，并写明被什么挤掉。
    const got = coverage.get(topGoal.id) || 0;
    if (got <= 0) {
      let cause = '今日容量不足';
      if (capacity > 0 && courseMinutes >= capacity) cause = `固定课程（${courseMinutes} 分钟）`;
      else if (urgentPlacedMinutes > 0) cause = `逾期/今日截止任务（已占 ${urgentPlacedMinutes} 分钟）`;
      addWarning(
        `最高优先目标「${topGoal.title}」的主线预留被${cause}挤掉：今日主线 0 分钟（目标 ${topGoalReserveTarget} 分钟）`,
      );
    }
  }

  // ---- 规则 9：间隔复习（done 且 3/7 天前完成，每天最多 2 个）---------------
  const reviewCandidates = [];
  for (const entry of entries) {
    if (entry.status !== 'done') continue;
    const completed = toDate(entry.task.completedAt) || toDate(entry.task.updatedAt);
    if (!completed) continue;
    const age = dayDiffKeys(shanghaiDayKey(completed), dateStr);
    if (age === 3 || age === 7) reviewCandidates.push({ entry, age });
  }
  reviewCandidates.sort((a, b) => a.age - b.age || cmpStr(a.entry.taskId, b.entry.taskId));
  for (const candidate of reviewCandidates.slice(0, MAX_REVIEW_BLOCKS)) {
    const result = placeBlock({
      duration: REVIEW_BLOCK_MINUTES,
      ranges: preferredRanges('review'),
      kind: 'review',
      title: `复习：${candidate.entry.title}`,
      taskIds: [candidate.entry.taskId],
      why: `间隔复习（${candidate.age} 天前完成）踩在遗忘临界点，用 20 分钟换长期记忆。`,
      output: '不看资料复述核心要点，并说出 1 个易错点',
      minMinutes: 15,
    });
    if (!result.ok) addWarning(`复习块「${candidate.entry.title}」未能排入（容量/时间不足）`);
  }

  // ---- 规则 5：求职目标当天保证一个 application 块 -------------------------
  const jobGoals = liveGoals.filter((goal) => goal.kind === 'job');
  const hasApplicationBlock = () => state.blocks.some((block) => block.kind === 'application');
  if (jobGoals.length && !hasApplicationBlock()) {
    const jobGoal = jobGoals[0];
    const result = placeBlock({
      duration: 30,
      ranges: preferredRanges('application'),
      kind: 'application',
      title: '投递推进：投 1 个岗位 / 改一版简历',
      why: `求职目标「${jobGoal.title}」需要每天一次可见的输出，别让目标停在想法上。`,
      output: '投出 1 份，或完成 1 个岗位的简历定制',
      minMinutes: 15,
    });
    if (result.ok) addCoverage(jobGoal.id, result.minutes);
    else addWarning('求职目标今日未获投递块（容量被更高优先目标与截止任务占满）');
  }

  // ---- 规则 7：运动 30min（可被容量挤掉，但排在低优先学习块之前）------------
  placeBlock({
    duration: 30,
    ranges: preferredRanges('exercise'),
    kind: 'exercise',
    title: '运动：快走 / 跑步 / 力量 30 分钟',
    taskIds: [],
    why: '身体是长期主义的地基，30 分钟换整晚精力。',
    output: '出汗 30 分钟，心率明显上来',
    minMinutes: 15,
  });

  // ---- 规则 5：本周实践/输出块 ≥ 3（周一为一周起点，用 history 计数）-------
  const weekStart = addDaysToDateKey(dateStr, -((weekdayIndex + 6) % 7));
  let weekOutputCount = 0;
  for (const plan of history) {
    if (!plan || typeof plan !== 'object' || !isDateKey(plan.date) || !Array.isArray(plan.blocks)) continue;
    if (plan.date === dateStr) continue; // 当天的旧计划会被重排，不重复计数
    if (plan.date < weekStart || plan.date > dateStr) continue;
    for (const block of plan.blocks) if (block && OUTPUT_KINDS.has(block.kind)) weekOutputCount += 1;
  }
  weekOutputCount += state.blocks.filter((block) => OUTPUT_KINDS.has(block.kind)).length;
  if (weekOutputCount < WEEK_OUTPUT_TARGET) {
    // 周日是本周最后一天，缺几个补几个；平时先补一个，避免一天堆太多。
    const missing = WEEK_OUTPUT_TARGET - weekOutputCount;
    const addCount = weekdayIndex === 0 ? missing : 1;
    for (let index = 0; index < addCount; index += 1) {
      const result = placeBlock({
        duration: 30,
        ranges: preferredRanges('practice'),
        kind: 'practice',
        title: '实践输出：把本周所学做成可展示的小产出',
        why: '每周至少 3 个实践/输出块，避免只输入不输出。',
        output: '一个可展示的小产出（代码/笔记/复盘卡片）',
        minMinutes: 15,
      });
      if (!result.ok) break;
      weekOutputCount += 1;
    }
    if (weekOutputCount < WEEK_OUTPUT_TARGET) {
      addWarning(`本周实践/输出块仅 ${weekOutputCount} 个，未达每周 ${WEEK_OUTPUT_TARGET} 个的目标`);
    }
  }

  // ============================================================ 收尾：排序、编号、统计
  const orderedBlocks = state.blocks
    .slice()
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin || cmpStr(a.kind, b.kind) || cmpStr(a.title, b.title))
    .map((block, index) => ({
      id: `b_${index + 1}`,
      start: fmtClock(block.startMin),
      end: fmtClock(block.endMin),
      kind: block.kind,
      title: block.title,
      taskIds: block.taskIds.slice(),
      why: block.why,
      output: block.output,
      minutes: block.endMin - block.startMin,
      done: false,
    }));

  // totalMinutes = 所有非 buffer/break 块分钟和（§2.3 最后一句）
  const totalMinutes = orderedBlocks.reduce(
    (sum, block) => (NON_WORK_KINDS.has(block.kind) ? sum : sum + block.minutes),
    0,
  );

  const unscheduled = [];
  const listedIds = new Set();
  for (const entry of entries) {
    if (listedIds.has(entry.taskId)) continue;
    const reason = unscheduledMap.get(entry.taskId);
    if (!reason) continue;
    listedIds.add(entry.taskId);
    unscheduled.push({ taskId: entry.taskId, reason });
  }

  // 今日重点 / 主攻方向（≤30 字，中文）
  const overdueEntries = entries
    .filter((entry) => STATUS_ACTIVE.has(entry.status) && entry.overdue)
    .sort((a, b) => compareEntries(a, b, seed));
  const dueSoonEntries = entries
    .filter((entry) => STATUS_ACTIVE.has(entry.status) && entry.dueSoon)
    .sort((a, b) => compareEntries(a, b, seed));
  const hasActiveTask = entries.some((entry) => STATUS_ACTIVE.has(entry.status));

  let focus;
  if (overdueEntries.length) focus = truncateText(`先清逾期：${overdueEntries[0].title}`, 30);
  else if (dueSoonEntries.length) focus = truncateText(`优先截止：${dueSoonEntries[0].title}`, 30);
  else if (topGoal) focus = truncateText(`主线推进：${topGoal.title}`, 30);
  else if (hasActiveTask) focus = '把今天第一件事做扎实';
  else focus = '先定计划，再推主线';

  const theme = topGoal
    ? goalThemeLabel(topGoal.kind)
    : overdueEntries.length
      ? '截止冲刺'
      : dueSoonEntries.length
        ? 'DDL 优先'
        : '稳态推进';

  return {
    date: dateStr,
    generatedAt: nowDate.toISOString(),
    focus,
    theme,
    blocks: orderedBlocks,
    unscheduled,
    totalMinutes,
    load: { planned: totalMinutes, capacity },
    warnings,
  };
}
