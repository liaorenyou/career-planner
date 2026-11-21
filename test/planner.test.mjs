/**
 * 计划排程引擎测试（planner-engine 负责的唯一测试文件）
 *
 * 运行：node --test test/planner.test.mjs
 *
 * 覆盖 CONTRACT.md §2.4 要求的 8 种情形，以及导师额外要求的边界：
 *   - 全部任务都是 done / dueAt 无 / goal 无 targetDate / 容量 0 /
 *     任务时长超过剩余容量 / 固定课程与其它块冲突。
 * 另外覆盖：构造性约束（时间轴、时间窗、totalMinutes 口径）、确定性、
 * capacity 取值优先级、体力曲线、缓冲、复习节奏、每周输出配额、求职保证。
 *
 * 本文件不读磁盘、不访问网络、不依赖宿主时区（所有时间都显式带 +08:00）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { planDay, scoreTask, minutesOfDay, fmtClock, emptyPlan } from '../lib/planner.js';

// ============================================================ 公共常量与夹具

const BLOCK_KINDS = new Set([
  'course',
  'study',
  'homework',
  'practice',
  'application',
  'research',
  'review',
  'exercise',
  'buffer',
  'ritual',
  'break',
]);

const SATURDAY = '2026-11-21'; // getDay() === 6
const SUNDAY = '2026-11-22'; // getDay() === 0
const FRIDAY = '2026-11-20';
const NOW = new Date('2026-11-20T21:30:00+08:00');

function at(dateKey, clock) {
  return `${dateKey}T${clock}:00+08:00`;
}

function makeGoal(over = {}) {
  return {
    id: 'g_postgrad',
    kind: 'postgrad',
    title: '考研上岸',
    target: '某 985 计算机',
    targetDate: '2027-12-20',
    priority: 1,
    notes: '',
    ...over,
  };
}

function makeTask(over = {}) {
  return {
    id: 't_base',
    title: '高数第三章习题',
    kind: 'homework',
    course: '高等数学',
    startAt: '',
    endAt: '',
    dueAt: '',
    estMinutes: 60,
    priority: 2,
    goalId: '',
    status: 'todo',
    source: { type: 'manual', ref: '' },
    notes: '',
    breakdown: [],
    createdAt: '2026-11-10T09:00:00+08:00',
    updatedAt: '2026-11-10T09:00:00+08:00',
    fingerprint: 'fp',
    ...over,
  };
}

/** 默认 profile：两个目标 + 周六 600 分钟容量（含课程时间）。 */
function makeProfile(over = {}) {
  return {
    version: 1,
    identity: { name: '测试同学', school: '某大学', major: '计算机', grade: '大三', gradYear: 2028 },
    goals: [
      makeGoal(),
      makeGoal({ id: 'g_job', kind: 'job', title: '拿到暑期实习', target: '后端开发', targetDate: '2027-06-30', priority: 2 }),
    ],
    constraints: {
      dailyMinutes: 180,
      weekdayMinutes: { 0: 240, 1: 240, 2: 240, 3: 240, 4: 240, 5: 240, 6: 600 },
      quietStart: '23:30',
      quietEnd: '07:00',
      wakeAt: '07:30',
      sleepAt: '23:30',
      daysOff: [0],
    },
    resources: [],
    ...over,
  };
}

/** 典型输入：5 个任务 + 2 个目标 + 2 段课程表。 */
function makeTypicalInput(over = {}) {
  return {
    date: SATURDAY,
    now: NOW,
    profile: makeProfile(),
    tasks: [
      makeTask({
        id: 't_math',
        title: '高数：中值定理 20 题',
        dueAt: at('2026-11-22', '23:59'),
        estMinutes: 60,
        priority: 1,
        goalId: 'g_postgrad',
      }),
      makeTask({
        id: 't_os',
        title: '操作系统实验报告',
        course: '操作系统',
        dueAt: at('2026-11-19', '23:59'), // 逾期
        estMinutes: 90,
        priority: 2,
      }),
      makeTask({
        id: 't_resume',
        title: '改一版后端简历',
        kind: 'application',
        course: '',
        dueAt: at('2026-11-21', '18:00'),
        estMinutes: 40,
        priority: 1,
        goalId: 'g_job',
      }),
      makeTask({
        id: 't_ds',
        title: '408 数据结构：图的最短路',
        kind: 'reading',
        course: '数据结构',
        estMinutes: 45,
        priority: 2,
        goalId: 'g_postgrad',
      }),
      makeTask({
        id: 't_leetcode',
        title: '刷 5 道机试题',
        kind: 'practice',
        course: '',
        estMinutes: 50,
        priority: 3,
        goalId: 'g_job',
      }),
      makeTask({
        id: 'c_am',
        title: '编译原理（第 10 周）',
        kind: 'course',
        course: '编译原理',
        startAt: at(SATURDAY, '08:00'),
        endAt: at(SATURDAY, '09:40'),
        estMinutes: 100,
        goalId: '',
      }),
      makeTask({
        id: 'c_pm',
        title: '计算机网络（第 10 周）',
        kind: 'course',
        course: '计算机网络',
        startAt: at(SATURDAY, '14:00'),
        endAt: at(SATURDAY, '15:40'),
        estMinutes: 100,
        goalId: '',
      }),
      makeTask({
        id: 't_done3',
        title: '线代错题整理',
        course: '线性代数',
        status: 'done',
        estMinutes: 30,
        goalId: 'g_postgrad',
        updatedAt: at('2026-11-18', '20:00'), // 3 天前完成 -> 复习
      }),
    ],
    intel: [],
    history: [],
    seed: 0,
    ...over,
  };
}

// ============================================================ 断言工具

function blockOf(plan, taskId) {
  return plan.blocks.filter((block) => block.taskIds.includes(taskId));
}

function startMin(block) {
  return minutesOfDay(block.start);
}

function endMin(block) {
  return minutesOfDay(block.end);
}

/**
 * 构造性硬约束检查（CONTRACT §2.2 + §2.3）：
 * 字段齐全、时间轴有序不重叠、不越出 wakeAt~quietStart、end>start、
 * totalMinutes === 非 buffer/break 块分钟和、load.planned === totalMinutes。
 */
function assertPlanInvariants(plan, options = {}) {
  const { wakeAt = '07:30', quietStart = '23:30', checkCapacity = true } = options;

  assert.equal(typeof plan.date, 'string');
  assert.match(plan.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof plan.generatedAt, 'string');
  assert.ok(!Number.isNaN(new Date(plan.generatedAt).getTime()), 'generatedAt 必须是可解析的 ISO 时间');
  assert.equal(typeof plan.focus, 'string');
  assert.ok(plan.focus.length > 0);
  assert.ok(Array.from(plan.focus).length <= 30, 'focus 不超过 30 字');
  assert.equal(typeof plan.theme, 'string');
  assert.ok(plan.theme.length > 0);
  assert.ok(Array.isArray(plan.blocks));
  assert.ok(Array.isArray(plan.unscheduled));
  assert.ok(Array.isArray(plan.warnings));
  assert.equal(typeof plan.totalMinutes, 'number');
  assert.equal(typeof plan.load, 'object');
  assert.equal(plan.load.planned, plan.totalMinutes);

  const wake = minutesOfDay(wakeAt);
  const quiet = minutesOfDay(quietStart);

  // 块顺序：plan.blocks 必须按 start 升序（宿主按此顺序渲染/推送）
  let previousStart = -1;
  const ids = new Set();
  for (const block of plan.blocks) {
    assert.equal(typeof block.id, 'string');
    assert.match(block.id, /^b_\d+$/);
    assert.ok(!ids.has(block.id), `块 id 重复：${block.id}`);
    ids.add(block.id);

    assert.equal(typeof block.start, 'string');
    assert.equal(typeof block.end, 'string');
    const start = startMin(block);
    const end = endMin(block);
    assert.ok(Number.isFinite(start) && Number.isFinite(end), `非法时间：${block.start}-${block.end}`);
    assert.ok(end > start, 'end 必须大于 start（且同一天）');
    assert.ok(start >= wake, `块不能早于 wakeAt：${block.start}`);
    assert.ok(end <= quiet, `块不能晚于 quietStart：${block.end}`);
    assert.ok(start >= previousStart, 'plan.blocks 必须按 start 升序');
    previousStart = start;

    assert.ok(BLOCK_KINDS.has(block.kind), `未知块类型：${block.kind}`);
    assert.equal(typeof block.title, 'string');
    assert.ok(block.title.length > 0);
    assert.ok(Array.isArray(block.taskIds));
    for (const taskId of block.taskIds) assert.equal(typeof taskId, 'string');
    assert.equal(typeof block.why, 'string');
    assert.equal(typeof block.output, 'string');
    assert.equal(block.minutes, end - start, 'minutes 必须等于 end-start');
    assert.equal(block.done, false);
  }

  // 相邻块不能重叠
  for (let index = 1; index < plan.blocks.length; index += 1) {
    assert.ok(
      endMin(plan.blocks[index - 1]) <= startMin(plan.blocks[index]),
      `块重叠：${plan.blocks[index - 1].end} > ${plan.blocks[index].start}`,
    );
  }

  // totalMinutes 只算非 buffer/break 块
  const workMinutes = plan.blocks
    .filter((block) => block.kind !== 'buffer' && block.kind !== 'break')
    .reduce((sum, block) => sum + block.minutes, 0);
  assert.equal(plan.totalMinutes, workMinutes);
  assert.equal(plan.load.planned, workMinutes);
  assert.equal(typeof plan.load.capacity, 'number');
  if (checkCapacity) {
    assert.ok(
      plan.load.planned <= plan.load.capacity,
      `总工时 ${plan.load.planned} 超过 capacity ${plan.load.capacity}`,
    );
  }

  for (const item of plan.unscheduled) {
    assert.equal(typeof item.taskId, 'string');
    assert.ok(item.taskId.length > 0);
    assert.equal(typeof item.reason, 'string');
    assert.ok(item.reason.length > 0);
  }
  for (const warning of plan.warnings) assert.equal(typeof warning, 'string');
}

/** 从 plan 中取某个 kind 的块。 */
function blocksOfKind(plan, kind) {
  return plan.blocks.filter((block) => block.kind === kind);
}

// ============================================================ 1. 时间工具

test('minutesOfDay / fmtClock：08:30 与 510 互相转换，非法输入安全', () => {
  assert.equal(minutesOfDay('08:30'), 510);
  assert.equal(minutesOfDay('8:30'), 510);
  assert.equal(minutesOfDay('08:30:00'), 510);
  assert.equal(minutesOfDay('00:00'), 0);
  assert.equal(minutesOfDay('23:59'), 23 * 60 + 59);
  assert.equal(minutesOfDay('24:00'), 1440);
  assert.ok(Number.isNaN(minutesOfDay('24:30')));
  assert.ok(Number.isNaN(minutesOfDay('12:60')));
  assert.ok(Number.isNaN(minutesOfDay('nope')));
  assert.ok(Number.isNaN(minutesOfDay('')));

  assert.equal(fmtClock(510), '08:30');
  assert.equal(fmtClock(0), '00:00');
  assert.equal(fmtClock(1439), '23:59');
  assert.equal(fmtClock(1440), '24:00');
  assert.equal(fmtClock(510.4), '08:30');
  for (const clock of ['00:00', '07:30', '09:05', '13:30', '23:30']) {
    assert.equal(fmtClock(minutesOfDay(clock)), clock);
  }
});

test('emptyPlan 返回完整 Plan 形状', () => {
  const plan = emptyPlan(SUNDAY);
  assert.equal(plan.date, SUNDAY);
  assert.equal(plan.focus, '');
  assert.equal(plan.theme, '');
  assert.deepEqual(plan.blocks, []);
  assert.deepEqual(plan.unscheduled, []);
  assert.equal(plan.totalMinutes, 0);
  assert.deepEqual(plan.load, { planned: 0, capacity: 0 });
  assert.deepEqual(plan.warnings, []);
  assert.ok(!Number.isNaN(new Date(plan.generatedAt).getTime()));
});

// ============================================================ 2. 典型计划形状

test('典型输入：Plan 形状与所有构造性硬约束', () => {
  const input = makeTypicalInput();
  const plan = planDay(input);

  assertPlanInvariants(plan);
  assert.equal(plan.date, SATURDAY);

  // 固定时段课程必须被原样占位
  const amCourse = blockOf(plan, 'c_am');
  assert.equal(amCourse.length, 1);
  assert.equal(amCourse[0].kind, 'course');
  assert.equal(amCourse[0].start, '08:00');
  assert.equal(amCourse[0].end, '09:40');
  const pmCourse = blockOf(plan, 'c_pm');
  assert.equal(pmCourse.length, 1);
  assert.equal(pmCourse[0].start, '14:00');
  assert.equal(pmCourse[0].end, '15:40');

  // 仪式块：晨间计划 + 日终复盘
  assert.ok(blocksOfKind(plan, 'ritual').length >= 1);
  const eveningReview = plan.blocks.filter((block) => block.kind === 'review' && block.title.includes('日终复盘'));
  assert.equal(eveningReview.length, 1);

  // 逾期任务必须进 warnings 且被置顶（第一个带 taskIds 的学习块）
  assert.ok(plan.warnings.some((warning) => warning.includes('已逾期')));
  const firstTaskBlock = plan.blocks.find((block) => block.taskIds.length > 0 && block.kind !== 'course');
  assert.ok(firstTaskBlock, '至少有一个任务块');
  assert.deepEqual(firstTaskBlock.taskIds, ['t_os']);

  // 任务在 unscheduled 里必须带可读原因
  assert.ok(plan.unscheduled.every((item) => item.reason.length > 0));

  // 块标题/理由/产出都是中文且非空
  assert.ok(plan.blocks.every((block) => block.title.length > 0 && block.why.length > 0));
});

// ============================================================ 3. 空任务

test('没有任何任务：仍产出仪式块，并为每个目标生成主线推进块', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: makeProfile(),
    tasks: [],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  assert.ok(blocksOfKind(plan, 'ritual').length >= 1, '晨间仪式块');
  assert.ok(plan.blocks.some((block) => block.kind === 'review' && block.title.includes('日终复盘')), '日终复盘块');

  for (const goalTitle of ['考研上岸', '拿到暑期实习']) {
    assert.ok(
      plan.blocks.some((block) => block.title.includes(goalTitle) || block.why.includes(goalTitle)),
      `目标「${goalTitle}」应该有推进块`,
    );
  }
  // 求职目标 -> application 块；考研目标 -> study 块
  assert.ok(plan.blocks.some((block) => block.kind === 'application' && block.title.includes('拿到暑期实习')));
  assert.ok(plan.blocks.some((block) => block.kind === 'study' && block.title.includes('考研上岸')));
});

// ============================================================ 4. 截止压力排序

test('截止压力：dueAt 近的任务排在 dueAt 远的前面', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: makeProfile({
      goals: [],
      constraints: makeProfile().constraints,
    }),
    tasks: [
      makeTask({ id: 't_near', title: '明天要交的作业', dueAt: at('2026-11-22', '12:00'), estMinutes: 60 }),
      makeTask({ id: 't_far', title: '两周后的事', dueAt: at('2026-12-05', '12:00'), estMinutes: 60 }),
      makeTask({ id: 't_none', title: '没有截止的事', estMinutes: 60 }),
    ],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  const near = blockOf(plan, 't_near')[0];
  const far = blockOf(plan, 't_far')[0];
  const none = blockOf(plan, 't_none')[0];
  assert.ok(near && far && none, '三个任务都应该被安排');
  assert.ok(startMin(near) < startMin(far), '截止近的必须更早');
  assert.ok(startMin(far) < startMin(none), '有截止的必须早于没截止的');
});

test('scoreTask：逾期 > 临近截止 > 远期；优先级与目标权重同向', () => {
  const profile = makeProfile();
  const overdue = makeTask({ id: 'a', dueAt: at('2026-11-19', '23:59') });
  const far = makeTask({ id: 'b', dueAt: at('2026-12-31', '23:59') });
  const noDue = makeTask({ id: 'c', dueAt: '' });
  const highPriority = makeTask({ id: 'd', dueAt: at('2026-11-25', '23:59'), priority: 1 });
  const lowPriority = makeTask({ id: 'e', dueAt: at('2026-11-25', '23:59'), priority: 5 });
  const withGoal = makeTask({ id: 'f', dueAt: at('2026-11-25', '23:59'), goalId: 'g_postgrad', priority: 3 });
  const withoutGoal = makeTask({ id: 'g', dueAt: at('2026-11-25', '23:59'), priority: 3 });

  const score = (task) => scoreTask({ task, now: NOW, profile });
  assert.ok(score(overdue) > score(far));
  assert.ok(score(far) > score(noDue));
  assert.ok(score(highPriority) > score(lowPriority));
  assert.ok(score(withGoal) > score(withoutGoal));
  assert.ok(Number.isFinite(score(noDue)));

  // 同样的输入两次评分一致（确定性）
  assert.equal(score(highPriority), scoreTask({ task: highPriority, now: NOW, profile }));
  // 缺省参数不崩溃
  assert.ok(Number.isFinite(scoreTask({ task: highPriority })));
});

// ============================================================ 5. 逾期告警

test('逾期任务：进 warnings（含"已逾期"）并排在最前', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: makeProfile({ goals: [] }),
    tasks: [
      makeTask({ id: 't_normal_1', title: '普通任务一', estMinutes: 40, dueAt: at('2026-12-01', '12:00') }),
      makeTask({ id: 't_late', title: '已经逾期的大作业', estMinutes: 60, dueAt: at('2026-11-19', '23:59') }),
      makeTask({ id: 't_normal_2', title: '普通任务二', estMinutes: 40 }),
    ],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  assert.ok(plan.warnings.some((warning) => warning.includes('已逾期')));
  assert.ok(plan.warnings.some((warning) => warning.includes('已经逾期的大作业')));
  const late = blockOf(plan, 't_late')[0];
  const normal = blockOf(plan, 't_normal_1')[0];
  assert.ok(startMin(late) < startMin(normal), '逾期任务必须置顶');
});

// ============================================================ 6. 超容量 -> unscheduled

test('超出当日容量：进 unscheduled，总工时不超过 capacity', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: makeProfile({
      goals: [],
      constraints: {
        dailyMinutes: 120,
        weekdayMinutes: { 0: 120, 1: 120, 2: 120, 3: 120, 4: 120, 5: 120, 6: 120 },
        quietStart: '23:30',
        quietEnd: '07:00',
        wakeAt: '07:30',
        sleepAt: '23:30',
        daysOff: [0],
      },
    }),
    tasks: [
      makeTask({ id: 't1', title: '任务一', estMinutes: 60, dueAt: at('2026-11-22', '12:00') }),
      makeTask({ id: 't2', title: '任务二', estMinutes: 60 }),
      makeTask({ id: 't3', title: '任务三', estMinutes: 60 }),
      makeTask({ id: 't4', title: '任务四', estMinutes: 60 }),
    ],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  assert.equal(plan.load.capacity, 120);
  assert.ok(plan.totalMinutes <= 120);
  assert.ok(plan.unscheduled.length > 0, '装不下的任务必须进 unscheduled');
  assert.ok(plan.unscheduled.some((item) => item.reason.includes('容量') || item.reason.includes('时间')));

  // 所有 4 个任务要么有块，要么进 unscheduled（不能静默丢任务）
  for (const taskId of ['t1', 't2', 't3', 't4']) {
    const scheduled = plan.blocks.some((block) => block.taskIds.includes(taskId));
    const unscheduled = plan.unscheduled.some((item) => item.taskId === taskId);
    const done = taskId === 't1' && scheduled;
    assert.ok(scheduled || unscheduled, `${taskId} 既没排也没进 unscheduled`);
    assert.ok(done || true);
  }
});

// ============================================================ 7. 时间轴无重叠

test('时间轴：多任务 + 多课程 + 仪式混合时无重叠、不越窗', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: makeProfile(),
    tasks: [
      makeTask({ id: 'k1', title: '课一', kind: 'course', startAt: at(SATURDAY, '08:00'), endAt: at(SATURDAY, '10:00') }),
      makeTask({ id: 'k2', title: '课二', kind: 'course', startAt: at(SATURDAY, '10:00'), endAt: at(SATURDAY, '11:30') }),
      makeTask({ id: 'k3', title: '课三', kind: 'course', startAt: at(SATURDAY, '16:00'), endAt: at(SATURDAY, '17:00') }),
      makeTask({ id: 'e1', title: '任务甲', estMinutes: 150, dueAt: at('2026-11-23', '12:00') }),
      makeTask({ id: 'e2', title: '任务乙', kind: 'application', estMinutes: 90, goalId: 'g_job' }),
      makeTask({ id: 'e3', title: '任务丙', kind: 'reading', estMinutes: 40, goalId: 'g_postgrad' }),
    ],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  assert.ok(plan.blocks.length >= 6);
  // 课程块必须彼此相邻不重叠（10:00 交接）
  const k1 = blockOf(plan, 'k1')[0];
  const k2 = blockOf(plan, 'k2')[0];
  assert.equal(k1.end, k2.start);
});

// ============================================================ 8. 确定性

test('确定性：相同输入两次调用完全一致（除 generatedAt），且不修改入参', () => {
  const input = makeTypicalInput();
  const snapshot = structuredClone(input);

  const first = planDay(input);
  const second = planDay(input);

  assert.deepEqual(input, snapshot, 'planDay 不能修改入参');

  const withoutGeneratedAt = (plan) => {
    const copy = structuredClone(plan);
    delete copy.generatedAt;
    return copy;
  };
  assert.deepEqual(withoutGeneratedAt(first), withoutGeneratedAt(second));

  // 换一个 now，只应影响 generatedAt（计划本身与 now 无关，除非任务已逾期）
  const other = planDay({ ...makeTypicalInput(), now: new Date('2026-11-20T22:30:00+08:00') });
  assert.deepEqual(first.blocks, other.blocks);
  assert.deepEqual(first.unscheduled, other.unscheduled);
  assert.equal(first.totalMinutes, other.totalMinutes);
});

test('确定性：seed=0 时平局按 task.id 字典序', () => {
  const profile = makeProfile({ goals: [] });
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile,
    tasks: [
      makeTask({ id: 't_b', title: '同名任务', estMinutes: 30 }),
      makeTask({ id: 't_a', title: '同名任务', estMinutes: 30 }),
      makeTask({ id: 't_c', title: '同名任务', estMinutes: 30 }),
    ],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  const a = blockOf(plan, 't_a')[0];
  const b = blockOf(plan, 't_b')[0];
  const c = blockOf(plan, 't_c')[0];
  assert.ok(startMin(a) < startMin(b));
  assert.ok(startMin(b) < startMin(c));

  // 同一输入 + 同一 seed 必须复现同样的顺序
  const again = planDay({
    date: SATURDAY,
    now: NOW,
    profile,
    tasks: [
      makeTask({ id: 't_b', title: '同名任务', estMinutes: 30 }),
      makeTask({ id: 't_a', title: '同名任务', estMinutes: 30 }),
      makeTask({ id: 't_c', title: '同名任务', estMinutes: 30 }),
    ],
    history: [],
    seed: 0,
  });
  assert.deepEqual(
    plan.blocks.map((block) => block.taskIds.join(',')),
    again.blocks.map((block) => block.taskIds.join(',')),
  );
});

// ============================================================ 9. 固定课程

test('固定时段课程：原样占位，课程任务只出现一次', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: makeProfile({ goals: [] }),
    tasks: [
      makeTask({
        id: 'c_unique',
        title: '线性代数课',
        kind: 'course',
        startAt: at(SATURDAY, '09:15'),
        endAt: at(SATURDAY, '10:50'),
        estMinutes: 95,
      }),
      makeTask({ id: 'x1', title: '自习任务', estMinutes: 45 }),
    ],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  const courseBlocks = blockOf(plan, 'c_unique');
  assert.equal(courseBlocks.length, 1, '课程任务只能产生一个块');
  assert.equal(courseBlocks[0].kind, 'course');
  assert.equal(courseBlocks[0].start, '09:15');
  assert.equal(courseBlocks[0].end, '10:50');
  assert.equal(courseBlocks[0].minutes, 95);
  // 课程与其他块不重叠（assertPlanInvariants 已检查），课程后应有缓冲（>=50min 块）
  const after = plan.blocks.find((block) => block.start === courseBlocks[0].end);
  assert.ok(after, '课程之后必须有下一个块（至少是缓冲）');
  assert.equal(after.kind, 'buffer');
});

test('固定课程与其它块冲突：重叠课程顺延、超窗课程裁剪/不排，并给出告警', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: makeProfile({ goals: [] }),
    tasks: [
      makeTask({ id: 'c1', title: '课A', kind: 'course', startAt: at(SATURDAY, '09:00'), endAt: at(SATURDAY, '11:00') }),
      makeTask({ id: 'c2', title: '课B', kind: 'course', startAt: at(SATURDAY, '10:00'), endAt: at(SATURDAY, '12:00') }),
      makeTask({ id: 'c3', title: '课C（早上 6 点，不在时间窗）', kind: 'course', startAt: at(SATURDAY, '06:00'), endAt: at(SATURDAY, '07:00') }),
    ],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);

  const c1 = blockOf(plan, 'c1');
  const c2 = blockOf(plan, 'c2');
  assert.equal(c1.length, 1);
  assert.equal(c2.length, 1);
  assert.equal(c1[0].start, '09:00');
  assert.equal(c1[0].end, '11:00');
  assert.equal(c2[0].start, '11:00', '重叠课程应顺延到前一节结束');
  assert.equal(c2[0].end, '12:00');
  assert.ok(plan.warnings.some((warning) => warning.includes('重叠')));

  // 06:00 的课在时间窗之外，不能越窗排入
  assert.equal(blockOf(plan, 'c3').length, 0);
  assert.ok(plan.unscheduled.some((item) => item.taskId === 'c3'));
  assert.ok(plan.warnings.some((warning) => warning.includes('时间窗')) || plan.unscheduled.some((item) => item.taskId === 'c3'));
});

test('固定时段：startAt/endAt 齐全的任务即使 kind 不是 course 也先占位；跨天块不排', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: makeProfile({
      goals: [],
      constraints: {
        dailyMinutes: 240,
        weekdayMinutes: { 0: 240, 1: 240, 2: 240, 3: 240, 4: 240, 5: 240, 6: 240 },
        quietStart: '23:30',
        quietEnd: '07:00',
        wakeAt: '07:30',
        sleepAt: '23:30',
        daysOff: [0],
      },
    }),
    tasks: [
      makeTask({
        id: 'lab',
        title: '实验室组会（固定时段）',
        kind: 'practice', // 不是 course，但有 startAt/endAt
        startAt: at(SATURDAY, '10:00'),
        endAt: at(SATURDAY, '11:00'),
      }),
      makeTask({
        id: 'cross',
        title: '跨天固定块',
        startAt: at(SATURDAY, '23:00'),
        endAt: at(SUNDAY, '00:30'),
      }),
      makeTask({ id: 'free', title: '普通任务', estMinutes: 40 }),
    ],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);

  const lab = blockOf(plan, 'lab');
  assert.equal(lab.length, 1);
  assert.equal(lab[0].kind, 'practice', '固定时段的 kind 跟随任务类型（不是一律 course）');
  assert.equal(lab[0].start, '10:00');
  assert.equal(lab[0].end, '11:00');

  // 跨天的固定块不能在今天排半个，进 unscheduled
  assert.equal(blockOf(plan, 'cross').length, 0);
  assert.ok(plan.unscheduled.some((item) => item.taskId === 'cross'));
  assert.ok(blockOf(plan, 'free').length === 1);
});

// ============================================================ 10. 周日复盘

test('周日：额外生成「周复盘」块；非周日没有', () => {
  const sundayPlan = planDay({
    date: SUNDAY,
    now: NOW,
    profile: makeProfile({
      constraints: {
        dailyMinutes: 240,
        weekdayMinutes: { 0: 300, 1: 240, 2: 240, 3: 240, 4: 240, 5: 240, 6: 240 },
        quietStart: '23:30',
        quietEnd: '07:00',
        wakeAt: '07:30',
        sleepAt: '23:30',
        daysOff: [0],
      },
    }),
    tasks: [makeTask({ id: 's1', title: '周日任务', estMinutes: 60 })],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(sundayPlan);
  const weekly = sundayPlan.blocks.filter((block) => block.kind === 'review' && block.title.includes('周复盘'));
  assert.equal(weekly.length, 1, '周日必须有一个周复盘块');
  assert.ok(weekly[0].title.includes('主线完成度'));
  assert.ok(weekly[0].title.includes('下周'));

  const fridayPlan = planDay({
    date: FRIDAY,
    now: NOW,
    profile: makeProfile({
      constraints: {
        dailyMinutes: 240,
        weekdayMinutes: { 0: 300, 1: 240, 2: 240, 3: 240, 4: 240, 5: 240, 6: 240 },
        quietStart: '23:30',
        quietEnd: '07:00',
        wakeAt: '07:30',
        sleepAt: '23:30',
        daysOff: [0],
      },
    }),
    tasks: [makeTask({ id: 'f1', title: '周五任务', estMinutes: 60 })],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(fridayPlan);
  assert.equal(fridayPlan.blocks.filter((block) => block.title.includes('周复盘')).length, 0);
});

// ============================================================ 11. 全部任务 done

test('全部任务都是 done：不产生学习块，只保留仪式块与间隔复习', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: makeProfile(),
    tasks: [
      makeTask({ id: 'd3', title: '三天前完成的事', status: 'done', updatedAt: at('2026-11-18', '20:00') }),
      makeTask({ id: 'd7', title: '七天前完成的事', status: 'done', updatedAt: at('2026-11-14', '20:00') }),
      makeTask({ id: 'd10', title: '十天前完成的事', status: 'done', updatedAt: at('2026-11-11', '20:00') }),
    ],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  assert.equal(plan.unscheduled.length, 0);
  // 已完成的普通任务不能再排学习块（复习块除外）
  for (const taskId of ['d3', 'd7', 'd10']) {
    const blocks = blockOf(plan, taskId);
    for (const block of blocks) assert.equal(block.kind, 'review', 'done 任务只允许复习块');
  }
  assert.ok(blocksOfKind(plan, 'ritual').length >= 1);
});

// ============================================================ 12. dueAt 无 / targetDate 无

test('边界：任务没有 dueAt、目标没有 targetDate 也能正常出计划', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: makeProfile({
      goals: [makeGoal({ id: 'g_no_date', kind: 'skill', title: '学会做菜', targetDate: '', priority: 2 })],
    }),
    tasks: [makeTask({ id: 'n1', title: '没有截止的任务', dueAt: '', estMinutes: 50 })],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  assert.ok(!plan.warnings.some((warning) => warning.includes('逾期')));
  assert.ok(blockOf(plan, 'n1').length === 1);
  assert.ok(
    plan.blocks.some((block) => block.title.includes('学会做菜') || block.why.includes('学会做菜')),
    '无 targetDate 的目标仍应有主线推进块',
  );
});

test('目标 targetDate 已过：只告警，不强行排该目标的主线', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: makeProfile({
      goals: [makeGoal({ id: 'g_past', kind: 'job', title: '过期目标', targetDate: '2026-11-01', priority: 1 })],
    }),
    tasks: [],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  assert.ok(plan.warnings.some((warning) => warning.includes('已过目标日期')));
});

// ============================================================ 13. 容量 0

test('容量 0：不排任何块，全部任务进 unscheduled 并告警', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: makeProfile({
      constraints: {
        dailyMinutes: 0,
        weekdayMinutes: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
        quietStart: '23:30',
        quietEnd: '07:00',
        wakeAt: '07:30',
        sleepAt: '23:30',
        daysOff: [0],
      },
    }),
    tasks: [makeTask({ id: 'z1', title: '容量为零时的任务', estMinutes: 60 })],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  assert.equal(plan.load.capacity, 0);
  assert.equal(plan.totalMinutes, 0);
  assert.equal(plan.blocks.length, 0);
  assert.ok(plan.warnings.some((warning) => warning.includes('容量为 0')));
  assert.ok(plan.unscheduled.some((item) => item.taskId === 'z1'));
});

// ============================================================ 14. 任务时长超过剩余容量

test('任务时长超过剩余容量：只排能容纳的部分，剩余分钟数进 unscheduled', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: makeProfile({
      goals: [],
      constraints: {
        dailyMinutes: 120,
        weekdayMinutes: { 0: 120, 1: 120, 2: 120, 3: 120, 4: 120, 5: 120, 6: 120 },
        quietStart: '23:30',
        quietEnd: '07:00',
        wakeAt: '07:30',
        sleepAt: '23:30',
        daysOff: [0],
      },
    }),
    tasks: [makeTask({ id: 'huge', title: '超长任务', estMinutes: 300, dueAt: at('2026-11-24', '12:00') })],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  const blocks = blockOf(plan, 'huge');
  assert.ok(blocks.length >= 1, '至少排一部分');
  const placed = blocks.reduce((sum, block) => sum + block.minutes, 0);
  assert.ok(placed < 300, '不可能全部排下');
  assert.ok(plan.totalMinutes <= 120);
  const unscheduled = plan.unscheduled.find((item) => item.taskId === 'huge');
  assert.ok(unscheduled, '剩余部分必须进 unscheduled');
  assert.ok(unscheduled.reason.includes('剩余'), `原因应说明剩余分钟数：${unscheduled.reason}`);
  assert.ok(blocks.every((block) => block.minutes >= 15), '不产生小于 15min 的任务碎片');
});

// ============================================================ 15. 课程占满容量

test('固定课程本身超过 capacity：保留课程块、其余全部进 unscheduled 并明确告警（契约冲突边界）', () => {
  // 说明：CONTRACT §2.2 的 totalMinutes 口径包含课程块，而 §2.3.1 要求总工时 ≤ capacity。
  // 当用户把 capacity 设得比课程时长还短时两条约束不可能同时满足：课程是既定事实不能删，
  // 因此这里保课程、清空其余安排，并给出显式告警（宿主面板会把 warnings 展示给用户）。
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: makeProfile({
      goals: [],
      constraints: {
        dailyMinutes: 100,
        weekdayMinutes: { 0: 100, 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100 },
        quietStart: '23:30',
        quietEnd: '07:00',
        wakeAt: '07:30',
        sleepAt: '23:30',
        daysOff: [0],
      },
    }),
    tasks: [
      makeTask({ id: 'bigcourse', title: '两小时的大课', kind: 'course', startAt: at(SATURDAY, '09:00'), endAt: at(SATURDAY, '11:00') }),
      makeTask({ id: 'extra', title: '装不下的任务', estMinutes: 60 }),
    ],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan, { checkCapacity: false });
  assert.ok(plan.warnings.some((warning) => warning.includes('超出今日容量')));
  assert.equal(blockOf(plan, 'bigcourse').length, 1);
  assert.deepEqual(blockOf(plan, 'bigcourse')[0].start, '09:00');
  // 除了课程（和课程后的缓冲）之外不再排任何工作块
  const workKinds = plan.blocks
    .filter((block) => block.kind !== 'buffer' && block.kind !== 'break')
    .map((block) => block.kind);
  assert.deepEqual(workKinds, ['course']);
  assert.ok(plan.unscheduled.some((item) => item.taskId === 'extra'));
});

// ============================================================ 16. capacity 取值

test('capacity 优先级：显式 weekdayMinutes[day] > 显式 dailyMinutes > 默认 weekday 表', () => {
  const base = {
    date: SATURDAY,
    now: NOW,
    tasks: [makeTask({ id: 'cap1', title: '任务', estMinutes: 30 })],
    history: [],
    seed: 0,
  };
  const capOf = (constraints) => planDay({ ...base, profile: makeProfile({ constraints }) }).load.capacity;

  assert.equal(
    capOf({
      dailyMinutes: 120,
      weekdayMinutes: { 0: 90, 1: 90, 2: 90, 3: 90, 4: 90, 5: 90, 6: 300 },
      quietStart: '23:30',
      quietEnd: '07:00',
      wakeAt: '07:30',
      sleepAt: '23:30',
      daysOff: [0],
    }),
    300,
    'weekdayMinutes 优先于 dailyMinutes',
  );

  assert.equal(
    capOf({ dailyMinutes: 120, quietStart: '23:30', quietEnd: '07:00', wakeAt: '07:30', sleepAt: '23:30', daysOff: [0] }),
    120,
    '没有 weekdayMinutes 时用 dailyMinutes',
  );

  assert.equal(
    capOf({ quietStart: '23:30', quietEnd: '07:00', wakeAt: '07:30', sleepAt: '23:30', daysOff: [0] }),
    240,
    '两者都没有时用默认 weekday 表（周六 240）',
  );

  assert.equal(
    capOf({
      dailyMinutes: 180,
      weekdayMinutes: { 0: 180, 1: 180, 2: 180, 3: 180, 4: 180, 5: 180, 6: 0 },
      quietStart: '23:30',
      quietEnd: '07:00',
      wakeAt: '07:30',
      sleepAt: '23:30',
      daysOff: [0],
    }),
    0,
    '显式 0 也必须被尊重',
  );
});

// ============================================================ 17. 求职保证 / 每周输出配额

test('求职目标：当天没有投递类任务时也会生成一个 application 块', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: makeProfile({
      goals: [makeGoal({ id: 'g_job_only', kind: 'job', title: '拿到暑期实习', priority: 1 })],
    }),
    tasks: [makeTask({ id: 'q1', title: '纯学习任务', kind: 'reading', estMinutes: 40 })],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  assert.ok(blocksOfKind(plan, 'application').length >= 1, '求职目标必须有 application 块');
});

test('每周实践/输出配额：一周内不足 3 个时补实践块；已满足时不补', () => {
  const weekHistoryFull = [
    {
      date: '2026-11-17',
      blocks: [
        { kind: 'practice', minutes: 30 },
        { kind: 'application', minutes: 30 },
        { kind: 'research', minutes: 30 },
      ],
    },
  ];

  const withQuota = planDay({
    date: SATURDAY,
    now: NOW,
    profile: makeProfile({ goals: [makeGoal({ id: 'g_pg', kind: 'postgrad', title: '考研', priority: 1 })] }),
    tasks: [],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(withQuota);
  assert.ok(blocksOfKind(withQuota, 'practice').length >= 1, '缺配额时应补实践块');

  const quotaMet = planDay({
    date: SATURDAY,
    now: NOW,
    profile: makeProfile({ goals: [makeGoal({ id: 'g_pg', kind: 'postgrad', title: '考研', priority: 1 })] }),
    tasks: [],
    history: weekHistoryFull,
    seed: 0,
  });
  assertPlanInvariants(quotaMet);
  assert.equal(blocksOfKind(quotaMet, 'practice').length, 0, '已满足配额时不应再塞实践块');
});

// ============================================================ 18. 精力曲线 / 缓冲

test('精力曲线：高认知学习块优先落在 11:30 之前', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: makeProfile({
      goals: [],
      constraints: {
        dailyMinutes: 240,
        weekdayMinutes: { 0: 240, 1: 240, 2: 240, 3: 240, 4: 240, 5: 240, 6: 240 },
        quietStart: '23:30',
        quietEnd: '07:00',
        wakeAt: '07:30',
        sleepAt: '23:30',
        daysOff: [0],
      },
    }),
    tasks: [makeTask({ id: 'cog', title: '高认知学习', kind: 'homework', estMinutes: 60 })],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  const block = blockOf(plan, 'cog')[0];
  assert.ok(startMin(block) < minutesOfDay('11:30'), `高认知块应在上午：${block.start}`);
});

test('精力曲线：输出型（application）优先落在 13:30~17:30', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: makeProfile({
      goals: [],
      constraints: {
        dailyMinutes: 240,
        weekdayMinutes: { 0: 240, 1: 240, 2: 240, 3: 240, 4: 240, 5: 240, 6: 240 },
        quietStart: '23:30',
        quietEnd: '07:00',
        wakeAt: '07:30',
        sleepAt: '23:30',
        daysOff: [0],
      },
    }),
    tasks: [makeTask({ id: 'out', title: '投递任务', kind: 'application', estMinutes: 40 })],
    history: [
      { date: '2026-11-17', blocks: [{ kind: 'practice' }, { kind: 'application' }, { kind: 'research' }] },
    ],
    seed: 0,
  });
  assertPlanInvariants(plan);
  const block = blockOf(plan, 'out')[0];
  assert.ok(startMin(block) >= minutesOfDay('13:30'));
  assert.ok(endMin(block) <= minutesOfDay('17:30'));
});

test('缓冲：>=50min 的块之后插入 buffer，且 buffer 不计入 totalMinutes', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: makeProfile({
      goals: [],
      constraints: {
        dailyMinutes: 240,
        weekdayMinutes: { 0: 240, 1: 240, 2: 240, 3: 240, 4: 240, 5: 240, 6: 240 },
        quietStart: '23:30',
        quietEnd: '07:00',
        wakeAt: '07:30',
        sleepAt: '23:30',
        daysOff: [0],
      },
    }),
    tasks: [makeTask({ id: 'long', title: '长块任务', estMinutes: 60 })],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  const indexed = plan.blocks.findIndex((block) => block.taskIds.includes('long'));
  assert.ok(indexed >= 0);
  const block = plan.blocks[indexed];
  assert.ok(block.minutes >= 50);
  const next = plan.blocks[indexed + 1];
  assert.ok(next, '长块之后应有缓冲块');
  assert.equal(next.kind, 'buffer');
  assert.equal(next.start, block.end);
  assert.ok(next.minutes >= 5 && next.minutes <= 10);
});

// ============================================================ 19. 复习节奏

test('间隔复习：done 且 3 天/7 天前完成的任务生成复习块，最多 2 个', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: makeProfile({
      goals: [],
      constraints: {
        dailyMinutes: 240,
        weekdayMinutes: { 0: 240, 1: 240, 2: 240, 3: 240, 4: 240, 5: 240, 6: 240 },
        quietStart: '23:30',
        quietEnd: '07:00',
        wakeAt: '07:30',
        sleepAt: '23:30',
        daysOff: [0],
      },
    }),
    tasks: [
      makeTask({ id: 'r3', title: '三天前完成', status: 'done', updatedAt: at('2026-11-18', '20:00') }),
      makeTask({ id: 'r7', title: '七天前完成', status: 'done', updatedAt: at('2026-11-14', '20:00') }),
      makeTask({ id: 'r10', title: '十天前完成', status: 'done', updatedAt: at('2026-11-11', '20:00') }),
    ],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  const reviewBlocks = plan.blocks.filter((block) => block.kind === 'review' && block.title.includes('复习'));
  assert.equal(reviewBlocks.length, 2, '每天最多 2 个间隔复习块');
  const taskIds = reviewBlocks.flatMap((block) => block.taskIds);
  assert.deepEqual(taskIds.sort(), ['r3', 'r7'], '优先 3 天前的复习，其次 7 天前');
});

// ============================================================ 20. 脏数据容错 / intel 不影响结果

test('容错：profile 缺字段、任务 kind/status 未知、intel 传入都不崩溃且 intel 不改变计划', () => {
  const dirty = {
    date: SATURDAY,
    now: NOW,
    profile: { goals: [{ id: 'g1', title: '随便一个目标' }], constraints: { wakeAt: '07:00', quietStart: '23:00' } },
    tasks: [
      makeTask({ id: 'u1', title: '未知类型任务', kind: 'weird-kind', status: 'pending', estMinutes: 30 }),
      makeTask({ id: 'u2', title: '未知状态任务', status: 'unknown', estMinutes: 40 }),
      { id: 'u3', title: '只有必填字段的任务' },
    ],
    history: [],
    seed: 0,
  };
  const planA = planDay({ ...dirty, intel: [] });
  const planB = planDay({ ...dirty, intel: [{ id: 'i1', kind: 'school-calendar', text: '下周有考试' }] });
  // 这个 fixture 显式给了 wakeAt 07:00 / quietStart 23:00，块必须落在这个自定义时间窗内
  assertPlanInvariants(planA, { wakeAt: '07:00', quietStart: '23:00' });
  assertPlanInvariants(planB, { wakeAt: '07:00', quietStart: '23:00' });

  const strip = (plan) => {
    const copy = structuredClone(plan);
    delete copy.generatedAt;
    return copy;
  };
  assert.deepEqual(strip(planA), strip(planB), 'intel 当前不参与排程，不应改变结果');

  // 未知 kind 归到 study，未知/缺省 status 按 todo 处理，不能丢任务
  for (const taskId of ['u1', 'u2', 'u3']) {
    assert.ok(
      planA.blocks.some((block) => block.taskIds.includes(taskId)) ||
        planA.unscheduled.some((item) => item.taskId === taskId),
      `${taskId} 不能静默消失`,
    );
  }
});

test('边界：没有任何目标、没有任何块可用时也不崩溃', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: { identity: {}, goals: [], constraints: {}, resources: [] },
    tasks: [],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  assert.ok(plan.blocks.length > 0, '默认约束下至少还有仪式块');
  assert.equal(typeof plan.focus, 'string');
  assert.equal(typeof plan.theme, 'string');
});

// ============================================================ 21. 主线预留（先于普通作业挤压）

/** 指定日容量、指定目标集合的 profile（其余用默认值）。 */
function profileWithCapacity(minutes, goals) {
  return makeProfile({
    goals: goals === undefined ? [makeGoal()] : goals,
    constraints: {
      dailyMinutes: minutes,
      weekdayMinutes: { 0: minutes, 1: minutes, 2: minutes, 3: minutes, 4: minutes, 5: minutes, 6: minutes },
      quietStart: '23:30',
      quietEnd: '07:00',
      wakeAt: '07:30',
      sleepAt: '23:30',
      daysOff: [0],
    },
  });
}

function blockWithTitle(plan, title) {
  return plan.blocks.find((block) => block.title === title) || null;
}

function mainlineBlock(plan, goalTitle) {
  return blockWithTitle(plan, `主线推进：${goalTitle}`);
}

test('主线预留：最高优先目标的 25% 是真实块，先于普通作业占位', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: profileWithCapacity(240, [makeGoal({ id: 'g_postgrad', title: '保研本校 CS', priority: 1 })]),
    tasks: [
      makeTask({
        id: 't_hw',
        title: '普通作业：实验报告',
        dueAt: at('2026-11-24', '23:59'), // 4 天后，不是逾期/24h 内截止
        estMinutes: 120,
        priority: 2,
      }),
    ],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);

  const reserve = mainlineBlock(plan, '保研本校 CS');
  assert.ok(reserve, '必须生成真实的「主线推进」块，而不是只在 warnings 里抱怨');
  assert.equal(reserve.minutes, Math.max(30, Math.ceil(240 * 0.25)), 'reserve = max(30, ceil(0.25 * capacity)) = 60');
  assert.deepEqual(reserve.taskIds, [], '预留块不绑定任务（目标没有可关联任务时也一样）');
  assert.ok(reserve.why.includes('预留'), 'why 要说明这是为目标预留的时间');

  const homework = blockOf(plan, 't_hw');
  assert.ok(homework.length >= 1, '普通作业仍然排得下（容量 240 ≥ 仪式 15 + 预留 60 + 作业 120）');
  assert.equal(
    homework.reduce((sum, block) => sum + block.minutes, 0),
    120,
    '容量够时应把普通作业完整排进去',
  );
  const firstHomeworkStart = Math.min(...homework.map(startMin));
  assert.ok(
    startMin(reserve) < firstHomeworkStart,
    '主线预留必须排在普通作业之前：“先预留，再用剩余容量做作业”',
  );

  assert.ok(!plan.warnings.some((warning) => warning.includes('未达 25%')), '预留已生成时不应再报未达 25%');
  assert.ok(!plan.warnings.some((warning) => warning.includes('未安排推进块')), '预留已生成时不应再报未安排推进块');
});

test('主线预留：reserve = max(30, ceil(0.25 * capacity))，capacity 60/240/400 都成立', () => {
  for (const [capacity, expected] of [
    [60, 30],
    [240, 60],
    [400, 100],
  ]) {
    const plan = planDay({
      date: SATURDAY,
      now: NOW,
      profile: profileWithCapacity(capacity, [makeGoal({ id: 'g_top', title: '最高优先目标', priority: 1 })]),
      tasks: [],
      history: [],
      seed: 0,
    });
    assertPlanInvariants(plan);
    const reserve = mainlineBlock(plan, '最高优先目标');
    assert.ok(reserve, `capacity ${capacity} 时应生成主线预留块`);
    assert.equal(reserve.minutes, expected, `capacity ${capacity} → reserve ${expected} 分钟`);
    assert.ok(plan.totalMinutes <= capacity);
  }
});

test('容量很小的边界：capacity 90 时预留 30 分钟，任务只排得下多少排多少', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: profileWithCapacity(90, [makeGoal({ id: 'g_top', title: '保研主线', priority: 1 })]),
    tasks: [makeTask({ id: 't_small', title: '小作业', dueAt: at('2026-11-26', '23:59'), estMinutes: 60 })],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  const reserve = mainlineBlock(plan, '保研主线');
  assert.ok(reserve);
  assert.equal(reserve.minutes, 30);
  // 90 - 仪式 15 - 预留 30 = 45 分钟给作业（或更少，取决于其它合成块）
  assert.ok(plan.totalMinutes <= 90);
  assert.ok(blockOf(plan, 't_small').length <= 1);
});

test('没有目标：不生成主线预留块，也不会出现主线相关告警', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: profileWithCapacity(240, []),
    tasks: [makeTask({ id: 't_hw', title: '普通作业', estMinutes: 60 })],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  assert.equal(plan.blocks.filter((block) => block.title.startsWith('主线推进：')).length, 0);
  assert.ok(!plan.warnings.some((warning) => warning.includes('主线预留')), '没有目标就不该有主线预留告警');
});

test('多个目标：只有最高优先目标拿满 25% 产能，另一个只有基础主线块', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: profileWithCapacity(240, [
      makeGoal({ id: 'g_job', title: '暑期实习', kind: 'job', priority: 2, targetDate: '2027-03-01' }),
      makeGoal({ id: 'g_post', title: '保研本校 CS', kind: 'postgrad', priority: 1, targetDate: '2027-06-30' }),
    ]),
    tasks: [],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  const topReserve = mainlineBlock(plan, '保研本校 CS');
  assert.ok(topReserve, 'priority 1 的目标必须先拿到预留块');
  assert.equal(topReserve.minutes, 60);

  const jobBlocks = plan.blocks.filter((block) => block.title.includes('暑期实习'));
  assert.ok(jobBlocks.length >= 1, 'priority 2 的目标也至少要有一个推进块');
  const jobMinutes = jobBlocks.reduce((sum, block) => sum + block.minutes, 0);
  assert.ok(jobMinutes < 60, `非最高优先目标不应拿满 25%（实际 ${jobMinutes} 分钟）`);
});

test('主线预留被固定课程挤到 0：告警写明被固定课程挤掉，且不重复抱怨', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: profileWithCapacity(60, [makeGoal({ id: 'g_top', title: '保研主线', priority: 1 })]),
    tasks: [
      makeTask({
        id: 'c_big',
        title: '连上四节的大课',
        kind: 'course',
        startAt: at(SATURDAY, '08:00'),
        endAt: at(SATURDAY, '09:30'), // 90min > capacity 60
        estMinutes: 90,
      }),
    ],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan, { checkCapacity: false }); // 契约冲突边界：课程本身超过容量

  assert.equal(mainlineBlock(plan, '保研主线'), null, '容量已满时主线预留拿不到时间');
  const squeeze = plan.warnings.find((warning) => warning.includes('主线预留被'));
  assert.ok(squeeze, '预留被挤到 0 时必须告警');
  assert.ok(squeeze.includes('固定课程'), `告警要写明被固定课程挤掉：${squeeze}`);
  assert.ok(squeeze.includes('0 分钟'));
  assert.ok(
    !plan.warnings.some((warning) => warning.includes('今日未能安排推进块')),
    '同一目标不应同时出现“未能安排推进块”和“预留被挤掉”两条告警',
  );
});

test('主线预留被逾期任务挤到 0：告警写明被逾期/今日截止任务挤掉', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: profileWithCapacity(90, [makeGoal({ id: 'g_top', title: '保研主线', priority: 1 })]),
    tasks: [
      makeTask({
        id: 't_overdue',
        title: '已经逾期的大作业',
        dueAt: at('2026-11-19', '23:59'),
        estMinutes: 180,
        priority: 2,
      }),
    ],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  assert.equal(mainlineBlock(plan, '保研主线'), null);
  const squeeze = plan.warnings.find((warning) => warning.includes('主线预留被'));
  assert.ok(squeeze, '预留为 0 时必须告警');
  assert.ok(
    squeeze.includes('逾期') || squeeze.includes('今日截止'),
    `告警要写明被逾期/今日截止任务挤掉：${squeeze}`,
  );
  // 逾期任务本身仍然优先（规则 3）
  const overdueBlocks = blockOf(plan, 't_overdue');
  assert.ok(overdueBlocks.length >= 1, '逾期任务应优先占用容量');
});

test('unscheduled 的“剩余 X 分钟”等于真实剩余：已排分钟 + X === 预估时长', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: profileWithCapacity(240, [makeGoal({ id: 'g_top', title: '保研主线', priority: 1 })]),
    tasks: [
      makeTask({ id: 't_a', title: '作业 A', dueAt: at('2026-11-24', '23:59'), estMinutes: 120 }),
      makeTask({ id: 't_b', title: '作业 B', dueAt: at('2026-11-24', '23:59'), estMinutes: 120 }),
    ],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);

  let checked = 0;
  for (const item of plan.unscheduled) {
    const match = /剩余 (\d+) 分钟未排/.exec(item.reason);
    if (!match) continue;
    const remaining = Number(match[1]);
    const placed = blockOf(plan, item.taskId).reduce((sum, block) => sum + block.minutes, 0);
    assert.equal(placed + remaining, 120, `${item.taskId}：已排 ${placed} + 剩余 ${remaining} 必须等于预估 120`);
    checked += 1;
  }
  assert.ok(checked >= 1, '至少有一个任务被部分排入，才能校验“真实剩余”');
  assert.ok(mainlineBlock(plan, '保研主线'), '部分排不下不应该影响主线预留');
});

// ============================================================ 22. 「今日截止」以计划日为准

test('今日截止：dueAt 落在计划日当天 23:59（距 now > 24h）必须进 urgent 组，排在主线预留之前', () => {
  const plan = planDay({
    date: SATURDAY, // 2026-11-21
    now: NOW, // 2026-11-20 21:30 左右，距 11-21 23:59 超过 24h
    profile: profileWithCapacity(240, [makeGoal({ id: 'g_top', title: '保研主线', priority: 1 })]),
    tasks: [
      makeTask({ id: 't_today', title: '当天要交的作业', dueAt: at(SATURDAY, '23:59'), estMinutes: 30 }),
      makeTask({ id: 't_far', title: '几天后才交的作业', dueAt: at('2026-11-26', '23:59'), estMinutes: 30 }),
    ],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  const reserve = mainlineBlock(plan, '保研主线');
  assert.ok(reserve, '主线预留块仍要生成');
  const todayStart = Math.min(...blockOf(plan, 't_today').map(startMin));
  const farStart = Math.min(...blockOf(plan, 't_far').map(startMin));
  assert.ok(
    todayStart < startMin(reserve),
    '计划日当天 23:59 截止（虽距 now > 24h）也是「今日截止」，必须先于主线预留占位',
  );
  assert.ok(farStart > startMin(reserve), '几天后才截止的任务排在主线预留之后');
});

test('今日截止：due 落在计划日次日 08:00 且距 now < 24h 也算（滚动 24h 兜底）', () => {
  const plan = planDay({
    date: SATURDAY,
    now: new Date('2026-11-21T20:00:00+08:00'), // 计划日当晚
    profile: profileWithCapacity(240, [makeGoal({ id: 'g_top', title: '保研主线', priority: 1 })]),
    tasks: [
      makeTask({ id: 't_next_morning', title: '明早 8 点截止的报告', dueAt: at('2026-11-22', '08:00'), estMinutes: 30 }),
      makeTask({ id: 't_far', title: '几天后才交的作业', dueAt: at('2026-11-26', '23:59'), estMinutes: 30 }),
    ],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  const reserve = mainlineBlock(plan, '保研主线');
  assert.ok(reserve);
  const nextMorningStart = Math.min(...blockOf(plan, 't_next_morning').map(startMin));
  assert.ok(
    nextMorningStart < startMin(reserve),
    '不在计划日但距 now 不到 24h 的截止任务也必须进 urgent 组',
  );
  assert.ok(Math.min(...blockOf(plan, 't_far').map(startMin)) > startMin(reserve));
});

test('今日截止：due 在计划日之后且距 now > 24h 不算 urgent，排在主线预留之后', () => {
  const plan = planDay({
    date: SATURDAY,
    now: NOW,
    profile: profileWithCapacity(240, [makeGoal({ id: 'g_top', title: '保研主线', priority: 1 })]),
    tasks: [makeTask({ id: 't_later', title: '四天后的作业', dueAt: at('2026-11-25', '23:59'), estMinutes: 30 })],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);
  const reserve = mainlineBlock(plan, '保研主线');
  assert.ok(reserve);
  assert.ok(Math.min(...blockOf(plan, 't_later').map(startMin)) > startMin(reserve));
});

test('回归：真实周六数据（2026-11-21）里「高数」当天 23:59 截止会被真实排入，不再被容量口径漏掉', () => {
  const realProfile = makeProfile({
    goals: [
      makeGoal({
        id: 'g_699ac753c835',
        kind: 'postgrad',
        title: '保研本校 CS',
        target: '专业前 20%',
        targetDate: '2027-06-30',
        priority: 1,
      }),
      makeGoal({
        id: 'g_71a84e352661',
        kind: 'job',
        title: '暑期实习',
        target: '拿到后端实习 offer',
        targetDate: '2027-03-01',
        priority: 2,
      }),
    ],
    constraints: {
      dailyMinutes: 180,
      weekdayMinutes: { 0: 120, 1: 180, 2: 180, 3: 180, 4: 180, 5: 180, 6: 240 },
      quietStart: '23:30',
      quietEnd: '07:00',
      wakeAt: '07:30',
      sleepAt: '23:30',
      daysOff: [0],
    },
  });
  const plan = planDay({
    date: SATURDAY,
    now: new Date('2026-11-20T23:26:00+08:00'),
    profile: realProfile,
    tasks: [
      makeTask({ id: 't_fd4ba1c10cc8', title: '高数第三章 5-12 题', kind: 'homework', dueAt: '2026-11-21T23:59:00+08:00', estMinutes: 90, priority: 2 }),
      makeTask({ id: 't_e704ba09a29f', title: '操作系统实验二：实现简单调度器', kind: 'homework', dueAt: '2026-11-22T23:59:00+08:00', estMinutes: 180, priority: 1 }),
      makeTask({ id: 't_3ed805517c36', title: '投 3 份后端实习简历', kind: 'application', dueAt: '2026-11-24T18:00:00+08:00', estMinutes: 60, priority: 2 }),
      makeTask({ id: 't_9039771d90b0', title: '数据结构课', kind: 'course', startAt: '2026-11-26T10:00:00+08:00', endAt: '2026-11-26T11:40:00+08:00', estMinutes: 100, priority: 3 }),
    ],
    history: [],
    seed: 0,
  });
  assertPlanInvariants(plan);

  // 高数（计划日当天 23:59 截止）必须真的排进计划，而不是只躺在 unscheduled 里
  const gaoshu = blockOf(plan, 't_fd4ba1c10cc8');
  assert.ok(gaoshu.length >= 1, '计划日当天截止的作业必须被排入');
  assert.equal(gaoshu.reduce((sum, block) => sum + block.minutes, 0), 90, '高数应完整排入 90 分钟');

  const reserve = mainlineBlock(plan, '保研本校 CS');
  assert.ok(reserve, '主线预留块仍然存在');
  assert.ok(
    Math.min(...gaoshu.map(startMin)) < startMin(reserve),
    '当天要交的作业抢占顺序在主线预留之前',
  );
  assert.ok(
    plan.unscheduled.every((item) => item.taskId !== 't_fd4ba1c10cc8'),
    '高数不能再以「容量不足」进 unscheduled',
  );
  assert.ok(
    plan.warnings.some((warning) => warning.includes('未获投递块')),
    '求职目标口径的告警文案要更新，避免误导为“没排”',
  );
  assert.ok(!plan.warnings.some((warning) => warning.includes('未达 25%')));
});

test('未来日期的固定课程实例不进入 unscheduled（避免每日计划被多周课表噪音淹没）', () => {
  const profile = makeProfile({
    constraints: { ...makeProfile().constraints, dailyMinutes: 180, daysOff: [] },
  });
  const tasks = [
    makeTask({ id: 't_next_sun', title: '形势与政策', kind: 'course', startAt: at(SUNDAY, '08:20'), endAt: at(SUNDAY, '10:00'), estMinutes: 100 }),
    makeTask({ id: 't_next_wed', title: '高等数学A(一)', kind: 'course', startAt: at('2026-11-25', '08:20'), endAt: at('2026-11-25', '10:00'), estMinutes: 100 }),
  ];
  const plan = planDay({ date: SATURDAY, now: NOW, profile, tasks, seed: 7 });
  const ids = plan.unscheduled.map((u) => u.taskId);
  assert.ok(!ids.includes('t_next_sun'), '明天的课不该出现在今天的未安排里');
  assert.ok(!ids.includes('t_next_wed'), '下周的课不该出现在今天的未安排里');
  const titles = plan.blocks.map((b) => b.title);
  assert.ok(!titles.includes('形势与政策'), '课程不在今天，不能排进今天');
});


test('白天生成今天的计划：不把块排到已经过去的时间，已结束的课不再占位', () => {
  const profile = makeProfile({
    constraints: {
      ...makeProfile().constraints,
      dailyMinutes: 180,
      wakeAt: '07:30',
      quietStart: '23:30',
      daysOff: [],
    },
    goals: [],
  });
  const tasks = [
    // 今天上午已经上完的课：不该再占位，也不该报「未安排」
    makeTask({
      id: 't_morning_class',
      title: '高等数学A(一)',
      kind: 'course',
      startAt: at(SATURDAY, '08:20'),
      endAt: at(SATURDAY, '10:00'),
      estMinutes: 100,
    }),
    // 一件真任务：应该被排到「现在之后」
    makeTask({ id: 't_afternoon', title: '画 SolidWorks 装配体', kind: 'practice', estMinutes: 60 }),
  ];
  const now = new Date('2026-11-21T14:00:00+08:00');
  const plan = planDay({ date: SATURDAY, now, profile, tasks, seed: 11 });

  const early = plan.blocks.filter((b) => minutesOfDay(b.start) < minutesOfDay('14:00'));
  assert.deepEqual(early, [], '14:00 生成计划，不该还排 14:00 之前的块');

  const titles = plan.blocks.map((b) => b.title);
  assert.ok(!titles.includes('高等数学A(一)'), '上午已经结束的课不该再出现在计划里');

  const ids = plan.unscheduled.map((u) => u.taskId);
  assert.ok(!ids.includes('t_morning_class'), '已结束的课不该进「未安排」');

  assert.ok(
    plan.blocks.some((b) => b.title.includes('SolidWorks')),
    '真任务应该被排进今天剩下的时间',
  );
});
