import assert from 'node:assert/strict';
import test from 'node:test';

import { collectNews, formatNewsSection, pickNewsForDate, summarizeNews } from '../lib/news.js';

function fakeWeb(table) {
  return {
    async search({ query }) {
      return { sources: table[query] || [], truncated: false };
    },
  };
}

test('collectNews 过滤检索页/归档页/纯日期标题/无关旧闻，保留真新闻', async () => {
  const web = fakeWeb({
    '人工智能 重大突破 今天': [
      // 检索页（quark 之类）
      { url: 'https://m.quark.cn/s?q=AI', title: '夸克-新生代智能搜索' },
      // 归档页
      { url: 'https://www.qbitai.com/date/2025/09', title: '2025 年 9 月' },
      // 纯日期标题
      { url: 'https://example.com/news/1', title: '2025年 9月' },
      // 无关旧闻（没有话题词）
      { url: 'https://example.com/news/2', title: '某地气温骤降' },
      // 真新闻
      {
        url: 'https://www.itiger.com/hant/news/2678911080',
        title: 'OpenAI宣佈AI取得三項科學突破',
        snippet: 'AI 在数学、计算机科学和物理学领域取得重大突破',
      },
    ],
  });

  const result = await collectNews({ web, queries: ['人工智能 重大突破 今天'], maxItems: 3 });
  assert.equal(result.items.length, 1, '只应留下那条真新闻');
  assert.match(result.items[0].title, /OpenAI/);
  assert.equal(result.items[0].source, 'itiger.com');
  assert.deepEqual(result.errors, []);
});

test('collectNews 同一事件多家转载只留一条（标题前缀去重）', async () => {
  const web = fakeWeb({
    q1: [
      { url: 'https://a.example.com/1', title: 'OpenAI发布GPT-6.2模型' },
      { url: 'https://b.example.com/2', title: 'OpenAI发布GPT-6.2模型！' },
    ],
  });
  const result = await collectNews({ web, queries: ['q1'], maxItems: 3 });
  assert.equal(result.items.length, 1);
});

test('collectNews 尊重用户关注口径（isIgnored 命中即跳过）', async () => {
  const web = fakeWeb({
    q1: [{ url: 'https://a.example.com/1', title: 'AI 助力诗歌创作大赛', snippet: 'AI 诗歌' }],
  });
  const result = await collectNews({
    web,
    queries: ['q1'],
    maxItems: 3,
    isIgnored: (text) => text.includes('诗歌'),
  });
  assert.equal(result.items.length, 0);
});

test('collectNews 没有 web 服务时如实返回错误而不是抛异常', async () => {
  const result = await collectNews({ web: null, queries: ['q1'] });
  assert.equal(result.items.length, 0);
  assert.match(result.errors[0], /web\.search/);
});

test('formatNewsSection 把标题、来源、链接排成可直接推送的段落', () => {
  const text = formatNewsSection(
    [
      { title: 'OpenAI 取得科学突破', url: 'https://a.example.com/1', source: 'a.example.com' },
      { title: '国产 AI 制药突破', url: 'https://b.example.com/2', source: 'b.example.com' },
    ],
    '2026-11-21',
  );
  assert.match(text, /今日要闻（2026-11-21）/);
  assert.match(text, /· OpenAI 取得科学突破（a\.example\.com）/);
  assert.match(text, /https:\/\/b\.example\.com\/2/);
});

test('formatNewsSection 无条目时返回空字符串', () => {
  assert.equal(formatNewsSection([], '2026-11-21'), '');
  assert.equal(formatNewsSection(null, '2026-11-21'), '');
});

test('pickNewsForDate 只挑当天且 kind=news 的情报', () => {
  const intel = [
    { kind: 'news', date: '2026-11-21', title: '今天的 AI 新闻', url: 'https://a.example.com/1' },
    { kind: 'news', date: '2026-11-20', title: '昨天的 AI 新闻', url: 'https://a.example.com/2' },
    { kind: 'research', date: '2026-11-21', title: '薪资调研', url: 'https://a.example.com/3' },
  ];
  const picked = pickNewsForDate(intel, '2026-11-21');
  assert.equal(picked.length, 1);
  assert.match(picked[0].title, /今天的/);
});

test('summarizeNews 输出一行标题列表，便于记忆段拼接', () => {
  assert.equal(summarizeNews([{ title: 'A 突破' }, { title: 'B 发布' }], 2), 'A 突破；B 发布');
  assert.equal(summarizeNews([{ title: 'A 突破' }, { title: 'B 发布' }]), 'A 突破');
  assert.equal(summarizeNews([]), '');
});
