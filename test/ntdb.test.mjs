import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HMAC_SIZE,
  IV_SIZE,
  NT_HEADER_BYTES,
  PAGE_SIZE,
  RESERVE_SIZE,
  SQLITE_MAGIC,
  SQLITE_USABLE,
  USABLE_SIZE,
  decryptDatabaseBuffer,
  decryptPage,
  deriveKeys,
  encryptDatabaseBuffer,
  encryptPage,
  protoTexts,
} from '../lib/ntdb.js';

const KEY = 'ABCDEF0123456789'; // 16 字节 ASCII，形状同 QQ 真实密钥

function makePlainPage(pgno) {
  const buf = Buffer.alloc(USABLE_SIZE, pgno & 0xff);
  if (pgno === 1) {
    SQLITE_MAGIC.copy(buf, 0);
    buf.writeUInt16BE(PAGE_SIZE, 16);
    buf[20] = RESERVE_SIZE; // reserved bytes per page
    buf[21] = 64;
    buf[22] = 32;
    buf[23] = 32;
  }
  buf.writeUInt32BE(pgno, 40); // 页标记（避开头部 28..31 的库页数字段）
  return buf;
}

const SALT = Buffer.from('0123456789abcdef', 'utf8');

function buildEncrypted(pages, key) {
  return { file: encryptDatabaseBuffer({ pages, key, salt: SALT }), salt: SALT };
}

test('常量符合 SQLCipher 4 (+HMAC-SHA1) 的布局', () => {
  assert.equal(PAGE_SIZE, 4096);
  assert.equal(RESERVE_SIZE, 48);
  assert.equal(USABLE_SIZE, 4048); // 密文区长度
  assert.equal(SQLITE_USABLE, 4016); // 页内容真实可用长度（头部 reserved = 80）
  assert.equal(IV_SIZE + HMAC_SIZE, 36);
});

test('deriveKeys：加密密钥与 HMAC 密钥必须不同', () => {
  const salt = Buffer.alloc(16, 7);
  const keys = deriveKeys(KEY, salt);
  assert.equal(keys.encKey.length, 32);
  assert.equal(keys.hmacKey.length, 32);
  assert.notEqual(keys.encKey.toString('hex'), keys.hmacKey.toString('hex'));
  // 相同输入必须可复现
  assert.equal(deriveKeys(KEY, salt).encKey.toString('hex'), keys.encKey.toString('hex'));
  // 不同 salt 必须得到不同密钥
  assert.notEqual(deriveKeys(KEY, Buffer.alloc(16, 8)).encKey.toString('hex'), keys.encKey.toString('hex'));
});

test('单页加密/解密往返，第 1 页补回 SQLite magic', () => {
  const salt = Buffer.alloc(16, 3);
  const keys = deriveKeys(KEY, salt);
  const plain = makePlainPage(1);
  const page = encryptPage(plain, keys, 1, { salt });
  assert.equal(page.length, PAGE_SIZE);
  // 第 1 页前 16 字节是明文 salt 区（占位），密文从 16 开始
  const back = decryptPage(page, keys, 1);
  assert.equal(back.toString('hex'), plain.toString('hex'));
  assert.equal(back.subarray(0, 16).toString('latin1'), 'SQLite format 3\u0000');
});

test('HMAC 校验：改一个字节就必须失败', () => {
  const salt = Buffer.alloc(16, 4);
  const keys = deriveKeys(KEY, salt);
  const page = encryptPage(makePlainPage(2), keys, 2);
  page[100] ^= 0x01;
  assert.throws(() => decryptPage(page, keys, 2), /HMAC 校验失败/);
});

test('整库解密：多页往返，页号参与 HMAC（换页号即失败）', () => {
  const pages = [makePlainPage(1), makePlainPage(2), makePlainPage(3)];
  const { file } = buildEncrypted(pages, KEY);
  const out = decryptDatabaseBuffer({ buffer: file, key: KEY });
  assert.equal(out.length, pages.length * PAGE_SIZE);
  assert.equal(out.readUInt32BE(28), pages.length, '库页数必须与最终页数一致');
  pages.forEach((plain, i) => {
    const got = out.subarray(i * PAGE_SIZE, (i + 1) * PAGE_SIZE).subarray(0, SQLITE_USABLE);
    const expected = Buffer.from(plain.subarray(0, SQLITE_USABLE));
    if (i === 0) expected.writeUInt32BE(pages.length, 28); // 第 1 页头部会被写回真实库页数
    assert.equal(got.toString('hex'), expected.toString('hex'), `第 ${i + 1} 页内容不符`);
    // 保留区（每页最后 80 字节）必须是 0：写进 SQLCipher 的零填充会让 SQLite 报 malformed
    const reserved = out.subarray(i * PAGE_SIZE + SQLITE_USABLE, (i + 1) * PAGE_SIZE);
    assert.ok(reserved.every((b) => b === 0), `第 ${i + 1} 页保留区必须清零`);
  });

  // 把第 2 页与第 3 页对调 → 第 2 页 HMAC 必须失败
  const swapped = Buffer.from(file);
  const p2 = (NT_HEADER_BYTES + PAGE_SIZE);
  const p3 = (NT_HEADER_BYTES + 2 * PAGE_SIZE);
  file.copy(swapped, p2, p3, p3 + PAGE_SIZE);
  file.copy(swapped, p3, p2, p2 + PAGE_SIZE);
  assert.throws(() => decryptDatabaseBuffer({ buffer: swapped, key: KEY }), /HMAC 校验失败/);
});

test('整库解密：错误密钥必须报错而不是输出垃圾', () => {
  const { file } = buildEncrypted([makePlainPage(1), makePlainPage(2)], KEY);
  assert.throws(() => decryptDatabaseBuffer({ buffer: file, key: 'WRONGKEY12345678' }), /HMAC 校验失败|不是 SQLite 头/);
});

test('WAL：已提交帧覆盖主库页，未提交帧被忽略', () => {
  const salt = SALT;
  const keys = deriveKeys(KEY, salt);
  const pages = [makePlainPage(1), makePlainPage(2)];
  const dbFile = encryptDatabaseBuffer({ pages, key: KEY, salt });

  // 构造 WAL：1 帧已提交（把第 2 页改成 0xaa 填充），1 帧未提交（第 2 页改成 0xbb）
  const committed = Buffer.alloc(USABLE_SIZE, 0xaa);
  committed.writeUInt32BE(2, 30);
  const pending = Buffer.alloc(USABLE_SIZE, 0xbb);
  pending.writeUInt32BE(2, 30);
  const frames = [
    { pgno: 2, dbSize: pages.length, plain: committed },
    { pgno: 2, dbSize: 0, plain: pending },
  ];
  const walHead = Buffer.alloc(32);
  walHead.writeUInt32BE(0x377f0682, 0);
  walHead.writeUInt32BE(3007000, 4);
  walHead.writeUInt32BE(PAGE_SIZE, 8);
  const walFrames = frames.map((f) => {
    const fh = Buffer.alloc(24);
    fh.writeUInt32BE(f.pgno, 0);
    fh.writeUInt32BE(f.dbSize, 4);
    return Buffer.concat([fh, encryptPage(f.plain, keys, f.pgno)]);
  });
  const wal = Buffer.concat([walHead, ...walFrames]);

  const out = decryptDatabaseBuffer({ buffer: dbFile, key: KEY, wal });
  const page2 = out.subarray(PAGE_SIZE, 2 * PAGE_SIZE).subarray(0, SQLITE_USABLE);
  assert.equal(page2.toString('hex'), committed.subarray(0, SQLITE_USABLE).toString('hex'), '应使用已提交帧，忽略未提交帧');
  assert.equal(out.readUInt32BE(28), pages.length, 'WAL 提交帧的 dbSize 应写回库页数');
});

test('protoTexts：从嵌套 Protobuf 里抽出文本段', () => {
  const enc = (field, payload) => {
    const buf = [];
    let tag = field * 8 + 2;
    while (tag > 0x7f) {
      buf.push((tag & 0x7f) | 0x80);
      tag >>>= 7;
    }
    buf.push(tag);
    let len = payload.length;
    while (len > 0x7f) {
      buf.push((len & 0x7f) | 0x80);
      len >>>= 7;
    }
    buf.push(len);
    return Buffer.concat([Buffer.from(buf), payload]);
  };
  const text = enc(45101, Buffer.from('周五前交实验报告', 'utf8'));
  const outer = enc(40800, enc(45101, Buffer.from('群公告', 'utf8')));
  const joined = protoTexts(Buffer.concat([text, outer]));
  assert.ok(joined.includes('周五前交实验报告'));
  assert.ok(joined.includes('群公告'));
});

test('protoTexts：纯数字 ID 不当作文本', () => {
  const enc = (field, payload) => {
    let tag = field * 8 + 2;
    const head = [];
    while (tag > 0x7f) {
      head.push((tag & 0x7f) | 0x80);
      tag >>>= 7;
    }
    head.push(tag);
    head.push(payload.length);
    return Buffer.concat([Buffer.from(head), payload]);
  };
  const id = enc(45101, Buffer.from('123456789', 'utf8'));
  assert.equal(protoTexts(id).length, 0);
});
