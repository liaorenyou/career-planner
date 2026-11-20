/**
 * @local/career-planner —— 生涯规划插件（浏览器侧面板）
 *
 * 挂载方式：window.__ModuleLoader__.load({ id, factory(require) })。
 * factory 必须是纯函数（无副作用），React 通过 require('react') 取得，
 * 不 import 任何其他模块、不引用任何外部资源。
 *
 * 数据通道（同源）：
 *   GET  /career-planner/api/state?date=YYYY-MM-DD  -> { ok:true, data: State }
 *   POST /career-planner/api/act  body { action, ... } -> { ok:true, data: State }
 *
 * 只使用 --dsw-alias-* 主题 token，颜色不写死；图标用 currentColor。
 */
window.__ModuleLoader__.load({
  id: '@local/career-planner',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // ------------------------------------------------------------------
    // 文案（全部中文集中在这里；格式化函数也放进来，避免散落硬编码）
    // ------------------------------------------------------------------
    const T = {
      title: '生涯规划',
      loading: '正在加载今日计划…',
      busy: '处理中…',
      errorTitle: '宿主接口不可达',
      errorHint: '请确认 DSH 宿主已加载 career-planner 插件，然后重试。',
      renderFail: '面板渲染出错，已捕获以避免白屏。',
      detailPrefix: '详情：',
      retry: '重试',
      refresh: '刷新',
      regenerate: '重新生成',
      regenerateBusy: '生成中…',
      pushNow: '立即推送',
      pushBusy: '推送中…',
      pushSettings: '推送设置',
      pushSettingsTitle: '推送设置',
      todayFocus: '今日重点',
      noFocus: '还没有生成今天的方向，点「重新生成」试试。',
      themeLabel: '主攻方向',
      capacity: '容量进度',
      capacityValue: (planned, capacity) => `已排 ${planned} / ${capacity} 分钟`,
      overCapacity: '已超出今日容量，未排入的任务见待办列表。',
      timeline: '时间轴',
      timelineCount: (total, done) => `共 ${total} 项 · 已完成 ${done}`,
      blockDone: '标记完成',
      blockUndone: '标记未完成',
      whyPrefix: '理由：',
      outputPrefix: '产出：',
      minutes: '分钟',
      warnings: '提醒',
      tasks: '待办任务',
      tasksCount: (n) => `${n} 项待办`,
      tasksEmpty: '暂无待办任务。',
      taskDone: '标记完成',
      taskUndone: '标记未完成',
      goals: '目标',
      goalsEmpty: '还没有设定目标，去对话里跟助理说说你的规划。',
      goalCount: (n) => `${n} 个`,
      targetDate: '目标日期',
      noTargetDate: '未设日期',
      daysLeft: (n) => `还有 ${n} 天`,
      daysToday: '就是今天',
      daysPast: (n) => `已过 ${n} 天`,
      priority: '优先级 ',
      intel: '联网情报',
      intelEmpty: '暂无联网情报。',
      intelCount: (n) => `${n} 条`,
      intelUntitled: '未命名情报',
      pushStatus: '推送状态',
      pushOn: '已开启',
      pushOff: '已关闭',
      pushTime: '推送时间',
      pushChannels: '推送渠道',
      pushEnabled: '启用每日推送',
      pushLast: '上次推送',
      pushNever: '从未推送',
      pushResult: '上次结果',
      pushResultOk: '成功',
      pushResultFail: '失败',
      bound: '已绑定',
      unbound: '未绑定',
      channelQQ: 'QQ',
      channelWeChat: '微信',
      channelNone: '未配置',
      channelRequired: '请至少选择一个推送渠道。',
      pushSave: '保存设置',
      saving: '保存中…',
      cancel: '取消',
      emptyTitle: '还没有今天的计划',
      emptyHint: '去对话里跟助理说：',
      emptyQuote: '「帮我录入这学期的课表」',
      emptyTaskHint: '助理会把课程、作业和截止时间排进时间轴。',
      actFail: '操作失败',
      apiFail: '接口返回异常',
      netFail: '网络请求失败',
      streak: '连续天数',
      doneTodayLabel: '今日完成',
      overdueLabel: '逾期',
      daysUnit: '天',
      duePrefix: '截止 ',
      startPrefix: '开始 ',
      estPrefix: '预计 ',
      weekdays: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
      goalKind: { postgrad: '考研', job: '求职', exam: '考试', abroad: '留学', skill: '技能', other: '其他' },
      taskKind: { course: '课程', homework: '作业', exam: '考试', practice: '练习', application: '投递', research: '调研', reading: '阅读', other: '其他' },
      blockKind: { course: '课程', study: '学习', homework: '作业', practice: '练习', application: '投递', research: '调研', review: '复习', exercise: '运动', buffer: '缓冲', break: '休息', ritual: '仪式' },
    };

    // ------------------------------------------------------------------
    // 纯工具函数
    // ------------------------------------------------------------------
    function pad2(n) {
      return n < 10 ? '0' + n : '' + n;
    }

    function todayKey() {
      const d = new Date();
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    // 按本地时区解析 YYYY-MM-DD，避免 new Date('YYYY-MM-DD') 的 UTC 偏移。
    function parseDateKey(key) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key == null ? '' : key).trim());
      if (!m) return null;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return isNaN(d.getTime()) ? null : d;
    }

    function fmtDateCn(key) {
      const d = parseDateKey(key);
      if (!d) return typeof key === 'string' ? key : '';
      return d.getMonth() + 1 + '月' + d.getDate() + '日 ' + T.weekdays[d.getDay()];
    }

    function fmtDateTime(value) {
      if (value === null || value === undefined || value === '') return '';
      const d = value instanceof Date ? value : new Date(value);
      if (isNaN(d.getTime())) return '';
      return d.getMonth() + 1 + '月' + d.getDate() + '日 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    function clockMinutes(value) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(value == null ? '' : value).trim());
      if (!m) return null;
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      if (hh > 23 || mm > 59) return null;
      return hh * 60 + mm;
    }

    // 时间统一显示成 HH:MM。
    function fmtClock(value) {
      const m = /^(\d{1,2}):(\d{2})/.exec(String(value == null ? '' : value).trim());
      if (!m) return '';
      return pad2(Number(m[1])) + ':' + m[2];
    }

    function normaliseTime(value) {
      const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value == null ? '' : value).trim());
      return m ? m[1] + ':' + m[2] : '';
    }

    function truncate(text, max) {
      const s = String(text);
      if (s.length <= max) return s;
      return s.slice(0, Math.max(0, max - 1)) + '…';
    }

    function errText(err) {
      if (!err) return T.netFail;
      if (typeof err === 'string') return err;
      if (typeof err.message === 'string' && err.message) return err.message;
      return T.netFail;
    }

    function num(value) {
      const n = Number(value);
      return isFinite(n) ? n : 0;
    }

    function labelOf(map, kind) {
      if (typeof kind === 'string' && Object.prototype.hasOwnProperty.call(map, kind)) return map[kind];
      return map.other;
    }

    function blockKindLabel(kind) {
      return labelOf(T.blockKind, kind);
    }

    function taskKindLabel(kind) {
      return labelOf(T.taskKind, kind);
    }

    function goalKindLabel(kind) {
      return labelOf(T.goalKind, kind);
    }

    function blockMinutes(block) {
      if (!block || typeof block !== 'object') return 0;
      const n = Number(block.minutes);
      if (isFinite(n) && n > 0) return Math.round(n);
      const start = clockMinutes(block.start);
      const end = clockMinutes(block.end);
      if (start !== null && end !== null && end > start) return end - start;
      return 0;
    }

    function plannedMinutes(plan) {
      if (!plan || typeof plan !== 'object') return 0;
      const total = Number(plan.totalMinutes);
      if (isFinite(total)) return Math.round(total);
      const blocks = Array.isArray(plan.blocks) ? plan.blocks : [];
      return blocks.reduce(function (sum, block) {
        if (!block || block.kind === 'buffer' || block.kind === 'break') return sum;
        return sum + blockMinutes(block);
      }, 0);
    }

    function capacityFor(profile, dateKey) {
      const constraints = (profile && profile.constraints) || {};
      const date = parseDateKey(dateKey) || new Date();
      const weekdayMinutes = constraints.weekdayMinutes;
      let minutes = NaN;
      if (weekdayMinutes && typeof weekdayMinutes === 'object') {
        minutes = Number(weekdayMinutes[String(date.getDay())]);
      }
      if (isFinite(minutes) && minutes > 0) return minutes;
      const daily = Number(constraints.dailyMinutes);
      if (isFinite(daily) && daily > 0) return daily;
      return 180;
    }

    function goalCountdown(goal, baseKey) {
      const target = parseDateKey(goal && goal.targetDate);
      if (!target) return { text: T.noTargetDate, past: false };
      const base = parseDateKey(baseKey) || new Date();
      const days = Math.round((target.getTime() - base.getTime()) / 86400000);
      if (days > 0) return { text: T.daysLeft(days), past: false };
      if (days === 0) return { text: T.daysToday, past: false };
      return { text: T.daysPast(-days), past: true };
    }

    function isOverdueTask(task) {
      if (!task || task.status === 'done' || task.status === 'skipped') return false;
      if (!task.dueAt) return false;
      const due = new Date(task.dueAt);
      return !isNaN(due.getTime()) && due.getTime() < Date.now();
    }

    function dueText(task) {
      if (!task || typeof task !== 'object') return '';
      if (task.dueAt) {
        const due = new Date(task.dueAt);
        if (!isNaN(due.getTime())) return T.duePrefix + fmtDateTime(due);
      }
      if (task.startAt && task.endAt) {
        return fmtClock(task.startAt) + '–' + fmtClock(task.endAt);
      }
      if (task.startAt) {
        const start = new Date(task.startAt);
        if (!isNaN(start.getTime())) return T.startPrefix + fmtDateTime(start);
      }
      const est = Number(task.estMinutes);
      if (isFinite(est) && est > 0) return T.estPrefix + Math.round(est) + ' ' + T.minutes;
      return '';
    }

    function taskSortTime(task) {
      if (!task) return Number.MAX_SAFE_INTEGER;
      const raw = task.dueAt || task.startAt;
      const d = raw ? new Date(raw) : null;
      return d && !isNaN(d.getTime()) ? d.getTime() : Number.MAX_SAFE_INTEGER;
    }

    function compareTask(a, b) {
      const aDone = a && a.status === 'done' ? 1 : 0;
      const bDone = b && b.status === 'done' ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      const at = taskSortTime(a);
      const bt = taskSortTime(b);
      if (at !== bt) return at - bt;
      const ap = Number(a && a.priority) || 3;
      const bp = Number(b && b.priority) || 3;
      if (ap !== bp) return ap - bp;
      return String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
    }

    function groupTasks(tasks) {
      const order = ['course', 'homework', 'exam', 'practice', 'application', 'research', 'reading', 'other'];
      const buckets = {};
      (Array.isArray(tasks) ? tasks : []).forEach(function (task) {
        if (!task || typeof task !== 'object') return;
        const kind = order.indexOf(task.kind) >= 0 ? task.kind : 'other';
        if (!buckets[kind]) buckets[kind] = [];
        buckets[kind].push(task);
      });
      return order.filter(function (kind) {
        return !!(buckets[kind] && buckets[kind].length);
      }).map(function (kind) {
        return { kind: kind, items: buckets[kind].slice().sort(compareTask) };
      });
    }

    function channelsText(channels) {
      if (!Array.isArray(channels) || channels.length === 0) return T.channelNone;
      return channels.map(function (channel) {
        if (channel === 'qq') return T.channelQQ;
        if (channel === 'wechat') return T.channelWeChat;
        return String(channel);
      }).join('、');
    }

    function pushResultText(result) {
      if (!result || typeof result !== 'object') return '';
      const rows = Array.isArray(result) ? result : (Array.isArray(result.results) ? result.results : [result]);
      const parts = [];
      rows.forEach(function (row) {
        if (!row || typeof row !== 'object') return;
        const channel = row.channel === 'qq' ? T.channelQQ : row.channel === 'wechat' ? T.channelWeChat : (typeof row.channel === 'string' ? row.channel : '');
        const okText = row.ok === true ? T.pushResultOk : row.ok === false ? T.pushResultFail : '';
        const detail = typeof row.detail === 'string' && row.detail ? '（' + truncate(row.detail, 60) + '）' : '';
        const text = channel + okText + detail;
        if (text) parts.push(text);
      });
      return parts.join('；');
    }

    function unwrap(json) {
      if (json && json.ok === true && json.data && typeof json.data === 'object') return json.data;
      const reason = json && (json.error || json.message);
      throw new Error(reason ? String(reason) : T.apiFail);
    }

    function readJsonSafe(response) {
      return response.json().catch(function () {
        return null;
      });
    }

    // ------------------------------------------------------------------
    // HTTP：同源接口（路径都必须以 /career-planner/api/ 开头）
    // ------------------------------------------------------------------
    async function apiGetState(date) {
      const response = await fetch('/career-planner/api/state?date=' + encodeURIComponent(String(date || todayKey())), {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      const json = await readJsonSafe(response);
      if (!response.ok) {
        const reason = json && (json.error || json.message);
        throw new Error('HTTP ' + response.status + (reason ? '：' + reason : ''));
      }
      return unwrap(json);
    }

    async function apiAct(payload) {
      const response = await fetch('/career-planner/api/act', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload || {}),
      });
      const json = await readJsonSafe(response);
      if (!response.ok) {
        const reason = json && (json.error || json.message);
        throw new Error('HTTP ' + response.status + (reason ? '：' + reason : ''));
      }
      return unwrap(json);
    }

    // ------------------------------------------------------------------
    // 样式：只用 --dsw-alias-* token，类名统一 cp- 前缀
    // ------------------------------------------------------------------
    const CSS = `
.cp-root {
  display: flex;
  flex-direction: column;
  gap: 16px;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 100%;
  padding: 20px 22px 28px;
  overflow-y: auto;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
}
.cp-header { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px 16px; }
.cp-headline { flex: 1 1 300px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.cp-title { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 18px; font-weight: 600; }
.cp-theme { padding: 1px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-brand-primary); font-size: 11px; font-weight: 500; white-space: nowrap; }
.cp-date { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.cp-focus { font-size: 13px; word-break: break-word; }
.cp-focus-label { color: var(--dsw-alias-label-secondary); }
.cp-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.cp-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 6px 12px; font-family: inherit; font-size: 12px; line-height: 1.4; cursor: pointer; transition: background .15s ease, border-color .15s ease; }
.cp-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.cp-btn:disabled { opacity: .55; cursor: not-allowed; }
.cp-btn-primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); font-weight: 600; }
.cp-btn.cp-is-active { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.cp-capacity { display: flex; flex-direction: column; gap: 6px; }
.cp-capacity-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; font-size: 12px; }
.cp-progress { height: 8px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.cp-progress-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); transition: width .2s ease; }
.cp-progress-fill.cp-is-over { background: var(--dsw-alias-state-warn-primary); }
.cp-warn-text { color: var(--dsw-alias-state-warn-primary); font-size: 11px; }
.cp-notice { border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 8px; padding: 8px 10px; color: var(--dsw-alias-state-error-primary); font-size: 12px; word-break: break-word; }
.cp-grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start; }
.cp-main-col, .cp-side-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.cp-card { display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.cp-card-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; font-weight: 600; }
.cp-card-title .cp-muted { font-weight: 400; font-size: 11px; }
.cp-warn-card { border-color: var(--dsw-alias-state-warn-primary); }
.cp-muted { color: var(--dsw-alias-label-secondary); }
.cp-busy { font-size: 12px; }
.cp-timeline { display: flex; flex-direction: column; gap: 2px; }
.cp-block { display: grid; grid-template-columns: 104px minmax(0, 1fr) auto; gap: 10px; padding: 8px; border-radius: 8px; }
.cp-block:hover { background: var(--dsw-alias-bg-layer-2); }
.cp-block-time { padding-top: 1px; color: var(--dsw-alias-label-secondary); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.cp-block-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.cp-block-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.cp-block-title { font-weight: 600; word-break: break-word; }
.cp-block.cp-is-done .cp-block-title { color: var(--dsw-alias-label-secondary); text-decoration: line-through; }
.cp-block-min { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.cp-why, .cp-output { color: var(--dsw-alias-label-secondary); font-size: 12px; word-break: break-word; }
.cp-output { font-size: 11px; }
.cp-check { display: flex; align-items: flex-start; padding-top: 2px; cursor: pointer; }
.cp-check input { width: 16px; height: 16px; margin: 0; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
.cp-check input:disabled { cursor: not-allowed; }
.cp-badge { display: inline-flex; align-items: center; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 18px; white-space: nowrap; }
.cp-badge-brand { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-brand-primary); }
.cp-badge-ok { border-color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-state-success-primary); }
.cp-badge-idle { border-color: var(--dsw-alias-state-idle-primary); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-state-idle-primary); }
.cp-badge-warn { border-color: var(--dsw-alias-state-warn-primary); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-state-warn-primary); }
.cp-list { display: flex; flex-direction: column; gap: 2px; margin: 0; padding-left: 18px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.cp-task-groups { display: flex; flex-direction: column; gap: 6px; }
.cp-group-title { margin-top: 2px; color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 500; }
.cp-task { display: flex; align-items: flex-start; gap: 8px; padding: 5px 6px; border-radius: 8px; }
.cp-task:hover { background: var(--dsw-alias-bg-layer-2); }
.cp-task-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.cp-task-title { font-size: 12px; font-weight: 500; word-break: break-word; }
.cp-task.cp-is-done .cp-task-title { color: var(--dsw-alias-label-secondary); text-decoration: line-through; }
.cp-task-meta { display: flex; flex-wrap: wrap; gap: 4px 6px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.cp-chip-sm { display: inline-flex; align-items: center; padding: 0 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); font-size: 10px; line-height: 16px; white-space: nowrap; }
.cp-chip-sm.cp-is-overdue { color: var(--dsw-alias-state-error-primary); }
.cp-goals { display: flex; flex-direction: column; gap: 8px; }
.cp-goal { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; }
.cp-goal-top { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.cp-goal-priority { font-size: 11px; }
.cp-goal-count { margin-left: auto; color: var(--dsw-alias-brand-primary); font-size: 12px; font-weight: 600; white-space: nowrap; }
.cp-goal-count.cp-is-past { color: var(--dsw-alias-state-warn-primary); }
.cp-goal-title { font-size: 13px; font-weight: 600; word-break: break-word; }
.cp-goal-target, .cp-goal-date { font-size: 11px; }
.cp-intel-list { display: flex; flex-direction: column; }
.cp-intel-item { display: flex; flex-direction: column; gap: 2px; padding: 7px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.cp-intel-item:first-child { padding-top: 0; border-top: 0; }
.cp-intel-title { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; font-size: 12px; font-weight: 500; }
.cp-link { color: var(--dsw-alias-brand-primary); text-decoration: none; word-break: break-word; }
.cp-link:hover { text-decoration: underline; }
.cp-intel-summary { font-size: 11px; word-break: break-word; }
.cp-intel-meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: 10px; }
.cp-push-rows { display: flex; flex-direction: column; gap: 4px; }
.cp-info-row { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; }
.cp-info-label { flex: none; color: var(--dsw-alias-label-secondary); }
.cp-info-value { text-align: right; word-break: break-word; }
.cp-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 14px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.cp-empty-sm { padding: 10px; }
.cp-empty-title { color: var(--dsw-alias-label-primary); font-weight: 600; }
.cp-empty-quote { color: var(--dsw-alias-brand-primary); font-weight: 600; }
.cp-empty-hint { font-size: 11px; }
.cp-settings { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 14px; }
.cp-field { display: flex; flex-direction: column; gap: 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.cp-field-inline { flex-direction: row; align-items: center; gap: 8px; padding-bottom: 4px; }
.cp-field input[type="time"] { appearance: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 3px 6px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 12px; }
.cp-chip-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.cp-checkbox-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; }
.cp-checkbox-chip input { margin: 0; accent-color: var(--dsw-alias-brand-primary); }
.cp-settings-actions { display: flex; gap: 8px; }
.cp-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.cp-stat { display: flex; flex-direction: column; gap: 2px; padding: 10px 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.cp-stat-value { font-size: 20px; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; }
.cp-stat-value.cp-is-warn { color: var(--dsw-alias-state-error-primary); }
.cp-stat-unit { margin-left: 2px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.cp-stat-label { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.cp-loading { display: flex; align-items: center; gap: 10px; padding: 32px 8px; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.cp-spinner { width: 14px; height: 14px; border: 2px solid var(--dsw-alias-border-l1); border-top-color: var(--dsw-alias-brand-primary); border-radius: 50%; animation: cp-spin .8s linear infinite; }
.cp-error { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; max-width: 480px; margin: 48px auto; padding: 24px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.cp-error-title { font-size: 16px; font-weight: 600; color: var(--dsw-alias-state-error-primary); }
.cp-error-detail { color: var(--dsw-alias-label-secondary); font-size: 12px; word-break: break-word; }
@keyframes cp-spin { to { transform: rotate(360deg); } }
@media (max-width: 900px) { .cp-grid { grid-template-columns: minmax(0, 1fr); } }
`;

    // ------------------------------------------------------------------
    // 侧边栏图标：24×24 内联 SVG，原创「上升台阶 + 目标旗」几何图形
    // ------------------------------------------------------------------
    const BADGE_ACCENT = {
      practice: ' cp-badge-brand',
      application: ' cp-badge-brand',
      research: ' cp-badge-brand',
      exercise: ' cp-badge-brand',
      review: ' cp-badge-idle',
      buffer: ' cp-badge-idle',
      break: ' cp-badge-idle',
    };

    function CareerIcon(props) {
      return h(
        'svg',
        {
          width: 24,
          height: 24,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          ...(props && typeof props.style === 'object' ? { style: props.style } : null),
        },
        h('path', {
          d: 'M4 20V16h4.5v-4h4.5V8h4.5V4',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 4, cy: 20, r: 1.5, fill: 'currentColor' }),
        h('circle', { cx: 8.5, cy: 16, r: 1.5, fill: 'currentColor' }),
        h('circle', { cx: 13, cy: 12, r: 1.5, fill: 'currentColor' }),
        h('circle', { cx: 17.5, cy: 8, r: 1.5, fill: 'currentColor' }),
        h('path', {
          d: 'M17.5 8V2.5',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M17.5 2.5h4.6l-1.4 1.6 1.4 1.6h-4.6',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        })
      );
    }

    // ------------------------------------------------------------------
    // 错误边界：任何渲染异常都不许白屏
    // ------------------------------------------------------------------
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false, message: '' };
        this.reset = this.reset.bind(this);
      }

      static getDerivedStateFromError(err) {
        return { failed: true, message: errText(err) };
      }

      componentDidCatch() {
        // 出错信息已经展示在错误态里，这里不再向上抛。
      }

      reset() {
        this.setState({ failed: false, message: '' });
      }

      render() {
        if (this.state.failed) {
          return h(
            'div',
            { className: 'cp-root' },
            h('style', { key: 'cp-style' }, CSS),
            h(
              'div',
              { className: 'cp-error' },
              h('div', { className: 'cp-error-title' }, T.errorTitle),
              h('div', { className: 'cp-error-detail' }, T.renderFail),
              this.state.message ? h('div', { className: 'cp-error-detail' }, T.detailPrefix + this.state.message) : null,
              h('button', { type: 'button', className: 'cp-btn cp-btn-primary', onClick: this.reset }, T.retry)
            )
          );
        }
        return this.props.children;
      }
    }

    // ------------------------------------------------------------------
    // 面板主体
    // ------------------------------------------------------------------
    function CareerPanel() {
      return h(PanelBoundary, null, h(PanelInner));
    }

    function PanelInner() {
      const [phase, setPhase] = React.useState('loading');
      const [dataState, setDataState] = React.useState(null);
      const [errorText, setErrorText] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [notice, setNotice] = React.useState(null);
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const [form, setForm] = React.useState(null);

      const today = todayKey();
      const data = dataState;
      const date = data && typeof data.date === 'string' && data.date ? data.date : today;
      const baseKey = data && typeof data.today === 'string' && data.today ? data.today : today;

      // 只在组件挂载时拉一次；其余靠显式按钮刷新，不做轮询。
      React.useEffect(function () {
        let alive = true;
        (async function () {
          try {
            const next = await apiGetState(todayKey());
            if (!alive) return;
            setDataState(next);
            setPhase('ready');
            setErrorText('');
          } catch (err) {
            if (!alive) return;
            setErrorText(errText(err));
            setPhase('error');
          }
        })();
        return function () {
          alive = false;
        };
      }, []);

      function applyJson(json) {
        const next = unwrap(json);
        setDataState(next);
        setPhase('ready');
        setErrorText('');
        setNotice(null);
        return next;
      }

      function reportError(err) {
        const message = errText(err);
        if (dataState) {
          setNotice({ text: T.actFail + '：' + message });
        } else {
          setErrorText(message);
          setPhase('error');
        }
      }

      async function refresh() {
        if (busy) return false;
        setBusy('refresh');
        setNotice(null);
        try {
          applyJson(await apiGetState(date));
          return true;
        } catch (err) {
          reportError(err);
          return false;
        } finally {
          setBusy('');
        }
      }

      async function act(payload, label) {
        if (busy) return false;
        setBusy(label || 'act');
        setNotice(null);
        try {
          applyJson(await apiAct(payload));
          return true;
        } catch (err) {
          reportError(err);
          return false;
        } finally {
          setBusy('');
        }
      }

      function regenerate() {
        act({ action: 'regenerate', date: date }, 'regenerate');
      }

      function pushNow() {
        act({ action: 'pushNow' }, 'push');
      }

      function toggleBlock(block) {
        if (!block || typeof block.id !== 'string' || !block.id) return;
        act({ action: 'toggleBlock', date: date, blockId: block.id }, 'block:' + block.id);
      }

      function toggleTask(task) {
        if (!task || somethingEmpty(task.id)) return;
        act({ action: 'toggleTask', taskId: String(task.id) }, 'task:' + String(task.id));
      }

      function toggleSettings() {
        if (settingsOpen) {
          setSettingsOpen(false);
          setForm(null);
          return;
        }
        const push = (data && data.push) || {};
        let channels = Array.isArray(push.channels) ? push.channels.filter(function (channel) {
          return channel === 'qq' || channel === 'wechat';
        }) : [];
        if (channels.length === 0) channels = ['qq', 'wechat'];
        setForm({
          enabled: push.enabled !== false,
          time: normaliseTime(push.time) || '08:00',
          channels: channels,
        });
        setSettingsOpen(true);
      }

      function closeSettings() {
        setSettingsOpen(false);
        setForm(null);
      }

      function updateForm(patch) {
        setForm(function (prev) {
          if (!prev) return prev;
          return Object.assign({}, prev, patch);
        });
      }

      function toggleChannel(channel) {
        setForm(function (prev) {
          if (!prev) return prev;
          const has = prev.channels.indexOf(channel) >= 0;
          const channels = has ? prev.channels.filter(function (c) { return c !== channel; }) : prev.channels.concat([channel]);
          return Object.assign({}, prev, { channels: channels });
        });
      }

      async function saveSettings() {
        if (!form) return;
        const ok = await act({
          action: 'savePush',
          enabled: !!form.enabled,
          time: normaliseTime(form.time) || '08:00',
          channels: form.channels.slice(),
        }, 'savePush');
        if (ok) closeSettings();
      }

      // ---------------- 加载 / 错误态 ----------------
      if (phase === 'loading') {
        return h(
          'div',
          { className: 'cp-root' },
          h('style', { key: 'cp-style' }, CSS),
          h('div', { className: 'cp-loading' },
            h('span', { className: 'cp-spinner' }),
            h('span', null, T.loading)
          )
        );
      }

      if (phase === 'error' || !data) {
        return h(
          'div',
          { className: 'cp-root' },
          h('style', { key: 'cp-style' }, CSS),
          h(
            'div',
            { className: 'cp-error' },
            h('div', { className: 'cp-error-title' }, T.errorTitle),
            h('div', { className: 'cp-error-detail' }, T.errorHint),
            errorText ? h('div', { className: 'cp-error-detail' }, T.detailPrefix + errorText) : null,
            h(
              'button',
              { type: 'button', className: 'cp-btn cp-btn-primary', disabled: !!busy, onClick: refresh },
              busy ? T.busy : T.retry
            )
          )
        );
      }

      // ---------------- 派生数据 ----------------
      const profile = data.profile && typeof data.profile === 'object' ? data.profile : {};
      const plan = data.plan && typeof data.plan === 'object' ? data.plan : null;
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      const goals = Array.isArray(profile.goals) ? profile.goals : [];
      const intel = Array.isArray(data.intel) ? data.intel : [];
      const push = data.push && typeof data.push === 'object' ? data.push : {};
      const stats = data.stats && typeof data.stats === 'object' ? data.stats : {};
      const blocks = plan && Array.isArray(plan.blocks) ? plan.blocks : [];
      const warnings = plan && Array.isArray(plan.warnings) ? plan.warnings : [];
      const doneBlocks = blocks.filter(function (block) { return !!(block && block.done); }).length;
      const capacity = plan && plan.load && isFinite(Number(plan.load.capacity))
        ? Math.max(0, Number(plan.load.capacity))
        : capacityFor(profile, date);
      const planned = plan && plan.load && isFinite(Number(plan.load.planned))
        ? Math.max(0, Number(plan.load.planned))
        : plannedMinutes(plan);
      const overCapacity = capacity > 0 && planned > capacity;
      const percent = capacity > 0 ? Math.min(100, Math.round((planned / capacity) * 100)) : 0;
      const taskGroups = groupTasks(tasks);
      const openTasks = tasks.filter(function (task) { return task && task.status !== 'done'; }).length;
      const pushRows = [
        { key: 'time', label: T.pushTime, value: normaliseTime(push.time) || '—' },
        { key: 'channels', label: T.pushChannels, value: channelsText(push.channels) },
        { key: 'last', label: T.pushLast, value: push.lastPushAt ? fmtDateTime(push.lastPushAt) : T.pushNever },
      ];
      const pushResult = pushResultText(push.lastResult);
      if (pushResult) pushRows.push({ key: 'result', label: T.pushResult, value: pushResult });
      const targets = push.targets && typeof push.targets === 'object' ? push.targets : {};
      if (targets.qq) pushRows.push({ key: 'qq', label: T.channelQQ, value: targets.qq.known ? T.bound : T.unbound });
      if (targets.wechat) pushRows.push({ key: 'wechat', label: T.channelWeChat, value: targets.wechat.bound ? T.bound : T.unbound });

      // ---------------- 子渲染 ----------------
      function renderBlock(block, index) {
        if (!block || typeof block !== 'object') return null;
        const done = !!block.done;
        const id = typeof block.id === 'string' ? block.id : '';
        const minutes = blockMinutes(block);
        const kind = typeof block.kind === 'string' ? block.kind : 'other';
        return h(
          'div',
          { className: 'cp-block' + (done ? ' cp-is-done' : ''), key: id || 'block-' + index },
          h('div', { className: 'cp-block-time' }, fmtClock(block.start) + '–' + fmtClock(block.end)),
          h(
            'div',
            { className: 'cp-block-main' },
            h(
              'div',
              { className: 'cp-block-head' },
              h('span', { className: 'cp-block-title' }, String(block.title || '')),
              h('span', { className: 'cp-badge' + (BADGE_ACCENT[kind] || '') }, blockKindLabel(kind)),
              minutes ? h('span', { className: 'cp-block-min' }, minutes + ' ' + T.minutes) : null
            ),
            block.why ? h('div', { className: 'cp-why' }, T.whyPrefix + String(block.why)) : null,
            block.output ? h('div', { className: 'cp-output' }, T.outputPrefix + String(block.output)) : null
          ),
          h(
            'label',
            { className: 'cp-check', title: done ? T.blockUndone : T.blockDone },
            h('input', {
              type: 'checkbox',
              checked: done,
              disabled: !!busy,
              onChange: function () { toggleBlock(block); },
              'aria-label': (done ? T.blockUndone : T.blockDone) + '：' + String(block.title || ''),
            })
          )
        );
      }

      function renderTask(task, index) {
        if (!task || typeof task !== 'object') return null;
        const done = task.status === 'done';
        const overdue = isOverdueTask(task);
        const due = dueText(task);
        return h(
          'div',
          { className: 'cp-task' + (done ? ' cp-is-done' : ''), key: task.id || 'task-' + index },
          h(
            'label',
            { className: 'cp-check', title: done ? T.taskUndone : T.taskDone },
            h('input', {
              type: 'checkbox',
              checked: done,
              disabled: !!busy,
              onChange: function () { toggleTask(task); },
              'aria-label': (done ? T.taskUndone : T.taskDone) + '：' + String(task.title || ''),
            })
          ),
          h(
            'div',
            { className: 'cp-task-main' },
            h('div', { className: 'cp-task-title' }, String(task.title || '')),
            h(
              'div',
              { className: 'cp-task-meta' },
              task.course ? h('span', { className: 'cp-chip-sm' }, String(task.course)) : null,
              due ? h('span', { className: 'cp-chip-sm' + (overdue ? ' cp-is-overdue' : '') }, due) : null,
              task.priority ? h('span', { className: 'cp-chip-sm' }, T.priority + task.priority) : null
            )
          )
        );
      }

      function renderGoal(goal, index) {
        if (!goal || typeof goal !== 'object') return null;
        const countdown = goalCountdown(goal, baseKey);
        const kind = typeof goal.kind === 'string' ? goal.kind : 'other';
        return h(
          'div',
          { className: 'cp-goal', key: goal.id || 'goal-' + index },
          h(
            'div',
            { className: 'cp-goal-top' },
            h('span', { className: 'cp-badge cp-badge-brand' }, goalKindLabel(kind)),
            h('span', { className: 'cp-goal-priority cp-muted' }, T.priority + num(goal.priority || 3)),
            h('span', { className: 'cp-goal-count' + (countdown.past ? ' cp-is-past' : '') }, countdown.text)
          ),
          h('div', { className: 'cp-goal-title' }, String(goal.title || '')),
          goal.target ? h('div', { className: 'cp-goal-target cp-muted' }, String(goal.target)) : null,
          goal.targetDate
            ? h('div', { className: 'cp-goal-date cp-muted' }, T.targetDate + '：' + fmtDateCn(goal.targetDate))
            : null
        );
      }

      function renderIntel(item, index) {
        if (!item || typeof item !== 'object') return null;
        const title = String(item.title || item.summary || T.intelUntitled);
        return h(
          'div',
          { className: 'cp-intel-item', key: item.id || 'intel-' + index },
          h(
            'div',
            { className: 'cp-intel-title' },
            item.url
              ? h('a', { className: 'cp-link', href: String(item.url), target: '_blank', rel: 'noreferrer noopener' }, title)
              : title,
            item.source ? h('span', { className: 'cp-chip-sm' }, String(item.source)) : null
          ),
          item.summary ? h('div', { className: 'cp-intel-summary cp-muted' }, String(item.summary)) : null,
          h(
            'div',
            { className: 'cp-intel-meta cp-muted' },
            item.fetchedAt ? fmtDateTime(item.fetchedAt) : '',
            Array.isArray(item.tags) && item.tags.length
              ? h('span', null, item.tags.slice(0, 3).map(function (tag) { return '#' + tag; }).join(' '))
              : null
          )
        );
      }

      function renderEmptyState() {
        return h(
          'div',
          { className: 'cp-empty' },
          h('div', { className: 'cp-empty-title' }, T.emptyTitle),
          h('div', null, T.emptyHint),
          h('div', { className: 'cp-empty-quote' }, T.emptyQuote),
          h('div', { className: 'cp-empty-hint' }, T.emptyTaskHint)
        );
      }

      function renderSettings() {
        if (!form) return null;
        return h(
          'section',
          { className: 'cp-card cp-settings-card' },
          h('div', { className: 'cp-card-title' }, h('span', null, T.pushSettingsTitle)),
          h(
            'div',
            { className: 'cp-settings' },
            h(
              'label',
              { className: 'cp-field cp-field-inline' },
              h('span', null, T.pushEnabled),
              h('input', {
                type: 'checkbox',
                checked: !!form.enabled,
                disabled: !!busy,
                onChange: function (event) {
                  updateForm({ enabled: !!(event && event.target && event.target.checked) });
                },
              })
            ),
            h(
              'label',
              { className: 'cp-field' },
              h('span', null, T.pushTime),
              h('input', {
                type: 'time',
                value: form.time,
                disabled: !!busy,
                onChange: function (event) {
                  const next = normaliseTime(event && event.target && event.target.value);
                  if (next) updateForm({ time: next });
                },
              })
            ),
            h(
              'div',
              { className: 'cp-field' },
              h('span', null, T.pushChannels),
              h(
                'div',
                { className: 'cp-chip-row' },
                h(
                  'label',
                  { className: 'cp-checkbox-chip', key: 'qq' },
                  h('input', {
                    type: 'checkbox',
                    checked: form.channels.indexOf('qq') >= 0,
                    disabled: !!busy,
                    onChange: function () { toggleChannel('qq'); },
                  }),
                  h('span', null, T.channelQQ)
                ),
                h(
                  'label',
                  { className: 'cp-checkbox-chip', key: 'wechat' },
                  h('input', {
                    type: 'checkbox',
                    checked: form.channels.indexOf('wechat') >= 0,
                    disabled: !!busy,
                    onChange: function () { toggleChannel('wechat'); },
                  }),
                  h('span', null, T.channelWeChat)
                )
              )
            )
          ),
          form.channels.length === 0 ? h('div', { className: 'cp-warn-text' }, T.channelRequired) : null,
          h(
            'div',
            { className: 'cp-settings-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'cp-btn cp-btn-primary',
                disabled: !!busy || form.channels.length === 0,
                onClick: saveSettings,
              },
              busy === 'savePush' ? T.saving : T.pushSave
            ),
            h('button', { type: 'button', className: 'cp-btn', disabled: !!busy, onClick: closeSettings }, T.cancel)
          )
        );
      }

      // ---------------- 面板结构 ----------------
      const header = h(
        'header',
        { className: 'cp-header' },
        h(
          'div',
          { className: 'cp-headline' },
          h(
            'div',
            { className: 'cp-title' },
            h('span', null, T.title),
            plan && plan.theme ? h('span', { className: 'cp-theme' }, T.themeLabel + ' · ' + String(plan.theme)) : null
          ),
          h('div', { className: 'cp-date' }, fmtDateCn(date)),
          plan && plan.focus
            ? h('div', { className: 'cp-focus' }, h('span', { className: 'cp-focus-label' }, T.todayFocus + '：'), String(plan.focus))
            : h('div', { className: 'cp-focus cp-muted' }, T.noFocus)
        ),
        h(
          'div',
          { className: 'cp-actions' },
          busy ? h('span', { className: 'cp-muted cp-busy' }, T.busy) : null,
          h('button', { type: 'button', className: 'cp-btn', disabled: !!busy, onClick: refresh }, T.refresh),
          h(
            'button',
            { type: 'button', className: 'cp-btn cp-btn-primary', disabled: !!busy, onClick: regenerate },
            busy === 'regenerate' ? T.regenerateBusy : T.regenerate
          ),
          h(
            'button',
            { type: 'button', className: 'cp-btn', disabled: !!busy, onClick: pushNow },
            busy === 'push' ? T.pushBusy : T.pushNow
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'cp-btn' + (settingsOpen ? ' cp-is-active' : ''),
              disabled: !!busy,
              onClick: toggleSettings,
              'aria-expanded': settingsOpen ? 'true' : 'false',
            },
            T.pushSettings
          )
        )
      );

      const capacityBar = h(
        'div',
        { className: 'cp-capacity' },
        h(
          'div',
          { className: 'cp-capacity-head' },
          h('span', null, T.capacity),
          h('span', { className: 'cp-muted' }, T.capacityValue(planned, capacity))
        ),
        h(
          'div',
          {
            className: 'cp-progress',
            role: 'progressbar',
            'aria-valuemin': 0,
            'aria-valuemax': capacity,
            'aria-valuenow': planned,
            'aria-label': T.capacity,
          },
          h('div', {
            className: 'cp-progress-fill' + (overCapacity ? ' cp-is-over' : ''),
            style: { width: percent + '%' },
          })
        ),
        overCapacity ? h('div', { className: 'cp-warn-text' }, T.overCapacity) : null
      );

      const timelineCard = h(
        'section',
        { className: 'cp-card' },
        h(
          'div',
          { className: 'cp-card-title' },
          h('span', null, T.timeline),
          h('span', { className: 'cp-muted' }, T.timelineCount(blocks.length, doneBlocks))
        ),
        blocks.length === 0 ? renderEmptyState() : h('div', { className: 'cp-timeline' }, blocks.map(renderBlock))
      );

      const warningsCard = warnings.length
        ? h(
            'section',
            { className: 'cp-card cp-warn-card' },
            h('div', { className: 'cp-card-title' }, h('span', null, T.warnings)),
            h('ul', { className: 'cp-list' }, warnings.map(function (warning, index) {
              return h('li', { key: index }, String(warning));
            }))
          )
        : null;

      const tasksCard = h(
        'section',
        { className: 'cp-card' },
        h(
          'div',
          { className: 'cp-card-title' },
          h('span', null, T.tasks),
          h('span', { className: 'cp-muted' }, T.tasksCount(openTasks))
        ),
        taskGroups.length === 0
          ? h('div', { className: 'cp-empty cp-empty-sm' }, T.tasksEmpty)
          : h(
              'div',
              { className: 'cp-task-groups' },
              taskGroups.map(function (group) {
                return h(
                  'div',
                  { className: 'cp-task-group', key: group.kind },
                  h('div', { className: 'cp-group-title' }, taskKindLabel(group.kind)),
                  group.items.map(renderTask)
                );
              })
            )
      );

      const goalsCard = h(
        'section',
        { className: 'cp-card' },
        h(
          'div',
          { className: 'cp-card-title' },
          h('span', null, T.goals),
          goals.length ? h('span', { className: 'cp-muted' }, T.goalCount(goals.length)) : null
        ),
        goals.length === 0
          ? h('div', { className: 'cp-empty cp-empty-sm' }, T.goalsEmpty)
          : h('div', { className: 'cp-goals' }, goals.map(renderGoal))
      );

      const intelCard = h(
        'section',
        { className: 'cp-card' },
        h(
          'div',
          { className: 'cp-card-title' },
          h('span', null, T.intel),
          intel.length ? h('span', { className: 'cp-muted' }, T.intelCount(intel.length)) : null
        ),
        intel.length === 0
          ? h('div', { className: 'cp-empty cp-empty-sm' }, T.intelEmpty)
          : h('div', { className: 'cp-intel-list' }, intel.map(renderIntel))
      );

      const pushCard = h(
        'section',
        { className: 'cp-card' },
        h(
          'div',
          { className: 'cp-card-title' },
          h('span', null, T.pushStatus),
          h('span', { className: 'cp-badge' + (push.enabled ? ' cp-badge-ok' : ' cp-badge-idle') }, push.enabled ? T.pushOn : T.pushOff)
        ),
        h(
          'div',
          { className: 'cp-push-rows' },
          pushRows.map(function (row) {
            return h(
              'div',
              { className: 'cp-info-row', key: row.key },
              h('span', { className: 'cp-info-label' }, row.label),
              h('span', { className: 'cp-info-value' }, row.value)
            );
          })
        )
      );

      const footer = h(
        'footer',
        { className: 'cp-stats' },
        h(
          'div',
          { className: 'cp-stat' },
          h(
            'div',
            { className: 'cp-stat-value' },
            String(num(stats.streakDays)),
            h('span', { className: 'cp-stat-unit' }, T.daysUnit)
          ),
          h('div', { className: 'cp-stat-label' }, T.streak)
        ),
        h(
          'div',
          { className: 'cp-stat' },
          h('div', { className: 'cp-stat-value' }, String(num(stats.doneToday))),
          h('div', { className: 'cp-stat-label' }, T.doneTodayLabel)
        ),
        h(
          'div',
          { className: 'cp-stat' },
          h('div', { className: 'cp-stat-value' + (num(stats.overdue) > 0 ? ' cp-is-warn' : '') }, String(num(stats.overdue))),
          h('div', { className: 'cp-stat-label' }, T.overdueLabel)
        )
      );

      return h(
        'div',
        { className: 'cp-root', 'aria-busy': busy ? 'true' : 'false' },
        h('style', { key: 'cp-style' }, CSS),
        header,
        capacityBar,
        settingsOpen && form ? renderSettings() : null,
        notice ? h('div', { className: 'cp-notice' }, String(notice.text)) : null,
        h(
          'div',
          { className: 'cp-grid' },
          h('div', { className: 'cp-main-col' }, timelineCard, warningsCard),
          h('aside', { className: 'cp-side-col' }, tasksCard, goalsCard, intelCard, pushCard)
        ),
        footer
      );
    }

    function somethingEmpty(value) {
      return value === null || value === undefined || value === '';
    }

    // ------------------------------------------------------------------
    // 插槽注册：sidebar.panellist 的 id 必须与 main 的 key 完全一致
    // ------------------------------------------------------------------
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'career-planner',
              order: 70,
              label: () => T.title,
            },
            CareerIcon
          );
        });
        ctx.slots.inject('main', function () {
          return ctx.slots.register(
            {
              name: 'main',
              key: 'career-planner',
            },
            CareerPanel
          );
        });
      },
    };
  },
});
