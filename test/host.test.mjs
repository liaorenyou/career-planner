/**
 * 插件整体自检（Host 侧）：不依赖真正的 DSH 宿主，用假的 ctx 把插件跑起来。
 *
 * 覆盖：工具注册、资料/任务落库、计划生成、系统提示词记忆、HTTP 面板接口、
 * 磁盘文件形状、计划的时间轴硬约束。
 *
 * 跑法：node --test test/host.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在导入插件之前设好 DSH_HOME：插件在 apply 时才读它（不能进程内改两次）
const HOME = await mkdtemp(join(tmpdir(), 'career-host-'));
process.env.DSH_HOME = HOME;

const plugin = await import('../index.js');

function fakeHost() {
  const tools = new Map();
  const routes = [];
  const promptSections = [];
  const timers = [];
  const disposers = [];
  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
        tools.set(definition.name, definition);
        const dispose = () => tools.delete(definition.name);
        disposers.push(dispose);
        return dispose;
      },
    },
    webServer: {
      register(route) {
        routes.push(route);
        const dispose = () => routes.splice(routes.indexOf(route), 1);
        disposers.push(dispose);
        return dispose;
      },
    },
    systemPrompt: {
      context(section) {
        promptSections.push(section);
        return () => {};
      },
      section(section) {
        promptSections.push(section);
        return () => {};
      },
    },
    timer: {
      // 记录但绝不真的触发：测试不该等 24 小时
      timeout(callback, delay) {
        timers.push({ callback, delay });
        return () => {};
      },
    },
    get(key) {
      return ctx[key];
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => dispose?.();
    },
    set() {},
    on() {},
  };
  return { ctx, tools, routes, promptSections, timers, disposers };
}

function fakeRequest(method, url, body) {
  const listeners = new Map();
  const req = {
    method,
    url,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return req;
    },
    destroy() {},
  };
  setImmediate(() => {
    if (body !== undefined) for (const fn of listeners.get('data') || []) fn(Buffer.from(body));
    for (const fn of listeners.get('end') || []) fn();
  });
  return req;
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    done: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers || {};
      return this;
    },
    end(body) {
      this.body = body || '';
      this.done = true;
    },
  };
}

async function waitDone(res, timeoutMs = 3000) {
  const started = Date.now();
  while (!res.done) {
    if (Date.now() - started > timeoutMs) throw new Error('http handler 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
  return JSON.parse(res.body);
}

const host = fakeHost();
plugin.apply(host.ctx, { timeZone: 'Asia/Shanghai', pushTime: '08:00', channels: ['qq'] });

const tool = (name) => {
  const definition = host.tools.get(name);
  assert.ok(definition, `缺少工具 ${name}`);
  return definition;
};
const call = async (name, args) => tool(name).execute(args ?? {}, {});

test('注册了全部 11 个工具，且都有 description / parameters / output.render', () => {
  const expected = [
    'career_get', 'career_profile_set', 'career_tasks_add', 'career_task_update',
    'career_plan_generate', 'career_chat_scan', 'career_research', 'career_push', 'career_done',
    'career_groups', 'career_chat_import',
  ];
  for (const name of expected) {
    const definition = tool(name);
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length > 20, `${name} 的 description 太短`);
    assert.equal(typeof definition.parameters, 'object');
    assert.equal(typeof definition.execute, 'function');
    assert.equal(typeof definition.output?.render, 'function');
  }
  assert.equal(host.tools.size, expected.length);
});

test('注册了系统提示词记忆段和 HTTP 路由', () => {
  assert.ok(host.promptSections.length >= 1, '没有注册系统提示词段');
  assert.equal(typeof host.promptSections[0].text, 'function');
  const route = host.routes.find((r) => r.path === '/career-planner/api');
  assert.ok(route, '没有注册 /career-planner/api 路由');
  assert.equal(route.kind, 'prefix');
  // prefix 匹配规则：pathname === path 或 pathname.startsWith(path + '/')，注册值不能带尾斜杠
  assert.ok(!route.path.endsWith('/'), 'prefix 路由不能以斜杠结尾，否则永远匹配不上');
});

test('写入身份/目标/约束，落盘且进记忆段', async () => {
  await call('career_profile_set', {
    identity: { name: '测试同学', school: '某某大学', major: '计算机', grade: '大三', gradYear: 2028 },
    goals: [
      { kind: 'postgrad', title: '考研上岸', target: '某 985 计算机', targetDate: '2027-12-20', priority: 1 },
      { kind: 'job', title: '拿到大厂暑期实习', target: '后端开发', priority: 2 },
    ],
    constraints: { dailyMinutes: 180, wakeAt: '07:30', quietStart: '23:30' },
    resources: [{ kind: 'course', title: '数据结构', detail: '已学完，A-', tags: ['基础'] }],
  });
  const raw = JSON.parse(await readFile(join(HOME, 'career-planner', 'profile.json'), 'utf8'));
  assert.equal(raw.identity.name, '测试同学');
  assert.equal(raw.goals.length, 2);
  assert.equal(raw.goals[0].priority, 1);
  assert.ok(raw.goals[0].id.startsWith('g_'));
  assert.equal(raw.constraints.dailyMinutes, 180);
  // 缺省字段要补齐（不能把 quietEnd 之类丢掉）
  assert.equal(raw.constraints.quietEnd, '07:00');
  assert.equal(raw.constraints.weekdayMinutes['0'], 120);

  const section = await host.promptSections[0].text();
  assert.match(section, /测试同学/);
  assert.match(section, /考研上岸/);
});

test('加任务去重、更新状态、落盘', async () => {
  const due = new Date(Date.now() + 36 * 3600 * 1000).toISOString();
  const first = await call('career_tasks_add', {
    tasks: [
      { title: '高数第三章习题', kind: 'homework', course: '高等数学', dueAt: due, estMinutes: 60, priority: 1 },
      { title: '改简历（后端方向）', kind: 'application', estMinutes: 45, priority: 2, goalId: 'g_x' },
      { title: '数据结构 线性表 复习', kind: 'study', estMinutes: 30 },
    ],
    source: 'chat',
    sourceRef: '老师群消息',
  });
  assert.equal(first.ok, true);
  assert.equal(first.added.length, 3);

  const second = await call('career_tasks_add', {
    tasks: [{ title: ' 高数第三章习题 ', kind: 'homework', course: '高等数学', dueAt: due }],
  });
  assert.equal(second.added.length, 0, '同标题同截止的任务应被去重');

  const raw = JSON.parse(await readFile(join(HOME, 'career-planner', 'tasks.json'), 'utf8'));
  assert.equal(raw.tasks.length, 3);
  assert.ok(raw.tasks.every((t) => typeof t.fingerprint === 'string' && t.fingerprint.length === 16));
  assert.ok(raw.tasks.every((t) => t.status === 'todo'));

  const target = raw.tasks.find((t) => t.title.includes('高数'));
  const updated = await call('career_task_update', {
    id: target.id,
    status: 'done',
    notes: '做到了第 8 题',
    addBreakdown: [{ title: '前半部分', minutes: 30 }],
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.task.status, 'done');
  assert.ok(updated.task.completedAt);
  assert.equal(updated.task.breakdown.length, 1);

  const missing = await call('career_task_update', { id: 't_nope', status: 'done' });
  assert.equal(missing.ok, false);
});

test('课程表周课可以一次展开成多周（repeatWeeks）', async () => {
  const start = new Date(Date.now() + 24 * 3600 * 1000);
  start.setHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 100 * 60 * 1000);
  const res = await call('career_tasks_add', {
    repeatWeeks: 3,
    tasks: [{
      title: '数据结构课',
      kind: 'course',
      course: '数据结构',
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      estMinutes: 100,
    }],
  });
  assert.equal(res.ok, true);
  assert.equal(res.added.length, 3, '3 周应展开成 3 条任务');

  const raw = JSON.parse(await readFile(join(HOME, 'career-planner', 'tasks.json'), 'utf8'));
  const courses = raw.tasks.filter((t) => t.title === '数据结构课');
  assert.equal(courses.length, 3);
  const starts = courses.map((t) => Date.parse(t.startAt)).sort((a, b) => a - b);
  const week = 7 * 24 * 3600 * 1000;
  assert.equal(starts[1] - starts[0], week);
  assert.equal(starts[2] - starts[1], week);
  // 每周时长保持一致
  for (const t of courses) {
    assert.equal(Date.parse(t.endAt) - Date.parse(t.startAt), 100 * 60 * 1000);
  }
  // 第 2/3 周要能看出是第几周
  assert.ok(courses.some((t) => String(t.notes || '').includes('第 2 周')));
});

test('生成今日计划：时间轴无重叠、在时间窗内、容量受控', async () => {
  const result = await call('career_plan_generate', {});
  assert.equal(result.ok, true);
  const plan = result.plan;
  assert.match(plan.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.isArray(plan.blocks) && plan.blocks.length > 0, '计划至少要有一个块');
  assert.equal(typeof plan.focus, 'string');
  assert.equal(typeof plan.theme, 'string');
  assert.ok(plan.totalMinutes > 0);

  const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const sorted = [...plan.blocks].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  for (let i = 0; i < sorted.length; i += 1) {
    const block = sorted[i];
    assert.ok(toMinutes(block.end) > toMinutes(block.start), `块 ${block.id} 的 end 不晚于 start`);
    assert.ok(toMinutes(block.start) >= 7 * 60, `块 ${block.id} 早于起床时间`);
    assert.ok(toMinutes(block.end) <= 23 * 60 + 59, `块 ${block.id} 越过 24 点`);
    if (i > 0) {
      assert.ok(toMinutes(sorted[i - 1].end) <= toMinutes(block.start), `块 ${block.id} 与前一块重叠`);
    }
    assert.equal(typeof block.why, 'string');
    assert.equal(typeof block.output, 'string');
    assert.ok(Array.isArray(block.taskIds));
  }
  const workMinutes = sorted
    .filter((b) => b.kind !== 'buffer' && b.kind !== 'break')
    .reduce((sum, b) => sum + (Number(b.minutes) || 0), 0);
  assert.equal(plan.totalMinutes, workMinutes, 'totalMinutes 必须等于非 buffer/break 块的分钟和');
  assert.ok(plan.totalMinutes <= 240 + 60, `计划工时 ${plan.totalMinutes} 超出合理容量`);

  const file = JSON.parse(await readFile(join(HOME, 'career-planner', 'plans', `${plan.date}.json`), 'utf8'));
  assert.equal(file.date, plan.date);
  assert.equal(file.blocks.length, plan.blocks.length);
});

test('career_get 能读到计划与统计', async () => {
  const state = await call('career_get', { sections: ['plan', 'stats', 'tasks'] });
  assert.equal(state.ok, true);
  assert.ok(state.plan);
  assert.ok(state.stats.tasksOpen >= 1);
  assert.match(state.digest, /<career-planner>/);
});

test('HTTP 面板接口：GET state', async () => {
  const route = host.routes.find((r) => r.path === '/career-planner/api');
  const res = fakeResponse();
  await route.handler(fakeRequest('GET', '/career-planner/api/state'), res);
  const payload = await waitDone(res);
  assert.equal(payload.ok, true);
  assert.ok(payload.data.plan, 'state 里应该带今日计划');
  assert.equal(typeof payload.data.profile.identity.name, 'string');
  assert.ok(Array.isArray(payload.data.tasks));
  assert.ok(payload.data.stats);
  assert.equal(typeof payload.data.push.time, 'string');
});

test('HTTP 面板接口：POST act 勾选完成 / 重排 / 改推送设置', async () => {
  const route = host.routes.find((r) => r.path === '/career-planner/api');
  const act = async (body) => {
    const res = fakeResponse();
    await route.handler(fakeRequest('POST', '/career-planner/api/act', JSON.stringify(body)), res);
    return waitDone(res);
  };

  const state = await act({ action: 'nonexistent' });
  assert.equal(state.ok, false);

  const before = (await (async () => {
    const res = fakeResponse();
    await route.handler(fakeRequest('GET', '/career-planner/api/state'), res);
    return waitDone(res);
  })()).data;
  const block = before.plan.blocks.find((b) => b.kind !== 'buffer' && b.kind !== 'break');
  assert.ok(block, '计划里应该有工作块');

  const toggled = await act({ action: 'toggleBlock', date: before.date, blockId: block.id });
  assert.equal(toggled.ok, true);
  assert.equal(toggled.data.plan.blocks.find((b) => b.id === block.id).done, true);

  const push = await act({ action: 'savePush', enabled: true, time: '07:30', channels: ['qq', 'file'] });
  assert.equal(push.ok, true);
  assert.equal(push.data.push.time, '07:30');
  assert.ok(push.data.push.channels.includes('file'));

  const badTime = await act({ action: 'savePush', time: '25:99' });
  assert.equal(badTime.ok, false);

  const added = await act({ action: 'addTask', task: { title: '面板加的任务', kind: 'other', estMinutes: 20 } });
  assert.equal(added.ok, true);

  const regenerated = await act({ action: 'regenerate' });
  assert.equal(regenerated.ok, true);
  assert.ok(regenerated.data.plan.blocks.length > 0);
});

test('推送设置落盘、推送结果如实记录（无凭据时不谎报成功）', async () => {
  // 1) 只传 channels = 改设置，不推送
  const configured = await call('career_push', { channels: ['file'], time: '07:30' });
  assert.equal(configured.ok, true);
  assert.equal(configured.push.channels.join(','), 'file');

  // 2) 再推一次：此时只有 file 通道，必须真的写出留档文件
  const result = await call('career_push', {});
  assert.equal(typeof result.ok, 'boolean');
  const pushFile = JSON.parse(await readFile(join(HOME, 'career-planner', 'push.json'), 'utf8'));
  assert.equal(pushFile.time, '07:30');
  assert.ok(pushFile.lastPushAt);
  assert.equal(typeof pushFile.lastResult, 'object');
  if (result.ok) {
    assert.ok(Array.isArray(result.results) && result.results.some((r) => r.ok));
  }
});

test('career_done 按推送序号勾选时间块（「完成 2」闭环）', async () => {
  // 先确保有一份今天的计划
  const generated = await call('career_plan_generate', {});
  assert.equal(generated.ok, true);

  // 无参调用：列出可勾选条目和序号
  const listing = await call('career_done', {});
  assert.ok(Array.isArray(listing.index) && listing.index.length > 0, '应返回显示序号映射');
  assert.equal(typeof listing.message, 'string');

  const target = listing.index[0];
  const done = await call('career_done', { n: target.n });
  assert.equal(done.ok, true);
  assert.equal(done.n, target.n);
  const block = done.plan.blocks.find((b) => b.id === target.blockId);
  assert.equal(block.done, true, '对应的时间块应被勾上');

  // 取消完成
  const undone = await call('career_done', { n: target.n, done: false });
  assert.equal(undone.ok, true);
  const after = undone.plan.blocks.find((b) => b.id === target.blockId);
  assert.equal(after.done, false);

  // 越界序号要给出可用列表而不是静默成功
  const bad = await call('career_done', { n: 99 });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /找不到|可勾选/);
});

test('定时器按每天固定时刻排程（不是固定 24h 后）', () => {
  assert.ok(host.timers.length >= 1, '应该至少排了一个定时器');
  const delay = host.timers[0].delay;
  assert.ok(delay > 0 && delay <= 24 * 3600 * 1000 + 5000, `定时延迟 ${delay}ms 不在一天之内`);
});

test('关注口径：文艺活动默认进忽略清单，可自行增删，并写进记忆段', async () => {
  // 默认就有「诗歌/征文/晚会」这类词，不需要用户先配置
  const before = JSON.parse(await readFile(join(HOME, 'career-planner', 'profile.json'), 'utf8'));
  assert.ok(Array.isArray(before.prefs.ignoreTopics));
  assert.ok(before.prefs.ignoreTopics.includes('诗歌'));
  assert.ok(before.prefs.ignoreTopics.includes('征文'));

  // 用户补充自己的口径（比如再加「电竞」），旧的不能被冲掉
  await call('career_profile_set', { prefs: { ignoreTopics: [...before.prefs.ignoreTopics, '电竞', '电竞'] } });
  const raw = JSON.parse(await readFile(join(HOME, 'career-planner', 'profile.json'), 'utf8'));
  assert.ok(raw.prefs.ignoreTopics.includes('诗歌'), '原有的忽略词不能被覆盖掉');
  assert.equal(raw.prefs.ignoreTopics.filter((x) => x === '电竞').length, 1, '重复词要去重');

  const section = await host.promptSections[0].text();
  assert.match(section, /关注口径/);
  assert.match(section, /诗歌/);
  assert.match(section, /文艺娱乐类活动直接忽略/);

  // 过滤函数本身：命中忽略词的不该进任务库
  const { isIgnoredText } = await import('../lib/store.js');
  assert.equal(isIgnoredText('诗歌散文大赛 11月26日晚22:00', raw.prefs), true);
  assert.equal(isIgnoredText('女生3V3篮球赛招募', raw.prefs), true);
  assert.equal(isIgnoredText('高数第三章作业，周五交', raw.prefs), false);
  assert.equal(isIgnoredText('', raw.prefs), false);
  // 豁免：志愿工时可能算第二课堂学分，不能被「乒乓球赛」这类词误杀
  assert.equal(isIgnoredText('乒乓球台值班志愿活动，计 5h 工时', raw.prefs), false);
});

test('清理', async () => {
  await rm(HOME, { recursive: true, force: true });
});
