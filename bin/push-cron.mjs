#!/usr/bin/env node
// bin/push-cron.mjs —— 不依赖 DSH 进程的「每日计划」推送兜底
//
// 插件内定时器只在 Harness 开着时才会触发；launchd 每天 08:00 拉起本脚本，
// 即使 Harness 没开，也会读本地数据、生成/读取当天计划、排版后推到 QQ / 微信，
// 并追加一行 JSON 到 ~/.dsh/career-planner/push-cron.log。
//
// 用法：
//   node bin/push-cron.mjs            # 幂等：今天已经成功推过就跳过
//   node bin/push-cron.mjs --force    # 忽略幂等，强制重发（也忽略 push.enabled=false）
//   node bin/push-cron.mjs --dry      # 只打印格式化后的消息，不发送、不写 push.json
//   node bin/push-cron.mjs --help
//
// 退出码：0 = 成功 / 已跳过；1 = 所有通知通道（qq/wechat）都失败；2 = 配置缺失
//        （没有 profile.json，无法排计划）。launchd 日志里靠这个区分。
//
// 零第三方依赖，只 import node: 内置模块与包内 ../lib/*。

import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  paths as storePaths,
  readJson,
  readPlan,
  savePlan,
  savePush,
  normalizePush,
  normalizeTask,
  emptyPush,
  nowIso,
  dateKeyIn,
  recentPlanList,
} from '../lib/store.js';
import { planDay } from '../lib/planner.js';
import { formatPlanMessage, pushAll } from '../lib/push.js';
import { readStatusLog, readQQCredentials } from '../lib/imsource.js';

/** push.json 缺省时用的时区（normalizePush 的默认值同样是 Asia/Shanghai）。 */
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

const USAGE = `用法：node bin/push-cron.mjs [--dry] [--force]

  （无参数）  幂等推送：今天已经成功推过就跳过
  --dry       只打印格式化后的消息，不发送、不改 push.json
  --force     忽略幂等（今天已推过也重发）和 push.enabled=false
  --help      显示本帮助

退出码：0 成功/跳过；1 通知通道全部失败；2 配置缺失（没有 profile.json）`;

/** 解析命令行参数（未知参数只提示，不影响运行）。 */
export function parseArgs(argv = []) {
  const args = { force: false, dry: false, help: false, unknown: [] };
  for (const raw of Array.isArray(argv) ? argv : []) {
    const arg = String(raw);
    if (arg === '--force' || arg === '-f') args.force = true;
    else if (arg === '--dry' || arg === '--dry-run') args.dry = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg) args.unknown.push(arg);
  }
  return args;
}

/** DSH home：DSH_HOME 优先，其次 $HOME/.dsh。（与 lib/store.js 的 dshHome 保持一致） */
export function resolveHome(env = process.env) {
  const fromEnv = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : '';
  return fromEnv || path.join(env?.HOME || homedir(), '.dsh');
}

/** 组装 pushAll 的 targets；push.json 目前存 channels（qq/wechat/file），兼容未来直接给 targets。 */
export function buildTargets({ push, home, traces, creds }) {
  const channels = Array.isArray(push?.channels) ? push.channels : ['qq'];
  const targets = {};

  // 兼容：push.json 里直接写了 targets 时优先用它。
  if (push?.targets && typeof push.targets === 'object') {
    if (push.targets.qq) {
      targets.qq = {
        enabled: push.targets.qq.enabled !== false,
        openid: String(push.targets.qq.openid || traces?.lastQQOpenid || ''),
        appId: String(push.targets.qq.appId || creds?.appId || ''),
        secret: String(push.targets.qq.secret || creds?.secret || ''),
      };
    }
    if (push.targets.wechat) {
      targets.wechat = {
        enabled: push.targets.wechat.enabled !== false,
        tokenPath: String(push.targets.wechat.tokenPath || path.join(home, 'im-bridge-weixin.json')),
      };
    }
    if (push.targets.file?.dir) targets.file = { dir: String(push.targets.file.dir) };
  }

  if (!targets.qq && channels.includes('qq')) {
    targets.qq = {
      enabled: true,
      openid: traces?.lastQQOpenid || '',
      appId: creds?.appId || '',
      secret: creds?.secret || '',
    };
  }
  if (!targets.wechat && channels.includes('wechat')) {
    targets.wechat = { enabled: true, tokenPath: path.join(home, 'im-bridge-weixin.json') };
  }
  // file 通道只留档，不通知；默认写到 outbox（与插件内推送一致）。
  if (!targets.file) targets.file = { dir: path.join(home, 'career-planner', 'outbox') };
  return targets;
}

/** 追加一行 JSON 到 push-cron.log；写日志失败不影响推送结果。 */
async function appendCronLog(base, record) {
  try {
    await mkdir(base, { recursive: true });
    await appendFile(path.join(base, 'push-cron.log'), `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    /* 日志失败不能把推送搞挂 */
  }
}

/** 今天是否已经成功推过（只认 push.lastPushAt 的日期，时区按 push.timeZone）。 */
export function lastPushDate(push, timeZone = DEFAULT_TIME_ZONE) {
  const at = push?.lastPushAt ? String(push.lastPushAt) : '';
  if (!at) return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  return dateKeyIn(date, timeZone);
}

/**
 * 主流程（不直接 process.exit，返回 { exitCode, action, ... }，方便测试）。
 *
 * @param {object} options
 * @param {string[]} [options.argv]
 * @param {object}   [options.env]
 * @param {Date}     [options.now]
 * @param {(line: string) => void} [options.out] 默认 console.log
 */
export async function runPushCron({ argv = process.argv.slice(2), env = process.env, now = new Date(), out } = {}) {
  const say = typeof out === 'function' ? out : (line) => console.log(line);
  const args = parseArgs(argv);
  if (args.unknown.length) say(`warn: 未知参数已忽略：${args.unknown.join(' ')}`);

  if (args.help) {
    say(USAGE);
    return { exitCode: 0, action: 'help' };
  }

  const home = resolveHome(env);
  const base = path.join(home, 'career-planner');
  const p = storePaths(base);
  await mkdir(base, { recursive: true }).catch(() => undefined);

  // ---- 配置：profile 不存在 = 还没初始化插件，启动即无意义 ----
  const rawProfile = await readJson(p.profile, null);
  if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) {
    say(`配置缺失：读不到 ${p.profile}（先在 DSH 面板里打开一次 career-planner 插件）`);
    await appendCronLog(base, {
      time: nowIso(),
      event: 'config-missing',
      exitCode: 2,
      profile: p.profile,
    });
    return { exitCode: 2, action: 'config-missing', profile: p.profile };
  }

  const rawTasks = await readJson(p.tasks, null);
  const tasks = (Array.isArray(rawTasks?.tasks) ? rawTasks.tasks : [])
    .map(normalizeTask)
    .filter((task) => task.title);
  const rawPush = await readJson(p.push, null);
  const push = normalizePush(rawPush ?? emptyPush(DEFAULT_TIME_ZONE));
  const timeZone = push.timeZone || DEFAULT_TIME_ZONE;
  const today = dateKeyIn(now, timeZone);
  const mode = args.dry ? 'dry' : 'live';

  // ---- 幂等：今天成功推过就跳过（--force 忽略；--dry 只看不推）----
  const lastDate = lastPushDate(push, timeZone);
  // 只有真的推到人手上（qq/wechat）才算今天推过；只写了本地 outbox
  // 不算，否则这条兜底会以为已经推过而跳过（2026-11-21 早上就是这么漏的）。
  const lastResult = push?.lastResult && typeof push.lastResult === 'object' ? push.lastResult : {};
  const delivered = Boolean(
    (lastResult.qq && lastResult.qq.ok) || (lastResult.wechat && lastResult.wechat.ok),
  );
  const alreadyPushed = lastDate === today && delivered;
  const disabled = push.enabled === false;

  if (!args.dry && !args.force && (alreadyPushed || disabled)) {
    const reason = alreadyPushed ? 'already pushed' : 'push disabled';
    say(`skip: ${reason}${alreadyPushed ? ` (lastPushAt=${push.lastPushAt})` : ''}`);
    await appendCronLog(base, {
      time: nowIso(),
      event: 'skip',
      date: today,
      reason,
      lastPushAt: push.lastPushAt || '',
      exitCode: 0,
    });
    return { exitCode: 0, action: 'skip', reason, date: today };
  }

  // ---- 读/生成当天计划 ----
  let plan = await readPlan(p, today);
  let generated = false;
  if (!plan) {
    const history = (await recentPlanList(p, 8)).filter((item) => item.date < today).slice(0, 7);
    plan = planDay({
      date: today,
      now,
      profile: rawProfile,
      tasks,
      intel: [],
      history,
      seed: 0,
    });
    try {
      await savePlan(p, plan);
      generated = true;
    } catch {
      generated = false; // 只读文件系统 / 权限问题：不写盘也能推
    }
  }

  const { text: message, index } = formatPlanMessage({
    plan,
    profile: rawProfile,
    date: plan.date || today,
    withIndex: true,
  });
  const chars = Array.from(message).length;

  // ---- --dry：只打印，不发送、不写 push.json ----
  if (args.dry) {
    say(`push-cron: date=${today} mode=dry blocks=${index.length} chars=${chars} planGenerated=${generated} wouldSkip=${alreadyPushed || disabled}`);
    say(message);
    say('dry: not sent');
    await appendCronLog(base, {
      time: nowIso(),
      event: 'dry',
      date: today,
      blocks: index.length,
      chars,
      planGenerated: generated,
      wouldSkip: alreadyPushed || disabled,
      exitCode: 0,
    });
    return { exitCode: 0, action: 'dry', message, index, plan, date: today };
  }

  // ---- 解析推送目标 ----
  const statusPath = path.join(home, 'im-bridge-status.log');
  const traces = await readStatusLog({ path: statusPath }).catch(() => ({ lastQQOpenid: null, lastWeixinOpenid: null }));
  const credentialsPath = path.join(home, '.credentials.yaml');
  const creds = await readQQCredentials({ path: credentialsPath, env });
  const targets = buildTargets({ push, home, traces, creds });
  if (args.force && disabled) say('warn: push.enabled=false，但 --force 仍然推送');

  const channelList = Object.entries(targets)
    .filter(([, target]) => target && target.enabled !== false)
    .map(([name]) => name)
    .join(',');
  say(`push-cron: date=${today} mode=live channels=${channelList || '<none>'} blocks=${index.length} chars=${chars}`);

  // ---- 发送 ----
  const startedAt = Date.now();
  const results = await pushAll({ text: message, plan, targets });
  const byChannel = {};
  for (const result of results) {
    byChannel[result.channel] = {
      ok: Boolean(result.ok),
      detail: String(result.detail || '').slice(0, 300),
      // 留存 HTTP 证据（launchd 日志里能直接看到状态码和响应体片段）
      ...(result.status ? { status: result.status } : {}),
      ...(result.body ? { body: String(result.body).slice(0, 300) } : {}),
    };
    say(`  ${result.channel}: ${result.ok ? 'ok' : 'fail'} — ${String(result.detail || '').slice(0, 200)}`);
  }

  // ---- 退出码：file 只是留档，通知通道全失败才是失败 ----
  const notifying = results.filter((result) => result.channel !== 'file');
  const okNotifying = notifying.some((result) => result.ok);
  const okFile = results.some((result) => result.channel === 'file' && result.ok);
  let exitCode;
  if (!results.length) exitCode = 2; // 没有任何可执行通道（配置缺失）
  else if (notifying.length ? okNotifying : okFile) exitCode = 0;
  else exitCode = 1;
  const ok = exitCode === 0;

  // 只有成功才写 lastPushAt（失败留着，下次手动跑/重试不会被幂等跳过）；
  // lastResult 每次都写，方便面板和日志看到原因。
  try {
    await savePush(p, {
      ...push,
      lastPushAt: ok ? nowIso() : push.lastPushAt,
      lastResult: byChannel,
    });
  } catch {
    /* 写不了 push.json 也要把结果打出来 */
  }

  const record = {
    time: nowIso(),
    event: 'push',
    date: today,
    mode,
    forced: Boolean(args.force),
    ok,
    exitCode,
    planGenerated: generated,
    blocks: index.length,
    chars,
    durationMs: Date.now() - startedAt,
    channels: byChannel,
  };
  await appendCronLog(base, record);
  say(`result: ${ok ? 'ok' : 'failed'} exit=${exitCode}`);

  return { exitCode, action: 'push', ok, results, byChannel, message, index, plan, date: today, targets, record };
}

// 只在被直接执行时跑 main；被 test 里 import 时不执行。
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  runPushCron()
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((error) => {
      console.error('push-cron 异常：', error?.stack || error);
      process.exitCode = 1;
    });
}
