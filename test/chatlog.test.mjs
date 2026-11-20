import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  QQKeyMissingError,
  __internal,
  dedupeCandidates,
  extractTaskCandidates,
  guessKind,
  isNoiseText,
  isTaskText,
  makeTitle,
  mergeRelated,
  openQQDb,
  parseGroupsJson,
  readDbKey,
  readGroupList,
  readQQMessages,
  scoreConfidence,
} from '../lib/chatlog.js';

// 固定锚点：2026-11-21（周六）09:00 Asia/Shanghai。所有时间断言都对着它算，
// 跟跑测试的机器在哪个时区、系统时区怎么设都无关。
const NOW = Date.parse('2026-11-21T09:00:00+08:00');
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const TMP = mkdtempSync(join(tmpdir(), 'career-chatlog-'));
const PLAIN_MSG_DB = '/tmp/v3-nt_msg.db';
const PLAIN_GROUP_DB = '/tmp/v3-group_info.db';
const REAL_GROUP_INFO_DB = join(
  process.env.HOME || '',
  '.dsh/career-planner/qq/group_info.db',
);

function dueIso(text, now = NOW) {
  const info = __internal.parseDueInfo(text, now);
  return info && info.iso ? info.iso : null;
}

function msg(id, groupCode, ts, text, groupName = '示例通知群C') {
  return { id: String(id), groupCode, groupName, senderId: '10001', ts, text };
}

// ---------------------------------------------------------------------------
// 1. 密钥
// ---------------------------------------------------------------------------

test('readDbKey：读纯 16 字节 ASCII 密钥', () => {
  const path = join(TMP, 'dbkey-plain.txt');
  writeFileSync(path, 'ABCDEF0123456789\n');
  assert.equal(readDbKey(path), 'ABCDEF0123456789');
});

test('readDbKey：兼容 key= 前缀与 JSON 两种写法', () => {
  const eq = join(TMP, 'dbkey-eq.txt');
  writeFileSync(eq, 'key=abcdefghijklmnop\n');
  assert.equal(readDbKey(eq), 'abcdefghijklmnop');

  const json = join(TMP, 'dbkey.json');
  writeFileSync(json, '{"key":"0123456789abcdef"}');
  assert.equal(readDbKey(json), '0123456789abcdef');
});

test('readDbKey：文件不存在 / 内容不对 → QQKeyMissingError', () => {
  assert.throws(
    () => readDbKey(join(TMP, 'no-such-key.txt')),
    (err) => err instanceof QQKeyMissingError && /不存在/.test(err.message),
  );
  const short = join(TMP, 'dbkey-short.txt');
  writeFileSync(short, 'too-short');
  assert.throws(() => readDbKey(short), QQKeyMissingError);
  assert.throws(() => readDbKey(''), QQKeyMissingError);
});

// ---------------------------------------------------------------------------
// 2. 群白名单 JSON
// ---------------------------------------------------------------------------

test('parseGroupsJson：数组形式，字段归一化', () => {
  const groups = parseGroupsJson(
    JSON.stringify([
      { code: 100000001, name: '示例通知群A', enabled: true },
      { groupCode: '100000002', title: '示例通知群B' },
    ]),
  );
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], { code: 100000001, name: '示例通知群A', enabled: true });
  assert.equal(groups[1].code, 100000002);
  assert.equal(groups[1].name, '示例通知群B');
  assert.equal(typeof groups[1].enabled, 'boolean');
});

test('parseGroupsJson：对象形式 + enabled=false 保留 + 按群号去重', () => {
  const groups = parseGroupsJson({
    groups: [
      { code: 100000003, name: '示例通知群C', enabled: false },
      { code: '100000003', name: '重复的同一个群' },
    ],
  });
  assert.equal(groups.length, 1, '同群号应去重');
  assert.equal(groups[0].code, 100000003);
});

test('parseGroupsJson：空串 / 坏 JSON / null 一律返回空数组（不抛）', () => {
  assert.deepEqual(parseGroupsJson(''), []);
  assert.deepEqual(parseGroupsJson('   '), []);
  assert.deepEqual(parseGroupsJson('这不是 JSON'), []);
  assert.deepEqual(parseGroupsJson(null), []);
  assert.deepEqual(parseGroupsJson([]), []);
});

// ---------------------------------------------------------------------------
// 3. 中文时间解析（Asia/Shanghai，锚点固定）
// ---------------------------------------------------------------------------

test('时间：今天/明天/后天（无时刻 → 当天 23:59）', () => {
  assert.equal(dueIso('今天交作业'), '2026-11-21T23:59:00+08:00');
  assert.equal(dueIso('明天前提交'), '2026-11-22T23:59:00+08:00');
  assert.equal(dueIso('后天之前完成'), '2026-11-23T23:59:00+08:00');
});

test('时间：周X / 本周X / 下周X', () => {
  assert.equal(dueIso('周日前完成'), '2026-11-22T23:59:00+08:00');
  assert.equal(dueIso('本周六晚上12点截止'), '2026-11-22T00:00:00+08:00');
  assert.equal(dueIso('下周四前交'), '2026-11-26T23:59:00+08:00');
  assert.equal(dueIso('请在周一提交'), '2026-11-23T23:59:00+08:00');
});

test('时间：月日 + 可选时刻，纯日期取 23:59', () => {
  assert.equal(dueIso('11月26日'), '2026-11-26T23:59:00+08:00');
  assert.equal(
    dueIso('投稿截止：11 月 26 日（下周四）晚 22:00'),
    '2026-11-26T22:00:00+08:00',
  );
  assert.equal(dueIso('12月10日前提交'), '2026-12-10T23:59:00+08:00');
  assert.equal(dueIso('2026年12月10日前'), '2026-12-10T23:59:00+08:00');
});

test('时间：数字日期 11.26 / 11-26 / 11/26', () => {
  assert.equal(dueIso('11.26 前完成'), '2026-11-26T23:59:00+08:00');
  assert.equal(dueIso('11-26 交'), '2026-11-26T23:59:00+08:00');
  assert.equal(dueIso('时间：11/26 18:00'), '2026-11-26T18:00:00+08:00');
});

test('时间：月底 / 本月底 / 晚上时段', () => {
  assert.equal(dueIso('本月底前交'), '2026-11-30T23:59:00+08:00');
  assert.equal(dueIso('月底截止'), '2026-11-30T23:59:00+08:00');
  assert.equal(dueIso('今晚 22:00 前提交'), '2026-11-21T22:00:00+08:00');
  assert.equal(dueIso('明天下午3点半'), '2026-11-22T15:30:00+08:00');
});

test('时间：区间取终点（11.10-11.16 / 11月10日—11月16日）', () => {
  assert.equal(dueIso('报名时间：11.10-11.16'), '2026-11-16T23:59:00+08:00');
  assert.equal(dueIso('2026.11.10-11.16 报名'), '2026-11-16T23:59:00+08:00');
  assert.equal(dueIso('11月10日—11月16日'), '2026-11-16T23:59:00+08:00');
});

test('时间：不误判 第3-4节 / 长数字串 / 非法月日', () => {
  assert.equal(dueIso('本周预约的是第13周的第3次实验，第3-4节'), null);
  assert.equal(dueIso('订单号 20261121304'), null);
  assert.equal(dueIso('13月32日交'), null);
});

test('时间：老消息按自身年份解析，不一律卷到下一年', () => {
  const oldAnchor = Date.parse('2026-10-23T10:00:00+08:00');
  assert.equal(dueIso('10月27日前提交', oldAnchor), '2026-10-27T23:59:00+08:00');
  // 跨年场景才卷年：12 月消息里说「1月5日」
  const decAnchor = Date.parse('2026-12-20T10:00:00+08:00');
  assert.equal(dueIso('1月5日前交', decAnchor), '2027-01-05T23:59:00+08:00');
});

test('时间：没有日期 → null；只有时段词 → 当天 23:59 且 vague', () => {
  // 完全没有日期线索 → null（parseDueAt 同样返回空串）
  assert.equal(__internal.parseDueInfo('请大家积极参加活动', NOW), null);
  assert.equal(__internal.parseDueAt('请大家积极参加活动', NOW), '');
  const vague = __internal.parseDueInfo('请尽量在下午完成填报', NOW);
  assert.equal(vague.iso, '2026-11-21T23:59:00+08:00');
  assert.equal(vague.vague, true);
});

test('时间：parseDueAt 返回 ISO 或空串', () => {
  assert.equal(__internal.parseDueAt('周日前完成', NOW), '2026-11-22T23:59:00+08:00');
  assert.equal(__internal.parseDueAt('收到', NOW), '');
});

test('时间换算不依赖宿主时区：固定 epoch → 上海字段', () => {
  const epoch = Date.parse('2026-11-26T22:00:00+08:00');
  assert.equal(__internal.formatShanghaiIso(epoch), '2026-11-26T22:00:00+08:00');
  const parts = __internal.shanghaiParts(epoch);
  assert.equal(parts.y, 2026);
  assert.equal(parts.mo, 11);
  assert.equal(parts.d, 26);
  assert.equal(parts.h, 22);
  assert.equal(parts.mi, 0);
  assert.equal(__internal.fromShanghai(2026, 11, 26, 22, 0), epoch);
});

// ---------------------------------------------------------------------------
// 4. 噪声过滤
// ---------------------------------------------------------------------------

test('噪声：纯图片名/文件名/uins 串/JSON app/纯 @/emoji/链接 都要过滤', () => {
  assert.equal(isNoiseText('IMG_20261120_123456.png'), true);
  assert.equal(isNoiseText('学生名单.xlsx'), true);
  assert.equal(isNoiseText('u_fx0-g9sBC5oeEknGgrQMoA'), true);
  assert.equal(isNoiseText('{"app":"com.tencent.miniapp","desc":"x"}'), true);
  assert.equal(isNoiseText('@宣委-廖耘震202603401253'), true);
  assert.equal(isNoiseText('[图片]'), true);
  assert.equal(isNoiseText('🙂🙂🙂'), true);
  assert.equal(isNoiseText('https://zgs.chsi.com.cn/'), true);
  assert.equal(isNoiseText('all'), true);
  assert.equal(
    isNoiseText('实训操作讲解.mp4-default.mp4::NTOSFull::/Users/x/Library/Containers/yy'),
    true,
  );
});

test('噪声：真正的通知文本不能被当噪声', () => {
  assert.equal(
    isNoiseText('@全体成员 职规赛报名必须填指导老师电话，请在本周日 17:00 前完成填报'),
    false,
  );
  assert.equal(isNoiseText('转学院教务老师通知：请尽量在下午完成表格填报。'), false);
  assert.equal(isNoiseText('2027年征兵预储班的通知，感兴趣的同学及时关注'), false);
});

test('噪声：cleanSegments 拼段去重并保留正文', () => {
  const segments = __internal.cleanSegments([
    '@全体成员',
    ' 职规赛报名 ',
    'u_abc123456',
    '',
    '周日前完成',
  ]);
  assert.deepEqual(segments, ['职规赛报名', '周日前完成']);
  const text = __internal.normalizeText(segments.join(' '));
  assert.match(text, /职规赛报名/);
  assert.match(text, /周日前完成/);
  assert.doesNotMatch(text, /u_abc123456|@全体成员/);
});

// ---------------------------------------------------------------------------
// 5. 合并
// ---------------------------------------------------------------------------

test('合并：同群 5 分钟内的短句补充并进上一条通知', () => {
  const messages = [
    msg('1', 100000001, NOW, '如果职规赛报名必须要填指导老师的电话，导员电话是13800000000'),
    msg('2', 100000001, NOW + 41 * 1000, '周日前完成'),
  ];
  const merged = mergeRelated(messages);
  assert.equal(merged.length, 1);
  assert.match(merged[0].text, /周日前完成/);
  assert.equal(merged[0].supportText, '周日前完成');
});

test('合并：超过 5 分钟或不同群不合并', () => {
  const far = mergeRelated([
    msg('1', 100000001, NOW, '职规赛报名通知，需要提交截图'),
    msg('2', 100000001, NOW + 6 * 60 * 1000, '周日前完成'),
  ]);
  assert.equal(far.length, 2);

  const otherGroup = mergeRelated([
    msg('1', 100000001, NOW, '职规赛报名通知，需要提交截图'),
    msg('2', 100000003, NOW + 30 * 1000, '周日前完成'),
  ]);
  assert.equal(otherGroup.length, 2);
});

test('合并：不相关的话题不会被合并进去', () => {
  const merged = mergeRelated([
    msg('1', 100000001, NOW, '职规赛报名通知，需要提交报名截图给班长'),
    msg('2', 100000001, NOW + 60 * 1000, '食堂今天中午有免费西瓜'),
  ]);
  assert.equal(merged.length, 2);
});

// ---------------------------------------------------------------------------
// 6. 任务判定与置信度
// ---------------------------------------------------------------------------

test('判定：有动作词或通知名词+时间才算任务', () => {
  assert.equal(isTaskText('周五前提交实验报告', NOW), true);
  assert.equal(isTaskText('填报专业分流学生名单表格', NOW), true);
  assert.equal(isTaskText('我不知道怎么提交，怎么办啊？', NOW), false);
  assert.equal(isTaskText('哈哈哈哈哈', NOW), false);
  assert.equal(isTaskText('收到，谢谢老师', NOW), false);
});

test('置信度：基础 0.1，按规则加分并封顶 0.95', () => {
  assert.equal(scoreConfidence({ text: '嗯', groupName: '', dueInfo: null, action: false }), 0.1);
  assert.equal(
    scoreConfidence({
      text: '周五前提交实验报告，逾期不候，请各位同学务必注意时间安排',
      groupName: '示例通知群C',
      dueInfo: __internal.parseDueInfo('周五前提交', NOW),
      action: true,
    }),
    0.95,
  );
  const onlyAction = scoreConfidence({ text: '请大家报名', groupName: '', dueInfo: null, action: true });
  assert.equal(onlyAction, 0.4);
  const onlyDue = scoreConfidence({
    text: '11月26日',
    groupName: '',
    dueInfo: __internal.parseDueInfo('11月26日', NOW),
    action: false,
  });
  assert.equal(onlyDue, 0.5);
});

// ---------------------------------------------------------------------------
// 7. 标题
// ---------------------------------------------------------------------------

test('标题：主题词 + 动词，读起来像任务名（≤40 字）', () => {
  const title = makeTitle(
    '@全体成员 职规赛报名必须填指导老师电话，导员电话是13800000000；总之如果非必须就填导员。周日前完成',
    { now: NOW, supportText: '周日前完成' },
  );
  assert.match(title, /职规赛|职业规划/);
  assert.match(title, /报名/);
  assert.ok(title.length <= 40, `标题太长：${title}`);
  assert.doesNotMatch(title, /13800000000|@全体成员|https?:/);
});

test('标题：竞赛/投稿类能抽到 大赛 + 投稿', () => {
  const title = makeTitle(
    '湖北省高校第四十二届“一二·九”诗歌散文大赛现已启动，感兴趣的同学可以积极参与。投稿截止：11 月 26 日（下周四）晚 22:00',
    { now: NOW },
  );
  assert.match(title, /诗歌散文大赛/);
  assert.ok(title.length <= 40, `标题太长：${title}`);
});

test('标题：supportText 追加括号补充', () => {
  const title = makeTitle('请完成职规赛报名', { now: NOW, supportText: '周日前完成' });
  assert.match(title, /（周日前完成）$/);
});

test('标题：兜底不为空、不带文件路径/链接/@', () => {
  const junk = makeTitle(
    'u_fx0-g9sBC5oeEknGgrQMoA 实训操作讲解.mp4-default.mp4::NTOSFull::/Users/x/a.mp4',
    { now: NOW },
  );
  assert.ok(typeof junk === 'string');
  assert.doesNotMatch(junk, /NTOSFull|\/Users\/|u_fx0/);
  assert.ok(junk.length <= 40);
});

// ---------------------------------------------------------------------------
// 8. 候选抽取
// ---------------------------------------------------------------------------

test('抽取：通知类消息产出形状完整的候选（title/dueAt/kind/priority/evidence）', () => {
  const messages = [
    msg(
      '10',
      100000002,
      NOW - 2 * HOUR,
      '现上传职规赛报名通知，请各位在本周日17：00之前完成填报，每位同学都要参与并提供截图。',
      '示例通知群B',
    ),
  ];
  const candidates = extractTaskCandidates(messages, { now: NOW });
  assert.ok(candidates.length >= 1, '应抽到至少一条候选');
  const [candidate] = candidates;
  assert.equal(typeof candidate.title, 'string');
  assert.ok(candidate.title.length > 0 && candidate.title.length <= 40);
  assert.equal(candidate.dueAt, '2026-11-22T17:00:00+08:00');
  assert.ok(['application', 'homework', 'other'].includes(candidate.kind), candidate.kind);
  assert.ok(candidate.priority >= 1 && candidate.priority <= 5);
  assert.ok(candidate.confidence > 0.5 && candidate.confidence <= 0.95);
  assert.equal(candidate.evidence.groupCode, 100000002);
  assert.equal(candidate.evidence.groupName, '示例通知群B');
  assert.match(candidate.evidence.text, /职规赛/);
});

test('抽取：噪声 / 闲聊 / 过期截止 / 陈旧消息都被丢掉', () => {
  const messages = [
    msg('1', 100000001, NOW - HOUR, 'u_fx0-g9sBC5oeEknGgrQMoA'),
    msg('2', 100000001, NOW - HOUR, '{"app":"com.tencent.miniapp"}'),
    msg('3', 100000001, NOW - HOUR, '我不知道怎么提交，怎么办啊？'),
    msg('4', 100000001, NOW - DAY, '请于11月20日17:00前完成填报并提交截图'),
    msg('5', 100000001, NOW - 10 * DAY, '请大家积极参加志愿活动，营造良好氛围'),
  ];
  const candidates = extractTaskCandidates(messages, { now: NOW });
  assert.equal(candidates.length, 0, `不该有候选，实际：${JSON.stringify(candidates.map((c) => c.title))}`);
});

test('抽取：补充消息时「周日前完成」的截止时间落到主子句上', () => {
  const messages = [
    msg(
      '1',
      100000001,
      NOW - 3 * HOUR,
      '如果职规赛报名必须要填指导老师的电话，导员电话是13800000000；如果同学们想填其他老师，也可以。',
    ),
    msg('2', 100000001, NOW - 3 * HOUR + 41 * 1000, '周日前完成'),
  ];
  const candidates = extractTaskCandidates(messages, { now: NOW });
  assert.ok(candidates.length >= 1);
  assert.equal(candidates[0].dueAt, '2026-11-22T23:59:00+08:00');
  assert.match(candidates[0].title, /职规赛|职业规划|报名/);
});

test('抽取：空输入 / 非数组输入返回空数组', () => {
  assert.deepEqual(extractTaskCandidates([], { now: NOW }), []);
  assert.deepEqual(extractTaskCandidates(null, { now: NOW }), []);
});

// ---------------------------------------------------------------------------
// 9. 去重
// ---------------------------------------------------------------------------

test('去重：同标题同一天的候选只留置信度最高的', () => {
  const base = {
    title: '职规赛报名',
    dueAt: '2026-11-22T17:00:00+08:00',
    kind: 'application',
    priority: 1,
    evidence: { groupCode: 1, groupName: 'g', ts: NOW, text: 'x' },
  };
  const deduped = dedupeCandidates([
    { ...base, confidence: 0.6 },
    { ...base, confidence: 0.9 },
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].confidence, 0.9);
});

test('去重：同标题不同截止日期保留两条', () => {
  const make = (dueAt, conf) => ({
    title: '诗歌散文大赛投稿',
    dueAt,
    kind: 'application',
    priority: 2,
    confidence: conf,
    evidence: { groupCode: 1, groupName: 'g', ts: NOW, text: 'x' },
  });
  const deduped = dedupeCandidates([
    make('2026-11-26T22:00:00+08:00', 0.9),
    make('2026-12-05T23:59:00+08:00', 0.8),
  ]);
  assert.equal(deduped.length, 2);
});

test('去重：空输入安全', () => {
  assert.deepEqual(dedupeCandidates([]), []);
  assert.deepEqual(dedupeCandidates(null), []);
});

// ---------------------------------------------------------------------------
// 10. 分类 / 优先级 / 内部导出
// ---------------------------------------------------------------------------

test('kind：考试/实验报告/报名/论文 各自归类', () => {
  assert.equal(guessKind('期末考试安排'), 'exam');
  assert.equal(guessKind('提交实验报告'), 'homework');
  assert.equal(guessKind('职规赛报名'), 'application');
  assert.equal(guessKind('阅读文献，做好读书笔记'), 'reading');
});

test('priority：今天到期 → 1，远期 → 4，无截止 → 3', () => {
  assert.equal(__internal.priorityFor('2026-11-21T23:59:00+08:00', NOW, '今天交'), 1);
  // 距 now 约 1.3 天 → 2；「明天」这种字面词才直接判 1
  assert.equal(__internal.priorityFor('2026-11-22T17:00:00+08:00', NOW, '周日交'), 2);
  assert.equal(__internal.priorityFor('2026-11-22T17:00:00+08:00', NOW, '紧急，明天交'), 1);
  assert.equal(__internal.priorityFor('2026-12-20T23:59:00+08:00', NOW, '下个月交'), 4);
  assert.equal(__internal.priorityFor(null, NOW, '有空做'), 3);
});

test('__internal 暴露测试所需的纯函数', () => {
  for (const key of [
    'parseDueInfo',
    'parseDueAt',
    'isNoiseSegment',
    'cleanSegments',
    'mergeRelated',
    'dedupeCandidates',
    'makeTitle',
    'similarity',
    'isSupplement',
    'scoreConfidence',
  ]) {
    assert.equal(typeof __internal[key], 'function', `__internal.${key} 必须是函数`);
  }
});

// ---------------------------------------------------------------------------
// 11. 读库（合成 fixture + 本机真实样本，缺样本就跳过）
// ---------------------------------------------------------------------------

test('readGroupList：缺少 group_info.db 抛普通 Error 而不是 QQKeyMissingError', async () => {
  await assert.rejects(
    () => readGroupList({ groupInfoPath: join(TMP, 'nope-group-info.db'), keyPath: '' }),
    (err) => err instanceof Error && !(err instanceof QQKeyMissingError) && /找不到/.test(err.message),
  );
});

test('readGroupList：从明文 group_info fixture 读出群名', async (t) => {
  if (!existsSync(PLAIN_GROUP_DB)) {
    t.skip('本机没有 /tmp/v3-group_info.db 样本');
    return;
  }
  const groups = await readGroupList({ groupInfoPath: PLAIN_GROUP_DB, plainDir: join(TMP, 'plain-g') });
  assert.ok(Array.isArray(groups) && groups.length > 0, '应读到群列表');
  for (const group of groups) {
    assert.equal(typeof group.code, 'number');
    assert.equal(typeof group.name, 'string');
    assert.ok(group.code > 0 && group.name.length > 0);
  }
  assert.ok(groups.length >= 20, `群列表应有 20 个以上：${groups.length}`);
  assert.equal(new Set(groups.map((g) => g.code)).size, groups.length, '群号不应重复');
});

test('openQQDb：明文库直接复用且 decrypted=false', async (t) => {
  if (!existsSync(PLAIN_MSG_DB)) {
    t.skip('本机没有 /tmp/v3-nt_msg.db 样本');
    return;
  }
  const opened = await openQQDb({ dbPath: PLAIN_MSG_DB, plainPath: join(TMP, 'plain-o', 'nt_msg.plain.db') });
  try {
    assert.equal(opened.decrypted, false);
    const row = opened.db.prepare('SELECT count(*) AS n FROM group_msg_table').get();
    assert.ok(Number(row.n) > 0);
  } finally {
    opened.close();
  }
});

test('openQQDb：加密库但缺密钥 → QQKeyMissingError（明文库不会误报）', async () => {
  const fake = join(TMP, 'fake-encrypted.db');
  // QQ NT 加密头：1024 字节自定义头，开头是「SQLite header 3\0」，与明文 magic 不同
  const head = Buffer.alloc(1100);
  Buffer.from('SQLite header 3\u0000', 'latin1').copy(head, 0);
  writeFileSync(fake, head);
  await assert.rejects(
    () => openQQDb({ dbPath: fake, keyPath: join(TMP, 'no-key-here.txt') }),
    (err) => err instanceof QQKeyMissingError,
  );
});

test('readQQMessages：真实库冒烟（读消息 + 抽候选）', async (t) => {
  if (!existsSync(PLAIN_MSG_DB)) {
    t.skip('本机没有 /tmp/v3-nt_msg.db 样本');
    return;
  }
  // 不写死群号：群列表来自库里本身（group_info 给群名，没有就按消息表里的群号）
  const messages = await readQQMessages({
    dbPath: PLAIN_MSG_DB,
    groupInfoPath: existsSync(PLAIN_GROUP_DB) ? PLAIN_GROUP_DB : '',
    keyPath: PLAIN_MSG_DB, // 明文库不该真去读密钥
    plainDir: join(TMP, 'plain-m'),
    sinceMs: NOW - 30 * DAY,
    limit: 200,
  });
  assert.ok(Array.isArray(messages), '返回的必须是消息数组');
  assert.ok(messages.length > 20, `消息数偏少：${messages.length}`);
  const first = messages[0];
  assert.deepEqual(
    Object.keys(first).sort().filter((k) => ['groupCode', 'groupName', 'id', 'senderId', 'text', 'ts'].includes(k)),
    ['groupCode', 'groupName', 'id', 'senderId', 'text', 'ts'],
  );
  assert.equal(typeof first.id, 'string');
  assert.equal(typeof first.ts, 'number');
  assert.ok(first.ts > 1e12, 'ts 应是毫秒');

  const candidates = dedupeCandidates(extractTaskCandidates(messages, { now: NOW }));
  assert.ok(candidates.length > 0, '真实数据应能抽出候选任务');
  for (const candidate of candidates.slice(0, 20)) {
    assert.ok(candidate.title.length > 0 && candidate.title.length <= 40, candidate.title);
    assert.ok(candidate.confidence > 0 && candidate.confidence <= 0.95);
  }
  assert.ok(candidates.some((c) => c.title.length >= 4), '至少要有几条像标题的候选');
});


/** 本机群白名单（~/.dsh/career-planner/groups.json，不入库，可能不存在） */
function readLocalGroups() {
  try {
    const file = join(process.env.HOME || '', '.dsh/career-planner/groups.json');
    return JSON.parse(readFileSync(file, 'utf8') || '[]');
  } catch {
    return [];
  }
}

test('readQQMessages：真实本机加密库 + 密钥（有才跑）', async (t) => {
  const qqDir = join(process.env.HOME || '', '.dsh/career-planner/qq');
  const dbPath = join(qqDir, 'nt_msg.db');
  const keyPath = join(qqDir, 'dbkey.txt');
  if (!existsSync(dbPath) || !existsSync(keyPath)) {
    t.skip('本机没有真实 QQ 库/密钥');
    return;
  }
  const messages = await readQQMessages({
    dbPath,
    groupInfoPath: existsSync(REAL_GROUP_INFO_DB) ? REAL_GROUP_INFO_DB : '',
    keyPath,
    plainDir: join(TMP, 'plain-real'),
    groups: readLocalGroups(),
    sinceMs: NOW - 7 * DAY,
    limit: 50,
  });
  assert.ok(Array.isArray(messages));
  assert.ok(messages.length > 0, '真实库里最近 7 天该有消息');
});
