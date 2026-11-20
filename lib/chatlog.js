/**
 * chatlog.js — 读 QQ NT 本地消息库，并把群里的通知/作业类消息整理成「候选任务」。
 *
 * 数据链路：
 *   QQ 原始库（1024 字节自定义头 + SQLCipher）
 *     --(ntdb.decryptDatabaseBuffer)--> 明文 SQLite（缓存到 plainDir）
 *     --(node:sqlite readOnly)---------> group_msg_table / group_list
 *     --(本文件规则抽取)---------------> 候选任务（title/dueAt/kind/confidence/evidence）
 *
 * 设计边界：
 *  - 只读：不写 QQ 原始文件，明文副本写到调用方给的 plainDir。
 *  - 零第三方依赖，只用 node: 内置模块。
 *  - 时间全部按 Asia/Shanghai（UTC+8）折算，不依赖宿主时区，也不读 TZ 环境变量。
 *  - 只做「结构化 + 规则化抽取」，是否最终落库由上层（index.js / agent）决定。
 *
 * 对外契约见 CONTRACT.md 与 test/chatlog.test.mjs。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { decryptDatabaseBuffer, protoTexts, tableColumns } from './ntdb.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** 固定按 UTC+8 处理中文时间；不碰宿主时区。 */
export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const MAX_LIMIT = 5000;

/** 没有密钥 / 密钥坏了时抛这个，上层据此提示用户去跑 tools/extract_key.py。 */
export class QQKeyMissingError extends Error {
  constructor(message = '还没有 QQ 数据库密钥（需要先运行 tools/extract_key.py）') {
    super(message);
    this.name = 'QQKeyMissingError';
  }
}

// ---------------------------------------------------------------------------
// 1. 密钥
// ---------------------------------------------------------------------------

/**
 * 读 16 字节 ASCII 密钥。兼容这几种文件内容：
 *   `abcdefghijklmnop`            ← 纯密钥一行
 *   `key=abcdefghijklmnop`        ← 带前缀
 *   `{"key":"abcdefghijklmnop"}`  ← JSON
 * 文件不存在/内容不像密钥 → QQKeyMissingError。
 * @param {string} path
 * @returns {string} 16 字节密钥
 */
export function readDbKey(path) {
  if (!path || typeof path !== 'string') {
    throw new QQKeyMissingError('没有配置 QQ 数据库密钥文件路径');
  }
  if (!existsSync(path)) {
    throw new QQKeyMissingError(`QQ 数据库密钥文件不存在：${path}`);
  }
  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!raw) throw new QQKeyMissingError(`QQ 数据库密钥文件是空的：${path}`);

  const candidates = [];
  const quoted = /["']([\x21-\x7e]{16})["']/.exec(raw);
  if (quoted) candidates.push(quoted[1]);
  const token = /(?:^|[\s:=,])([\x21-\x7e]{16})(?=$|[\s,;'"])/.exec(raw);
  if (token) candidates.push(token[1]);
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (/^[\x21-\x7e]{16}$/.test(t)) candidates.push(t);
  }
  for (const value of candidates) {
    if (/^[\x21-\x7e]{16}$/.test(value)) return value;
  }
  throw new QQKeyMissingError(`QQ 数据库密钥文件内容不像 16 字节 ASCII 密钥：${path}`);
}

// ---------------------------------------------------------------------------
// 2. 解密 + 打开明文库
// ---------------------------------------------------------------------------

function plainIsFresh(dbPath, plainPath) {
  try {
    if (!existsSync(plainPath)) return false;
    const plainStat = statSync(plainPath);
    if (!plainStat.size) return false;
    if (plainStat.mtimeMs < statSync(dbPath).mtimeMs) return false;
    const walPath = `${dbPath}-wal`;
    if (existsSync(walPath) && plainStat.mtimeMs < statSync(walPath).mtimeMs) return false;
    return true;
  } catch {
    return false;
  }
}

/** 把加密库（+WAL）解密成明文 SQLite 文件；返回字节数。 */
async function decryptToFile(dbPath, key, outPath) {
  const buffer = readFileSync(dbPath);
  const walPath = `${dbPath}-wal`;
  const wal = existsSync(walPath) ? readFileSync(walPath) : null;
  const plain = decryptDatabaseBuffer({ buffer, key, wal });
  mkdirSync(dirname(outPath), { recursive: true });
  await writeFile(outPath, plain);
  return { bytes: plain.length, walApplied: Boolean(wal) };
}

async function openSqlite(path) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    throw new Error('当前 Node 没有 node:sqlite（需要 Node 22.5+ / 24+）');
  }
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    throw new Error(`明文库打不开（可能是明文页布局不兼容）：${error.message}`);
  }
}

/** 明文 SQLite 头；QQ 的加密库自定义头是 `SQLite header 3\0`，二者可区分。 */
const PLAIN_SQLITE_MAGIC = Buffer.from('SQLite format 3\u0000', 'latin1');

/** 这个文件本身是不是已经是明文 SQLite（测试 fixture / 已解密的库）。 */
function isPlainSqliteFile(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(16);
    const bytes = readSync(fd, head, 0, 16, 0);
    return bytes >= 16 && head.equals(PLAIN_SQLITE_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** 惰性取密钥：只有在真要解密时才去读密钥文件。 */
function lazyKey(keyPath, key) {
  let cached = '';
  return () => {
    if (cached) return cached;
    if (typeof key === 'function') {
      cached = String(key() || '');
    } else if (typeof key === 'string' && /^[\x21-\x7e]{16}$/.test(key)) {
      cached = key;
    } else if (typeof key === 'string' && key) {
      cached = readDbKey(key);
    } else {
      cached = readDbKey(keyPath);
    }
    if (!/^[\x21-\x7e]{16}$/.test(cached)) {
      throw new QQKeyMissingError('QQ 数据库密钥不是 16 字节 ASCII');
    }
    return cached;
  };
}

/**
 * 内部共用：确保明文副本是最新的（mtime >= 主库 / WAL），再只读打开。
 * readQQMessages / readGroupList 都走这一份逻辑。
 * - 传入的库本身就是明文 SQLite（例如已解密的样本）→ 直接只读打开，不需要密钥。
 * - 否则先解密到 plainPath（已存在且不比主库/WAL 旧就复用）。
 */
async function openPlainDb({ dbPath, getKey, plainPath }) {
  if (!dbPath || !existsSync(dbPath)) {
    throw new QQKeyMissingError(`找不到 QQ 数据库：${dbPath || '(未配置)'}`);
  }
  if (isPlainSqliteFile(dbPath)) {
    const db = await openSqlite(dbPath);
    return {
      db,
      plainPath: dbPath,
      decrypted: false,
      close() {
        try {
          db.close();
        } catch {
          /* 忽略重复 close */
        }
      },
    };
  }

  const target = plainPath || join(dirname(dbPath), 'plain', `${basename(dbPath)}.plain.db`);
  let decrypted = false;
  if (!plainIsFresh(dbPath, target)) {
    try {
      await decryptToFile(dbPath, getKey(), target);
    } catch (error) {
      if (error instanceof QQKeyMissingError) throw error;
      throw new Error(`QQ 数据库解密失败（密钥可能不对，或库正在写入）：${error.message}`);
    }
    decrypted = true;
  }
  const db = await openSqlite(target);
  return {
    db,
    plainPath: target,
    decrypted,
    close() {
      try {
        db.close();
      } catch {
        /* 忽略重复 close */
      }
    },
  };
}

/**
 * 打开 QQ 消息库，需要时解密到 plainPath。明文副本比主库/WAL 新时直接复用。
 * @param {{dbPath?: string, keyPath?: string, plainPath?: string, key?: string}} opts
 * @returns {Promise<{db: object, plainPath: string, decrypted: boolean, close: () => void}>}
 */
export async function openQQDb({ dbPath, keyPath, plainPath, key } = {}) {
  if (!dbPath) throw new QQKeyMissingError('没有配置 QQ 消息库路径');
  if (!existsSync(dbPath)) throw new QQKeyMissingError(`找不到 QQ 消息库：${dbPath}`);
  const opened = await openPlainDb({ dbPath, getKey: lazyKey(keyPath, key), plainPath });
  return {
    db: opened.db,
    plainPath: opened.plainPath,
    decrypted: opened.decrypted,
    close: opened.close,
  };
}

/** 读 group_list：60001=群号(INTEGER)、60007=群名(TEXT)。 */
export function readGroupNames(db) {
  let exists = false;
  try {
    exists = Boolean(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='group_list'").get(),
    );
  } catch {
    return [];
  }
  if (!exists) return [];
  const cols = tableColumns(db, 'group_list');
  if (!cols.includes('60001') || !cols.includes('60007')) return [];

  const rows = db
    .prepare('SELECT CAST("60001" AS TEXT) AS code, CAST("60007" AS TEXT) AS name FROM group_list')
    .all();
  const byCode = new Map();
  for (const row of rows) {
    const code = Number(row.code);
    const name = normalizeText(row.name);
    if (!Number.isFinite(code) || code <= 0 || !name) continue;
    if (!byCode.has(code)) byCode.set(code, name);
  }
  const list = [...byCode].map(([code, name]) => ({ code, name }));
  try {
    list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  } catch {
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  return list;
}

/**
 * 读本机 QQ 群列表（解密 group_info.db）。
 * @param {{groupInfoPath?: string, keyPath?: string, plainDir?: string}} opts
 * @returns {Promise<{code: number, name: string}[]>}
 */
export async function readGroupList({ groupInfoPath, keyPath, plainDir, key } = {}) {
  if (!groupInfoPath) throw new Error('没有配置 QQ 群列表库路径（group_info.db）');
  if (!existsSync(groupInfoPath)) throw new Error(`找不到 QQ 群列表库：${groupInfoPath}`);
  const dir = plainDir || join(dirname(groupInfoPath), 'plain');
  const opened = await openPlainDb({
    dbPath: groupInfoPath,
    getKey: lazyKey(keyPath, key),
    plainPath: join(dir, 'group_info.plain.db'),
  });
  try {
    return readGroupNames(opened.db);
  } finally {
    opened.close();
  }
}

// ---------------------------------------------------------------------------
// 3. 读群消息
// ---------------------------------------------------------------------------

function pickGroupMsgTable(db) {
  let names = [];
  try {
    names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => String(r.name));
  } catch {
    return '';
  }
  if (names.includes('group_msg_table')) return 'group_msg_table';
  return names.find((n) => /group.*msg.*table/i.test(n)) || '';
}

function normalizeEpoch(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // QQ 的 40050 是秒；兼容毫秒库
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

function safeProtoTexts(blob) {
  if (!blob) return [];
  try {
    return protoTexts(Buffer.isBuffer(blob) ? blob : Buffer.from(blob));
  } catch {
    return [];
  }
}

/**
 * 从已打开的明文库读群消息。
 * 列号（QQ NT 4.x 逆向结论）：40001 id、40030 群号(数值)、40021 群号(文本)、
 * 40033 发送者、40050 时间戳(秒)、40800 消息体 Protobuf。
 *
 * 注意：40001 是大整数（> 2^53），SQL 里一律 CAST(... AS TEXT)，也绝不用它排序。
 *
 * @param {object} db node:sqlite DatabaseSync
 * @param {{groups?: {code: number|string, name?: string}[], sinceMs?: number, limit?: number}} opts
 * @returns {Promise<{id: string, groupCode: number, groupName: string, senderId: string, ts: number, text: string}[]>}
 *   limit 是「每个群最多多少条」，返回按时间升序。
 */
export async function readGroupMessagesFromDb(db, opts = {}) {
  const groups = Array.isArray(opts.groups) ? opts.groups : [];
  const sinceMs = Number(opts.sinceMs) || 0;
  const limit = Math.max(1, Math.min(Number(opts.limit) || 400, MAX_LIMIT));
  const table = pickGroupMsgTable(db);
  if (!table) return [];

  const cols = tableColumns(db, table);
  const has = (name) => cols.includes(String(name));
  if (!has('40050') || !has('40800')) return [];

  const groupCols = ['40030', '40021'].filter((c) => has(c));
  if (!groupCols.length) return [];

  const nameByCode = new Map();
  for (const group of groups) {
    const code = Number(group?.code);
    if (Number.isFinite(code) && code > 0) nameByCode.set(code, normalizeText(group?.name));
  }
  const codes = [...new Set(groups.map((g) => Number(g?.code)).filter((c) => Number.isFinite(c) && c > 0))];

  const select = [
    has('40001') ? 'CAST("40001" AS TEXT) AS id' : 'CAST(rowid AS TEXT) AS id',
    `CAST("${groupCols[0]}" AS TEXT) AS g0`,
    groupCols[1] ? `CAST("${groupCols[1]}" AS TEXT) AS g1` : "'' AS g1",
    has('40033') ? 'CAST("40033" AS TEXT) AS sender' : "'' AS sender",
    'CAST("40050" AS TEXT) AS ts',
    '"40800" AS body',
  ].join(', ');
  const sinceSec = sinceMs > 0 ? Math.floor(sinceMs / 1000) : 0;

  const collected = [];
  const queries = codes.length ? codes.map((code) => ({ code })) : [{ code: null }];
  for (const query of queries) {
    let sql = `SELECT ${select} FROM "${table}"`;
    const params = [];
    const where = [];
    if (query.code != null) {
      where.push(`(${groupCols.map((c) => `CAST("${c}" AS TEXT) = ?`).join(' OR ')})`);
      for (let i = 0; i < groupCols.length; i += 1) params.push(String(query.code));
    }
    if (sinceSec) {
      where.push('"40050" >= ?');
      params.push(sinceSec);
    }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ` ORDER BY "40050" DESC LIMIT ${limit}`;
    try {
      collected.push(...db.prepare(sql).all(...params));
    } catch {
      /* 单群查询失败不影响其它群 */
    }
  }

  const seen = new Set();
  const messages = [];
  for (const row of collected) {
    const id = String(row.id ?? '');
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const ts = normalizeEpoch(row.ts);
    if (!ts) continue;
    const groupCode = Number(row.g0) || Number(row.g1) || 0;
    if (!Number.isFinite(groupCode) || groupCode <= 0) continue;
    const segments = cleanSegments(safeProtoTexts(row.body));
    if (!segments.length) continue;
    messages.push({
      id,
      groupCode,
      groupName: nameByCode.get(groupCode) || '',
      senderId: String(row.sender ?? ''),
      ts,
      text: segments.join(' '),
    });
  }
  messages.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  return messages;
}

/**
 * 高层入口：解密消息库 + 读群名 + 读群消息。
 * 返回消息数组（数组上额外挂了 groups / plainPath / decrypted 三个属性，方便调试）。
 *
 * @param {{dbPath?: string, groupInfoPath?: string, keyPath?: string, plainDir?: string,
 *          groups?: {code: number, name?: string}[], sinceMs?: number, limit?: number}} opts
 */
export async function readQQMessages(opts = {}) {
  const { dbPath, groupInfoPath, keyPath, plainDir } = opts;
  const getKey = lazyKey(keyPath, opts.key);
  const dir = plainDir || join(dirname(dbPath || '.'), 'plain');
  const opened = await openPlainDb({
    dbPath,
    getKey,
    plainPath: join(dir, 'nt_msg.plain.db'),
  });

  let groupInfo = null;
  const names = new Map();
  try {
    if (groupInfoPath && existsSync(groupInfoPath)) {
      try {
        groupInfo = await openPlainDb({
          dbPath: groupInfoPath,
          getKey,
          plainPath: join(dir, 'group_info.plain.db'),
        });
        for (const g of readGroupNames(groupInfo.db)) names.set(g.code, g.name);
      } catch {
        // 群名读不到不影响消息读取；下游用传入的 groups.name
        groupInfo = null;
      }
    }

    let effectiveGroups = (Array.isArray(opts.groups) ? opts.groups : [])
      .map((g) => {
        const code = Number(g?.code);
        return {
          code,
          name: normalizeText(g?.name) || names.get(code) || '',
        };
      })
      .filter((g) => Number.isFinite(g.code) && g.code > 0);
    if (!effectiveGroups.length && names.size) {
      effectiveGroups = [...names].map(([code, name]) => ({ code, name }));
    }

    const messages = await readGroupMessagesFromDb(opened.db, {
      groups: effectiveGroups,
      sinceMs: opts.sinceMs,
      limit: opts.limit,
    });
    messages.groups = effectiveGroups;
    messages.plainPath = opened.plainPath;
    messages.decrypted = opened.decrypted;
    return messages;
  } finally {
    if (groupInfo) groupInfo.close();
    opened.close();
  }
}

// ---------------------------------------------------------------------------
// 4. 文本归一化 / 噪声过滤
// ---------------------------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 全角 ASCII（数字、冒号等）→ 半角；中文标点保持不变。 */
export function toHalfWidth(value) {
  return String(value ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/** 去控制符、统一空白；保留换行（标题/分句需要）。 */
export function normalizeText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/[\u00a0\u2005\u2009\u3000]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim();
}

const FILE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|heic|xlsx?|docx?|pptx?|pdf|txt|zip|rar|7z|csv|md)$/i;
const PLACEHOLDER_RE = /^\[(图片|表情|动画表情|语音|视频|文件|位置|链接|图片消息|文件消息)\]$/;
const CHATTER_RE = /(怎么|如何|为什么|怎么办|咋办|不知道|受不了|是吗|可以吗|有没有|会不会|能不能)/;

function isEmojiOnly(text) {
  if (!/\p{Extended_Pictographic}/u.test(text)) return false;
  const rest = text.replace(/[\p{Extended_Pictographic}\p{Emoji_Component}\uFE0F\u200D~～]/gu, '');
  return rest.replace(/[\s!！?？。，,、·:：]/g, '') === '';
}

function safeJson(value) {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * 单段文本是不是「纯噪声」：图片/文件名、uin、JSON 小程序体、纯 @、纯表情、纯链接……
 * 用于过滤 protoTexts 抽出来的一段段内容。
 */
export function isNoiseSegment(raw) {
  const s = normalizeText(raw);
  if (!s) return true;
  if (!/[\p{L}\p{N}]/u.test(s)) return true;
  if (s.length < 2) return true;
  if (/^[{[]/.test(s)) {
    if (safeJson(s)) return true;
    if (/"(app|prompt|view|meta|bizsrc|sourceName)"\s*:/.test(s)) return true;
  }
  if (PLACEHOLDER_RE.test(s)) return true;
  if (/^(@\S+\s*)+$/.test(s)) return true;
  if (/^\/[^\s/]{1,16}$/.test(s)) return true;
  if (/^u_[A-Za-z0-9_\-+/=]+$/.test(s)) return true;
  if (/^[0-9A-Fa-f]{16,}$/.test(s)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  if (/^(?:all|a11|NTOSFull|default|undefined|null)$/i.test(s)) return true;
  if (/::NTOS|NTOSFull|\/Users\/|\\Users\\|\.mp4-default\.|\.mp4::/i.test(s)) return true;
  if (FILE_EXT_RE.test(s) && !/[，。！？；：、]/.test(s)) {
    // 纯文件名（含中文文件名，如「学生名单.xlsx」）不该当正文
    const hasCjk = /[\u4e00-\u9fa5]/.test(s);
    if ((hasCjk && s.length <= 30) || (!hasCjk && s.length < 160)) return true;
  }
  if (/^\/download\?/i.test(s) || /^\/[0-9a-f]{16,}$/i.test(s)) return true;
  if (/^(https?:\/\/|www\.)\S+$/i.test(s)) return true;
  if (isEmojiOnly(s)) return true;
  if (!/[\u4e00-\u9fa5]/.test(s) && /^[A-Za-z0-9+/=_\-.~:]{12,}$/.test(s)) return true;
  return false;
}

/** 整条消息是否没有可读内容（问候、纯 @、纯链接等）。 */
export function isNoiseText(raw) {
  const text = normalizeText(raw);
  if (!text) return true;
  if (isNoiseSegment(text)) return true;
  const stripped = text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@[^\s，。：；、！？]{1,40}/g, ' ')
    .replace(/u_[A-Za-z0-9_\-+/=]+/g, ' ')
    .replace(/[0-9A-Fa-f]{16,}/g, ' ')
    .replace(/\[(图片|表情|动画表情|语音|视频|文件|位置|链接)\]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length < 4) return true;
  if (
    /^(各位|大家|同学们|亲们|朋友们)?(早上好|上午好|中午好|下午好|晚上好|好|同学好|同学们好)$/.test(
      stripped,
    )
  ) {
    return true;
  }
  return false;
}

/** 把 protoTexts 的若干段过滤、去重、拼成消息正文。 */
export function cleanSegments(texts) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(texts) ? texts : [texts]) {
    const s = normalizeText(raw);
    if (!s || isNoiseSegment(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. 中文时间解析（Asia/Shanghai，UTC+8）
// ---------------------------------------------------------------------------

/** 把毫秒时间戳拆成上海时间各字段（不看宿主时区）。 */
export function shanghaiParts(ms) {
  const d = new Date(Number(ms) + SHANGHAI_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    wd: d.getUTCDay(),
  };
}

/** 上海时间的年月日时分 → UTC 毫秒。 */
export function fromShanghai(y, mo, d, h = 0, mi = 0) {
  return Date.UTC(y, mo - 1, d, h, mi, 0) - SHANGHAI_OFFSET_MS;
}

/** 上海时区当天 00:00 的毫秒时间戳。 */
export function shanghaiDayStart(ms) {
  const p = shanghaiParts(ms);
  return fromShanghai(p.y, p.mo, p.d, 0, 0);
}

/** ISO 8601 带 +08:00，例如 2026-11-26T22:00:00+08:00。 */
export function formatShanghaiIso(ms) {
  const p = shanghaiParts(ms);
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}T${pad2(p.h)}:${pad2(p.mi)}:00+08:00`;
}

/** 上海时区的 YYYY-MM-DD HH:mm，给 evidence/notes 用。 */
export function formatShanghaiTime(ms) {
  const p = shanghaiParts(ms);
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)} ${pad2(p.h)}:${pad2(p.mi)}`;
}

function msOf(value) {
  if (value instanceof Date) return value.getTime();
  const n = Number(value);
  if (!Number.isFinite(n)) return Date.now();
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

function offsetDay(startMs, days) {
  const p = shanghaiParts(startMs + days * DAY_MS);
  return { y: p.y, mo: p.mo, d: p.d };
}

const CN_WEEKDAY = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 0,
  天: 0,
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 0,
};

// --- 日期/时刻解析 -------------------------------------------------------

const RELATIVE_DAYS = [
  ['大后天', 3],
  ['后天', 2],
  ['明早', 1],
  ['明晚', 1],
  ['明天', 1],
  ['明日', 1],
  ['今早', 0],
  ['今晚', 0],
  ['今天', 0],
  ['今日', 0],
];

const RANGE_SEP_SRC = '[-–—~～至到]';
const NUM_TAIL_BAD = /^\s*(节|次|周|课|班|点|分|人|个|名|天|年|级|室|楼|栋|%|#)/;
const NUM_HEAD_BAD = /(第|星期|礼拜|周|上|下|这|本)\s*$/;

function validDate(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === mo && dt.getUTCDate() === d;
}

/**
 * 没有年份的「X 月 Y 日」：如果按锚点年份算出来已过去 20 天以上，
 * 认为说的是下一年（例如 12 月底通知「1 月 5 日」）。
 */
function rollYear({ y, mo, d }, anchorStart) {
  if (!validDate(y, mo, d)) return { y, mo, d };
  const candidate = fromShanghai(y, mo, d, 23, 59);
  if (candidate < anchorStart - 20 * DAY_MS) {
    const ny = y + 1;
    if (validDate(ny, mo, d)) return { y: ny, mo, d };
  }
  return { y, mo, d };
}

/** 区间型日期（「11.10-11.16」「10月15日—11月3日」）：截止取区间终点。 */
function collectDateRanges(text, anchorStart, anchorParts) {
  const ranges = [];
  const push = (match, endY, endMo, endD, endText) => {
    const day = rollYear({ y: endY, mo: endMo, d: endD }, anchorStart);
    if (!validDate(day.y, day.mo, day.d)) return;
    ranges.push({
      from: match.index,
      to: match.index + match[0].length,
      index: match.index + match[0].length - endText.length,
      end: match.index + match[0].length,
      phrase: match[0].replace(/\s+/g, ''),
      day,
    });
  };

  // 2026.11.10-11.16 / 2026年11月10日—11月16日
  const reYmd = new RegExp(
    `(\\d{4})\\s*(?:年|[.\\-/])\\s*(\\d{1,2})\\s*(?:月|[.\\-/])\\s*(\\d{1,2})\\s*[日号]?\\s*${RANGE_SEP_SRC}+\\s*(\\d{1,2})\\s*(?:月|[.\\-/])\\s*(\\d{1,2})\\s*[日号]?`,
    'g',
  );
  let match;
  while ((match = reYmd.exec(text))) {
    push(match, Number(match[1]), Number(match[4]), Number(match[5]), match[0].slice(-3));
  }
  // 11月10日-11月16日
  const reMd = new RegExp(
    `(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*[日号]\\s*${RANGE_SEP_SRC}+\\s*(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*[日号]`,
    'g',
  );
  while ((match = reMd.exec(text))) {
    push(match, anchorParts.y, Number(match[3]), Number(match[4]), match[0].slice(-3));
  }
  // 11.10-11.16
  const reNum = new RegExp(
    `(?<![\\d.\\-/])(\\d{1,2})\\s*[.\\-/]\\s*(\\d{1,2})\\s*${RANGE_SEP_SRC}+\\s*(\\d{1,2})\\s*[.\\-/]\\s*(\\d{1,2})(?![\\d.\\-/])`,
    'g',
  );
  while ((match = reNum.exec(text))) {
    const mo = Number(match[1]);
    const d = Number(match[2]);
    const mo2 = Number(match[3]);
    const d2 = Number(match[4]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || mo2 < 1 || mo2 > 12 || d2 < 1 || d2 > 31) continue;
    push(match, anchorParts.y, mo2, d2, match[0].slice(-3));
  }
  return ranges;
}

function collectDateHits(text, anchorStart) {
  const anchor = shanghaiParts(anchorStart);
  const ranges = collectDateRanges(text, anchorStart, anchor);
  const hits = [];
  const inRange = (index) => ranges.some((range) => index >= range.from && index < range.to);
  const add = (hit) => {
    if (!hit) return;
    if (!Number.isFinite(hit.index) || hit.index < 0) return;
    if (inRange(hit.index)) return;
    hits.push(hit);
  };

  for (const range of ranges) {
    hits.push({
      kind: 'range',
      explicit: true,
      index: range.index,
      end: range.end,
      phrase: range.phrase,
      ...range.day,
    });
  }

  // 2026年11月26日 / 2026.11.26 / 2026-11-26
  const reYmd = /(\d{4})\s*(?:年|[.\-/])\s*(\d{1,2})\s*(?:月|[.\-/])\s*(\d{1,2})\s*[日号]?/g;
  let match;
  while ((match = reYmd.exec(text))) {
    const y = Number(match[1]);
    const mo = Number(match[2]);
    const d = Number(match[3]);
    if (inRange(match.index) || !validDate(y, mo, d)) continue;
    add({ kind: 'ymd', explicit: true, y, mo, d, index: match.index, end: match.index + match[0].length, phrase: match[0] });
  }

  // 11月26日 / 11月26号
  const reMd = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g;
  while ((match = reMd.exec(text))) {
    const mo = Number(match[1]);
    const d = Number(match[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || !validDate(anchor.y, mo, d)) continue;
    const day = rollYear({ y: anchor.y, mo, d }, anchorStart);
    add({ kind: 'md', explicit: true, ...day, index: match.index, end: match.index + match[0].length, phrase: match[0] });
  }

  // 11.26 / 11-26 / 11/26（避开「第3-4节」「11-30304」这类编号）
  const reNum = /(?<![\d.\-/])(\d{1,2})\s*[.\-/]\s*(\d{1,2})(?![\d.\-/])/g;
  while ((match = reNum.exec(text))) {
    const mo = Number(match[1]);
    const d = Number(match[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || !validDate(anchor.y, mo, d)) continue;
    const before = text.slice(Math.max(0, match.index - 3), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 3);
    if (NUM_HEAD_BAD.test(before) || NUM_TAIL_BAD.test(after)) continue;
    const day = rollYear({ y: anchor.y, mo, d }, anchorStart);
    add({ kind: 'num', explicit: true, ...day, index: match.index, end: match.index + match[0].length, phrase: match[0] });
  }

  // 今天 / 明天 / 后天 / 大后天 / 今早 / 今晚 / 明晚
  for (const [word, days] of RELATIVE_DAYS) {
    const index = text.indexOf(word);
    if (index < 0) continue;
    add({ kind: 'rel', explicit: true, ...offsetDay(anchorStart, days), index, end: index + word.length, phrase: word });
  }

  // 周X / 本周X / 下周X
  const reWd = /(下下|下|本|这|今)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/g;
  while ((match = reWd.exec(text))) {
    if (inRange(match.index)) continue;
    const target = CN_WEEKDAY[match[2]];
    if (!Number.isFinite(target)) continue;
    const scope = match[1] || '';
    let daysAhead;
    if (scope === '下' || scope === '下下') {
      const mondayIndex = (anchor.wd + 6) % 7;
      daysAhead = (scope === '下下' ? 14 : 7) - mondayIndex + ((target + 6) % 7);
    } else {
      daysAhead = (target - anchor.wd + 7) % 7;
    }
    add({
      kind: 'wd',
      explicit: true,
      ...offsetDay(anchorStart, daysAhead),
      index: match.index,
      end: match.index + match[0].length,
      phrase: match[0].replace(/\s+/g, ''),
    });
  }

  // 月底 / 月末
  const reMonthEnd = /(本|这个|下个)?\s*月(?:底|末)/g;
  while ((match = reMonthEnd.exec(text))) {
    const monthOffset = match[1] === '下个' ? 1 : 0;
    const y = anchor.y;
    const mo = anchor.mo + monthOffset;
    const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    add({
      kind: 'monthEnd',
      explicit: true,
      y: mo === 13 ? y + 1 : y,
      mo: mo === 13 ? 1 : mo,
      d: lastDay,
      index: match.index,
      end: match.index + match[0].length,
      phrase: match[0].replace(/\s+/g, ''),
    });
  }

  hits.sort((a, b) => a.index - b.index);
  return hits;
}

const DEADLINE_CONTEXT_RE = /(截止|截至|截至时间|截止时间|之前|以前|前完成|前提交|前上交|之前完成|时间[:：]|于\d|在\d)/;

/** 多条时间线索时挑最像「截止时间」的那条。 */
function pickDateHit(hits, text) {
  if (!hits.length) return null;
  const score = (hit) => {
    let value = 0;
    if (hit.kind === 'range') value += 6;
    else if (hit.kind === 'ymd') value += 5;
    else if (hit.kind === 'rel') value += 4;
    else if (hit.kind === 'wd') value += 3;
    else if (hit.kind === 'md' || hit.kind === 'num') value += 2;
    else value += 1;
    // 「11月20日（周四）」括号里的星期只是注解，不是另一个截止时间
    if (hit.kind === 'wd' && /[（(]\s*$/.test(text.slice(Math.max(0, hit.index - 2), hit.index))) value -= 4;
    const window = text.slice(Math.max(0, hit.index - 12), Math.min(text.length, hit.end + 10));
    if (DEADLINE_CONTEXT_RE.test(window)) value += 2;
    if (/(?:日|天|周[一二三四五六日天]|号|点)\s*前/.test(window)) value += 2;
    return value;
  };
  return hits.slice().sort((a, b) => score(b) - score(a) || a.index - b.index)[0];
}

// --- 时刻解析 -------------------------------------------------------------

const PERIOD_SOURCE = '凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|晚间|今晚|明晚|晚';
const PERIOD_WORD_RE = /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|晚间|今晚|明晚)/;

function adjustHour(hour, period) {
  if (!period) return hour;
  if (/凌晨/.test(period)) return hour === 12 ? 0 : hour;
  if (/早上|早晨|上午/.test(period)) return hour;
  if (/中午/.test(period)) return hour < 11 ? hour + 12 : hour;
  if (/下午|傍晚|晚上|晚间|晚|今晚|明晚/.test(period)) return hour < 12 ? hour + 12 : hour;
  return hour;
}

function collectClocks(text) {
  const found = [];
  const colonRe = new RegExp(`(?:(${PERIOD_SOURCE})\\s*)?(\\d{1,2})\\s*[:：]\\s*(\\d{2})`, 'g');
  let match;
  while ((match = colonRe.exec(text))) {
    const period = match[1] || '';
    const rawHour = Number(match[2]);
    let hour = adjustHour(rawHour, period);
    let dayShift = 0;
    // 「晚上12点」= 当天 24:00 = 次日 00:00
    if (rawHour === 12 && /晚上|晚间|晚|今晚|明晚/.test(period) && !/下午|中午|上午|早上|早晨/.test(period)) {
      hour = 0;
      dayShift = 1;
    }
    const minute = Number(match[3]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      found.push({ index: match.index, h: hour, mi: minute, dayShift, text: match[0].replace(/\s+/g, ''), period });
    }
  }
  const pointRe = new RegExp(`(?:(${PERIOD_SOURCE})\\s*)?(\\d{1,2})\\s*点\\s*(半|(\\d{1,2})\\s*分?)?`, 'g');
  while ((match = pointRe.exec(text))) {
    const period = match[1] || '';
    const rawHour = Number(match[2]);
    let hour = adjustHour(rawHour, period);
    let dayShift = 0;
    if (rawHour === 12 && /晚上|晚间|晚|今晚|明晚/.test(period) && !/下午|中午|上午|早上|早晨/.test(period)) {
      hour = 0;
      dayShift = 1;
    }
    const minute = match[3] === '半' ? 30 : Number(match[4] || 0);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      found.push({ index: match.index, h: hour, mi: minute, dayShift, text: match[0].replace(/\s+/g, ''), period });
    }
  }
  found.sort((a, b) => a.index - b.index);
  return found;
}

function pickClock(clocks, afterIndex) {
  if (!clocks.length) return null;
  if (afterIndex >= 0) {
    const after = clocks.find((c) => c.index >= afterIndex);
    if (after) return after;
  }
  return clocks[0];
}

/**
 * 解析中文截止时间，全部按 Asia/Shanghai（UTC+8）折算，不依赖宿主时区。
 *
 * 支持：今天/明日/后天/大后天、今早/明晚、周X/本周X/下周X/月底、
 *      2026年11月26日、11月26日、11月26号、11.26、11-26、11/26、
 *      11.10-11.16（取区间终点）、今晚 22:00、下午 3 点半、晚上12点……
 * 解析到日期但没时刻 → 当天 23:59；只解析到「下午/晚上」这类半天词 → 当天 23:59 并标 vague。
 *
 * @param {string} rawText
 * @param {number|Date} [now] 锚点时间（默认现在；抽候选时应传消息时间）
 * @returns {{iso: string, hasClock: boolean, explicit: boolean, vague: boolean,
 *            phrase: string, clockText: string, index: number, fields: object} | null}
 */
export function parseDueInfo(rawText, now = Date.now()) {
  const text = toHalfWidth(normalizeText(rawText));
  if (!text) return null;
  const anchorMs = msOf(now);
  const parts = shanghaiParts(anchorMs);
  const todayStart = shanghaiDayStart(anchorMs);

  const hits = collectDateHits(text, todayStart);
  const dateHit = pickDateHit(hits, text);
  const clocks = collectClocks(text);

  let day = null;
  let explicit = false;
  let vague = false;
  let clock = null;
  if (dateHit) {
    day = { y: dateHit.y, mo: dateHit.mo, d: dateHit.d };
    explicit = true;
    clock = pickClock(clocks, dateHit.index);
  } else {
    const period = PERIOD_WORD_RE.exec(text);
    if (!period && !clocks.length) return null;
    day = { y: parts.y, mo: parts.mo, d: parts.d };
    vague = !clocks.length;
    clock = clocks[0] || null;
  }

  const hour = clock ? clock.h : 23;
  const minute = clock ? clock.mi : 59;
  let epoch = fromShanghai(day.y, day.mo, day.d, hour, minute);
  if (clock && clock.dayShift) epoch += clock.dayShift * DAY_MS;

  return {
    iso: formatShanghaiIso(epoch),
    hasClock: Boolean(clock),
    explicit,
    vague,
    phrase: dateHit ? dateHit.phrase : '',
    clockText: clock ? clock.text : '',
    index: dateHit ? dateHit.index : -1,
    fields: { ...day, h: hour, mi: minute },
  };
}

/** 只要 ISO 字符串的便捷版（解析不到返回 ''）。 */
export function parseDueAt(rawText, now = Date.now()) {
  const info = parseDueInfo(rawText, now);
  return info ? info.iso : '';
}

// ---------------------------------------------------------------------------
// 6. 任务判定
// ---------------------------------------------------------------------------

/** 动作词：出现就说明「有事要做」。 */
export const ACTION_WORDS = [
  '提交',
  '截止',
  '报名',
  '上报',
  '上交',
  '完成',
  '填报',
  '填写',
  '参加',
  '考试',
  '答辩',
  '交作业',
  '实验报告',
  '课程设计',
  'PPT',
  '汇报',
  '投稿',
  '上传',
  '签到',
  '申请',
  '确认',
  '统计',
  '收集表',
  '选题',
  '开题',
  '查重',
];

/** 事件词：用于挑标题，不单独作为任务判定依据。 */
const SECONDARY_ACTION_WORDS = ['启动', '征集', '招募', '举办', '开展', '通知', '安排', '公布'];

const TOPIC_RE = /(作业|实验|报告|论文|课程设计|大赛|比赛|活动|通知|名单|表格|文件|附件|材料|讲座|课程|习题|考试|答辩|志愿者|招募|征兵|分流)/;
const NOTICE_NOUN_RE = /(通知|名单|表格|文件|附件|安排|要求|材料|系统)/;
const TIME_HINT_RE = new RegExp(
  `(今天|今日|明天|明日|后天|大后天|下周|本周|这周|周[一二三四五六日天]|星期[一二三四五六日天]|月底|月末|${'\\d{1,2}'}\\s*月\\s*\\d{1,2}|\\d{1,2}\\s*[:：]\\s*\\d{2}|\\d{1,2}\\s*点)`,
);

export function hasActionWord(text) {
  return ACTION_WORDS.some((word) => text.includes(word));
}

function hasSecondaryActionWord(text) {
  return SECONDARY_ACTION_WORDS.some((word) => text.includes(word));
}

export function hasTimeHint(text) {
  return TIME_HINT_RE.test(text);
}

/** 群名像不像「通知类群」（教务处/学院/课程群）。 */
export function isNoticeGroup(groupName) {
  const name = normalizeText(groupName);
  if (!name) return false;
  return /(通知|公告|教务|学院|年级|班级|课程|导论|班群|辅导员)/.test(name);
}

/**
 * 一条消息值不值得当任务候选。
 * 规则：有动作词，或（通知/名单/表格/文件 类名词 + 有时间要求）。
 * 另外挡掉「怎么提交啊」「为什么…」这类纯提问/闲聊。
 */
export function isTaskText(rawText, now = Date.now()) {
  const text = normalizeText(rawText);
  if (!text || text.length < 4) return false;
  if (isNoiseText(text)) return false;

  const due = parseDueInfo(text, now);
  const noticeNoun = NOTICE_NOUN_RE.test(text);
  const chatter = CHATTER_RE.test(text) && !due;
  if (chatter) return false;

  const action = hasActionWord(text);
  if (!action && !(noticeNoun && due)) return false;
  // 没截止时间、没通知类名词、又短又像随口一句：不太可能是任务
  if (!due && !noticeNoun && text.length < 20 && /^(可以|能不能|能否|已经|好的|收到|谢谢|哈哈|好|嗯|行)/.test(text)) {
    return false;
  }
  return true;
}

/**
 * confidence 纯规则计算（0~1，封顶 0.95）：
 *   基础 0.1；有明确截止时间 +0.4；有动作词 +0.3；来自通知类群 +0.1；文本长度>20 +0.1。
 */
export function scoreConfidence({ text = '', groupName = '', dueInfo = null, action = false } = {}) {
  let score = 0.1;
  if (dueInfo && dueInfo.iso && (dueInfo.explicit || dueInfo.hasClock)) score += 0.4;
  if (action || hasActionWord(text)) score += 0.3;
  if (isNoticeGroup(groupName)) score += 0.1;
  if (String(text).length > 20) score += 0.1;
  return Math.min(0.95, Math.round(score * 100) / 100);
}

// ---------------------------------------------------------------------------
// 7. 标题 / 课程 / 类型
// ---------------------------------------------------------------------------

const LIST_MARKER_RE =
  /^(?:(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*[)）]?\s*[.、,，:：)）]\s*|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]\s*|[1-9]\uFE0F?\u20E3\s*|[a-zA-Z][.)、]\s*|[-–—•·*+>]\s*)+/;
const EDGE_JUNK_RE =
  /^[\s"'“”‘’「」『』，,。.、；;：:！!？?…—–·~～\-]+|[\s"'“”‘’「」『』，,。.、；;：:！!？?…—–·~～\-]+$/gu;
const NTOS_JUNK_RE = /[\w.\-]*::NTOSFull::\S*|\/Users\/\S+|\\Users\\\S+/g;
const JUNK_TITLE_RE =
  /::NTOS|NTOSFull|\/Users\/|\\Users\\|u_[A-Za-z0-9_]{6,}|https?:|@[^\s]{1,40}|\.(?:mp4|png|jpe?g|gif|docx?|xlsx?|pptx?|pdf)\b/i;

function stripMentions(text) {
  return String(text)
    .replace(NTOS_JUNK_RE, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@[^\s，。：；、！？]{1,40}/g, ' ')
    .replace(/\bu_[A-Za-z0-9_\-+/=]+/g, ' ')
    .replace(/\b[0-9A-Fa-f]{16,}(?:\.(?:png|jpe?g|gif|webp|bmp|xlsx?|docx?|pptx?|pdf))?\b/g, ' ')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ')
    .replace(/\b1\d{10}\b/g, ' ')
    .replace(/\[(图片|表情|动画表情|语音|视频|文件|位置|链接)\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const GREETING_RE =
  /^(?:如果说是|如果说|如果|那么|总之|另外|还有|以及|所以|但是|不过|同时|然后|因此|其实|就是|补充一下|顺便|提醒一下|麻烦|请|大家|各位同学[们]?好?|同学们|亲爱的同学们|各位)[，,：:！!。\s]*/;

const NOTICE_PREFIX_RE = /^(?:转)?[^：:，,。]{0,14}通知[：:]\s*/;

function stripFillers(text) {
  let s = String(text).trim();
  for (let i = 0; i < 4; i += 1) {
    const next = s.replace(GREETING_RE, '').replace(NOTICE_PREFIX_RE, '').trim();
    if (next === s || !next) break;
    s = next;
  }
  return s;
}

function clauseScore(clause) {
  let score = 0;
  if (hasActionWord(clause)) score += 3;
  if (TOPIC_RE.test(clause)) score += 2;
  if (hasTimeHint(clause)) score += 1;
  const len = clause.length;
  if (len >= 6 && len <= 40) score += 1;
  if (len > 40) score -= 1;
  return score;
}

function pickTitleClause(text) {
  const clauses = String(text)
    .split(/[。！？!?；;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && !isNoiseSegment(s));
  if (!clauses.length) return '';
  let best = clauses[0];
  let bestScore = -Infinity;
  for (const clause of clauses) {
    const score = clauseScore(clause);
    if (score > bestScore) {
      best = clause;
      bestScore = score;
    }
  }
  return best;
}

function compactClause(clause, budget = 40) {
  const segments = stripFillers(clause)
    .split(/[，,]/)
    .map((s) => stripFillers(stripMentions(s)))
    .filter(Boolean);
  if (!segments.length) return '';
  let picked;
  const actionIndex = segments.findIndex((s) => hasActionWord(s) || hasSecondaryActionWord(s));
  if (actionIndex > 0) {
    const merged = segments.slice(actionIndex - 1).join('，');
    picked = merged.length <= budget ? merged : segments.slice(actionIndex).join('，');
  } else {
    picked = segments.slice(0, actionIndex === 0 ? segments.length : 1).join('，');
  }
  return picked;
}

// --- 主题词 / 动词 / 组合标题 ---------------------------------------------

const TOPIC_LEXICON = [
  '职业规划大赛',
  '职规赛',
  '专业分流',
  '学生手册',
  '今日校园',
  '学习通',
  '选课',
  '预选',
  '体测',
  '助学金',
  '奖学金',
  '评教',
  '四六级',
  '计算机二级',
  '征兵',
  '反诈',
  '志愿服务',
  '志愿者',
  '讲座',
  '实验预约',
  '实验报告',
  '实验',
  '竞赛',
  '招募',
  '课程设计',
  '签到',
  '问卷',
  '投票',
  '入党',
  '团员',
  '迎新',
  '论文',
  '开题',
  '答辩',
  '军训',
  '运动会',
  '方阵',
  '彩排',
  '综测',
  '第二课堂',
  '医保',
  '体检',
  '宿舍',
  '寝室',
  '招聘',
  '实习',
  '就业',
  '考研',
  '保研',
  '大赛',
  '比赛',
  '作业',
  '考试',
  '报告',
  '名单',
  '表格',
];
const TOPIC_WORDS = [...new Set(TOPIC_LEXICON)].sort((a, b) => b.length - a.length);

const TOPIC_NOUN_SUFFIX_RE =
  /([\u4e00-\u9fa5]{2,20}?)(大赛|比赛|竞赛|名单|表格|问卷|截图|作业|报告|论文|考试|讲座|活动|招募|课程设计)/g;
const BAD_TOPIC_LEFT = /(老师|导员|学院|学校|教务|同学|各位|全体|大家|通知|关于|转)/;
const TOPIC_LEFT_TAIL_RE = /[需将要请的应是为在把]+$/;
const TOPIC_LEFT_LEAD_RE =
  /^(?:同时|并且|并|而且|且|还|也|就|再|先|然后|现拟|现在|目前|本次|此次|关于|根据|按照|经研究|决定|为了)*(?:完成|参加|参与|进行|开展|举行|举办|组织|召开|启动|提交|填报|填写|报名|面向|针对|拟)?/;
const TOPIC_LEFT_SPLIT_RE = /(?:开展|举行|举办|组织|召开|启动)/;

const TITLE_VERBS = [
  '报名',
  '填报',
  '填写',
  '提交',
  '上交',
  '上报',
  '投稿',
  '选课',
  '预约',
  '签到',
  '申请',
  '答辩',
  '考试',
  '上传',
  '收集',
  '参加',
  '确认',
  '领取',
  '完成',
];
const GENERIC_VERBS = new Set(['完成', '参加', '确认', '领取', '收集']);

const STOP_QUALIFIER = /^(?:请|大家|各位|同学|同学们|麻烦|注意|记得|务必|需要|尽快|及时|相关|所有|本次|此次)$/;

/** 在文本里找最像「这件事叫什么」的主题短语。 */
export function findTopicPhrase(text) {
  const cleaned = String(text);
  const candidates = [];
  const nounRe = new RegExp(TOPIC_NOUN_SUFFIX_RE.source, 'g');
  let match;
  while ((match = nounRe.exec(cleaned))) {
    let left = match[1];
    if (BAD_TOPIC_LEFT.test(left)) continue;
    left = left.replace(TOPIC_LEFT_TAIL_RE, '');
    const trunk = left.split(TOPIC_LEFT_SPLIT_RE).pop();
    if (trunk !== left) left = trunk;
    left = left.replace(TOPIC_LEFT_LEAD_RE, '');
    if (left.length < 2) continue;
    const phrase = left + match[2];
    candidates.push({
      phrase,
      index: match.index + match[1].length - left.length,
      weight: 2 + Math.min(8, phrase.length) * 0.1,
    });
  }
  for (const word of TOPIC_WORDS) {
    const index = cleaned.indexOf(word);
    if (index < 0) continue;
    candidates.push({ phrase: word, index, weight: 1.5 + word.length * 0.1 });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.weight - a.weight || a.index - b.index);
  let best = candidates[0];
  // 「专业分流」+「学生名单」→ 专业分流学生名单
  for (const word of TOPIC_WORDS) {
    if (word.length < 3 || best.phrase.includes(word)) continue;
    const index = cleaned.indexOf(word);
    if (index < 0 || Math.abs(index - best.index) > 20) continue;
    if (best.phrase.length + word.length > 18) continue;
    // 「志愿活动」+「志愿者」这种同词根的不拼，避免叠字
    const shared = [...new Set(best.phrase)].filter((ch) => word.includes(ch)).length;
    if (shared >= 2) continue;
    best = { ...best, phrase: index < best.index ? `${word}${best.phrase}` : `${best.phrase}${word}` };
    break;
  }
  return best;
}

function pickActionVerb(text) {
  let best = null;
  TITLE_VERBS.forEach((verb, rank) => {
    const index = String(text).indexOf(verb);
    if (index < 0) return;
    if (!best || rank < best.rank || (rank === best.rank && index < best.index)) best = { verb, index, rank };
  });
  return best ? best.verb : '';
}

const LOCALITY_RE = /^(今日校园|学习通|知网|超星|雨课堂|智慧树|钉钉|学校官网|教务系统|大赛平台|学校平台|校园网|易班|学工系统|问卷星)$/;

function prependQualifier(text, phrase) {
  const index = String(text).indexOf(phrase);
  if (index <= 0) return '';
  const before = String(text)
    .slice(Math.max(0, index - 8), index)
    .replace(/[\s，,。；;：:、]+$/, '');
  // 只有「今日校园上的签到」「教务系统里的表格」这种限定语才值得并进去
  const match = /([\u4e00-\u9fa5]{2,6})((?:的|上|在|里|中))$/.exec(before);
  if (!match) return '';
  const word = match[1];
  if (STOP_QUALIFIER.test(word) || BAD_TOPIC_LEFT.test(word)) return '';
  if (!LOCALITY_RE.test(word) && match[2] !== '的') return '';
  return word + phrase;
}

const HEAD_NOISE_RE = /^(?:我校|我院|本院|贵校|贵院|该院|学校|学院|关于|转发|通知|机械学院|化学学院)/;

function stripHeadNoise(phrase) {
  let out = String(phrase);
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(HEAD_NOISE_RE, '').replace(/^的+/, '').trim();
    if (next === out || !next) break;
    out = next;
  }
  return out;
}

/** 消息自带的【…】/《…》标题（多半是作者定的正题，优先用）。 */
function bracketTitle(text) {
  const body = String(text).trim();
  const match = /^[【\[《「“]([^】\]》」”\n]{4,30})[】\]》」”]/.exec(body);
  if (!match || !match[1]) return '';
  const title = cleanTitlePunctuation(stripHeadNoise(match[1]));
  return title.length >= 4 ? title : '';
}

/** 第一行短句当标题（「各位同学，现通知如下」这类不算）。 */
function firstLineTitle(text) {
  const firstLine = String(text).trim().split(/[\n。！？!?]/)[0].trim();
  if (firstLine.length < 6 || firstLine.length > 24) return '';
  const candidate = cleanTitlePunctuation(stripHeadNoise(stripFillers(firstLine)));
  if (candidate.length < 6) return '';
  if (!findTopicPhrase(candidate) && !hasActionWord(candidate)) return '';
  return candidate;
}

function composeCompound(text) {
  const topic = findTopicPhrase(text);
  if (!topic) return '';
  let phrase = topic.phrase;
  if (phrase.length <= 3) phrase = prependQualifier(text, phrase) || phrase;
  phrase = stripHeadNoise(phrase);
  const verb = pickActionVerb(text);
  const verbIndex = verb ? String(text).indexOf(verb) : -1;
  let core = phrase;
  // 动词离主题太远多半是别的句子，硬拼会串味
  if (verb && !phrase.includes(verb) && !GENERIC_VERBS.has(verb) && Math.abs(verbIndex - topic.index) <= 30) {
    core = `${phrase}${verb}`;
  }
  if (core.length > 26) core = phrase;
  if (phrase.length < 3 && core.length < 4) return '';
  return cleanTitlePunctuation(core);
}

const TRAILING_DEADLINE_RE = /[，,；;]\s*(?:截止|截至|时间)[^，,。；;]*$/;

function fallbackTitle(text, budget) {
  const cleaned = stripMentions(text);
  const clauses = String(cleaned)
    .split(/[。！？!?；;\n]+/)
    .map((s) => stripFillers(s).trim())
    .filter((s) => s.length >= 4 && !isNoiseSegment(s));
  const pool = [];
  for (const clause of clauses) {
    pool.push(clause);
    for (const segment of clause.split(/[，,]/)) {
      const piece = stripFillers(segment).trim();
      if (piece.length >= 4) pool.push(piece);
    }
  }
  let best = '';
  let bestScore = -Infinity;
  for (const candidate of pool) {
    const trimmed = cleanTitlePunctuation(candidate.replace(TRAILING_DEADLINE_RE, ''));
    if (!trimmed) continue;
    const score = clauseScore(trimmed) + (trimmed.length <= budget ? 1 : -2) + (findTopicPhrase(trimmed) ? 2 : 0);
    if (score > bestScore) {
      best = trimmed;
      bestScore = score;
    }
  }
  if (!best) return '';
  if (best.length > budget) best = `${best.slice(0, Math.max(4, budget - 1))}…`;
  return best;
}

function scoreTitle(title) {
  if (!title) return -Infinity;
  let score = 0;
  const len = title.length;
  if (len >= 6 && len <= 24) score += 3;
  else if (len <= 30) score += 1;
  else score -= 2;
  if (hasActionWord(title)) score += 2;
  if (findTopicPhrase(title)) score += 2;
  if (JUNK_TITLE_RE.test(title)) score -= 6;
  if (/[，,：:]/.test(title)) score -= 1;
  if (LIST_MARKER_RE.test(title)) score -= 2;
  return score;
}

const LEAD_CONNECTOR_RE = /^(?:将|请|要|需|应|须|并|再|还|就|先|待)+/;

function cleanTitlePunctuation(text) {
  return String(text)
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
    .replace(LIST_MARKER_RE, '')
    .replace(/\s*([月日号点时:：])\s*/g, '$1')
    .replace(/([，,])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(EDGE_JUNK_RE, '')
    .replace(LEAD_CONNECTOR_RE, '')
    .trim()
    .replace(EDGE_JUNK_RE, '')
    .trim();
}

const SUPPORT_DEADLINE_RE =
  /(?:今天|今日|明天|明日|后天|大后天|下周[一二三四五六日天]?|本周[一二三四五六日天]?|这周[一二三四五六日天]?|周[一二三四五六日天]|月底|月末|\d{1,2}\s*月\s*\d{1,2}\s*[日号]?)[^，,。；;\n]{0,6}/;

function titleSuffix(supportText, mainText) {
  const support = normalizeText(supportText);
  if (!support || support.length > 30) return '';
  const match = SUPPORT_DEADLINE_RE.exec(support);
  if (!match) return '';
  const phrase = cleanTitlePunctuation(stripMentions(match[0])).replace(/[，,。；;：:]+$/, '');
  if (!phrase || phrase.length > 12) return '';
  if (normalizeText(mainText).includes(phrase)) return '';
  return `（${phrase}）`;
}

/**
 * 生成「像人话」的标题：主题短语 + 动作词，或退回到最像任务的分句，
 * 去 @/链接/文件哈希/列表序号，压到 40 字以内。
 * @param {string} rawText
 * @param {{supportText?: string, now?: number|Date, maxLength?: number}} [opts]
 */
export function makeTitle(rawText, opts = {}) {
  const original = normalizeText(rawText);
  if (!original) return '';
  const text = stripFillers(original);
  const maxLength = Math.max(10, Number(opts.maxLength) || 40);
  const suffix = titleSuffix(opts.supportText || '', original);
  const budget = Math.max(8, maxLength - suffix.length);

  const candidates = [
    { title: bracketTitle(text), bonus: 3 },
    { title: composeCompound(text), bonus: 2 },
    { title: firstLineTitle(text), bonus: 1 },
    { title: fallbackTitle(text, budget), bonus: 0 },
  ].filter((item) => item.title);
  let title = '';
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const score = scoreTitle(candidate.title) + candidate.bonus;
    if (score > bestScore) {
      title = candidate.title;
      bestScore = score;
    }
  }
  if (!title) title = cleanTitlePunctuation(stripMentions(text));
  if (title.length > budget) title = `${title.slice(0, Math.max(4, budget - 1))}…`;
  if (suffix && title.length + suffix.length <= maxLength) title += suffix;
  return title;
}

const COURSE_HINTS = [
  ['高等数学', ['高数', '高等数学']],
  ['线性代数', ['线代', '线性代数']],
  ['大学物理', ['大物', '大学物理']],
  ['数据结构', ['数据结构']],
  ['操作系统', ['操作系统']],
  ['计算机网络', ['计算机网络', '计网']],
  ['人工智能导论', ['人工智能导论', 'AI导论', '人工智能']],
  ['机械设计', ['机械设计']],
  ['工程制图', ['工程制图', '制图']],
  ['电机学', ['电机学', '电机']],
  ['大学英语', ['大学英语', '英语']],
];

/** 从正文（其次群名）猜课程名；猜不到返回 ''。 */
export function guessCourse(text, groupName = '') {
  const body = normalizeText(text);
  for (const [name, keys] of COURSE_HINTS) {
    if (keys.some((key) => body.includes(key))) return name;
  }
  const group = normalizeText(groupName);
  for (const [name, keys] of COURSE_HINTS) {
    if (keys.some((key) => group.includes(key))) return name;
  }
  return '';
}

const KIND_RULES = [
  ['exam', /(考试|测验|补考|笔试|面试|答辩|考核|考场)/],
  ['homework', /(作业|习题|实验报告|大作业|课程设计|报告|论文|PPT|pptx|汇报)/],
  ['application', /(报名|申请|投稿|填报|收集表|材料|表格|统计|征兵|大赛|分流)/],
  ['practice', /(实习|实践|志愿|活动|讲座|培训|比赛|招募)/],
  ['reading', /(阅读|读书|参考书|文献)/],
  ['course', /(上课|课程表|调课|停课|补课|教室|开课|签到)/],
];

/** 按正文关键词映射到 lib/store.js 的 TASK_KINDS。 */
export function guessKind(text) {
  const body = normalizeText(text);
  for (const [kind, re] of KIND_RULES) {
    if (re.test(body)) return kind;
  }
  return 'other';
}

function priorityFor(dueIso, nowMs, text) {
  if (/(紧急|尽快|立即|马上|今天|今晚|今日)/.test(text)) return 1;
  if (!dueIso) return 3;
  const due = Date.parse(dueIso);
  if (!Number.isFinite(due)) return 3;
  const days = (due - nowMs) / DAY_MS;
  if (days < 0) return 3;
  if (days <= 1) return 1;
  if (days <= 3) return 2;
  if (days <= 7) return 3;
  return 4;
}

// ---------------------------------------------------------------------------
// 8. 同类消息合并（同群、5 分钟、相似/前缀/补充）
// ---------------------------------------------------------------------------

function compareKey(text) {
  return String(text)
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

/** 字符二元组 Dice 相似度（0~1）。 */
export function similarity(a, b) {
  const x = compareKey(a);
  const y = compareKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
  const bigrams = new Map();
  for (let i = 0; i < x.length - 1; i += 1) {
    const gram = x.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < y.length - 1; i += 1) {
    const gram = y.slice(i, i + 2);
    const left = bigrams.get(gram) || 0;
    if (left > 0) {
      hits += 1;
      bigrams.set(gram, left - 1);
    }
  }
  return (2 * hits) / (x.length - 1 + (y.length - 1));
}

/** 短句补充：如「周日前完成」跟在上一条通知后面。 */
export function isSupplement(text) {
  const t = normalizeText(text);
  if (!t || t.length > 14) return false;
  if (!hasTimeHint(t) && !/(前|之前|截止)/.test(t)) return false;
  return /(完成|截止|之前|前|交|提交|报名|上传|填报|确认)/.test(t);
}

function relatedTo(baseText, text) {
  const a = normalizeText(baseText);
  const b = normalizeText(text);
  if (!a || !b) return false;
  if (isSupplement(b)) return true;
  if (similarity(a, b) >= 0.62) return true;
  const ka = compareKey(a);
  const kb = compareKey(b);
  if (ka.length >= 8 && kb.length >= 8 && (ka.startsWith(kb) || kb.startsWith(ka))) return true;
  return false;
}

const MERGE_WINDOW_MS = 5 * 60 * 1000;

/**
 * 合并「同群 + 5 分钟内 + 高度相似/前缀/短句补充」的消息。
 * 返回合并后的消息（保留第一条的 ts，text 拼接，baseText/supportText 分开留给标题用）。
 */
export function mergeRelated(messages) {
  const sorted = [...(messages || [])].sort(
    (a, b) => a.groupCode - b.groupCode || a.ts - b.ts || String(a.id).localeCompare(String(b.id)),
  );
  const lastByGroup = new Map();
  const merged = [];
  for (const message of sorted) {
    const text = normalizeText(message.text);
    if (!text) continue;
    const last = lastByGroup.get(message.groupCode);
    if (
      last &&
      message.ts - last.ts <= MERGE_WINDOW_MS &&
      message.ts >= last.ts &&
      relatedTo(last.text, text)
    ) {
      last.text = normalizeText(`${last.text} ${text}`);
      last.supportText = normalizeText(`${last.supportText} ${text}`);
      last.ts = message.ts;
      last.ids.push(message.id);
      continue;
    }
    const item = {
      ...message,
      text,
      baseText: text,
      supportText: '',
      ids: [message.id],
    };
    merged.push(item);
    lastByGroup.set(message.groupCode, item);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 9. 候选任务抽取 / 去重
// ---------------------------------------------------------------------------

function evidenceText(text) {
  const t = normalizeText(text);
  return t.length > 400 ? `${t.slice(0, 400)}…` : t;
}

/**
 * 从群消息列表抽候选任务（不落库）。
 * @param {{id?: string, groupCode?: number, groupName?: string, senderId?: string, ts?: number, text?: string}[]} messages
 * @param {{now?: number|Date, maxAgeDays?: number, minConfidence?: number}} [opts]
 * @returns {{title: string, course: string, dueAt: string, kind: string, priority: number,
 *            confidence: number, notes: string,
 *            evidence: {groupCode: number, groupName: string, ts: number, text: string}}[]}
 */
export function extractTaskCandidates(messages, opts = {}) {
  const nowMs = msOf(opts.now ?? Date.now());
  const maxAgeDays = Number.isFinite(Number(opts.maxAgeDays)) ? Number(opts.maxAgeDays) : 30;
  const minConfidence = Number(opts.minConfidence) || 0;
  const since = nowMs - maxAgeDays * DAY_MS;

  const prepared = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = normalizeText(message?.text);
    if (!text || isNoiseText(text)) continue;
    const ts = normalizeEpoch(message?.ts) || 0;
    if (ts && ts < since) continue;
    const groupCode = Number(message?.groupCode) || 0;
    if (!groupCode) continue;
    prepared.push({
      id: String(message?.id ?? ''),
      groupCode,
      groupName: normalizeText(message?.groupName),
      senderId: String(message?.senderId ?? ''),
      ts,
      text,
    });
  }

  const merged = mergeRelated(prepared);
  const candidates = [];
  const EXPIRE_GRACE_MS = 6 * 60 * 60 * 1000;
  const STALE_NO_DUE_MS = 7 * DAY_MS;
  for (const message of merged) {
    // 日期以「消息发出那一刻」为锚点解析：老消息里的「今天」是它发的那天
    const anchorMs = message.ts || nowMs;
    if (!isTaskText(message.text, anchorMs)) continue;
    const dueInfo = parseDueInfo(message.text, anchorMs);
    // 截止时间已经过去（超过 6 小时宽限）→ 不再是待办
    if (dueInfo && dueInfo.iso && Date.parse(dueInfo.iso) < nowMs - EXPIRE_GRACE_MS) continue;
    // 一周前、又没写任何截止时间的公告，没有排程价值
    if (!dueInfo && anchorMs < nowMs - STALE_NO_DUE_MS) continue;
    const title = makeTitle(message.baseText, { supportText: message.supportText, now: nowMs });
    if (!title) continue;
    const action = hasActionWord(message.text);
    const confidence = scoreConfidence({
      text: message.text,
      groupName: message.groupName,
      dueInfo,
      action,
    });
    if (confidence < minConfidence) continue;
    candidates.push({
      title,
      course: guessCourse(message.text, message.groupName),
      dueAt: dueInfo ? dueInfo.iso : '',
      kind: guessKind(message.text),
      priority: priorityFor(dueInfo ? dueInfo.iso : '', nowMs, message.text),
      confidence,
      notes: `QQ群「${message.groupName || message.groupCode}」${formatShanghaiTime(message.ts || nowMs)} 消息`,
      evidence: {
        groupCode: message.groupCode,
        groupName: message.groupName,
        ts: message.ts,
        text: evidenceText(message.text),
      },
    });
  }
  return dedupeCandidates(candidates);
}

function candidateTitleKey(title) {
  return String(title)
    .replace(/[（(].*?[)）]$/, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase()
    .slice(0, 30);
}

function dueDay(iso) {
  const text = String(iso || '').trim();
  return text ? text.slice(0, 10) : '';
}

/** 同一天/相邻一天的截止时间视作同一件事。 */
function sameDueWindow(a, b) {
  const da = dueDay(a);
  const db = dueDay(b);
  if (!da || !db) return true; // 一边没有截止时间：当作同一条，避免重复
  if (da === db) return true;
  const ta = Date.parse(`${da}T00:00:00+08:00`);
  const tb = Date.parse(`${db}T00:00:00+08:00`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return da === db;
  return Math.abs(ta - tb) <= DAY_MS * 1.5;
}

/**
 * 候选去重：同标题（+ 同日/相邻日截止）只保留一条，优先保留 confidence 高的，
 * 并从重复项里补全 course/dueAt 等字段。
 */
export function dedupeCandidates(candidates) {
  const buckets = new Map();
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    if (!raw || !raw.title) continue;
    const candidate = { ...raw, evidence: raw.evidence ? { ...raw.evidence } : { groupCode: 0, groupName: '', ts: 0, text: '' } };
    const key = candidateTitleKey(candidate.title);
    if (!key) continue;
    const list = buckets.get(key) || [];
    const slot = list.find((item) => sameDueWindow(item.dueAt, candidate.dueAt));
    if (!slot) {
      list.push(candidate);
      buckets.set(key, list);
      continue;
    }
    const slotConfidence = Number(slot.confidence) || 0;
    const candidateConfidence = Number(candidate.confidence) || 0;
    if (candidateConfidence > slotConfidence) {
      candidate.course = candidate.course || slot.course;
      candidate.dueAt = candidate.dueAt || slot.dueAt;
      candidate.kind = candidate.kind && candidate.kind !== 'other' ? candidate.kind : slot.kind;
      candidate.priority = Math.min(Number(candidate.priority) || 3, Number(slot.priority) || 3);
      slot.title = candidate.title;
      slot.course = candidate.course;
      slot.dueAt = candidate.dueAt;
      slot.kind = candidate.kind;
      slot.priority = candidate.priority;
      slot.confidence = candidate.confidence;
      slot.notes = candidate.notes;
      slot.evidence = candidate.evidence;
    } else {
      if (!slot.course && candidate.course) slot.course = candidate.course;
      if (!slot.dueAt && candidate.dueAt) slot.dueAt = candidate.dueAt;
    }
  }

  const out = [];
  for (const list of buckets.values()) out.push(...list);
  return out.sort(
    (a, b) =>
      Number(b.confidence || 0) - Number(a.confidence || 0) ||
      String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999')) ||
      String(a.title).localeCompare(String(b.title), 'zh-Hans-CN'),
  );
}

// ---------------------------------------------------------------------------
// 10. 群白名单 JSON
// ---------------------------------------------------------------------------

function toGroupEntry(code, name, enabled) {
  const num = Number(code);
  if (!Number.isFinite(num) || num <= 0) return null;
  return { code: num, name: normalizeText(name), enabled: enabled !== false };
}

/**
 * 解析群白名单 JSON。兼容：
 *   [{"code":100000001,"name":"示例通知群A","enabled":true}]
 *   [100000001, 100000002]
 *   {"groups":[...]} / {"100000001":{"name":"..."}} / {"100000001":"群名"}
 * 解析不了返回 []（插件启动时不要因为配置写错就崩）。
 * @param {string|object} text
 * @returns {{code: number, name: string, enabled: boolean}[]}
 */
export function parseGroupsJson(text) {
  let value = text;
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return [];
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!value || typeof value !== 'object') return [];

  let list = value;
  if (!Array.isArray(value)) {
    if (Array.isArray(value.groups)) list = value.groups;
    else {
      const entries = [];
      for (const [key, item] of Object.entries(value)) {
        if (item && typeof item === 'object') {
          entries.push(toGroupEntry(item.code ?? key, item.name, item.enabled));
        } else if (typeof item === 'string') {
          entries.push(toGroupEntry(key, item, true));
        } else if (typeof item === 'number') {
          entries.push(toGroupEntry(item, '', true));
        }
      }
      list = entries.filter(Boolean);
    }
  }

  const byCode = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    if (item == null) continue;
    let entry;
    if (typeof item === 'number' || typeof item === 'string') {
      entry = toGroupEntry(item, '', true);
    } else if (typeof item === 'object') {
      entry = toGroupEntry(item.code ?? item.groupCode ?? item.group ?? item.id, item.name ?? item.title, item.enabled);
    }
    if (!entry) continue;
    byCode.set(entry.code, entry);
  }
  return [...byCode.values()];
}

// ---------------------------------------------------------------------------
// 11. 测试用纯函数集合
// ---------------------------------------------------------------------------

export const __internal = {
  // 文本
  toHalfWidth,
  normalizeText,
  cleanSegments,
  isNoiseSegment,
  isNoiseText,
  isEmojiOnly,
  stripMentions,
  stripFillers,
  compareKey,
  // 时间
  shanghaiParts,
  fromShanghai,
  shanghaiDayStart,
  formatShanghaiIso,
  formatShanghaiTime,
  parseDueInfo,
  parseDueAt,
  adjustHour,
  collectClocks,
  collectDateHits,
  collectDateRanges,
  pickDateHit,
  pickClock,
  validDate,
  rollYear,
  // 规则
  ACTION_WORDS,
  hasActionWord,
  hasTimeHint,
  isNoticeGroup,
  isTaskText,
  scoreConfidence,
  makeTitle,
  pickTitleClause,
  compactClause,
  titleSuffix,
  findTopicPhrase,
  pickActionVerb,
  composeCompound,
  bracketTitle,
  firstLineTitle,
  fallbackTitle,
  scoreTitle,
  cleanTitlePunctuation,
  LIST_MARKER_RE,
  guessCourse,
  guessKind,
  priorityFor,
  // 合并/去重
  similarity,
  isSupplement,
  relatedTo,
  mergeRelated,
  mergeMessages: mergeRelated,
  dedupeCandidates,
  candidateTitleKey,
  dueDay,
  // 读库
  pickGroupMsgTable,
  normalizeEpoch,
  readGroupNames,
};
