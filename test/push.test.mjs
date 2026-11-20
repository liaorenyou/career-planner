// test/push.test.mjs —— push-channel 单元测试
//
// 运行：node --test test/push.test.mjs
// 只测纯函数、本地文件、本地 HTTP 和 stub 掉的 fetch；
// 不打真实外网、不用真实凭据（真实发送由 /tmp/career-push-live.mjs 单独做）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

import {
  defaultPaths,
  readStatusLog,
  readImBridgeMessages,
  parseQQCredentialsFromYaml,
  readQQCredentials,
} from '../lib/imsource.js';
import {
  formatPlanMessage,
  planDisplayIndex,
  classifyPushError,
  pushQQ,
  pushWeChat,
  pushAll,
  MAX_MESSAGE_CHARS,
} from '../lib/push.js';
import {
  buildTargets,
  lastPushDate,
  parseArgs,
  resolveHome,
  runPushCron,
} from '../bin/push-cron.mjs';

const cpLen = (text) => Array.from(text).length;

function makeTempDir() {
  return mkdtemp(path.join(tmpdir(), 'career-push-test-'));
}

function samplePlan(overrides = {}) {
  return {
    date: '2026-11-21',
    generatedAt: '2026-11-21T00:00:00.000Z',
    focus: '高数第三章收尾，投递两封简历',
    theme: '考研数学',
    blocks: [
      {
        id: 'b_1',
        start: '07:30',
        end: '08:10',
        kind: 'ritual',
        title: '晨间计划',
        taskIds: [],
        why: '先把今天定下来',
        output: '3 条今日重点',
        minutes: 40,
        done: false,
      },
      {
        id: 'b_2',
        start: '08:10',
        end: '08:20',
        kind: 'buffer',
        title: '缓冲',
        taskIds: [],
        why: '',
        output: '',
        minutes: 10,
        done: false,
      },
      {
        id: 'b_3',
        start: '08:20',
        end: '09:40',
        kind: 'study',
        title: '高数第三章习题',
        taskIds: ['t_1'],
        why: '考研数学是主线',
        output: '完成 1-20 题',
        minutes: 80,
        done: false,
      },
      {
        id: 'b_4',
        start: '09:50',
        end: '10:30',
        kind: 'application',
        title: '投递两封简历',
        taskIds: ['t_2'],
        why: '求职主线不能断',
        output: '2 个投递记录',
        minutes: 40,
        done: false,
      },
    ],
    unscheduled: [],
    totalMinutes: 160,
    load: { planned: 160, capacity: 180 },
    warnings: [],
    ...overrides,
  };
}

/** 用一个简单的假 Response 替身 stub 掉 fetch，记录每次请求。 */
function stubFetch(t, responder) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    const call = { url: String(url), method: init.method, headers: init.headers || {}, body };
    calls.push(call);
    const reply = await responder(call);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => reply.text ?? JSON.stringify(reply.json ?? {}),
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return calls;
}

// ---------------------------------------------------------------------------
// formatPlanMessage
// ---------------------------------------------------------------------------

test('formatPlanMessage：基本格式、纯文本、含交互提示', () => {
  const text = formatPlanMessage({ plan: samplePlan(), profile: {} });

  assert.ok(text.includes('【生涯日报 11月21日】'), text.slice(0, 80));
  assert.ok(text.includes('重点：高数第三章收尾'));
  assert.ok(text.includes('07:30-08:10'));
  assert.ok(text.includes('晨间计划'));
  assert.ok(text.includes('80min'));
  assert.ok(text.includes('｜'), '应带理由分隔符');
  assert.ok(text.includes('回复「完成 1」'), '应有回复提示');
  assert.ok(text.includes('共 160 分钟'));
  assert.ok(text.includes('3 个时间块'));

  // 不含 markdown：没有引用表格、加粗、标题
  assert.equal(/^\s*\|/m.test(text), false, '不能有 markdown 表格行');
  assert.equal(text.includes('---|'), false);
  assert.equal(text.includes('**'), false);
  assert.equal(/^#{1,6}\s/m.test(text), false);

  // buffer/break 不展示也不占号：显示序号连续（1..N），与「完成 N」一一对应
  assert.equal(text.includes('缓冲'), false);
  assert.ok(text.includes('2. 08:20-09:40'), '显示序号应连续：buffer 不占号');
  assert.ok(text.includes('3. 09:50-10:30'));
  assert.equal(/^4\. /m.test(text), false);
});

test('formatPlanMessage：withIndex 返回显示序号 -> blockId 映射，可供回复解析', () => {
  const plan = samplePlan();

  // 默认仍是字符串（兼容 host 现有调用：const text = formatPlanMessage({...})）
  const plain = formatPlanMessage({ plan });
  assert.equal(typeof plain, 'string');

  const { text, index } = formatPlanMessage({ plan, withIndex: true });
  assert.equal(typeof text, 'string');
  assert.equal(text, plain, 'withIndex 不应改变文本内容');

  // buffer（b_2）不展示，所以映射里没有它；n 连续
  assert.deepEqual(index, [
    { n: 1, blockId: 'b_1' },
    { n: 2, blockId: 'b_3' },
    { n: 3, blockId: 'b_4' },
  ]);

  // 模拟解析用户回复「完成 2」：n=2 -> blockId=b_3 -> 在 plan.blocks 里按 id 找到块
  const target = index.find((item) => item.n === 2);
  const block = plan.blocks.find((b) => b.id === target.blockId);
  assert.equal(block.title, '高数第三章习题');
  assert.ok(text.includes('2. 08:20-09:40'));

  // 空计划 / 只有 buffer 时 index 为空数组，仍是 { text, index }
  const empty = formatPlanMessage({ plan: null, withIndex: true });
  assert.deepEqual(empty.index, []);
  assert.equal(typeof empty.text, 'string');
});

test('planDisplayIndex：连续编号、跳过 buffer/break、无 id 时给空串', () => {
  assert.deepEqual(planDisplayIndex(samplePlan()).slice(0, 3), [
    { n: 1, blockId: 'b_1' },
    { n: 2, blockId: 'b_3' },
    { n: 3, blockId: 'b_4' },
  ]);

  const noId = planDisplayIndex({
    blocks: [
      { start: '07:30', end: '08:00', kind: 'study', title: '无 id 的块' },
      { start: '08:00', end: '08:10', kind: 'break', title: '休息' },
    ],
  });
  assert.deepEqual(noId, [{ n: 1, blockId: '' }]);

  assert.deepEqual(planDisplayIndex(null), []);
});

test('formatPlanMessage：超长截断后编号仍连续、显示块数与末尾统计一致', () => {
  const blocks = Array.from({ length: 40 }, (_, i) => ({
    id: `b_${i + 1}`,
    start: '07:30',
    end: '08:10',
    kind: i % 2 ? 'study' : 'practice',
    title: `第 ${i + 1} 块·把今天的任务往前推一点并记录产出`,
    taskIds: [],
    why: '理由写长一点，让消息更快超长，覆盖截断分支',
    output: '',
    minutes: 40,
    done: false,
  }));
  const plan = samplePlan({ blocks, totalMinutes: 40 * 40 });
  const { text, index } = formatPlanMessage({ plan, withIndex: true });

  assert.equal(index.length, 40);
  assert.ok(cpLen(text) <= MAX_MESSAGE_CHARS);
  assert.ok(text.includes('未显示'));

  // 截断后保留的行号必须是 1..kept 连续
  const numbers = [...text.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  assert.ok(numbers.length >= 1);
  numbers.forEach((n, i) => assert.equal(n, i + 1, `行号应连续，实际 ${numbers.join(',')}`));

  // 提示里「还有 N 个」+ 保留数 = 总展示数
  const dropped = Number((text.match(/还有 (\d+) 个时间块/) || [])[1]);
  assert.equal(numbers.length + dropped, 40);
  assert.ok(text.includes(`共 ${40 * 40} 分钟`));
});

test('formatPlanMessage：长度上限 1800 字（超长按块截断并提示）', () => {
  const blocks = Array.from({ length: 120 }, (_, i) => ({
    id: `b_${i}`,
    start: '07:30',
    end: '08:10',
    kind: 'study',
    title: `第 ${i + 1} 个学习块·背诵英语长难句并整理错题`,
    taskIds: [],
    why: '把今天的主线往前推一点点',
    output: '',
    minutes: 40,
    done: false,
  }));
  const text = formatPlanMessage({
    plan: samplePlan({ blocks, totalMinutes: 120 * 40 }),
  });

  assert.ok(cpLen(text) <= MAX_MESSAGE_CHARS, `实际 ${cpLen(text)} 字`);
  assert.ok(text.includes('未显示'), '截断时应提示还有块未显示');
  assert.ok(text.includes('回复「完成'), '截断后仍保留回复提示');

  // 截断后行号仍从 1 连续，不能出现跳号（否则「完成 N」会错位）
  const numbers = [...text.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  numbers.forEach((n, i) => assert.equal(n, i + 1, `行号应连续，实际 ${numbers.join(',')}`));
});

test('formatPlanMessage：plan 缺失/空计划也不 throw', () => {
  const fromNull = formatPlanMessage({ plan: null });
  assert.equal(typeof fromNull, 'string');
  assert.match(fromNull, /【生涯日报 \d+月\d+日】/);
  assert.ok(fromNull.includes('重新生成'));

  const fromEmptyPlan = formatPlanMessage({ plan: { date: '2026-11-22', blocks: [] } });
  assert.match(fromEmptyPlan, /【生涯日报 11月22日】/);
  assert.ok(fromEmptyPlan.includes('重新生成'));

  // 带目标时用第一个目标当兜底重点
  const withProfile = formatPlanMessage({
    plan: { date: '2026-11-22', blocks: [] },
    profile: { goals: [{ title: '考研上岸' }] },
  });
  assert.ok(withProfile.includes('重点：考研上岸'));
});

test('formatPlanMessage：date 参数与 plan.date 的优先级', () => {
  const plan = samplePlan({ date: '2026-12-01' });
  const text = formatPlanMessage({ plan, date: '2026-11-30' });
  assert.ok(text.includes('【生涯日报 12月1日】'), '优先用 plan.date');

  const noPlanDate = formatPlanMessage({ plan: { blocks: [] }, date: '2026-11-30' });
  assert.ok(noPlanDate.includes('【生涯日报 11月30日】'));
});

test('formatPlanMessage：逾期提醒与只含 buffer 的计划', () => {
  const warned = formatPlanMessage({
    plan: samplePlan({ warnings: ['任务「高数作业」已逾期', '今日容量不足'] }),
  });
  assert.ok(warned.includes('提醒：'));
  assert.ok(warned.includes('已逾期'));

  const onlyBuffers = formatPlanMessage({
    plan: samplePlan({
      blocks: [
        {
          id: 'b_buf',
          start: '12:00',
          end: '12:10',
          kind: 'buffer',
          title: '缓冲',
          taskIds: [],
          why: '',
          output: '',
          minutes: 10,
          done: false,
        },
      ],
      totalMinutes: 0,
    }),
  });
  assert.ok(onlyBuffers.includes('休息与缓冲'));
});

// ---------------------------------------------------------------------------
// classifyPushError
// ---------------------------------------------------------------------------

test('classifyPushError：401/403/429/其他', () => {
  assert.ok(classifyPushError(401, '{"code":11244}').startsWith('凭据失效'));
  assert.ok(classifyPushError(403, '').startsWith('凭据失效'));
  assert.ok(classifyPushError(429, 'too many').startsWith('频率限制'));
  assert.ok(classifyPushError(400, 'bad request').includes('HTTP 400'));
  assert.ok(classifyPushError(400, 'bad request').includes('bad request'));
  // body 截断，不会把超长 body 原样带回
  const longBody = 'x'.repeat(2000);
  assert.ok(classifyPushError(500, longBody).length < 300);
  // 没有状态码（网络失败）
  assert.ok(classifyPushError(undefined, '').includes('网络请求失败'));
  assert.ok(classifyPushError(0, 'ECONNRESET').includes('网络请求失败'));
});

// ---------------------------------------------------------------------------
// imsource.readStatusLog
// ---------------------------------------------------------------------------

test('readStatusLog：坏行跳过、openid 取最后一次、inbound 时间正序', async () => {
  const dir = await makeTempDir();
  const logPath = path.join(dir, 'status.log');
  const lines = [
    '{ 这不是 JSON',
    '42',
    '[1,2,3]',
    '',
    // QQ 入站：故意乱序（第二条时间更早）
    '{"time":"2026-11-20T05:00:00.000Z","event":"c2c-message","openid":"OPENID_A","text":"第一条"}',
    '{"time":"2026-11-20T03:00:00.000Z","event":"c2c-message","openid":"OPENID_B","text":"更早的一条"}',
    // 微信入站文本先出现，之后才有 replied 暴露 toUserId
    '{"time":"2026-11-20T06:00:00.000Z","event":"weixin-inbound-text","text":"微信来消息了"}',
    '{"time":"2026-11-20T06:00:01.000Z","event":"weixin-replied","toUserId":"WX_USER_1","status":200,"hasContextToken":true}',
    // 噪音行
    '{"time":"2026-11-20T07:00:00.000Z","event":"weixin-poll-failed","failures":237,"message":"session timeout"}',
    '{"time":"2026-11-20T07:00:01.000Z","event":"agent-created-seen","sessionId":"s1"}',
  ];
  await writeFile(logPath, `${lines.join('\n')}\n`, 'utf8');

  try {
    const result = await readStatusLog({ path: logPath, limit: 400 });

    assert.equal(result.lastQQOpenid, 'OPENID_A', '取最后一次出现的 QQ openid');
    assert.equal(result.lastWeixinOpenid, 'WX_USER_1');

    // inbound：2 条 QQ + 1 条微信，旧→新
    assert.equal(result.inbound.length, 3);
    assert.deepEqual(
      result.inbound.map((m) => m.platform),
      ['qq', 'qq', 'wechat'],
    );
    assert.deepEqual(
      result.inbound.map((m) => m.text),
      ['更早的一条', '第一条', '微信来消息了'],
    );
    // 微信 from 由 weixin-replied 回填
    assert.equal(result.inbound[2].from, 'WX_USER_1');
    // QQ from 是 openid
    assert.equal(result.inbound[0].from, 'OPENID_B');
    assert.equal(result.inbound[1].from, 'OPENID_A');

    // 时间正序
    const times = result.inbound.map((m) => Date.parse(m.at));
    for (let i = 1; i < times.length; i += 1) assert.ok(times[i] >= times[i - 1]);

    // entries：坏行被跳过，且都带 event
    assert.ok(result.entries.length > 0);
    for (const entry of result.entries) {
      assert.equal(typeof entry.event, 'string');
      assert.ok(entry.event.length > 0);
    }
    assert.equal(result.entries.some((e) => e.event === 'c2c-message'), true);

    // limit 只保留最近 N 条
    const limited = await readStatusLog({ path: logPath, limit: 2 });
    assert.equal(limited.entries.length, 2);
    assert.equal(limited.entries.at(-1).event, 'agent-created-seen');
    assert.equal(limited.lastQQOpenid, 'OPENID_A', 'openid 扫描整份日志，不受 limit 影响');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readStatusLog：文件不存在时返回空结果，不 throw', async () => {
  const result = await readStatusLog({ path: path.join(tmpdir(), `nope-${Date.now()}.log`) });
  assert.deepEqual(result, {
    entries: [],
    lastQQOpenid: null,
    lastWeixinOpenid: null,
    inbound: [],
  });
});

// ---------------------------------------------------------------------------
// imsource.readImBridgeMessages
// ---------------------------------------------------------------------------

test('readImBridgeMessages：控制口正常时返回归一化消息', async (t) => {
  const server = http.createServer((req, res) => {
    assert.ok(req.url.startsWith('/im-bridge/messages?'));
    assert.ok(req.url.includes('platform=qq'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        platform: 'qq',
        messages: [
          { role: 'user', text: '你好', seq: 1 },
          { role: 'assistant', text: '在的', seq: 2 },
          { role: 'user', text: '', seq: 3 }, // 空文本会被过滤
        ],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const messages = await readImBridgeMessages({ port, platform: 'qq', limit: 10 });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].platform, 'qq');
  assert.equal(messages[0].text, '你好');
  assert.equal(messages[0].seq, 1);
});

test('readImBridgeMessages：HTTP 非 2xx / 非 JSON 返回 []', async (t) => {
  let mode = '500';
  const server = http.createServer((req, res) => {
    if (mode === '500') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('not-json{');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  assert.deepEqual(await readImBridgeMessages({ port }), []);
  mode = 'garbage';
  assert.deepEqual(await readImBridgeMessages({ port }), []);
});

test('readImBridgeMessages：端口不可达返回 []', async () => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));

  assert.deepEqual(await readImBridgeMessages({ port }), []);
});

test('defaultPaths：结构与端口约定', () => {
  const paths = defaultPaths();
  assert.equal(typeof paths.home, 'string');
  assert.ok(paths.statusLog.endsWith('im-bridge-status.log'));
  assert.ok(paths.weixinToken.endsWith('im-bridge-weixin.json'));
  assert.ok(paths.statusJson.endsWith('im-bridge-status.json'));
  assert.equal(paths.controlPort, 8799);
  assert.equal(path.dirname(paths.statusLog), paths.home);
});

// ---------------------------------------------------------------------------
// pushQQ：参数校验 + 成功路径（stub fetch，不碰真实网络）
// ---------------------------------------------------------------------------

test('pushQQ：缺参数时结构化失败，不 throw', async () => {
  const empty = await pushQQ({ text: 'hi' });
  assert.equal(empty.ok, false);
  assert.equal(empty.channel, 'qq');
  assert.ok(empty.detail.includes('openid'));

  const noText = await pushQQ({ text: '   ', openid: 'o', appId: 'a', secret: 's' });
  assert.equal(noText.ok, false);
  assert.ok(noText.detail.includes('内容为空'));

  const noCreds = await pushQQ({ text: 'hi', openid: 'o' });
  assert.equal(noCreds.ok, false);
  assert.ok(noCreds.detail.includes('凭据'));
});

test('pushQQ：成功路径请求格式正确，token 缓存复用', async (t) => {
  const appId = `test-app-${Date.now()}-${Math.random()}`;
  const calls = stubFetch(t, (call) => {
    if (call.url === 'https://bots.qq.com/app/getAppAccessToken') {
      return { status: 200, json: { access_token: 'test-access-token', expires_in: 7200 } };
    }
    return { status: 200, json: { id: 'msg-1', timestamp: '2026-11-20T15:00:00Z' } };
  });

  const first = await pushQQ({ text: '你好', openid: 'OPENID_X', appId, secret: 'sec' });
  assert.equal(first.ok, true, first.detail);
  assert.equal(first.status, 200);
  assert.ok(first.detail.includes('已发送'));

  // 第二次：token 应复用（不再请求 token 接口）
  const second = await pushQQ({ text: '再来一条', openid: 'OPENID_X', appId, secret: 'sec' });
  assert.equal(second.ok, true);

  const tokenCalls = calls.filter((c) => c.url === 'https://bots.qq.com/app/getAppAccessToken');
  const messageCalls = calls.filter((c) => c.url.includes('/v2/users/'));
  assert.equal(tokenCalls.length, 1, 'token 应缓存复用');
  assert.equal(messageCalls.length, 2);
  assert.deepEqual(tokenCalls[0].body, { appId, clientSecret: 'sec' });

  const messageCall = messageCalls[0];
  assert.equal(messageCall.method, 'POST');
  assert.equal(messageCall.url, 'https://api.sgroup.qq.com/v2/users/OPENID_X/messages');
  assert.equal(messageCall.headers.authorization, 'QQBot test-access-token');
  assert.deepEqual(messageCall.body, { content: '你好', msg_type: 0 });
  assert.equal('msg_id' in messageCall.body, false, '主动消息不带 msg_id');
});

test('pushQQ：401 归类为凭据失效；网络异常结构化返回', async (t) => {
  const calls = stubFetch(t, () => ({
    status: 401,
    text: '{"code":11244,"message":"invalid appid"}',
  }));
  const result = await pushQQ({
    text: 'hi',
    openid: 'o',
    appId: `bad-app-${Date.now()}`,
    secret: 'bad',
  });
  assert.equal(result.ok, false);
  assert.ok(result.detail.includes('凭据失效'), result.detail);
  assert.equal(result.status, 401);
  assert.equal(calls.length, 1);

  // 网络异常（fetch 直接 throw）
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const network = await pushQQ({
    text: 'hi',
    openid: 'o',
    appId: `net-app-${Date.now()}`,
    secret: 's',
  });
  assert.equal(network.ok, false);
  assert.ok(network.detail.includes('网络请求失败'));
});

// ---------------------------------------------------------------------------
// pushWeChat：优雅降级 + 成功路径（stub fetch）
// ---------------------------------------------------------------------------

test('pushWeChat：缺 context_token / 无 token 文件都优雅失败，不 throw', async (t) => {
  const dir = await makeTempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const calls = stubFetch(t, () => ({ status: 200, json: { message_id: 1 } }));

  // 真实 ~/.dsh/im-bridge-weixin.json 就是只有 botToken、缺 context_token 的状态
  const tokenPath = path.join(dir, 'weixin.json');
  await writeFile(
    tokenPath,
    JSON.stringify({ botToken: 'fake-token', savedAt: '2026-10-26T03:56:41.544Z' }),
    'utf8',
  );

  const degraded = await pushWeChat({ text: 'hi', tokenPath });
  assert.equal(degraded.ok, false);
  assert.equal(degraded.channel, 'wechat');
  assert.ok(degraded.detail.includes('context_token'), degraded.detail);

  const missingFile = await pushWeChat({ text: 'hi', tokenPath: path.join(dir, 'nope.json') });
  assert.equal(missingFile.ok, false);
  assert.ok(missingFile.detail.includes('不可用'));

  const emptyText = await pushWeChat({ text: '', tokenPath });
  assert.equal(emptyText.ok, false);
  assert.equal(emptyText.detail.includes('内容为空'), true);

  assert.equal(calls.length, 0, '降级路径不应发起网络请求');
});

test('pushWeChat：成功路径请求体符合 iLink 协议（字段名宽容读取）', async (t) => {
  const dir = await makeTempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokenPath = path.join(dir, 'wx.json');
  // 下划线命名 + 嵌套一层也要能读出来
  await writeFile(
    tokenPath,
    JSON.stringify({ data: { bot_token: 'bot-tok', to_user_id: 'wx-user' }, context_token: 'ctx-tok' }),
    'utf8',
  );

  const calls = stubFetch(t, () => ({ status: 200, json: { message_id: 7524670155132954888 } }));
  const result = await pushWeChat({ text: 'hello 微信', tokenPath });

  assert.equal(result.ok, true, result.detail);
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ilinkai.weixin.qq.com/ilink/bot/sendmessage');
  assert.equal(calls[0].headers['content-type'], 'application/json');

  const { msg, base_info: baseInfo } = calls[0].body;
  assert.equal(msg.to_user_id, 'wx-user');
  assert.equal(msg.context_token, 'ctx-tok');
  assert.equal(msg.msg_type, 0);
  assert.equal(msg.content, 'hello 微信');
  assert.equal(typeof msg.client_id, 'string');
  assert.ok(msg.client_id.length > 0);
  assert.equal(baseInfo.channel_version, '2.4.9');
});

test('pushWeChat：errcode=-14 返回 session 过期提示，不 throw', async (t) => {
  const dir = await makeTempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokenPath = path.join(dir, 'wx.json');
  await writeFile(
    tokenPath,
    JSON.stringify({ bot_token: 't', to_user_id: 'u', context_token: 'c' }),
    'utf8',
  );
  stubFetch(t, () => ({ status: 200, json: { errcode: -14, errmsg: 'session timeout' } }));

  const result = await pushWeChat({ text: 'hi', tokenPath });
  assert.equal(result.ok, false);
  assert.ok(result.detail.includes('errcode=-14'), result.detail);
  assert.ok(result.detail.includes('过期'), result.detail);
});

// ---------------------------------------------------------------------------
// pushAll：多通道互不影响 + file 兜底
// ---------------------------------------------------------------------------

test('pushAll：禁用通道跳过，file 通道写入日期文件', async (t) => {
  const dir = await makeTempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const plan = samplePlan();
  const fileDir = path.join(dir, 'push');
  const results = await pushAll({
    text: formatPlanMessage({ plan }),
    plan,
    targets: {
      qq: { enabled: false },
      wechat: { enabled: false },
      file: { dir: fileDir },
    },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].channel, 'file');
  assert.equal(results[0].ok, true);
  const written = await readFile(path.join(fileDir, '2026-11-21.txt'), 'utf8');
  assert.ok(written.includes('【生涯日报 11月21日】'));
});

test('pushAll：QQ 失败不影响 file；未传 text 时用 plan 生成', async (t) => {
  const dir = await makeTempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const plan = samplePlan();
  const fileDir = path.join(dir, 'out');

  const results = await pushAll({
    plan,
    targets: {
      qq: { enabled: true }, // 缺 openid/凭据 -> ok:false
      file: { dir: fileDir },
    },
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].channel, 'qq');
  assert.equal(results[0].ok, false);
  assert.equal(results[1].channel, 'file');
  assert.equal(results[1].ok, true);

  const written = await readFile(path.join(fileDir, '2026-11-21.txt'), 'utf8');
  assert.ok(written.includes('重点：高数第三章收尾'), '未传 text 时应由 plan 格式化出内容');
});

test('pushAll：没有任何 targets 时返回空数组', async () => {
  assert.deepEqual(await pushAll({ text: 'hi' }), []);
  assert.deepEqual(await pushAll({}), []);
});

// ---------------------------------------------------------------------------
// 凭据读取：~/.dsh/.credentials.yaml 的 im-bridge/bot 记录
// ---------------------------------------------------------------------------

const CREDENTIALS_YAML = [
  'version: 1',
  'records:',
  '  other/record:',
  '    kind: api-key',
  '    env:',
  '      QQ_BOT_APPID: "999"',
  '  im-bridge/bot:',
  '    kind: api-key',
  '    env:',
  '      QQ_BOT_APPID: "123456789"  # 机器人 AppID',
  "      QQ_BOT_SECRET: 'test-secret-not-real'",
  '  tail/record:',
  '    kind: api-key',
].join('\n');

test('parseQQCredentialsFromYaml：宽容解析 im-bridge/bot 记录，缺字段返回 null', () => {
  assert.deepEqual(parseQQCredentialsFromYaml(CREDENTIALS_YAML), {
    appId: '123456789',
    secret: 'test-secret-not-real',
  });
  assert.equal(parseQQCredentialsFromYaml(CREDENTIALS_YAML, 'other/record'), null, '缺 secret 应返回 null');
  assert.equal(parseQQCredentialsFromYaml('version: 1\nrecords: {}\n'), null);
  assert.equal(parseQQCredentialsFromYaml(''), null);
});

test('readQQCredentials：环境变量优先；文件缺失/残缺返回 null，不 throw', async (t) => {
  const dir = await makeTempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, '.credentials.yaml');
  await writeFile(file, CREDENTIALS_YAML, 'utf8');

  assert.deepEqual(await readQQCredentials({ path: file, env: {} }), {
    appId: '123456789',
    secret: 'test-secret-not-real',
    source: file,
  });

  assert.deepEqual(
    await readQQCredentials({ path: path.join(dir, 'missing.yaml'), env: { QQ_BOT_APPID: ' env-app ', QQ_BOT_SECRET: 'env-secret' } }),
    { appId: 'env-app', secret: 'env-secret', source: 'env:QQ_BOT_APPID/QQ_BOT_SECRET' },
  );

  assert.equal(await readQQCredentials({ path: path.join(dir, 'missing.yaml'), env: {} }), null);

  const partial = path.join(dir, 'partial.yaml');
  await writeFile(partial, 'im-bridge/bot:\n  env:\n    QQ_BOT_APPID: "1"\n', 'utf8');
  assert.equal(await readQQCredentials({ path: partial, env: {} }), null);
});

// ---------------------------------------------------------------------------
// push-cron：不依赖 DSH 进程的 8 点推送兜底
// ---------------------------------------------------------------------------

function cronProfile() {
  return {
    version: 1,
    identity: { name: '测试用户', school: '示例大学', major: '计算机', grade: '大三', gradYear: 2028 },
    goals: [
      { id: 'g_1', kind: 'postgrad', title: '保研本校 CS', target: '专业前 20%', targetDate: '2027-06-30', priority: 1 },
      { id: 'g_2', kind: 'job', title: '暑期实习', target: '拿到后端实习 offer', targetDate: '2027-03-01', priority: 2 },
    ],
    constraints: { dailyMinutes: 120 },
    resources: [],
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

/** 临时 DSH_HOME：自动清理；返回离线可跑的 run(argv)。 */
async function setupCronHome(t, { push, profile = cronProfile() } = {}) {
  const dir = await makeTempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, '.dsh');
  const base = path.join(home, 'career-planner');
  await mkdir(base, { recursive: true });
  if (profile) await writeFile(path.join(base, 'profile.json'), JSON.stringify(profile, null, 2), 'utf8');
  if (push) await writeFile(path.join(base, 'push.json'), JSON.stringify(push, null, 2), 'utf8');
  const lines = [];
  // 固定「上海时间 08:10」，与 launchd 的 08:00 同一时区
  const run = (argv, now = new Date('2026-11-20T00:10:00.000Z')) =>
    runPushCron({ argv, env: { DSH_HOME: home }, now, out: (line) => lines.push(line) });
  return { dir, home, base, lines, run };
}

async function readCronLog(base) {
  const text = await readFile(path.join(base, 'push-cron.log'), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line));
}

test('push-cron：parseArgs / resolveHome / lastPushDate / buildTargets', () => {
  const args = parseArgs(['--dry', '--force', '--bogus']);
  assert.equal(args.dry, true);
  assert.equal(args.force, true);
  assert.equal(args.help, false);
  assert.deepEqual(args.unknown, ['--bogus']);
  assert.equal(parseArgs(['-f']).force, true);
  assert.equal(parseArgs(['-h']).help, true);

  assert.equal(resolveHome({ DSH_HOME: '/tmp/dsh-home', HOME: '/home/u' }), '/tmp/dsh-home');
  assert.equal(resolveHome({ HOME: '/home/u' }), path.join('/home/u', '.dsh'));

  assert.equal(lastPushDate({ lastPushAt: '2026-11-20T00:05:00.000Z' }, 'Asia/Shanghai'), '2026-11-20');
  assert.equal(lastPushDate({ lastPushAt: '2026-11-20T16:30:00.000Z' }, 'Asia/Shanghai'), '2026-11-21');
  assert.equal(lastPushDate({ lastPushAt: 'not-a-date' }), '');
  assert.equal(lastPushDate({}), '');

  const targets = buildTargets({
    push: { channels: ['qq', 'wechat'] },
    home: '/home/u/.dsh',
    traces: { lastQQOpenid: 'openid-from-log' },
    creds: { appId: 'app', secret: 'sec' },
  });
  assert.equal(targets.qq.enabled, true);
  assert.equal(targets.qq.openid, 'openid-from-log');
  assert.equal(targets.qq.appId, 'app');
  assert.equal(targets.qq.secret, 'sec');
  assert.equal(targets.wechat.tokenPath, path.join('/home/u/.dsh', 'im-bridge-weixin.json'));
  assert.ok(targets.file.dir.endsWith(path.join('career-planner', 'outbox')));

  const fileOnly = buildTargets({ push: { channels: ['file'] }, home: '/h' });
  assert.equal(fileOnly.qq, undefined);
  assert.equal(fileOnly.wechat, undefined);
});

test('push-cron --dry：现算计划、打印格式化消息、写 dry 日志、绝不发送', async (t) => {
  const { base, lines, run } = await setupCronHome(t);

  const result = await run(['--dry']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.action, 'dry');
  assert.equal(result.date, '2026-11-20');
  assert.ok(result.plan && Array.isArray(result.plan.blocks) && result.plan.blocks.length > 0, '应现算出一份计划');
  assert.ok(result.message.includes('【生涯日报'), 'dry 应打印格式化后的日报');
  assert.ok(result.index.length > 0);

  const log = await readCronLog(base);
  assert.equal(log.at(-1).event, 'dry');
  assert.equal(log.at(-1).exitCode, 0);
  assert.equal(log.at(-1).date, '2026-11-20');

  // 现算的计划应落盘
  const planRaw = JSON.parse(await readFile(path.join(base, 'plans', '2026-11-20.json'), 'utf8'));
  assert.equal(planRaw.date, '2026-11-20');

  // 不发送：不产生 outbox 文件，也不写 push.json 的 lastPushAt
  await assert.rejects(readFile(path.join(base, 'outbox', '2026-11-20.txt'), 'utf8'), /ENOENT/);
  const pushRaw = await readFile(path.join(base, 'push.json'), 'utf8').catch(() => '');
  assert.ok(!pushRaw.includes('lastPushAt') || !JSON.parse(pushRaw).lastPushAt, 'dry 不能标记已推送');
});

test('push-cron：同日已推过 => skip: already pushed；--force 绕过且 file 通道成功', async (t) => {
  const { base, lines, run } = await setupCronHome(t, {
    push: {
      enabled: true,
      time: '08:00',
      timeZone: 'Asia/Shanghai',
      channels: ['file'],
      lastPushAt: '2026-11-20T00:05:00.000Z',
      lastResult: {},
    },
  });

  const skipped = await run([]);
  assert.equal(skipped.exitCode, 0);
  assert.equal(skipped.action, 'skip');
  assert.ok(
    lines.some((line) => line === 'skip: already pushed (lastPushAt=2026-11-20T00:05:00.000Z)'),
    'launchd 日志里要出现明确的 skip 行',
  );
  const log = await readCronLog(base);
  assert.equal(log.at(-1).event, 'skip');
  await assert.rejects(readFile(path.join(base, 'outbox', '2026-11-20.txt'), 'utf8'), /ENOENT/, '跳过时不应发送');

  lines.length = 0;
  const forced = await run(['--force']);
  assert.equal(forced.action, 'push');
  assert.equal(forced.exitCode, 0);
  assert.equal(forced.byChannel.file.ok, true);
  const written = await readFile(path.join(base, 'outbox', '2026-11-20.txt'), 'utf8');
  assert.ok(written.includes('【生涯日报'));
  const pushRaw = JSON.parse(await readFile(path.join(base, 'push.json'), 'utf8'));
  assert.ok(pushRaw.lastPushAt, '--force 成功后要写 lastPushAt 供幂等判断');
  assert.equal(pushRaw.lastResult.file.ok, true);

  // --dry 不受幂等限制，仍可查看消息
  lines.length = 0;
  const dry = await run(['--dry']);
  assert.equal(dry.action, 'dry');
  assert.ok(lines.includes('dry: not sent'));
});

test('push-cron：push.enabled=false 时跳过（--force 仍可强推）', async (t) => {
  const { lines, run } = await setupCronHome(t, {
    push: { enabled: false, timeZone: 'Asia/Shanghai', channels: ['file'] },
  });

  const skipped = await run([]);
  assert.equal(skipped.exitCode, 0);
  assert.equal(skipped.reason, 'push disabled');
  assert.ok(lines.some((line) => line === 'skip: push disabled'));

  lines.length = 0;
  const forced = await run(['--force']);
  assert.equal(forced.action, 'push');
  assert.equal(forced.exitCode, 0);
});

test('push-cron：profile.json 缺失 => 退出码 2，并写 config-missing 日志', async (t) => {
  const { base, lines, run } = await setupCronHome(t, { profile: null });

  const result = await run([]);
  assert.equal(result.exitCode, 2);
  assert.equal(result.action, 'config-missing');
  assert.ok(lines.some((line) => line.includes('配置缺失')), '要打印人能看懂的原因');

  const log = await readCronLog(base);
  assert.equal(log.at(-1).event, 'config-missing');
  assert.equal(log.at(-1).exitCode, 2);
});

test('push-cron：QQ 通道失败但 file 留档成功 => 退出码 1（file 不算通知成功）', async (t) => {
  const { run } = await setupCronHome(t, {
    push: { enabled: true, timeZone: 'Asia/Shanghai', channels: ['qq'] },
  });

  const result = await run([]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.action, 'push');
  assert.equal(result.byChannel.qq.ok, false, '临时 DSH_HOME 里没有凭据/openid，QQ 应结构化失败');
  assert.equal(result.byChannel.file.ok, true, 'file 通道仍应留档');
  assert.ok(String(result.byChannel.qq.detail).length > 0);
});
