// imsource.js —— 读取 im-bridge 插件的本地痕迹（聊天记录来源）
//
// im-bridge 插件（dsh-plugin-im-bridge）把运行状态以「一行一个 JSON」的形式
// 追加写到 `~/.dsh/im-bridge-status.log`。其中有：
//   - `c2c-message`：QQ 入站消息，带 `openid`（接收者/用户）和完整 `text`
//   - `weixin-inbound-text`：微信入站文本（不带 openid）
//   - `weixin-replied`：微信回复记录，带 `toUserId`（即用户的 openid）
// 另外它在本机 8799 端口开了一个只读控制口，可以按平台读最近对话。
//
// 本文件只做「读」，不做任何写入；所有失败都降级为空结果，不 throw。
//
// 注意：这里的「openid」是发消息时的接收者标识（QQ 用户 openid / 微信 to_user_id），
// 不是机器人自己的 id。推送适配器靠它定位用户。

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 本机 im-bridge 控制口默认端口（im-bridge 插件固定监听 8799）。 */
export const CONTROL_PORT = 8799;

/** 控制口 HTTP 读取超时（毫秒）。 */
const CONTROL_TIMEOUT_MS = 10_000;

/**
 * 解析出 im-bridge 相关文件的默认路径。
 * 允许用 DSH_HOME 覆盖（测试/多 profile 场景），否则是 `~/.dsh`。
 */
export function defaultPaths() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return {
    home,
    statusLog: path.join(home, 'im-bridge-status.log'),
    weixinToken: path.join(home, 'im-bridge-weixin.json'),
    statusJson: path.join(home, 'im-bridge-status.json'),
    controlPort: CONTROL_PORT,
  };
}

function asString(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function asPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 根据事件名推断平台：c2c-message / qq-* → qq，weixin-* → wechat。 */
function platformOfEvent(event) {
  if (!event) return undefined;
  const e = asString(event);
  if (e === 'c2c-message' || e.startsWith('qq-')) return 'qq';
  if (e.startsWith('weixin') || e.includes('weixin')) return 'wechat';
  return undefined;
}

/** 把一行原始 JSON 归一化成 { at, event, platform?, text?, openid? }。 */
function toEntry(record) {
  const event = asString(record.event);
  const entry = {
    at: asString(record.time || record.at || record.timestamp),
    event,
  };
  const platform = asString(record.platform) || platformOfEvent(event);
  if (platform) entry.platform = platform;
  const text = asString(record.text);
  if (text) entry.text = text;
  const openid = asString(record.openid || record.openId || record.toUserId);
  if (openid) entry.openid = openid;
  return entry;
}

/**
 * 判断候选时间是否比当前记录更晚（用于从整份日志里取「最近一次」的 openid）。
 * - 候选时间非法、当前时间合法 -> 不更新（保留已知时间的记录）
 * - 两者都非法 -> 更新（退化成「文件里最后出现的」）
 */
function isLater(candidateTime, currentTime) {
  if (Number.isNaN(candidateTime)) return Number.isNaN(currentTime);
  return Number.isNaN(currentTime) || candidateTime >= currentTime;
}

/** 时间排序比较器：非法时间保持原相对顺序（稳定排序）。 */
function compareByTime(a, b) {
  const ta = Date.parse(a?.at || '');
  const tb = Date.parse(b?.at || '');
  if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
  if (Number.isNaN(ta)) return 1;
  if (Number.isNaN(tb)) return -1;
  return ta - tb;
}

/**
 * 读 im-bridge 状态日志。
 *
 * 返回：
 *   entries          —— 最近 limit 条可解析记录（旧→新，坏行/非对象行跳过）
 *   lastQQOpenid     —— 最后一条 QQ 入站消息的 openid（没有则 null）
 *   lastWeixinOpenid —— 最后一次见的微信用户 id（weixin-replied.toUserId 等；没有则 null）
 *   inbound          —— 入站消息（旧→新，最多 limit 条）：
 *                       { at, platform: 'qq'|'wechat', from, text }
 *
 * 说明：`limit` 约束的是 entries / inbound 的返回条数；openid 需要从整份日志里
 * 找「最后一次出现」，因为日志尾部可能长期只有轮询状态行（没有 openid）。
 * 日志本身是追加写的，坏行（截断、非 JSON）一律跳过。
 *
 * 文件读不到（不存在/无权限）时返回空结果，绝不 throw。
 */
export async function readStatusLog({ path: statusPath = defaultPaths().statusLog, limit = 400 } = {}) {
  const cap = asPositiveInt(limit, 400);
  const empty = { entries: [], lastQQOpenid: null, lastWeixinOpenid: null, inbound: [] };

  let raw;
  try {
    raw = await readFile(statusPath, 'utf8');
  } catch {
    return empty;
  }

  const entries = [];
  const inbound = [];
  let lastQQOpenid = null;
  let lastQQTime = Number.NaN;
  let lastWeixinOpenid = null;
  let lastWeixinTime = Number.NaN;
  // 微信入站文本事件本身不带用户 id；用此前最近一次 weixin-replied.toUserId 兜底。
  let currentWeixinFrom = '';

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue; // 坏行跳过
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;

    const entry = toEntry(record);
    if (!entry.at && !entry.event) continue;
    entries.push(entry);

    const event = entry.event;

    if (event === 'c2c-message') {
      // QQ 入站消息：openid + 完整文本
      const openid = entry.openid || asString(record.openid);
      if (openid) {
        const atTime = Date.parse(entry.at);
        if (isLater(atTime, lastQQTime)) {
          lastQQOpenid = openid;
          lastQQTime = atTime;
        }
        inbound.push({
          at: entry.at,
          platform: 'qq',
          from: openid,
          text: entry.text || '',
        });
      }
      continue;
    }

    if (event.startsWith('weixin') || event === 'wechat-message') {
      // 微信侧：回复记录带 toUserId；入站文本事件单独一行
      const openid = asString(record.toUserId || record.to_user_id || record.openid || record.openId);
      if (openid) {
        const atTime = Date.parse(entry.at);
        if (isLater(atTime, lastWeixinTime)) {
          lastWeixinOpenid = openid;
          lastWeixinTime = atTime;
        }
        currentWeixinFrom = openid;
      }
      if (entry.text) {
        inbound.push({
          at: entry.at,
          platform: 'wechat',
          from: currentWeixinFrom,
          text: entry.text,
        });
      }
    }
  }

  // 微信入站可能先于 weixin-replied 出现在日志里：用最后已知的用户 id 回填。
  if (lastWeixinOpenid) {
    for (const msg of inbound) {
      if (msg.platform === 'wechat' && !msg.from) msg.from = lastWeixinOpenid;
    }
  }

  inbound.sort(compareByTime);

  return {
    entries: entries.slice(-cap),
    lastQQOpenid,
    lastWeixinOpenid,
    inbound: inbound.slice(-cap),
  };
}

/**
 * 通过 im-bridge 的本机控制口读取某平台最近的对话消息。
 *
 * GET http://127.0.0.1:${port}/im-bridge/messages?platform=${platform}&limit=${limit}
 * 返回归一化后的数组：[{ role: 'user'|'assistant', text, seq?, at?, platform }]
 *
 * 控制口没开、超时、返回非 JSON / 非 2xx —— 一律返回 []（不 throw）。
 */
export async function readImBridgeMessages({ port = defaultPaths().controlPort, platform = 'qq', limit = 50 } = {}) {
  const p = asPositiveInt(port, CONTROL_PORT);
  const n = asPositiveInt(limit, 50);
  const plat = typeof platform === 'string' && platform.trim() ? platform.trim() : 'qq';

  try {
    const url = `http://127.0.0.1:${p}/im-bridge/messages?platform=${encodeURIComponent(plat)}&limit=${n}`;
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    if (!res.ok) return [];

    const body = await res.json().catch(() => null);
    if (!body) return [];
    const list = Array.isArray(body) ? body : Array.isArray(body.messages) ? body.messages : [];

    return list
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const text = asString(item.text || item.content);
        const role = asString(item.role) || 'user';
        const out = { role, text, platform: plat };
        if (Number.isFinite(item.seq)) out.seq = item.seq;
        const at = asString(item.at || item.time);
        if (at) out.at = at;
        return out;
      })
      .filter((item) => item.text);
  } catch {
    return []; // 控制口不可达：安静降级
  }
}

// ---------------------------------------------------------------------------
// 宿主凭据存储（launchd 兜底推送需要在没有 DSH 进程时也能拿到 QQ 凭据）
// ---------------------------------------------------------------------------

/**
 * DSH 凭据存储文件的默认路径（宿主 `ctx.credentials` 落盘的位置）。
 * 同样允许 DSH_HOME 覆盖。
 */
export function defaultCredentialsPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, '.credentials.yaml');
}

/** 取出 YAML 里某条记录的缩进块（`  im-bridge/bot:` 那一行之后、更缩进的行）。 */
function recordBlock(text, recordKey) {
  const lines = String(text).split(/\r?\n/);
  const escaped = String(recordKey).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyRe = new RegExp(`^\\s*${escaped}\\s*:\\s*$`);
  const start = lines.findIndex((line) => keyRe.test(line));
  if (start < 0) return '';

  const baseIndent = (lines[start].match(/^\s*/) || [''])[0].length;
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = (line.match(/^\s*/) || [''])[0].length;
    if (indent <= baseIndent) break; // 回到同级/上级 key，块结束
    block.push(line);
  }
  return block.join('\n');
}

/** 从记录块里取一个标量值（去引号、去行尾注释）。 */
function yamlScalar(block, key) {
  if (!block) return '';
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm');
  const match = re.exec(block);
  if (!match) return '';
  let value = match[1].trim();
  // 先去掉引号外的行尾注释（引号内的 # 是值的一部分），再脱引号。
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '\\' && inDouble) {
      i += 1;
      continue;
    }
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(value[i - 1]))) {
      value = value.slice(0, i).trim();
      break;
    }
  }
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return value.trim();
}

/**
 * 宽容解析 DSH 凭据存储文本，取 `im-bridge/bot` 记录里的 QQ_BOT_APPID / QQ_BOT_SECRET。
 *
 * 真实文件形如：
 *   records:
 *     im-bridge/bot:
 *       kind: api-key
 *       env:
 *         QQ_BOT_APPID: "123456789"
 *         QQ_BOT_SECRET: "******"
 *
 * 解析不出（文件格式变了、字段缺失）返回 null，不 throw。
 */
export function parseQQCredentialsFromYaml(text, recordKey = 'im-bridge/bot') {
  const block = recordBlock(text, recordKey);
  if (!block) return null;
  const appId = yamlScalar(block, 'QQ_BOT_APPID');
  const secret = yamlScalar(block, 'QQ_BOT_SECRET');
  if (!appId || !secret) return null;
  return { appId, secret };
}

/**
 * 读 QQ 机器人凭据：优先环境变量（launchd 可在 plist 里注入），否则读凭据存储文件。
 *
 * @returns {Promise<{appId: string, secret: string, source: string} | null>}
 *          读不到返回 null，不 throw。
 */
export async function readQQCredentials({ path: credentialsPath = defaultCredentialsPath(), env = process.env } = {}) {
  const fromEnv = (name) => (typeof env?.[name] === 'string' ? env[name].trim() : '');
  if (fromEnv('QQ_BOT_APPID') && fromEnv('QQ_BOT_SECRET')) {
    return { appId: fromEnv('QQ_BOT_APPID'), secret: fromEnv('QQ_BOT_SECRET'), source: 'env:QQ_BOT_APPID/QQ_BOT_SECRET' };
  }

  let text;
  try {
    text = await readFile(credentialsPath, 'utf8');
  } catch {
    return null;
  }
  const creds = parseQQCredentialsFromYaml(text);
  if (!creds) return null;
  return { ...creds, source: credentialsPath };
}
