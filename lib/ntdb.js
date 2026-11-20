/**
 * ntdb.js — 读取 QQ NT (NTQQ) 本地加密数据库，纯 Node 实现，零第三方依赖。
 *
 * 背景（实测 + 源码核对）：
 *   - QQ NT 把聊天记录存在 `nt_msg.db` 里，格式是「1024 字节自定义头 + SQLCipher 4 数据库」。
 *   - 自定义头第一段是 `SQLite header 3\0`（故意不是标准 `SQLite format 3\0`）。
 *   - 密钥是 16 字节 ASCII，只在 QQ 进程内存里，无法从磁盘推导（见 bin/qq-key.md）。
 *   - SQLCipher 参数固定：page_size 4096 / kdf_iter 4000 / HMAC-SHA1 / PBKDF2-HMAC-SHA512。
 *
 * 本文件实现：
 *   1. deriveKeys(key, salt)          —— SQLCipher 4 的加密/校验密钥派生
 *   2. decryptPage(page, keys, pgno)  —— 单页解密（含 HMAC 校验）
 *   3. decryptDatabase({src, dst, key}) —— 整库解密成普通 SQLite 文件
 *   4. mergeWal({db, wal, out})       —— 把 -wal 里未落盘的页合并进明文库
 *   5. openPlain(path)                —— 用 node:sqlite 打开
 *   6. protoTexts(buf)                —— 从消息体 Protobuf 里抽出所有文本段
 *   7. readGroupMessages(...)         —— 按群号 + 时间窗读群消息
 *
 * 解密语义（对应 sqlcipher.c 的 sqlite3Codec / sqlcipher_page_cipher）：
 *   reserve_sz = ceil((IV16 + HMAC20) / 16) * 16 = 48
 *   usable     = 4096 - 48 = 4048
 *   普通页：密文 page[0..4048) | IV page[4048..4064) | HMAC page[4064..4084)
 *   第 1 页：salt page[0..16) | 密文 page[16..4048) | IV page[4048..4064) | HMAC page[4064..4084)
 *           解密后明文 = "SQLite format 3\0" + 明文 page[16..4048)
 *   HMAC 覆盖「密文 || IV || pgno 的小端 4 字节」
 */

import { createCipheriv, createDecipheriv, createHmac, pbkdf2Sync, timingSafeEqual } from 'node:crypto';

export const SQLITE_MAGIC = Buffer.from('SQLite format 3\u0000', 'latin1');
export const PAGE_SIZE = 4096;
export const IV_SIZE = 16;
export const HMAC_SIZE = 20;
export const RESERVE_SIZE = Math.ceil((IV_SIZE + HMAC_SIZE) / 16) * 16; // 48（密文区的收尾方式）
/** 每页实际可用（SQLite 头部 offset 20 记录保留区 = 80 → usable 4016）。
 *  实测：解密出的 4048 字节里，末尾 32 字节恒为 0（SQLCipher 的零填充），
 *  真正属于 SQLite 页内容的是前 4016 字节；写明文库时每页只前 4016 字节有效、其余补 0，
 *  否则 SQLite 会报 `Fragmentation of 32 bytes` / `database disk image is malformed`。 */
export const SQLITE_RESERVE = 80;
export const SQLITE_USABLE = PAGE_SIZE - SQLITE_RESERVE; // 4016
export const USABLE_SIZE = PAGE_SIZE - RESERVE_SIZE; // 4048（密文区长度）

/** QQ 在 sqlcipher 库前面加的自定义头长度 */
export const NT_HEADER_BYTES = 1024;
/** login.db 的固定密钥，所有设备一致，不是聊天记录密钥 */
export const LOGIN_DB_KEY = 'BD156D6710D54D8782F4';

const HMAC_SALT_MASK = 0x3a;

function xorSalt(salt) {
  const out = Buffer.alloc(salt.length);
  for (let i = 0; i < salt.length; i += 1) out[i] = salt[i] ^ HMAC_SALT_MASK;
  return out;
}

/**
 * 由 16 字节 ASCII 密钥 + 库内 salt 派生 AES/HMAC 密钥。
 * @param {string|Buffer} key 16 字节 ASCII 密钥
 * @param {Buffer} salt 文件前 16 字节
 * @param {{kdfIter?: number, keySize?: number}} [opts]
 */
export function deriveKeys(key, salt, opts = {}) {
  const kdfIter = opts.kdfIter ?? 4000;
  const keySize = opts.keySize ?? 32;
  const pass = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8');
  if (!pass.length) throw new Error('密钥为空');
  if (!Buffer.isBuffer(salt) || salt.length !== 16) throw new Error('salt 必须是 16 字节');
  const encKey = pbkdf2Sync(pass, salt, kdfIter, keySize, 'sha512');
  const hmacKey = pbkdf2Sync(encKey, xorSalt(salt), 2, keySize, 'sha512');
  return { encKey, hmacKey, kdfIter, keySize };
}

export function pageHmac(keys, pgno, cipherAndIv) {
  const pg = Buffer.alloc(4);
  pg.writeUInt32LE(pgno >>> 0, 0);
  return createHmac('sha1', keys.hmacKey).update(cipherAndIv).update(pg).digest();
}

/**
 * 解密单页，返回 4048 字节明文（第 1 页已补回 SQLite magic）。
 * @param {Buffer} page 恰好 4096 字节
 * @param {object} keys deriveKeys 的返回
 * @param {number} pgno 1 起
 * @param {{verify?: boolean}} [opts]
 */
export function decryptPage(page, keys, pgno, opts = {}) {
  if (page.length !== PAGE_SIZE) throw new Error(`页长度应为 ${PAGE_SIZE}，实际 ${page.length}`);
  const verify = opts.verify !== false;
  const isFirst = pgno === 1;
  const dataStart = isFirst ? IV_SIZE : 0;
  const ctLen = USABLE_SIZE - dataStart;
  const ctEnd = dataStart + ctLen;
  const iv = page.subarray(USABLE_SIZE, USABLE_SIZE + IV_SIZE);
  const mac = page.subarray(USABLE_SIZE + IV_SIZE, USABLE_SIZE + IV_SIZE + HMAC_SIZE);

  if (verify) {
    const expect = pageHmac(keys, pgno, page.subarray(dataStart, USABLE_SIZE + IV_SIZE));
    if (!timingSafeEqual(expect, mac)) {
      throw new Error(`第 ${pgno} 页 HMAC 校验失败：密钥不对或文件损坏`);
    }
  }

  const decipher = createDecipheriv('aes-256-cbc', keys.encKey, iv);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(page.subarray(dataStart, ctEnd)), decipher.final()]);
  if (isFirst) return Buffer.concat([SQLITE_MAGIC, plain]);
  return plain;
}

/**
 * 反向：把 4048 字节明文封成 4096 字节加密页（仅测试与自检用）。
 * 第 1 页按 SQLCipher 语义在开头写入 salt（明文），真实页面内容的头 16 字节不落盘。
 */
export function encryptPage(plain, keys, pgno, opts = {}) {
  if (plain.length !== USABLE_SIZE) throw new Error(`明文页应为 ${USABLE_SIZE} 字节`);
  const isFirst = pgno === 1;
  const dataStart = isFirst ? IV_SIZE : 0;
  const body = isFirst ? plain.subarray(IV_SIZE) : plain;
  const ivBuf = opts.iv ?? Buffer.alloc(IV_SIZE, pgno & 0xff);
  const enc = createCipheriv('aes-256-cbc', keys.encKey, ivBuf);
  enc.setAutoPadding(false);
  const ct = Buffer.concat([enc.update(body), enc.final()]);
  const page = Buffer.alloc(PAGE_SIZE);
  if (isFirst) {
    const salt = opts.salt;
    if (Buffer.isBuffer(salt) && salt.length === 16) salt.copy(page, 0);
    else plain.subarray(0, IV_SIZE).copy(page, 0);
  }
  ct.copy(page, dataStart);
  ivBuf.copy(page, USABLE_SIZE);
  pageHmac(keys, pgno, page.subarray(dataStart, USABLE_SIZE + IV_SIZE)).copy(
    page,
    USABLE_SIZE + IV_SIZE,
  );
  return page;
}

/**
 * 反向：把若干 4048 字节明文页拼成「1024 自定义头 + 加密页」的库文件（测试/自检用）。
 * @param {{pages: Buffer[], key: string, salt: Buffer, headerBytes?: number}} opts
 */
export function encryptDatabaseBuffer(opts) {
  const { pages, key } = opts;
  const headerBytes = opts.headerBytes ?? NT_HEADER_BYTES;
  const salt = opts.salt ?? Buffer.alloc(16, 1);
  const keys = deriveKeys(key, salt);
  const head = Buffer.alloc(headerBytes);
  Buffer.from('SQLite header 3\u0000', 'latin1').copy(head, 0);
  const body = pages.map((plain, idx) => encryptPage(plain, keys, idx + 1, { salt }));
  return Buffer.concat([head, ...body]);
}

function assertSqliteHeader(firstPage) {
  if (firstPage.subarray(0, 16).compare(SQLITE_MAGIC) !== 0) {
    throw new Error('解密后第 1 页不是 SQLite 头：密钥错误或库格式不符');
  }
}

/** 读第 1 页头部里的「库页数」（SQLite header 偏移 28，大端 uint32）。 */
export function dbPageCount(firstPlainPage) {
  const n = firstPlainPage.readUInt32BE(28);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 解密整个库文件（含可选 WAL），返回明文 SQLite 文件内容（每页 PAGE_SIZE，尾部补 48 个零）。
 *
 * 关键细节（实测 QQ 7.0.3 的 nt_msg.db）：
 *  - 文件尾部会预分配若干页，但库头 offset 28 记录的「库页数」小于物理页数；
 *    超出库页数的页不是库的一部分（未加密/残留），不能要求它通过 HMAC。
 *  - 因此先解第 1 页拿库页数，库内页严格校验，库外页宽松处理；WAL 里的提交帧可以把库撑大。
 * @param {{buffer: Buffer, key: string, headerBytes?: number, wal?: Buffer, verify?: boolean}} opts
 */
export function decryptDatabaseBuffer(opts) {
  const { buffer, key } = opts;
  const headerBytes = opts.headerBytes ?? NT_HEADER_BYTES;
  const verify = opts.verify !== false;
  if (!Buffer.isBuffer(buffer) || buffer.length < headerBytes + PAGE_SIZE) {
    throw new Error('数据库文件太小或不完整');
  }

  const salt = buffer.subarray(headerBytes, headerBytes + 16);
  const keys = deriveKeys(key, salt);
  const physicalPages = Math.floor((buffer.length - headerBytes) / PAGE_SIZE);
  if (!physicalPages) throw new Error('数据库文件里没有完整页');

  const readPhysical = (i) => {
    const start = headerBytes + (i - 1) * PAGE_SIZE;
    return buffer.subarray(start, start + PAGE_SIZE);
  };

  // 第 1 页先解出来：既校验密钥对不对，也读出库页数
  const first = decryptPage(readPhysical(1), keys, 1, { verify });
  assertSqliteHeader(first);
  const pageSizeField = first.readUInt16BE(16);
  if (pageSizeField !== PAGE_SIZE) {
    throw new Error(`库的自报页大小是 ${pageSizeField}，与 ${PAGE_SIZE} 不符`);
  }
  const headerPages = dbPageCount(first) || physicalPages;
  const pages = new Map([[1, first]]);

  const strictUntil = Math.min(headerPages, physicalPages);
  for (let i = 2; i <= strictUntil; i += 1) {
    pages.set(i, decryptPage(readPhysical(i), keys, i, { verify }));
  }
  // 库外尾页：能解就解，解不动就当不存在（不抛错）
  for (let i = strictUntil + 1; i <= physicalPages; i += 1) {
    try {
      pages.set(i, decryptPage(readPhysical(i), keys, i, { verify: false }));
    } catch {
      /* 尾页不是库的一部分 */
    }
  }

  let finalPages = strictUntil;
  if (opts.wal && opts.wal.length) {
    const merged = applyWalFrames(pages, opts.wal, keys, { verify });
    if (merged.dbSize) finalPages = merged.dbSize;
  }
  if (finalPages > physicalPages && pages.size < finalPages) {
    throw new Error('WAL 声称的库比主库更大，缺少页数据');
  }

  const out = Buffer.alloc(finalPages * PAGE_SIZE);
  for (let i = 1; i <= finalPages; i += 1) {
    const plain = pages.get(i);
    // 只拷 SQLITE_USABLE 字节：解密出的 4048 字节末尾 32 字节是 SQLCipher 零填充，
    // 一并写进去会让 SQLite 认为页里有 32 字节碎片，查询时报 malformed。
    if (plain) plain.copy(out, (i - 1) * PAGE_SIZE, 0, Math.min(SQLITE_USABLE, plain.length));
  }
  // 页头里的「库页数」必须与最终页数一致，否则 SQLite 会认为末页越界（invalid page number）。
  if (out.length >= PAGE_SIZE) out.writeUInt32BE(finalPages, 28);
  return out;
}

/**
 * 合并 WAL：WAL 页与主库页同样加密；帧头 24 字节明文（pgno、dbSize、salt1、salt2、cksum1、cksum2）。
 * 只有「最后一个 dbSize 不为 0 的提交帧」之前的帧属于已提交事务，之后的帧可能是半截写入，必须丢弃。
 */
export function applyWalFrames(pages, wal, keys, opts = {}) {
  if (wal.length < 32) return { applied: 0, maxPage: 0, dbSize: 0 };
  const magic = wal.readUInt32BE(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) throw new Error('WAL 魔数不对');
  const walPageSize = wal.readUInt32BE(8) || PAGE_SIZE;
  if (walPageSize !== PAGE_SIZE) throw new Error(`WAL 页大小 ${walPageSize} 不支持`);

  const frameSize = 24 + PAGE_SIZE;
  const frameCount = Math.floor((wal.length - 32) / frameSize);
  const frames = [];
  let commitCount = 0;
  let commitDbSize = 0;
  for (let f = 0; f < frameCount; f += 1) {
    const off = 32 + f * frameSize;
    const pgno = wal.readUInt32BE(off);
    if (!pgno) break;
    const dbSize = wal.readUInt32BE(off + 4);
    frames.push({ pgno, dbSize, page: wal.subarray(off + 24, off + 24 + PAGE_SIZE) });
    if (dbSize) {
      commitCount = frames.length;
      commitDbSize = dbSize;
    }
  }

  let applied = 0;
  let maxPage = 0;
  for (let i = 0; i < commitCount; i += 1) {
    const { pgno, page } = frames[i];
    try {
      pages.set(pgno, decryptPage(page, keys, pgno, { verify: opts.verify !== false }));
      applied += 1;
      if (pgno > maxPage) maxPage = pgno;
    } catch (err) {
      // 提交帧解不开就是真的不对了
      throw err;
    }
  }
  return { applied, maxPage, dbSize: commitDbSize };
}

/**
 * 从消息体 Protobuf（列 40800）里抠出所有可读文本。
 * 不实现完整 schema：按 wire format 递归，收集 length-delimited 字段里的 UTF-8 文本段，
 * 同时干掉 QQ 的富文本控制字符。
 */
export function protoTexts(buf) {
  const out = [];
  const walk = (b, depth) => {
    if (depth > 6 || b.length < 2) return;
    let i = 0;
    while (i < b.length) {
      const tag = readVarint(b, i);
      if (!tag) return;
      i = tag.next;
      const field = tag.value >>> 3;
      const wire = tag.value & 7;
      if (wire === 0) {
        const v = readVarint(b, i);
        if (!v) return;
        i = v.next;
      } else if (wire === 1) {
        i += 8;
      } else if (wire === 5) {
        i += 4;
      } else if (wire === 2) {
        const len = readVarint(b, i);
        if (!len) return;
        i = len.next;
        const end = i + len.value;
        if (end > b.length) return;
        const chunk = b.subarray(i, end);
        const s = decodeText(chunk);
        if (s) out.push(s);
        else if (chunk.length > 4) walk(chunk, depth + 1);
        i = end;
      } else {
        return;
      }
    }
  };
  walk(buf, 0);
  return out;
}

function readVarint(b, start) {
  let value = 0;
  let shift = 0;
  let i = start;
  while (i < b.length && shift < 64) {
    const byte = b[i];
    value += (byte & 0x7f) * 2 ** shift;
    i += 1;
    if (!(byte & 0x80)) return { value, next: i };
    shift += 7;
  }
  return null;
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

function decodeText(chunk) {
  if (chunk.length < 2) return null;
  let str;
  try {
    str = new TextDecoder('utf-8', { fatal: true }).decode(chunk);
  } catch {
    return null;
  }
  const cleaned = str.replace(CONTROL_CHARS, '').trim();
  if (!cleaned) return null;
  const digits = cleaned.replace(/[^0-9]/g, '').length;
  if (digits === cleaned.length && cleaned.length <= 12) return null; // 纯数字多半是 id/时间戳
  return cleaned;
}

/** 用 node:sqlite 打开明文库（只读语义由调用方保证） */
export async function openPlain(path) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path, { readOnly: true });
}

export function tableColumns(db, table) {
  const rows = db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all();
  return rows.map((r) => String(r.name));
}

export function listTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => String(r.name));
}

/**
 * 读群消息。列名按 QQ 的字段号：40021=群号(字符串) 40030=群号(数值) 40033=发送者 40050=时间 40800=消息体。
 * @param {object} db node:sqlite DatabaseSync
 * @param {{groupIds?: (string|number)[], sinceTs?: number, limit?: number}} opts
 */
export function readGroupMessages(db, opts = {}) {
  const cols = tableColumns(db, 'group_msg_table');
  const has = (name) => cols.includes(name);
  const tsCol = has('40050') ? '40050' : null;
  const bodyCol = has('40800') ? '40800' : null;
  const groupText = has('40021') ? '"40021"' : null;
  const groupNum = has('40030') ? '"40030"' : null;
  if (!tsCol || !bodyCol) throw new Error('group_msg_table 缺少 40050/40800 列，库版本不符');

  const select = [
    has('40001') ? '"40001" AS msg_id' : 'rowid AS msg_id',
    groupText ? `${groupText} AS group_id` : 'NULL AS group_id',
    groupNum ? `${groupNum} AS group_no` : 'NULL AS group_no',
    has('40033') ? '"40033" AS sender' : 'NULL AS sender',
    `"${tsCol}" AS ts`,
    `"${bodyCol}" AS body`,
  ].join(', ');

  const where = [];
  const params = [];
  if (opts.sinceTs) {
    where.push(`"${tsCol}" >= ?`);
    params.push(opts.sinceTs);
  }
  if (Array.isArray(opts.groupIds) && opts.groupIds.length) {
    const ids = opts.groupIds.map((x) => String(x));
    const parts = [];
    if (groupText) {
      parts.push(`CAST("40021" AS TEXT) IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    if (groupNum) {
      parts.push(`CAST("40030" AS TEXT) IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    if (parts.length) where.push(`(${parts.join(' OR ')})`);
  }
  const limit = Math.max(1, Math.min(Number(opts.limit) || 500, 5000));
  const sql = `SELECT ${select} FROM group_msg_table${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY "40050" DESC LIMIT ${limit}`;
  const rows = db.prepare(sql).all(...params);
  return rows.map((r) => {
    const body = r.body ? Buffer.from(r.body) : Buffer.alloc(0);
    return {
      msgId: String(r.msg_id ?? ''),
      groupId: r.group_id == null ? '' : String(r.group_id),
      groupNo: r.group_no == null ? '' : String(r.group_no),
      sender: r.sender == null ? '' : String(r.sender),
      ts: Number(r.ts) || 0,
      text: protoTexts(body).join(' ').trim(),
    };
  });
}
