// 「今日要闻」：每天给用户抓 2~4 条真正值得知道的时事，附在推送正文的任务下面。
//
// 设计约束（都是被真实情况逼出来的）：
// - 只用宿主注入的 `web.search`，不自己发请求：插件运行在没有网络的进程里也能优雅降级。
// - 搜索服务偶尔只回链接、snippet 为空，所以标题即内容，宁短勿假装有摘要。
// - 结果必须去重、必须滤掉搜索页/聚合页/广告，否则推送里会出现「夸克搜索」这种噪音。
// - 关注口径（prefs.ignoreTopics）在这里也要生效：用户不想看文艺娱乐，就别推八卦新闻。

/**
 * 默认查询：偏科技/AI/教育政策——和「学业主线 + 升学/就业」相关，也覆盖用户说的「爆款时事」。
 * 想换成别的方向（比如某行业、某个考试），在 config.briefQueries 里传自己的查询词即可。
 */
export const DEFAULT_NEWS_QUERIES = [
  '人工智能 重大突破 今天',
  'AI 大模型 重要发布 科技新闻',
  '中国 科技 重大进展 教育',
];

/** 明显是搜索页 / 聚合页 / 广告的域名或路径，出现在推送里只会浪费眼睛。 */
const JUNK_HOSTS = [
  'quark.cn',
  'm.quark.cn',
  'baidu.com',
  'm.baidu.com',
  'sogou.com',
  'so.com',
  'bing.com',
  'google.com',
  'duckduckgo.com',
  'toutiao.com/search',
];

/** 标题里出现这些词，多半是软文/带货/星座运势，不是「轰动时事」。 */
const JUNK_TITLE_WORDS = [
  '优惠',
  '领券',
  '折扣',
  '下单',
  '直播预告',
  '招聘会预告',
  '星座',
  '运势',
  '图片大全',
  '免费下载',
];

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const ARCHIVE_PATH = /\/(date|tag|tags|category|archive|search|portal|list)(\/|$|\?)/i;

function isJunkUrl(url) {
  if (!url) return true;
  const host = hostOf(url);
  if (!host) return true;
  if (ARCHIVE_PATH.test(url)) return true;
  return JUNK_HOSTS.some((bad) => host === bad || host.endsWith(`.${bad}`) || url.includes(bad));
}

const DATE_ONLY = /^[\d\s年\-—\/.月日]+$/;
const DATE_PREFIX_ONLY = /^\d{4}\s*年(\s*\d{1,2}\s*月)?\s*$/;

function isJunkTitle(title) {
  if (!title) return true;
  const text = String(title).trim();
  if (text.length < 8) return true;
  if (DATE_ONLY.test(text) || DATE_PREFIX_ONLY.test(text)) return true;
  if (/^(首页|全部|更多|详情|上一页|下一页)$/.test(text)) return true;
  return JUNK_TITLE_WORDS.some((word) => text.includes(word));
}

/** 与「轰动时事」相关的话题词——标题或摘要里一个都没有的，多半是旧文/栏目页。 */
const TOPIC_WORDS = [
  'AI', '人工智能', '模型', '智能', '芯片', '算力', '机器人',
  '科技', '科学', '研究', '突破', '发布', '实验室', '算法',
  '量子', '航天', '新能源', '电池', '半导体', '工程', '产业',
  '教育', '高校', '政策', '制造',
];

function isTopical(title, snippet) {
  const text = `${title || ''} ${snippet || ''}`.toLowerCase();
  return TOPIC_WORDS.some((word) => text.includes(word.toLowerCase()));
}

/** 简单的稳定指纹，用来跨查询去重（同一事件常被多家转载，标题前缀高度相似）。 */
function titleKey(title) {
  return String(title)
    .replace(/[\s\p{P}]/gu, '')
    .slice(0, 18);
}

/**
 * 抓当天要闻。
 *
 * @param {object} params
 * @param {{search: Function}} params.web 宿主 web 服务（必须有 search）
 * @param {string[]} [params.queries] 覆盖默认查询
 * @param {number} [params.maxItems=3] 最多保留几条
 * @param {{ignoreTopics?: string[]}} [params.prefs] 关注口径
 * @param {number} [params.timeoutMs=15000] 单次查询超时
 * @param {(text: string) => boolean} [params.isIgnored] 判断一条文本是否属于「用户不想看的」
 * @returns {Promise<{items: Array<{title: string, url: string, source: string, snippet: string}>, queries: string[], errors: string[]}>}
 */
export async function collectNews({
  web,
  queries = DEFAULT_NEWS_QUERIES,
  maxItems = 3,
  prefs = {},
  timeoutMs = 15000,
  isIgnored,
} = {}) {
  const list = Array.isArray(queries) && queries.length ? queries.slice(0, 5) : DEFAULT_NEWS_QUERIES;
  const errors = [];
  const items = [];
  const seen = new Set();

  if (!web || typeof web.search !== 'function') {
    return { items: [], queries: list, errors: ['宿主没有可用的 web.search（联网能力不可用）'] };
  }

  const ignore = typeof isIgnored === 'function' ? isIgnored : () => false;
  const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;

  for (const query of list) {
    let result;
    try {
      result = await web.search({ query, maxResults: 5 }, signal);
    } catch (error) {
      errors.push(`「${query}」失败：${error?.message || String(error)}`);
      continue;
    }
    const sources = Array.isArray(result?.sources) ? result.sources : [];
    for (const src of sources) {
      const url = String(src?.url || '').trim();
      const title = String(src?.title || '').replace(/\s+/g, ' ').trim();
      const snippet = String(src?.snippet || src?.summary || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (isJunkUrl(url) || isJunkTitle(title)) continue;
      if (!isTopical(title, snippet)) continue;
      if (ignore(title)) continue;
      const key = titleKey(title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push({
        title,
        url,
        source: hostOf(url),
        snippet,
        publishedAt: src?.publishedAt ? String(src.publishedAt) : '',
        query,
      });
      if (items.length >= maxItems) break;
    }
    if (items.length >= maxItems) break;
  }

  // 全都来自同一个查询也没关系；但如果连一条实锤都没有，把错误如实带回去。
  return { items: items.slice(0, maxItems), queries: list, errors };
}

/**
 * 把要闻渲染成推送正文里的一段。
 *
 * 刻意保持紧凑：QQ 单条消息有长度上限（push.js 里 1800 字），要闻只是配角，
 * 每条一行标题 + 一行链接，三条大约 200 字。
 *
 * @param {Array<{title: string, url: string, source?: string}>} items
 * @param {string} [date] YYYY-MM-DD
 * @returns {string} 没有数据时返回空串（调用方据此决定不追加这一段）
 */
export function formatNewsSection(items, date = '') {
  const list = Array.isArray(items) ? items.filter((item) => item && item.title) : [];
  if (!list.length) return '';
  const head = date ? `今日要闻（${date}）` : '今日要闻';
  const lines = [head];
  for (const item of list) {
    const source = item.source ? `（${item.source}）` : '';
    lines.push(`· ${item.title}${source}`);
    if (item.url) lines.push(`  ${item.url}`);
  }
  return lines.join('\n');
}

/** 从情报库里挑出某天已存的要闻（用于白天补推时复用，不再重复联网）。 */
export function pickNewsForDate(intelItems, date) {
  if (!Array.isArray(intelItems) || !date) return [];
  return intelItems
    .filter((item) => item && item.kind === 'news' && String(item.date || item.createdAt || '').slice(0, 10) === date)
    .map((item) => ({ title: item.title, url: item.url, source: item.source || '', snippet: item.summary || '' }));
}

/** 给记忆段/面板用的一行摘要。 */
export function summarizeNews(items, limit = 1) {
  const list = Array.isArray(items) ? items.filter((item) => item && item.title) : [];
  if (!list.length) return '';
  return list.slice(0, Math.max(1, limit)).map((item) => item.title).join('；');
}
