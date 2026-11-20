// push.js —— 推送适配器：把当天计划排版成纯文本，推到 QQ / 微信 / 本地文件。
//
// 设计约束：
// - 零第三方依赖，只用 node: 内置模块。
// - 所有网络请求 10s 超时（AbortSignal.timeout），失败返回结构化结果，绝不 throw。
// - QQ token 缓存在模块内存（按 appId），过期前 60s 内复用。
// - 微信 iLink 目前 token 已知会过期（errcode=-14 session timeout）：
//   拿不到可用 token/context_token 就返回 { ok:false, detail }，绝不阻塞 QQ 通道。
// - 推送文本是纯文本（微信不支持 markdown 表格），总长 ≤ 1800 字。

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { defaultPaths } from './imsource.js';

/** 单条推送消息的最大字符数（按 Unicode 码点计）。 */
export const MAX_MESSAGE_CHARS = 1800;

/** 网络请求超时（毫秒）。 */
const NET_TIMEOUT_MS = 10_000;

/** 推送里不展示的时间块类型：缓冲/休息只是时间轴占位，推送里不占篇幅。 */
const SKIPPED_BLOCK_KINDS = new Set(['buffer', 'break']);

/** 末尾的交互提示（QQ 里回复关键词触发动作）。 */
const REPLY_HINT = '直接回复「完成 1」即可标记第 1 项完成，「取消 1」可以撤销。';

const QQ_TOKEN_ENDPOINT = 'https://bots.qq.com/app/getAppAccessToken';
const QQ_API_BASE = 'https://api.sgroup.qq.com';
const WECHAT_ENDPOINT = 'https://ilinkai.weixin.qq.com/ilink/bot/sendmessage';
const WECHAT_CHANNEL_VERSION = '2.4.9';

// QQ access_token 的内存缓存：appId -> { token, expiresAt }
const qqTokenCache = new Map();

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 按 Unicode 码点计长度（中文/emoji 都算 1 个字）。 */
function charLength(text) {
  return Array.from(text).length;
}

/** 截断到指定码点数，超出加省略号。 */
function clip(text, max) {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/** 把任意响应 body 压成一行、截断，便于放进 detail。 */
function snippet(bodyText, max = 200) {
  return String(bodyText ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function asString(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** 本地时区的 YYYY-MM-DD（不要用 toISOString，那是 UTC）。 */
function localDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 'YYYY-MM-DD' -> '11月21日'；格式不对就原样返回。 */
function formatDateCn(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asString(dateStr));
  if (!match) return asString(dateStr);
  return `${Number(match[2])}月${Number(match[3])}日`;
}

/** 'HH:MM' -> 当天分钟数；非法返回 NaN。 */
function hhmmToMinutes(hhmm) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(asString(hhmm));
  if (!match) return NaN;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return NaN;
  return h * 60 + m;
}

/** 块的分钟数：优先 minutes 字段，其次用 start/end 相减。 */
function blockMinutes(block) {
  if (Number.isFinite(Number(block?.minutes)) && Number(block.minutes) > 0) {
    return Math.round(Number(block.minutes));
  }
  const start = hhmmToMinutes(block?.start);
  const end = hhmmToMinutes(block?.end);
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) return end - start;
  return 0;
}

/**
 * POST JSON 并读回文本。返回 { res, text, json }；网络错误向上抛，由调用方兜住。
 * 统一 10s 超时。
 */
async function postJson(url, payload, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(NET_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => '');
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null; // 非 JSON 响应：保留 text 供 detail
    }
  }
  return { res, text, json };
}

// ---------------------------------------------------------------------------
// formatPlanMessage —— 纯文本日报
// ---------------------------------------------------------------------------

/** 块是否应该在日报里展示（buffer/break 属于后台节奏，不发到手机）。 */
function isVisibleBlock(block) {
  return Boolean(
    block &&
      typeof block === 'object' &&
      !SKIPPED_BLOCK_KINDS.has(block.kind) &&
      asString(block.start) &&
      asString(block.end) &&
      asString(block.title),
  );
}

/**
 * 日报显示序号 -> plan.blocks 的 blockId 映射。
 *
 * 日报只展示非 buffer/break 的块，并且**按展示顺序连续编号 1..N**（只数展示的块），
 * 所以解析用户回复「完成 N」时不能直接用 plan.blocks[N-1]，
 * 必须用这张表定位 blockId，再在 plan.blocks 里按 id 找块。
 *
 * @returns {Array<{ n: number, blockId: string }>}
 */
export function planDisplayIndex(plan) {
  const blocks = Array.isArray(plan?.blocks) ? plan.blocks : [];
  const index = [];
  for (const block of blocks) {
    if (!isVisibleBlock(block)) continue;
    index.push({ n: index.length + 1, blockId: asString(block.id) || asString(block.blockId) });
  }
  return index;
}

/**
 * 把 plan 排版成可直接发到 QQ/微信的纯文本日报。
 *
 * 形态：
 *   【生涯日报 11月21日】
 *   重点：xxx
 *
 *   1. 07:30-08:10 英语单词 40min ｜ 理由
 *   2. ...
 *   共 180 分钟 / 5 个时间块
 *   直接回复「完成 1」即可标记第 1 项完成，「取消 1」可以撤销。
 *
 * - 编号是**连续显示序号**（1..N，只数被展示的块；buffer/break 不展示也不占号），
 *   所以「完成 N」里的 N 与消息里看到的一致；
 * - 纯文本，不含 markdown 表格 / 加粗等语法；
 * - 总长 ≤ 1800 字，超出时按时间块从尾部截断并提示；
 * - plan 为 null / 字段缺失时也返回一条可读的兜底消息，不 throw；
 * - withIndex 为 true 时返回 `{ text, index }`，index 是 [{ n, blockId }] 映射表，
 *   宿主解析用户回复时用它把显示序号换成 blockId；不传时仍返回字符串（兼容旧调用）。
 */
export function formatPlanMessage({ plan, profile, date, withIndex = false } = {}) {
  const planDate = asString(plan?.date) || asString(date) || localDateString(new Date());
  const header = `【生涯日报 ${formatDateCn(planDate)}】`;

  const firstGoal = Array.isArray(profile?.goals)
    ? profile.goals.find((goal) => goal && asString(goal.title))
    : null;
  const focus =
    asString(plan?.focus) ||
    asString(firstGoal?.title) ||
    '今天也把主线往前推一小步。';

  const lines = [header, `重点：${clip(String(focus).replace(/\s+/g, ' ').trim(), 60)}`];

  const warnings = Array.isArray(plan?.warnings)
    ? plan.warnings.map((w) => asString(w).trim()).filter(Boolean)
    : [];
  if (warnings.length) {
    lines.push(`提醒：${clip(warnings.slice(0, 3).join('；'), 100)}`);
  }

  const blocks = Array.isArray(plan?.blocks) ? plan.blocks : [];
  // 连续显示序号：1..N，只数展示出来的块；index 供宿主把「完成 N」解析成 blockId。
  const visibleBlocks = blocks.filter(isVisibleBlock);
  const index = visibleBlocks.map((block, i) => ({
    n: i + 1,
    blockId: asString(block.id) || asString(block.blockId),
  }));

  const totalMinutes =
    Number.isFinite(Number(plan?.totalMinutes)) && Number(plan.totalMinutes) > 0
      ? Math.round(Number(plan.totalMinutes))
      : visibleBlocks.reduce((sum, block) => sum + blockMinutes(block), 0);

  const finish = (text) => (withIndex ? { text, index } : text);

  lines.push('');

  if (!blocks.length) {
    // 没生成计划：仍然给一条可读消息，方便用户知道要做什么。
    lines.push('今天的计划还没生成。回复「重新生成」，我按你的目标和任务排一版。', '');
    lines.push(...buildTail(totalMinutes, 0, false));
    return finish(assembleWithinLimit(lines));
  }

  if (!visibleBlocks.length) {
    lines.push('今天只安排了休息与缓冲，保持节奏就好。', '');
    lines.push(...buildTail(totalMinutes, 0, false));
    return finish(assembleWithinLimit(lines));
  }

  const blockLines = visibleBlocks.map((block, i) => {
    const minutes = blockMinutes(block);
    const title = clip(String(block.title).replace(/\s+/g, ' ').trim(), 40);
    const why = clip(String(block.why || '').replace(/\s+/g, ' ').trim(), 50);
    const minutesPart = minutes > 0 ? ` ${minutes}min` : '';
    const whyPart = why ? ` ｜ ${why}` : '';
    return `${i + 1}. ${block.start}-${block.end} ${title}${minutesPart}${whyPart}`;
  });

  // 先尝试全部放下；放不下就按块从尾部截断（保留至少 1 块），并留出提示行空间。
  function render(keptCount, droppedCount) {
    // 块数只数展示出来的块，与上面的连续编号保持一致
    const tail = buildTail(totalMinutes, visibleBlocks.length, droppedCount > 0, droppedCount);
    return [header, ...lines.slice(1), ...blockLines.slice(0, keptCount), ...tail].join('\n');
  }

  let kept = blockLines.length;
  let text = render(kept, 0);
  while (kept > 1 && charLength(text) > MAX_MESSAGE_CHARS) {
    kept -= 1;
    text = render(kept, blockLines.length - kept);
  }
  // 极端情况下（单行超长）硬截断，保证硬上限成立。
  if (charLength(text) > MAX_MESSAGE_CHARS) {
    text = Array.from(text).slice(0, MAX_MESSAGE_CHARS - 1).join('') + '…';
  }
  return finish(text);
}

/** 日报末尾：总量 + 交互提示（可选截断提示）。 */
function buildTail(totalMinutes, blockCount, truncated, droppedCount = 0) {
  const tail = [];
  const summary = [];
  if (totalMinutes > 0) summary.push(`共 ${totalMinutes} 分钟`);
  if (blockCount > 0) summary.push(`${blockCount} 个时间块`);
  if (summary.length) tail.push(summary.join(' / '));
  if (truncated && droppedCount > 0) {
    tail.push(`…还有 ${droppedCount} 个时间块未显示，可在面板查看完整计划。`);
  }
  tail.push(REPLY_HINT);
  return tail;
}

/** 把若干行凑成完整消息，并保证总长 ≤ 1800 字。 */
function assembleWithinLimit(lines) {
  let text = lines.join('\n');
  if (charLength(text) <= MAX_MESSAGE_CHARS) return text;
  text = clip(text, MAX_MESSAGE_CHARS - 1);
  return text;
}

// ---------------------------------------------------------------------------
// 错误分类
// ---------------------------------------------------------------------------

/**
 * 把 HTTP 状态码 + 响应 body 分类成用户可读的一行原因。
 * 401/403 -> 凭据失效；429 -> 频率限制；其他带截断 body。
 */
export function classifyPushError(status, bodyText) {
  const code = Number(status);
  const body = snippet(bodyText, 200);
  const suffix = body ? `：${body}` : '';
  if (code === 401 || code === 403) return `凭据失效（HTTP ${code}${suffix}）`;
  if (code === 429) return `频率限制（HTTP 429${suffix}）`;
  if (!Number.isFinite(code) || code <= 0) return `网络请求失败${body ? `：${body}` : ''}`;
  return `HTTP ${code}${suffix}`;
}

// ---------------------------------------------------------------------------
// QQ 官方机器人主动消息
// ---------------------------------------------------------------------------

/**
 * 取 QQ access_token：先查内存缓存（过期前 60s 复用），否则调
 * https://bots.qq.com/app/getAppAccessToken。
 * 失败时抛出带 status/body 的错误，由 pushQQ 统一转成结构化结果。
 */
async function getQQAccessToken({ appId, secret }) {
  const now = Date.now();
  const cached = qqTokenCache.get(appId);
  if (cached && cached.expiresAt > now) {
    return { token: cached.token, cached: true };
  }

  const { res, text, json } = await postJson(QQ_TOKEN_ENDPOINT, {
    appId,
    clientSecret: secret,
  });

  if (!res.ok) {
    const error = new Error(classifyPushError(res.status, text));
    error.status = res.status;
    error.body = text;
    throw error;
  }

  const token = asString(json?.access_token);
  if (!token) {
    const error = new Error(`获取 access_token 失败：${snippet(text) || '响应里没有 access_token'}`);
    error.status = res.status;
    error.body = text;
    throw error;
  }

  const expiresIn = Number(json?.expires_in) || 7200; // 默认 2 小时
  qqTokenCache.set(appId, {
    token,
    // 过期前 60s 就不再复用
    expiresAt: now + Math.max(0, expiresIn - 60) * 1000,
  });
  return { token, cached: false };
}

/**
 * 给 QQ 用户发一条纯文本主动消息（msg_type=0）。
 *
 * 两步：
 *   1) POST https://bots.qq.com/app/getAppAccessToken  -> access_token
 *   2) POST https://api.sgroup.qq.com/v2/users/{openid}/messages
 *      header authorization: `QQBot <token>`，body { content, msg_type: 0 }
 *
 * 返回 { ok, channel:'qq', detail, status?, body? }，永不 throw。
 */
export async function pushQQ({ text, openid, appId, secret } = {}) {
  const message = asString(text).trim();
  const fail = (detail, extra = {}) => ({ ok: false, channel: 'qq', detail, ...extra });

  if (!message) return fail('消息内容为空，未发送');
  if (!asString(openid)) {
    return fail('缺少接收者 openid（im-bridge 状态日志里没有找到 QQ 用户，请先让用户给机器人发一条消息）');
  }
  if (!asString(appId) || !asString(secret)) {
    return fail('缺少 QQ 机器人凭据（appId / secret），未发送');
  }

  try {
    const { token, cached } = await getQQAccessToken({ appId, secret });
    const url = `${QQ_API_BASE}/v2/users/${encodeURIComponent(openid)}/messages`;
    const { res, text: bodyText, json } = await postJson(
      url,
      { content: message, msg_type: 0 }, // 主动消息不带 msg_id
      { authorization: `QQBot ${token}` },
    );

    const status = res.status;
    const bodySnip = snippet(bodyText, 300);

    if (!res.ok) {
      return fail(classifyPushError(status, bodyText), { status, body: bodySnip });
    }
    // 少数情况下 2xx 也可能带业务错误码（如 code 非 0），一并判失败。
    if (json && json.code != null && Number(json.code) !== 0) {
      return fail(classifyPushError(status, bodyText), { status, body: bodySnip });
    }

    return {
      ok: true,
      channel: 'qq',
      status,
      detail: `已发送（HTTP ${status}${cached ? '，复用 token' : ''}）`,
      body: bodySnip,
    };
  } catch (error) {
    const status = Number.isFinite(error?.status) ? error.status : undefined;
    const fromBody = error?.body ? snippet(error.body, 300) : '';
    const detail = status
      ? fromBody
        ? `${classifyPushError(status, fromBody)}`
        : classifyPushError(status, error?.message)
      : `网络请求失败：${error?.message || error}`;
    return {
      ok: false,
      channel: 'qq',
      detail,
      ...(status ? { status } : {}),
      ...(fromBody ? { body: fromBody } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// 微信 iLink
// ---------------------------------------------------------------------------

/** 键名归一化：bot_token / botToken / bot-token 视为同一键。 */
function normalizeKey(key) {
  return String(key).replace(/[_\-\s]/g, '').toLowerCase();
}

/**
 * 宽容地在 JSON 里找字段：比较归一化后的键名，找不到时向下钻一层对象
 * （token 文件的结构可能随版本变化）。
 */
function pickField(data, names, depth = 3) {
  if (!data || typeof data !== 'object' || depth < 0) return undefined;
  const wanted = new Set(names.map(normalizeKey));
  for (const [key, value] of Object.entries(data)) {
    if (!wanted.has(normalizeKey(key))) continue;
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value != null && typeof value !== 'object') return value;
  }
  for (const value of Object.values(data)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const found = pickField(value, names, depth - 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** 读微信 token 文件（宽容字段名）。失败抛错，由 pushWeChat 兜住。 */
async function readWeixinCredentials(tokenPath) {
  const raw = await readFile(tokenPath, 'utf8');
  const data = JSON.parse(raw);
  const token = pickField(data, [
    'bot_token',
    'botToken',
    'bot_access_token',
    'token',
    'access_token',
    'accessToken',
  ]);
  const toUserId = pickField(data, ['to_user_id', 'toUserId', 'openid', 'user_id', 'userId']);
  const contextToken = pickField(data, ['context_token', 'contextToken']);
  return {
    token: asString(token),
    toUserId: asString(toUserId),
    contextToken: asString(contextToken),
  };
}

/**
 * 给微信用户发一条纯文本消息（iLink 协议）。
 *
 * 从 tokenPath 宽容读取 bot_token / to_user_id / context_token。
 * 微信通道当前已知会过期（errcode=-14 session timeout），所以：
 * 缺 token / 缺 context_token / 网络失败 —— 一律返回 { ok:false, detail }，绝不 throw。
 */
export async function pushWeChat({ text, tokenPath } = {}) {
  const message = asString(text).trim();
  const fail = (detail, extra = {}) => ({ ok: false, channel: 'wechat', detail, ...extra });

  if (!message) return fail('消息内容为空，未发送');

  const tokenFile = asString(tokenPath) || defaultPaths().weixinToken;

  let creds;
  try {
    creds = await readWeixinCredentials(tokenFile);
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? '文件不存在' : error?.message || String(error);
    return fail(`微信通道不可用：读取凭据 ${tokenFile} 失败（${reason}），可重新扫码绑定后再试`);
  }

  const missing = [];
  if (!creds.token) missing.push('bot_token');
  if (!creds.toUserId) missing.push('to_user_id');
  if (!creds.contextToken) missing.push('context_token');
  if (missing.length) {
    return fail(
      `微信通道不可用：${tokenFile} 缺少 ${missing.join('、')}（需要重新扫码绑定，拿到 context_token 后才能发）`,
    );
  }

  try {
    const payload = {
      msg: {
        to_user_id: creds.toUserId,
        context_token: creds.contextToken,
        client_id: `career-planner:${Date.now()}-${randomUUID().slice(0, 8)}`, // 每条唯一
        msg_type: 0,
        content: message,
      },
      base_info: { channel_version: WECHAT_CHANNEL_VERSION },
    };
    const { res, text: bodyText, json } = await postJson(WECHAT_ENDPOINT, payload);
    const status = res.status;
    const bodySnip = snippet(bodyText, 300);

    if (!res.ok) {
      return fail(classifyPushError(status, bodyText), { status, body: bodySnip });
    }

    const errcodeRaw = json?.errcode ?? json?.data?.errcode;
    const errcode = errcodeRaw == null ? null : Number(errcodeRaw);
    if (errcode !== null && errcode !== 0) {
      const errmsg = asString(json?.errmsg ?? json?.data?.errmsg);
      const hint =
        errcode === -14
          ? '微信 session 过期，需要重新扫码绑定'
          : errcode === -1
            ? '系统繁忙，可稍后重试'
            : '';
      return fail(`微信发送失败：errcode=${errcode} ${errmsg}${hint ? `（${hint}）` : ''}`, {
        status,
        body: bodySnip,
      });
    }

    return {
      ok: true,
      channel: 'wechat',
      status,
      detail: `已发送（HTTP ${status}）`,
      body: bodySnip,
    };
  } catch (error) {
    return fail(`网络请求失败：${error?.message || error}`);
  }
}

// ---------------------------------------------------------------------------
// pushAll —— 多通道扇出
// ---------------------------------------------------------------------------

/**
 * 依次尝试各通道，互相独立（一个失败不影响其他的）。
 *
 * targets: {
 *   qq?:     { openid, appId, secret, enabled },   // enabled === false 时跳过
 *   wechat?: { tokenPath, enabled },
 *   file?:   { dir }                               // 写到 dir/<date>.txt
 * }
 *
 * 返回 [{ channel: 'qq'|'wechat'|'file', ok, detail, ...extra }]
 * 永不 throw（每个通道内部兜住）。
 */
export async function pushAll({ text, plan, targets } = {}) {
  const t = targets && typeof targets === 'object' ? targets : {};
  const results = [];

  // text 可为空：允许调用方只传 plan，由这里格式化。
  const message =
    asString(text).trim() || (plan ? formatPlanMessage({ plan }) : '');

  // 1) QQ
  if (t.qq && t.qq.enabled !== false) {
    try {
      results.push(
        await pushQQ({
          text: message,
          openid: t.qq.openid,
          appId: t.qq.appId,
          secret: t.qq.secret,
        }),
      );
    } catch (error) {
      results.push({ ok: false, channel: 'qq', detail: `推送异常：${error?.message || error}` });
    }
  }

  // 2) 微信
  if (t.wechat && t.wechat.enabled !== false) {
    try {
      results.push(await pushWeChat({ text: message, tokenPath: t.wechat.tokenPath }));
    } catch (error) {
      results.push({ ok: false, channel: 'wechat', detail: `推送异常：${error?.message || error}` });
    }
  }

  // 3) 本地文件（兜底通道，用于排障/留档）
  if (t.file && asString(t.file.dir)) {
    try {
      if (!message) {
        results.push({ ok: false, channel: 'file', detail: '消息内容为空，未写入' });
      } else {
        const dir = asString(t.file.dir);
        await mkdir(dir, { recursive: true });
        const day = asString(plan?.date) || localDateString(new Date());
        const target = path.join(dir, `${day}.txt`);
        await writeFile(target, `${message}\n`, 'utf8');
        results.push({ ok: true, channel: 'file', detail: target });
      }
    } catch (error) {
      results.push({ ok: false, channel: 'file', detail: `写入失败：${error?.message || error}` });
    }
  }

  return results;
}
