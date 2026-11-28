/**
 * 武科大宣讲会 · Apple HIG & Liquid Glass 前端交互逻辑
 *
 * - 严格遵循 DESIGN.md：剔除彩虹企业头像、彩色标签堆砌与赛博渐变，统一采用克制灰阶 + Apple Blue (#0071E3)
 * - 支持离线即时开屏（读取打包内置的最新官网实时数据 demo-data.js）
 * - 支持通过 AndroidBridge 直连同步 https://wust.91wllm.cn/ 最新宣讲会与双选会、按需补全详情、原生系统日历、分享与沉浸状态栏联动
 */
(function () {
  'use strict';

  const D = window.DEMO_DATA;
  const OFF = D.official || { colleges: [], majors: [], groups: [] };
  const BRIDGE = window.AndroidBridge || null;

  const STORAGE = {
    FAV: 'wust-talks-fav-v4',
    PREF: 'wust-talks-pref-v4',
    HIST: 'wust-talks-hist-v4',
    THEME: 'wust-talks-theme-v1',
    LIVE: 'wust-talks-live-snapshot-v1',
    CLOUD: 'wust-talks-cloud-url-v1',
  };

  // ---------- UTC+8 时间工具 ----------
  const TZ8 = 8 * 3600000;
  const DAY = 86400000;
  const MAX_RANGE_DAYS = 90;
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const pad = (n) => String(n).padStart(2, '0');

  function dateKeyOf(ms) {
    const d = new Date(ms + TZ8);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  function startOfDay(s) {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d) - TZ8;
  }
  function endOfDay(s) {
    return startOfDay(s) + DAY - 1;
  }
  function addDays(s, delta) {
    return dateKeyOf(startOfDay(s) + delta * DAY);
  }
  function weekdayLabel(s) {
    const d = new Date(startOfDay(s) + TZ8);
    return WEEKDAYS[d.getUTCDay()];
  }
  function hhmm(ms) {
    const d = new Date(ms + TZ8);
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  function weekKeyOf(ms) {
    const [y, m, d] = dateKeyOf(ms).split('-').map(Number);
    const lm = Date.UTC(y, m - 1, d) - TZ8;
    const wd = (new Date(lm + TZ8).getUTCDay() + 6) % 7;
    const mon = lm - wd * DAY;
    const iy = new Date(mon + 3 * DAY + TZ8).getUTCFullYear();
    const j4 = Date.UTC(iy, 0, 4) - TZ8;
    const j4wd = (new Date(j4 + TZ8).getUTCDay() + 6) % 7;
    return `${iy}-W${pad(Math.floor((mon - (j4 - j4wd * DAY)) / (7 * DAY)) + 1)}`;
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ---------- 字典索引 ----------
  const majorById = Object.fromEntries(OFF.majors.map((m) => [m.id, m]));
  const collegeById = Object.fromEntries(OFF.colleges.map((c) => [c.id, c]));
  const campusById = Object.fromEntries((D.campuses || []).map((c) => [c._id, c]));
  const majorsByCollege = {};
  OFF.majors.forEach((m) => { (majorsByCollege[m.collegeId] ||= []).push(m); });

  const CAMPUS_LABEL = {
    campus_qingshan: '青山校区',
    campus_hongshan: '洪山校区',
    campus_other: '其他校区',
  };
  const JOB_CATEGORIES = [
    { id: 'job_rd', name: '研发技术', match: /研发|开发|软件|算法|AI|人工智能|数据|测试|需求分析|研究员|智能|信息安全|IT|技术/ },
    { id: 'job_engineer', name: '工程制造', match: /工程师|工艺|机械|电气|冶金|材料|能源|动力|结构设计|安全环保|检测|设备|技师|生产计划|采购员|装配/ },
    { id: 'job_product', name: '产品运营', match: /产品|运营|数据分析|用户|内容|新媒体/ },
    { id: 'job_market', name: '市场营销', match: /市场|营销|销售|业务|外贸|跨境电商|商务|拓展/ },
    { id: 'job_manage', name: '管理职能', match: /管培生|储备干部|职能|人力|行政|财务|会计|审计|法务|咨询|顾问|供应链|管理岗/ },
    { id: 'job_design', name: '设计创意', match: /设计|视觉|产品设计师|环境设计|创意/ },
    { id: 'job_edu', name: '教育培训', match: /教育|教师|培训|学科老师|课程顾问|教务/ },
    { id: 'job_tech_service', name: '技术服务', match: /实施|运维|支持|售后|交付|客户服务/ },
    { id: 'job_other', name: '其他岗位', match: /.*/ },
  ];

  function normalizeCampus(text) {
    if (/青山/.test(text)) return 'campus_qingshan';
    if (/黄家湖|洪山|教十一楼|教一楼|北苑|南苑/.test(text)) return 'campus_hongshan';
    return 'campus_other';
  }
  function jobCategoriesOf(positions, title) {
    const labels = new Set();
    const list = positions && positions.length ? positions : [title || ''];
    list.forEach((p) => {
      const hit = JOB_CATEGORIES.find((c) => c.match.test(p));
      if (hit) labels.add(hit.name);
    });
    return labels.size ? [...labels] : ['其他岗位'];
  }
  function matchMajorsFromText(text) {
    const out = [];
    OFF.majors.forEach((m) => {
      const clean = m.name.replace(/\(.*?\)/g, '');
      if (clean.length >= 2 && text.includes(clean)) out.push(m.id);
    });
    if (!out.length && /计算机|软件|IT|人工智能|信息/.test(text)) {
      OFF.majors.filter((m) => m.collegeId === 'jsjkx').forEach((m) => out.push(m.id));
    }
    if (!out.length && /机械|电气|自动化|工程/.test(text)) {
      OFF.majors.filter((m) => m.collegeId === 'jxzdh').slice(0, 4).forEach((m) => out.push(m.id));
    }
    if (!out.length && /材料|冶金|化工/.test(text)) {
      OFF.majors.filter((m) => m.collegeId === 'cl').slice(0, 4).forEach((m) => out.push(m.id));
    }
    if (!out.length && /医药|药学|护理|医学|生物/.test(text)) {
      OFF.majors.filter((m) => m.collegeId === 'yxb' || m.collegeId === 'smkxyjk').slice(0, 4).forEach((m) => out.push(m.id));
    }
    return [...new Set(out)].slice(0, 12);
  }

  function rebuildIndustries() {
    const map = new Map();
    D.talks.forEach((t) => {
      const name = t.industryName || '综合行业';
      if (!map.has(name)) {
        const id = `ind_${map.size}`;
        map.set(name, { _id: id, code: '', name });
      }
      t.industryId = map.get(name)._id;
    });
    D.industries = [...map.values()];
  }
  function getIndustryById(id) {
    return (D.industries || []).find((i) => i._id === id);
  }

  // ---------- 持久化状态 ----------
  function loadJSON(k, fallback) {
    try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
  }
  function saveJSON(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ }
  }
  const emptyPref = () => ({ campuses: [], colleges: [], majors: [], jobs: [] });

  const DEFAULT_CLOUD_URL = 'https://attentionisyouneed.github.io/wust-talks/live-data.json';
  let favorites = new Set(loadJSON(STORAGE.FAV, []));
  let pref = Object.assign(emptyPref(), loadJSON(STORAGE.PREF, {}));
  let history = loadJSON(STORAGE.HIST, []);
  let theme = loadJSON(STORAGE.THEME, 'auto');
  let cloudFeedUrl = String(loadJSON(STORAGE.CLOUD, DEFAULT_CLOUD_URL) || DEFAULT_CLOUD_URL).trim();
  let lastSyncedAt = 0;

  (function hydrateLiveCache() {
    const cached = loadJSON(STORAGE.LIVE, null);
    if (!cached || !Array.isArray(cached.talks) || !cached.talks.length) return;
    const bundledMs = Date.parse(D.generatedAt || '') || 0;
    if (cached.syncedAt && cached.syncedAt > bundledMs) {
      D.talks = cached.talks;
      if (Array.isArray(cached.jobfairs) && cached.jobfairs.length) D.jobfairs = cached.jobfairs;
      lastSyncedAt = cached.syncedAt;
    }
  })();
  rebuildIndustries();

  const state = {
    page: 'home',
    prevPage: 'home',
    detailId: null,
    homeQuick: 'all',
    homeDate: '',
    homeKeyword: '',
    syncing: false,
    filter: {
      keyword: '',
      timePreset: 'all',
      dateFrom: '',
      dateTo: '',
      campuses: [],
      colleges: [],
      majors: [],
      jobs: [],
      industries: [],
      includeExpired: false,
      sort: 'time',
      group: 'grid',
      collegesExpanded: false,
    },
    calendar: {
      year: 0,
      month: 0,
      selectedDay: '',
    },
    profile: {
      openStep: 0,
      tab: 'fav',
    },
  };

  // ---------- 主题切换与 Android 系统状态栏同步 ----------
  const THEME_ICONS = {
    auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"><circle cx="12" cy="12" r="4.6"/><path d="M12 1.5v2M12 20.5v2M4.58 4.58l1.41 1.41M18.01 18.01l1.41 1.41M1.5 12h2M20.5 12h2M4.58 19.42l1.41-1.41M18.01 5.99l1.41-1.41"/></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  };

  function syncNativeSystemBars() {
    if (!BRIDGE || typeof BRIDGE.setSystemBarTheme !== 'function') return;
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = theme === 'dark' || (theme === 'auto' && prefersDark);
    BRIDGE.setSystemBarTheme(Boolean(isDark));
  }

  function applyTheme(next) {
    theme = next;
    saveJSON(STORAGE.THEME, theme);
    document.documentElement.setAttribute('data-theme', theme);
    const btn = document.getElementById('btn-theme');
    if (btn) btn.innerHTML = THEME_ICONS[theme] || THEME_ICONS.auto;
    document.querySelectorAll('#set-theme button').forEach((b) => {
      b.classList.toggle('active', b.dataset.theme === theme);
    });
    syncNativeSystemBars();
  }

  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', () => { if (theme === 'auto') syncNativeSystemBars(); });
    }
  }

  // ---------- Toast & 原生复制 ----------
  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    const txt = document.getElementById('toast-msg');
    if (!el || !txt) return;
    txt.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  async function copyText(text, successMsg) {
    if (BRIDGE && typeof BRIDGE.copyText === 'function') {
      BRIDGE.copyText(String(text || ''), '');
      toast(successMsg || '已复制到剪贴板');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast(successMsg || '已复制到剪贴板');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast(successMsg || '已复制到剪贴板'); } catch { toast('复制失败'); }
      ta.remove();
    }
  }

  function toggleArr(arr, v) {
    const i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(v);
  }

  // ---------- 偏好匹配度 ----------
  function hasPref() {
    return pref.campuses.length + pref.colleges.length + pref.majors.length + pref.jobs.length > 0;
  }
  function relatedMajorSet(ids) {
    const out = new Set(ids || []);
    (ids || []).forEach((id) => {
      const m = majorById[id];
      if (!m) return;
      (majorsByCollege[m.collegeId] || []).forEach((x) => out.add(x.id));
      const grp = (OFF.groups || []).find((g) => g.id === m.category);
      if (grp) {
        OFF.majors.filter((x) => grp.collegeIds.includes(x.collegeId)).forEach((x) => out.add(x.id));
      }
    });
    return out;
  }
  function computeMatch(talk) {
    const hits = [];
    let score = 0;
    let weight = 0;

    if (pref.campuses.length) {
      weight += 25;
      if (pref.campuses.includes(talk.campusId)) { score += 25; hits.push(`校区匹配（${talk.campusName}）`); }
    }
    if (pref.colleges.length) {
      weight += 25;
      if ((talk.collegeIds || []).some((c) => pref.colleges.includes(c))) { score += 25; hits.push('举办学院匹配'); }
    }
    if (pref.majors.length) {
      weight += 30;
      const directHit = (talk.majorIds || []).some((m) => pref.majors.includes(m));
      const relSet = relatedMajorSet(pref.majors);
      const relHit = (talk.majorIds || []).some((m) => relSet.has(m));
      if (directHit) { score += 30; hits.push('招聘专业精准匹配'); }
      else if (relHit) { score += 20; hits.push('相近学科群匹配'); }
    }
    if (pref.jobs.length) {
      weight += 20;
      if ((talk.jobCategories || []).some((j) => pref.jobs.includes(j))) { score += 20; hits.push('岗位方向匹配'); }
    }
    if (!weight) return { pct: 0, hits: [], configured: false };
    return { pct: Math.round((score / weight) * 100), hits, configured: true };
  }

  // ---------- 状态判定 & 查询 ----------
  function isCancelled(t) { return Boolean(t.isCancelled || t.status === 'cancelled'); }
  function isLive(t, now) { return !isCancelled(t) && t.status !== 'expired' && t.startTime <= now && t.endTime >= now; }
  function isEnded(t, now) { return t.status === 'expired' || t.endTime < now; }
  function publicTalks(includeExpired = false) {
    const now = Date.now();
    return D.talks.filter((t) => {
      if (includeExpired) return true;
      return (t.status === 'published' || t.status === 'cancelled') && t.endTime >= now;
    });
  }

  function validateCustomRange(fromStr, toStr) {
    if (!fromStr || !toStr) return { valid: false, msg: '请选择起止日期' };
    const fromMs = startOfDay(fromStr);
    const toMs = endOfDay(toStr);
    if (toMs < fromMs) return { valid: false, msg: '结束日期不能早于开始日期' };
    const days = Math.floor((startOfDay(toStr) - fromMs) / DAY) + 1;
    if (days > MAX_RANGE_DAYS) return { valid: false, msg: `自定义区间不能超过 ${MAX_RANGE_DAYS} 天（当前 ${days} 天）` };
    return { valid: true, from: fromMs, to: toMs, days };
  }
  function rangeOf(preset, customFrom, customTo) {
    const now = Date.now();
    const today = dateKeyOf(now);
    const tomorrow = addDays(today, 1);
    switch (preset) {
      case 'today': return [startOfDay(today), endOfDay(today)];
      case 'tomorrow': return [startOfDay(tomorrow), endOfDay(tomorrow)];
      case 'next3days': return [startOfDay(today), endOfDay(addDays(today, 2))];
      case 'thisWeek': {
        const todayMs = startOfDay(today);
        const wd = (new Date(todayMs + TZ8).getUTCDay() + 6) % 7;
        const mon = todayMs - wd * DAY;
        return [mon, mon + 7 * DAY - 1];
      }
      case 'custom': {
        const v = validateCustomRange(customFrom, customTo);
        return v.valid ? [v.from, v.to] : null;
      }
      default: return null;
    }
  }

  function queryTalks(opts) {
    const now = Date.now();
    let list = publicTalks(Boolean(opts.includeExpired));

    if (opts.dateKey) {
      list = list.filter((t) => t.dateKey === opts.dateKey);
    } else {
      const r = rangeOf(opts.preset, opts.dateFrom, opts.dateTo);
      if (r) list = list.filter((t) => t.startTime >= r[0] && t.startTime <= r[1]);
    }
    if (opts.campuses?.length) list = list.filter((t) => opts.campuses.includes(t.campusId));
    if (opts.colleges?.length) list = list.filter((t) => (t.collegeIds || []).some((c) => opts.colleges.includes(c)));
    if (opts.majors?.length) {
      const mset = relatedMajorSet(opts.majors);
      list = list.filter((t) => (t.majorIds || []).some((m) => mset.has(m)));
    }
    if (opts.jobs?.length) list = list.filter((t) => (t.jobCategories || []).some((j) => opts.jobs.includes(j)));
    if (opts.industries?.length) list = list.filter((t) => opts.industries.includes(t.industryId));
    if (opts.keyword) {
      const k = opts.keyword.toLowerCase();
      list = list.filter((t) => [
        t.title, t.companyName, t.location, t.originalPlace, t.campusName, t.industryName,
        ...(t.positions || []), ...(t.majorNames || []), ...(t.collegeNames || []), ...(t.jobCategories || []),
      ].filter(Boolean).some((v) => String(v).toLowerCase().includes(k)));
    }
    if (opts.sort === 'match' && hasPref()) {
      return list.slice().sort((a, b) => computeMatch(b).pct - computeMatch(a).pct || a.startTime - b.startTime);
    }
    return list.slice().sort((a, b) => {
      const aEnd = isEnded(a, now) ? 1 : 0;
      const bEnd = isEnded(b, now) ? 1 : 0;
      if (aEnd !== bEnd) return aEnd - bEnd;
      return a.startTime - b.startTime;
    });
  }

  // ---------- 卡片与灰阶标识渲染 ----------
  function shortCompany(name) {
    const clean = String(name || '').replace(/有限公司|股份有限公司|集团|研究所|科技|中国|武汉|湖北|广东|江苏|河南|新疆|天津|南京|福建/g, '');
    return (clean || name || '企业').slice(0, 2);
  }

  function statusBadgesHtml(t, now) {
    const today = dateKeyOf(now);
    const tomorrow = addDays(today, 1);
    const out = [];
    if (isCancelled(t)) out.push('<span class="badge cancel">已取消</span>');
    else if (isLive(t, now)) out.push('<span class="badge live">进行中</span>');
    else if (isEnded(t, now)) out.push('<span class="badge ended">已结束</span>');
    else if (t.dateKey === today) out.push('<span class="badge today">今天</span>');
    else if (t.dateKey === tomorrow) out.push('<span class="badge tomorrow">明天</span>');

    if (t.campusId === 'campus_other' || /线上/.test(t.location || '')) {
      out.push('<span class="badge online">线上</span>');
    }
    const m = computeMatch(t);
    if (m.configured && m.pct >= 50) out.push(`<span class="badge match">匹配 ${m.pct}%</span>`);
    return out.join('');
  }

  function cardHtml(t) {
    const now = Date.now();
    const fav = favorites.has(t._id);
    const cancel = isCancelled(t);
    const allTagItems = [...(t.positions || []).slice(0, 2), ...(t.majorNames || []).slice(0, 2)];
    const shownTags = allTagItems.slice(0, 3).map((txt) => `<span class="tag">${esc(txt)}</span>`);
    const totalCount = (t.positions || []).length + (t.majorNames || []).length;
    const extraCount = Math.max(0, totalCount - shownTags.length);
    const tags = [...shownTags, extraCount > 0 ? `<span class="tag more">+${extraCount}</span>` : ''].join('');
    const wd = weekdayLabel(t.dateKey);
    const badges = statusBadgesHtml(t, now);

    return `<article class="card ${cancel ? 'is-cancel' : ''}" data-id="${esc(t._id)}">
      <button class="fav-toggle ${fav ? 'on' : ''}" data-fav="${esc(t._id)}" title="${fav ? '取消收藏' : '收藏'}" aria-label="收藏">
        <svg viewBox="0 0 24 24" fill="${fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.85"><path d="M12 20.5s-7-4.35-9.2-8.4C1.1 8.9 2.9 5 6.6 5c2.1 0 3.6 1.1 4.4 2.3L12 8.7l1-1.4C13.8 6.1 15.3 5 17.4 5c3.7 0 5.5 3.9 3.8 7.1-2.2 4.05-9.2 8.4-9.2 8.4z"/></svg>
      </button>
      <div class="card-top">
        <div class="logo" aria-hidden="true">${esc(shortCompany(t.companyName))}</div>
        <div class="card-main">
          <div class="card-title">${esc(t.companyName)}</div>
          <div class="card-sub">${esc(t.industryName || '校园招聘')}</div>
          ${badges ? `<div class="card-badges">${badges}</div>` : ''}
        </div>
      </div>
      <div class="card-meta">
        <div>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
          <span><b>${esc(t.dateKey)} ${wd}</b> · ${hhmm(t.startTime)}–${hhmm(t.endTime)}</span>
        </div>
        <div>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6-5.4-6-10a6 6 0 1 1 12 0c0 4.6-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/></svg>
          <span>${esc(t.campusName)} · ${esc(t.originalPlace || t.location)}</span>
        </div>
      </div>
      ${tags ? `<div class="tags">${tags}</div>` : ''}
      <div class="card-foot">
        <span>${esc((t.jobCategories || []).slice(0, 2).join(' · ') || '综合岗位')}</span>
        ${t.cancelReason ? `<span style="color:var(--red)">${esc(t.cancelReason)}</span>` : '<span class="go-hint">详情 ›</span>'}
      </div>
    </article>`;
  }

  function bindTalkInteractions(root = document) {
    root.querySelectorAll('.card[data-id]').forEach((card) => {
      card.onclick = (e) => {
        if (e.target.closest('[data-fav]')) return;
        showPage('detail', card.dataset.id);
      };
    });
    root.querySelectorAll('[data-fav]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const id = btn.dataset.fav;
        toggleFavorite(id);
        btn.classList.add('pop');
      };
    });
  }

  function toggleFavorite(id) {
    if (favorites.has(id)) {
      favorites.delete(id);
      toast('已取消收藏');
    } else {
      favorites.add(id);
      toast('已加入收藏');
    }
    saveJSON(STORAGE.FAV, [...favorites]);
    updateFavBadge();
    if (state.page === 'home') renderHome();
    if (state.page === 'filter') renderFilter();
    if (state.page === 'calendar') renderCalendar();
    if (state.page === 'detail' && state.detailId === id) renderDetail(id, true);
    if (state.page === 'profile') renderProfile();
  }

  function updateFavBadge() {
    const el = document.getElementById('tab-fav-badge');
    if (!el) return;
    el.textContent = String(favorites.size);
    el.classList.toggle('hidden', favorites.size === 0);
  }

  // ---------- 倒计时 ----------
  let countdownTimer = null;
  function updateCountdowns() {
    const now = Date.now();
    document.querySelectorAll('[data-countdown-start]').forEach((box) => {
      const s = Number(box.dataset.countdownStart);
      const e = Number(box.dataset.countdownEnd);
      if (now >= s && now <= e) {
        box.classList.add('live');
        box.innerHTML = '<div class="cell"><b>进行中</b><span>欢迎入场</span></div>';
        return;
      }
      const diff = Math.max(0, s - now);
      const d = Math.floor(diff / DAY);
      const h = Math.floor((diff % DAY) / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const sec = Math.floor((diff % 60000) / 1000);
      box.classList.remove('live');
      box.innerHTML = d > 0
        ? `<div class="cell"><b>${d}</b><span>天</span></div><div class="cell"><b>${pad(h)}</b><span>时</span></div><div class="cell"><b>${pad(m)}</b><span>分</span></div>`
        : `<div class="cell"><b>${pad(h)}</b><span>时</span></div><div class="cell"><b>${pad(m)}</b><span>分</span></div><div class="cell"><b>${pad(sec)}</b><span>秒</span></div>`;
    });
  }

  // ---------- 云端定时源 + Android 原生 + Web API 全通道实时同步（替代 Muse） ----------
  function setSyncUi(busy) {
    state.syncing = busy;
    const btn = document.getElementById('btn-sync-official');
    const lbl = document.getElementById('btn-sync-label');
    const profBtn = document.getElementById('btn-sync-profile');
    if (btn) btn.classList.toggle('syncing', busy);
    if (lbl) lbl.textContent = busy ? '同步中' : '同步官网';
    if (profBtn) {
      profBtn.disabled = busy;
      profBtn.textContent = busy ? '同步中…' : '同步';
    }
  }

  function applyFullSnapshot(snap, silent = false) {
    if (!snap || !Array.isArray(snap.talks) || !snap.talks.length) return false;
    const snapMs = Number(snap.syncedAt) || Date.parse(snap.generatedAt || '') || Date.now();
    const currentMs = lastSyncedAt || Date.parse(D.generatedAt || '') || 0;
    if (silent && snapMs <= currentMs) return false;

    D.talks = snap.talks;
    if (Array.isArray(snap.jobfairs) && snap.jobfairs.length) D.jobfairs = snap.jobfairs;
    if (snap.today) D.today = snap.today;
    lastSyncedAt = snapMs;
    rebuildIndustries();
    saveJSON(STORAGE.LIVE, {
      syncedAt: lastSyncedAt,
      talks: D.talks,
      jobfairs: D.jobfairs,
    });
    showPage(state.page, state.detailId);
    if (!silent) {
      const activeCnt = publicTalks(false).length;
      toast(`已更新官网 ${D.talks.length} 场排期（${activeCnt} 场近期有效）`);
    }
    return true;
  }

  async function fetchJsonWithBust(url, timeoutMs = 15000) {
    const sep = url.includes('?') ? '&' : '?';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${url}${sep}_t=${Date.now()}`, { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function syncViaWebOrCloud(silent = false) {
    if (!silent) {
      setSyncUi(true);
      toast('正在拉取武科大就业网最新排期…');
    }
    try {
      // 1) 若存在本地或服务端实时抓取接口 /api/sync（非 appassets 协议），优先直抓官网实时页面
      const isAndroidAssetOrigin = location.hostname === 'appassets.androidplatform.net';
      if (!silent && !isAndroidAssetOrigin && /^https?:$/i.test(location.protocol)) {
        try {
          const live = await fetchJsonWithBust('/api/sync', 20000);
          if (live && Array.isArray(live.talks) && live.talks.length) {
            setSyncUi(false);
            applyFullSnapshot(live, false);
            return true;
          }
        } catch {
          // 静态托管环境（如 GitHub Pages）无 /api/sync，自动降级拉取定时生成的云端 JSON
        }
      }

      // 2) 拉取用户配置的 GitHub Actions / Pages 云端 JSON 源，或同源 ./live-data.json
      const candidates = [];
      if (cloudFeedUrl) candidates.push(cloudFeedUrl);
      if (!isAndroidAssetOrigin && /^https?:$/i.test(location.protocol)) {
        candidates.push('./live-data.json');
      }
      for (const u of candidates) {
        try {
          const snap = await fetchJsonWithBust(u, 10000);
          if (snap && Array.isArray(snap.talks) && snap.talks.length) {
            setSyncUi(false);
            const updated = applyFullSnapshot(snap, silent);
            if (!silent && !updated) toast('当前已是最新排期');
            return true;
          }
        } catch {
          // try next candidate
        }
      }
      if (!silent) {
        setSyncUi(false);
        toast('暂无法连接同步源，已保留本地数据');
      }
      return false;
    } catch {
      if (!silent) {
        setSyncUi(false);
        toast('同步未完成，已保留本地数据');
      }
      return false;
    }
  }

  window.syncOfficialFromAndroid = function (fromSwipe = false) {
    if (state.syncing) {
      if (fromSwipe && BRIDGE && typeof BRIDGE.finishRefreshing === 'function') BRIDGE.finishRefreshing();
      return;
    }
    if (BRIDGE && typeof BRIDGE.syncOfficialSite === 'function') {
      setSyncUi(true);
      if (!fromSwipe) toast('正在直连武科大就业网同步…');
      BRIDGE.syncOfficialSite();
      return;
    }
    syncViaWebOrCloud(false);
  };

  window.onOfficialSyncError = function (err) {
    setSyncUi(false);
    if (cloudFeedUrl) {
      syncViaWebOrCloud(false);
      return;
    }
    toast(err?.message || '同步未完成，已保留本地数据');
  };

  window.onOfficialSyncDone = function (payload) {
    setSyncUi(false);
    if (!payload || !Array.isArray(payload.talks) || !payload.talks.length) {
      toast('官网暂无更新，保留当前排期');
      return;
    }
    // 如果返回的是完整预解析快照，直接合并
    if (payload.talks[0] && payload.talks[0]._id && payload.talks[0].startTime) {
      applyFullSnapshot(payload, false);
      return;
    }

    const now = Date.now();
    const existingBySid = Object.fromEntries(D.talks.map((t) => [String(t.sourceId), t]));
    const seenSids = new Set();
    const merged = [];

    payload.talks.forEach((raw) => {
      const m = String(raw.timeText || '').match(/(\d{4}[-.]\d{2}[-.]\d{2})\s+(\d{2}:\d{2})-(\d{2}:\d{2})/);
      if (!m || !raw.sourceId) return;
      const sid = String(raw.sourceId);
      seenSids.add(sid);
      const dateKey = m[1].replace(/\./g, '-');
      const sClock = m[2];
      const eClock = m[3];
      const [y, mo, d] = dateKey.split('-').map(Number);
      const [sh, sm] = sClock.split(':').map(Number);
      const [eh, em] = eClock.split(':').map(Number);
      const startTime = Date.UTC(y, mo - 1, d, sh, sm) - TZ8;
      const endTime = Date.UTC(y, mo - 1, d, eh, em) - TZ8;
      const prev = existingBySid[sid];
      const cancelled = Boolean(raw.isCancelled) || /取消/.test(raw.statusText || '') || /取消/.test(raw.companyName || '');
      const status = cancelled ? 'cancelled' : (endTime < now ? 'expired' : 'published');
      const loc = raw.location || prev?.location || '校内宣讲';
      const campusId = normalizeCampus(`${raw.statusText || ''} ${loc}`);

      const positions = (Array.isArray(raw.positions) && raw.positions.length) ? raw.positions : (prev?.positions || []);
      const announcement = raw.announcement || prev?.announcement || `举办地点：${loc}。点击详情可自动读取官网公告正文。`;
      const majorIds = prev?.majorIds?.length ? prev.majorIds : matchMajorsFromText(`${raw.companyName} ${positions.join(' ')} ${announcement}`);
      const collegeIds = [...new Set(majorIds.map((id) => majorById[id]?.collegeId).filter(Boolean))];

      merged.push({
        _id: `wust_${sid}`,
        sourceId: sid,
        sourceUrl: raw.sourceUrl || `https://wust.91wllm.cn/teachin/view/id/${sid}`,
        title: prev?.title || `${String(raw.companyName || '').replace(/校园招聘.*$/, '')}校园招聘宣讲会`,
        companyId: prev?.companyId || `co_${sid}`,
        companyName: raw.companyName,
        campusId,
        campusName: CAMPUS_LABEL[campusId],
        location: loc,
        originalPlace: loc,
        dateKey,
        originalDateKey: dateKey,
        weekKey: weekKeyOf(startTime),
        startTime,
        endTime,
        industryName: prev?.industryName || (/空|线上/.test((raw.statusText || '') + loc) ? '线上空中宣讲' : '校园专场招聘'),
        positions,
        requirements: prev?.requirements || `${raw.statusText ? raw.statusText + '宣讲 · ' : ''}详见官方招聘公告`,
        announcement,
        status,
        isCancelled: cancelled,
        cancelReason: cancelled ? (raw.cancelReason || prev?.cancelReason || '官网已标注取消，请留意最新通知') : '',
        collegeIds,
        collegeNames: collegeIds.map((id) => collegeById[id]?.name).filter(Boolean),
        majorIds,
        majorNames: majorIds.map((id) => majorById[id]?.name).filter(Boolean),
        jobCategories: jobCategoriesOf(positions, raw.companyName),
        sourceType: 'external',
        detailLoaded: Boolean((positions && positions.length) || raw.announcement || prev?.detailLoaded),
        createdAt: prev?.createdAt || now,
        updatedAt: now,
      });
    });

    // 保留近两日内已标记取消的历史场次（避免因官网列表隐藏取消项而丢失取消提示）
    Object.values(existingBySid).forEach((prev) => {
      const sid = String(prev.sourceId || '');
      if (!sid || seenSids.has(sid)) return;
      if (prev.isCancelled && prev.endTime >= now - 2 * DAY) {
        merged.push(prev);
      }
    });

    merged.sort((a, b) => b.startTime - a.startTime);

    if (merged.length) {
      D.talks = merged;
      if (Array.isArray(payload.jobfairs) && payload.jobfairs.length) D.jobfairs = payload.jobfairs;
      lastSyncedAt = payload.syncedAt || now;
      rebuildIndustries();
      saveJSON(STORAGE.LIVE, {
        syncedAt: lastSyncedAt,
        talks: D.talks,
        jobfairs: D.jobfairs,
      });
      const activeCnt = publicTalks(false).length;
      if (!payload.silent) {
        toast(`已同步官网 ${merged.length} 场宣讲会（${activeCnt} 场近期有效）`);
      }
      showPage(state.page, state.detailId);
    } else if (!payload.silent) {
      toast('未解析到有效宣讲会排期');
    }
  };

  window.onOfficialDetailDone = function (detail) {
    if (!detail || !detail.sourceId) return;
    const t = D.talks.find((x) => String(x.sourceId) === String(detail.sourceId));
    if (!t) return;
    if (detail.industryName) t.industryName = detail.industryName;
    if (detail.location) { t.location = detail.location; t.originalPlace = detail.location; }
    if (detail.isCancelled) {
      t.isCancelled = true;
      t.status = 'cancelled';
      t.cancelReason = detail.cancelReason || t.cancelReason || '官网已标注活动取消';
    }
    if (Array.isArray(detail.positions) && detail.positions.length) t.positions = detail.positions;
    if (detail.announcement) t.announcement = detail.announcement;
    if (detail.companyNature) t.requirements = `${detail.companyNature}${detail.companyScale ? ' · ' + detail.companyScale : ''} · 详见公告`;
    const majorIds = matchMajorsFromText(`${t.companyName} ${(t.positions || []).join(' ')} ${detail.majorsText || ''} ${t.announcement || ''}`);
    if (majorIds.length) {
      t.majorIds = majorIds;
      t.collegeIds = [...new Set(majorIds.map((id) => majorById[id]?.collegeId).filter(Boolean))];
      t.collegeNames = t.collegeIds.map((id) => collegeById[id]?.name).filter(Boolean);
      t.majorNames = majorIds.map((id) => majorById[id]?.name).filter(Boolean);
    }
    t.jobCategories = jobCategoriesOf(t.positions, t.companyName);
    t.detailLoaded = true;
    rebuildIndustries();
    saveJSON(STORAGE.LIVE, { syncedAt: lastSyncedAt || Date.now(), talks: D.talks, jobfairs: D.jobfairs });
    if (state.page === 'detail' && state.detailId === t._id) {
      renderDetail(t._id, true);
    }
  };

  // ---------- 首页渲染 ----------
  function renderHome() {
    const now = Date.now();
    const today = dateKeyOf(now);
    const wk = weekKeyOf(now);
    const activeAll = publicTalks(false);
    const todayTotal = D.talks.filter((t) => t.dateKey === today && !isCancelled(t)).length;
    const weekList = queryTalks({ preset: 'thisWeek', includeExpired: true });
    const matchedCount = hasPref()
      ? activeAll.filter((t) => computeMatch(t).pct >= 50).length
      : D.talks.length;

    const badgeEl = document.getElementById('hero-sync-badge');
    if (badgeEl) {
      badgeEl.textContent = lastSyncedAt ? `已同步 ${hhmm(lastSyncedAt)}` : `数据基准 ${D.today || today}`;
    }
    const syncTextEl = document.getElementById('sync-status-text');
    if (syncTextEl) {
      syncTextEl.textContent = lastSyncedAt
        ? `最近同步：${dateKeyOf(lastSyncedAt)} ${hhmm(lastSyncedAt)}（共 ${D.talks.length} 场）`
        : `内置官网实时排期（${D.today || today}），点击可抓取更新`;
    }

    document.getElementById('hero-date').innerHTML =
      `<span>${esc(today)} ${weekdayLabel(today)}</span><span class="wk">· ${esc(wk)}</span>`;
    document.getElementById('hero-greeting').textContent = hasPref()
      ? '为你精选的宣讲日程'
      : '校园宣讲日程';

    document.getElementById('hero-stats').innerHTML = `
      <div class="stat"><b>${activeAll.length}</b><span>待举办场次</span></div>
      <div class="stat"><b>${todayTotal}</b><span>今日排期</span></div>
      <div class="stat"><b>${weekList.length}</b><span>本周排期</span></div>
      <div class="stat"><b>${matchedCount}</b><span>${hasPref() ? '偏好匹配' : '总收录场次'}</span></div>
    `;

    const hotWords = ['升学就业', '南京医药', '华清电子', '沙钢', '远光软件', '管培生'];
    document.getElementById('hot-words').innerHTML =
      '<span>常搜</span>' + hotWords.map((w) => `<button data-hot="${esc(w)}">${esc(w)}</button>`).join('');
    document.querySelectorAll('#hot-words button').forEach((b) => {
      b.onclick = () => {
        state.homeKeyword = b.dataset.hot;
        document.getElementById('home-search').value = state.homeKeyword;
        document.getElementById('home-search-clear').classList.remove('hidden');
        renderHomeFeed();
      };
    });

    const nextTalk = activeAll
      .filter((t) => !isCancelled(t) && t.endTime >= now)
      .sort((a, b) => a.startTime - b.startTime)[0];
    const spotWrap = document.getElementById('spotlight-wrap');
    if (nextTalk) {
      const live = isLive(nextTalk, now);
      spotWrap.innerHTML = `<div class="spotlight" id="spotlight-card">
        <div class="spotlight-head">
          <div class="label ${live ? 'is-live' : ''}"><span class="pulse"></span><span>${live ? '正在进行' : '下一场宣讲'}</span></div>
          <span class="spotlight-arrow">查看详情 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></span>
        </div>
        <h4>${esc(nextTalk.companyName)}</h4>
        <div class="spotlight-foot">
          <div class="meta">
            <div>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
              <span>${esc(nextTalk.dateKey)} ${weekdayLabel(nextTalk.dateKey)} ${hhmm(nextTalk.startTime)}–${hhmm(nextTalk.endTime)}</span>
            </div>
            <div>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6-5.4-6-10a6 6 0 1 1 12 0c0 4.6-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/></svg>
              <span>${esc(nextTalk.campusName)} · ${esc(nextTalk.originalPlace || nextTalk.location)}</span>
            </div>
          </div>
          <div class="countdown" data-countdown-start="${nextTalk.startTime}" data-countdown-end="${nextTalk.endTime}"></div>
        </div>
      </div>`;
      document.getElementById('spotlight-card').onclick = () => showPage('detail', nextTalk._id);
      updateCountdowns();
    } else {
      spotWrap.innerHTML = '';
    }

    const countsByDate = {};
    D.talks.forEach((t) => { countsByDate[t.dateKey] = (countsByDate[t.dateKey] || 0) + 1; });
    const stripDays = Array.from({ length: 14 }, (_, i) => addDays(today, i));
    document.getElementById('date-strip').innerHTML =
      `<button class="dchip all ${!state.homeDate ? 'active' : ''}" data-day="">
        <div class="w">全部</div><div class="d">近期</div><div class="n has">${activeAll.length}场</div>
      </button>` +
      stripDays.map((day) => {
        const cnt = countsByDate[day] || 0;
        const dd = day.slice(8);
        const w = day === today ? '今天' : weekdayLabel(day);
        return `<button class="dchip ${day === today ? 'today' : ''} ${state.homeDate === day ? 'active' : ''}" data-day="${day}">
          <div class="w">${w}</div><div class="d">${dd}</div>
          <div class="n ${cnt ? 'has' : ''}">${cnt ? `${cnt}场` : ''}</div>
        </button>`;
      }).join('');
    document.querySelectorAll('#date-strip .dchip').forEach((b) => {
      b.onclick = () => {
        state.homeDate = b.dataset.day;
        state.homeQuick = 'all';
        renderHome();
      };
    });

    const quicks = [
      ['all', '全部近期'],
      ...(hasPref() ? [['match', '偏好推荐']] : []),
      ['today', '今天'],
      ['tomorrow', '明天'],
      ['thisWeek', '本周'],
      ['campus_qingshan', '青山校区'],
      ['campus_hongshan', '洪山校区'],
      ['campus_other', '线上 / 其他'],
      ['job_研发技术', '研发技术'],
      ['job_工程制造', '工程制造'],
    ];
    document.getElementById('quick-chips').innerHTML = quicks.map(([v, l]) => (
      `<button class="chip ${state.homeQuick === v && !state.homeDate ? 'active' : ''}" data-q="${esc(v)}">${esc(l)}</button>`
    )).join('');
    document.querySelectorAll('#quick-chips button').forEach((b) => {
      b.onclick = () => {
        state.homeQuick = b.dataset.q;
        state.homeDate = '';
        renderHome();
      };
    });

    const ctaWrap = document.getElementById('pref-cta-wrap');
    if (hasPref()) {
      const done = [pref.campuses, pref.colleges, pref.majors, pref.jobs].filter((a) => a.length > 0).length;
      ctaWrap.innerHTML = `<div class="cta" id="home-pref-cta">
        <div class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></div>
        <div><b>已启用 ${done}/4 项求职偏好</b><span>一键筛选符合专业与方向的场次</span></div>
        <span class="arrow">筛选 ›</span>
      </div>`;
      document.getElementById('home-pref-cta').onclick = () => { applyPrefToFilter(); showPage('filter'); };
    } else {
      ctaWrap.innerHTML = `<div class="cta" id="home-pref-cta">
        <div class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.8"/><path d="M5 20.5c.8-3.6 3.5-5.5 7-5.5s6.2 1.9 7 5.5"/></svg></div>
        <div><b>定制专业与岗位偏好</b><span>为每场宣讲会计算匹配度百分比</span></div>
        <span class="arrow">设置 ›</span>
      </div>`;
      document.getElementById('home-pref-cta').onclick = () => showPage('profile');
    }

    const weekDays = Array.from({ length: 7 }, (_, i) => addDays(today, i));
    const maxCnt = Math.max(1, ...weekDays.map((d) => countsByDate[d] || 0));
    document.getElementById('home-week-bars').innerHTML = weekDays.map((d) => {
      const cnt = countsByDate[d] || 0;
      const h = cnt ? Math.max(16, Math.round((cnt / maxCnt) * 72)) : 5;
      const lbl = d === today ? '今' : weekdayLabel(d).replace('周', '');
      return `<div class="bar ${cnt === 0 ? 'zero' : ''} ${d === today ? 'today' : ''} ${state.homeDate === d ? 'selected' : ''}" data-day="${d}" title="${d}：${cnt} 场">
        <b>${cnt || ''}</b>
        <i style="height:${h}px"></i>
        <span>${lbl}</span>
      </div>`;
    }).join('');
    document.querySelectorAll('#home-week-bars .bar').forEach((bar) => {
      bar.onclick = () => {
        state.homeDate = bar.dataset.day;
        state.homeQuick = 'all';
        renderHome();
      };
    });

    const fairs = D.jobfairs || [];
    document.getElementById('jobfairs-count').textContent = `${fairs.length} 场`;
    document.getElementById('jobfairs-list').innerHTML = fairs.map((f, idx) => {
      const m = String(f.date || '').match(/(\d{4})-(\d{2})-(\d{2})/);
      const mm = m ? `${Number(m[2])}月` : '双选';
      const dd = m ? m[3] : '--';
      return `<div class="fair" data-fair="${idx}">
        <div class="cal"><div class="m">${mm}</div><div class="d">${dd}</div></div>
        <div style="min-width:0">
          <div class="t">${esc(f.title)}</div>
          <div class="s">${esc(f.date)} · ${esc(f.place)}</div>
        </div>
      </div>`;
    }).join('');
    document.querySelectorAll('#jobfairs-list .fair').forEach((el) => {
      el.onclick = () => openJobfairSheet(fairs[Number(el.dataset.fair)]);
    });

    renderHomeFeed();
  }

  function renderHomeFeed() {
    const q = state.homeQuick;
    const opts = {
      keyword: state.homeKeyword,
      dateKey: state.homeDate || undefined,
      preset: ['today', 'tomorrow', 'thisWeek'].includes(q) ? q : 'all',
      campuses: q.startsWith('campus_') ? [q] : [],
      jobs: q.startsWith('job_') ? [q.slice(4)] : [],
      sort: q === 'match' ? 'match' : 'time',
      includeExpired: Boolean(state.homeKeyword || state.homeDate),
    };
    let list = queryTalks(opts);
    if (q === 'match' && hasPref()) list = list.filter((t) => computeMatch(t).pct > 0);

    const titleMap = {
      all: state.homeDate ? `${state.homeDate} ${weekdayLabel(state.homeDate)}` : '近期待举办宣讲',
      match: '偏好推荐宣讲',
      today: '今日宣讲',
      tomorrow: '明日宣讲',
      thisWeek: '本周宣讲',
      campus_qingshan: '青山校区宣讲',
      campus_hongshan: '洪山校区宣讲',
      campus_other: '线上与其他校区',
    };
    const title = titleMap[q] || (q.startsWith('job_') ? `${q.slice(4)}方向` : '宣讲列表');
    document.getElementById('home-feed-title').textContent = title;
    document.getElementById('home-feed-count').textContent = `${list.length} 场`;

    const el = document.getElementById('home-feed-list');
    el.innerHTML = list.length ? list.map(cardHtml).join('') : `<div class="empty">
      <div class="art"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4.2-4.2"/></svg></div>
      <b>暂无符合条件的待举办宣讲</b>
      可点击右上角「同步官网」拉取最新排期，或查看往期已归档场次
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:16px">
        <button class="btn primary sm" id="home-empty-all">查看含已结束场次</button>
        <button class="btn line sm" id="home-empty-reset">清除条件</button>
      </div>
    </div>`;
    const allBtn = document.getElementById('home-empty-all');
    if (allBtn) {
      allBtn.onclick = () => { state.filter.includeExpired = true; showPage('filter'); };
    }
    const resetBtn = document.getElementById('home-empty-reset');
    if (resetBtn) {
      resetBtn.onclick = () => {
        state.homeDate = ''; state.homeQuick = 'all'; state.homeKeyword = '';
        document.getElementById('home-search').value = '';
        document.getElementById('home-search-clear').classList.add('hidden');
        renderHome();
      };
    }
    bindTalkInteractions(el);
  }

  // ---------- 筛选页 ----------
  function renderChipGroup(id, items, selected, onClick) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = items.length ? items.map(([v, l]) => (
      `<button class="chip sm ${selected.includes(v) ? 'active' : ''}" data-v="${esc(v)}">${esc(l)}</button>`
    )).join('') : '<span style="font-size:12.5px;color:var(--muted)">请先在上方选择至少一个学院</span>';
    el.querySelectorAll('button').forEach((b) => { b.onclick = () => onClick(b.dataset.v); });
  }

  function renderFilter() {
    const f = state.filter;
    const today = dateKeyOf(Date.now());
    if (!f.dateFrom) f.dateFrom = today;
    if (!f.dateTo) f.dateTo = addDays(today, 14);

    const timeOpts = [
      ['all', '全部'], ['today', '今天'], ['tomorrow', '明天'],
      ['next3days', '未来三天'], ['thisWeek', '本周'], ['custom', '自定义'],
    ];
    renderChipGroup('f-time', timeOpts, [f.timePreset], (v) => { f.timePreset = v; renderFilter(); });
    document.getElementById('f-custom-wrap').classList.toggle('hidden', f.timePreset !== 'custom');
    const fromEl = document.getElementById('f-date-from');
    const toEl = document.getElementById('f-date-to');
    if (fromEl.value !== f.dateFrom) fromEl.value = f.dateFrom;
    if (toEl.value !== f.dateTo) toEl.value = f.dateTo;

    const hintEl = document.getElementById('f-date-hint');
    if (f.timePreset === 'custom') {
      const check = validateCustomRange(f.dateFrom, f.dateTo);
      hintEl.textContent = check.valid
        ? `闭区间共 ${check.days} 天（含结束日全天）`
        : check.msg;
      hintEl.style.color = check.valid ? 'var(--muted)' : 'var(--red)';
    }

    renderChipGroup('f-campus', D.campuses.map((c) => [c._id, c.name]), f.campuses, (v) => {
      toggleArr(f.campuses, v);
      renderFilter();
    });

    const colleges = OFF.colleges || [];
    const shownColleges = f.collegesExpanded ? colleges : colleges.slice(0, 10);
    renderChipGroup('f-college', shownColleges.map((c) => [c.id, c.name]), f.colleges, (v) => {
      toggleArr(f.colleges, v);
      const allowed = new Set(f.colleges.flatMap((cid) => (majorsByCollege[cid] || []).map((m) => m.id)));
      f.majors = f.majors.filter((m) => allowed.has(m));
      renderFilter();
    });
    const moreBtn = document.getElementById('f-college-more');
    moreBtn.classList.toggle('hidden', colleges.length <= 10);
    moreBtn.textContent = f.collegesExpanded ? '收起部分学院' : `展开全部 ${colleges.length} 个学院`;
    moreBtn.onclick = () => { f.collegesExpanded = !f.collegesExpanded; renderFilter(); };

    const visibleMajors = f.colleges.length ? f.colleges.flatMap((cid) => majorsByCollege[cid] || []) : [];
    document.getElementById('f-major-hint').textContent = f.colleges.length
      ? `已联动 ${visibleMajors.length} 个专业`
      : '请先选学院';
    renderChipGroup('f-major', visibleMajors.map((m) => [m.id, m.name]), f.majors, (v) => {
      toggleArr(f.majors, v);
      renderFilter();
    });

    renderChipGroup('f-job', (D.jobCategories || []).map((j) => [j.name, j.name]), f.jobs, (v) => {
      toggleArr(f.jobs, v);
      renderFilter();
    });
    renderChipGroup('f-industry', (D.industries || []).map((i) => [i._id, i.name]), f.industries, (v) => {
      toggleArr(f.industries, v);
      renderFilter();
    });

    document.querySelectorAll('#f-sort-seg button').forEach((b) => b.classList.toggle('active', b.dataset.sort === f.sort));
    document.querySelectorAll('#f-group-seg button').forEach((b) => b.classList.toggle('active', b.dataset.group === f.group));
    document.getElementById('f-include-expired').classList.toggle('active', f.includeExpired);

    const activeCount = f.campuses.length + f.colleges.length + f.majors.length + f.jobs.length + f.industries.length
      + (f.timePreset !== 'all' ? 1 : 0) + (f.keyword ? 1 : 0);
    const isCollapsed = document.getElementById('filter-side').classList.contains('collapsed');
    document.getElementById('filter-toggle-n').textContent = activeCount
      ? `已选 ${activeCount} 项 · ${isCollapsed ? '展开' : '收起'}`
      : (isCollapsed ? '展开' : '收起');

    const activeTags = [];
    if (f.timePreset !== 'all') activeTags.push({ label: `${timeOpts.find((x) => x[0] === f.timePreset)?.[1]}`, clear: () => { f.timePreset = 'all'; } });
    f.campuses.forEach((id) => activeTags.push({ label: campusById[id]?.name || id, clear: () => toggleArr(f.campuses, id) }));
    f.colleges.forEach((id) => activeTags.push({ label: collegeById[id]?.name || id, clear: () => { toggleArr(f.colleges, id); f.majors = f.majors.filter((m) => majorById[m]?.collegeId !== id); } }));
    f.majors.forEach((id) => activeTags.push({ label: majorById[id]?.name || id, clear: () => toggleArr(f.majors, id) }));
    f.jobs.forEach((n) => activeTags.push({ label: n, clear: () => toggleArr(f.jobs, n) }));
    f.industries.forEach((id) => activeTags.push({ label: getIndustryById(id)?.name || id, clear: () => toggleArr(f.industries, id) }));
    if (f.keyword) activeTags.push({ label: `“${f.keyword}”`, clear: () => { f.keyword = ''; document.getElementById('filter-search').value = ''; } });

    const tagsEl = document.getElementById('f-active-tags');
    tagsEl.innerHTML = activeTags.map((t, idx) => `<button class="chip sm" data-rm="${idx}">${esc(t.label)} <span class="x">×</span></button>`).join('');
    tagsEl.querySelectorAll('button').forEach((b) => {
      b.onclick = () => { activeTags[Number(b.dataset.rm)].clear(); renderFilter(); };
    });

    const list = queryTalks({
      keyword: f.keyword,
      preset: f.timePreset,
      dateFrom: f.dateFrom,
      dateTo: f.dateTo,
      campuses: f.campuses,
      colleges: f.colleges,
      majors: f.majors,
      jobs: f.jobs,
      industries: f.industries,
      includeExpired: f.includeExpired,
      sort: f.sort,
    });
    document.getElementById('f-result-count').innerHTML = `共 <b>${list.length}</b> 场 · ${f.sort === 'match' && hasPref() ? '匹配度优先' : '时间升序'}`;

    const listEl = document.getElementById('f-list');
    if (!list.length) {
      listEl.innerHTML = `<div class="list"><div class="empty">
        <div class="art"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"><path d="M4 7h16M7 12h10M10 17h4"/></svg></div>
        <b>没有符合条件的宣讲会</b>
        可开启「含已结束」浏览往期归档场次，或重置筛选条件
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:16px">
          ${!f.includeExpired ? '<button class="btn primary sm" id="f-empty-exp">显示含已结束场次</button>' : ''}
          <button class="btn line sm" id="f-empty-clear">重置条件</button>
        </div>
      </div></div>`;
      const expBtn = document.getElementById('f-empty-exp');
      if (expBtn) expBtn.onclick = () => { f.includeExpired = true; renderFilter(); };
      const clrBtn = document.getElementById('f-empty-clear');
      if (clrBtn) clrBtn.onclick = resetFilter;
      return;
    }

    if (f.group === 'date') {
      const groups = new Map();
      list.forEach((t) => {
        if (!groups.has(t.dateKey)) groups.set(t.dateKey, []);
        groups.get(t.dateKey).push(t);
      });
      listEl.innerHTML = [...groups.entries()].map(([dk, items]) => `
        <div class="date-group">
          <div class="date-head"><b>${esc(dk)}</b><span>${weekdayLabel(dk)} · ${items.length} 场</span><i></i></div>
          <div class="list grid2">${items.map(cardHtml).join('')}</div>
        </div>
      `).join('');
    } else {
      listEl.innerHTML = `<div class="list grid2">${list.map(cardHtml).join('')}</div>`;
    }
    bindTalkInteractions(listEl);
  }

  function resetFilter() {
    state.filter.keyword = '';
    state.filter.timePreset = 'all';
    state.filter.campuses = [];
    state.filter.colleges = [];
    state.filter.majors = [];
    state.filter.jobs = [];
    state.filter.industries = [];
    state.filter.includeExpired = false;
    document.getElementById('filter-search').value = '';
    renderFilter();
    toast('已重置筛选条件');
  }

  function applyPrefToFilter() {
    state.filter.campuses = [...pref.campuses];
    state.filter.colleges = [...pref.colleges];
    state.filter.majors = [...pref.majors];
    state.filter.jobs = [...pref.jobs];
    state.filter.timePreset = 'all';
    state.filter.sort = hasPref() ? 'match' : 'time';
  }

  // ---------- 日历页 ----------
  function renderCalendar() {
    const today = dateKeyOf(Date.now());
    if (!state.calendar.year) {
      const [y, m] = today.split('-').map(Number);
      state.calendar.year = y;
      state.calendar.month = m;
      state.calendar.selectedDay = today;
    }
    const { year, month, selectedDay } = state.calendar;
    document.getElementById('cal-title').textContent = `${year} 年 ${month} 月`;

    const byDay = {};
    D.talks.forEach((t) => { (byDay[t.dateKey] ||= []).push(t); });

    const firstMs = Date.UTC(year, month - 1, 1);
    const firstWd = (new Date(firstMs).getUTCDay() + 6) % 7;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const cells = [];
    for (let i = firstWd - 1; i >= 0; i -= 1) {
      const d = new Date(firstMs - (i + 1) * DAY);
      cells.push({ dk: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, day: d.getUTCDate(), out: true });
    }
    for (let d = 1; d <= daysInMonth; d += 1) {
      cells.push({ dk: `${year}-${pad(month)}-${pad(d)}`, day: d, out: false });
    }
    while (cells.length % 7 !== 0) {
      const idx = cells.length - firstWd - daysInMonth + 1;
      const d = new Date(Date.UTC(year, month, idx));
      cells.push({ dk: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, day: d.getUTCDate(), out: true });
    }

    const wdHeaders = ['一', '二', '三', '四', '五', '六', '日'].map((w) => `<div class="wd">${w}</div>`).join('');
    document.getElementById('cal-grid').innerHTML = wdHeaders + cells.map((c) => {
      const items = byDay[c.dk] || [];
      const heat = items.length >= 3 ? 'heat-3' : items.length === 2 ? 'heat-2' : items.length === 1 ? 'heat-1' : '';
      const dots = items.slice(0, 4).map((t) => `<i class="${isCancelled(t) ? 'c' : ''}"></i>`).join('');
      return `<button class="cal-day ${c.out ? 'out' : ''} ${c.dk === today ? 'today' : ''} ${c.dk === selectedDay ? 'sel' : ''} ${heat}" data-cal="${c.dk}">
        <span>${c.day}</span>
        <div class="dots">${dots}</div>
      </button>`;
    }).join('');
    document.querySelectorAll('#cal-grid .cal-day').forEach((b) => {
      b.onclick = () => { state.calendar.selectedDay = b.dataset.cal; renderCalendar(); };
    });

    const dayTalks = (byDay[selectedDay] || []).slice().sort((a, b) => a.startTime - b.startTime);
    document.getElementById('cal-day-title').textContent = `${selectedDay} ${weekdayLabel(selectedDay)}`;
    document.getElementById('cal-day-count').textContent = `${dayTalks.length} 场`;
    const listEl = document.getElementById('cal-day-list');
    listEl.innerHTML = dayTalks.length ? dayTalks.map(cardHtml).join('') : `<div class="empty">
      <div class="art"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 10h18"/></svg></div>
      <b>当日暂无排期</b>
      点选日历中带有蓝点的日期可查看对应场次
    </div>`;
    bindTalkInteractions(listEl);
  }

  // ---------- 详情页 ----------
  function addToCalendar(t) {
    if (BRIDGE && typeof BRIDGE.addCalendarEvent === 'function') {
      const desc = [
        `招聘岗位：${(t.positions || []).join('、') || '详见官网公告'}`,
        t.announcement || '',
        t.sourceUrl ? `官方公告：${t.sourceUrl}` : '',
      ].filter(Boolean).join('\n');
      BRIDGE.addCalendarEvent(
        `${t.companyName} · ${t.title}`,
        `${t.campusName} ${t.originalPlace || t.location}`,
        desc,
        t.startTime,
        t.endTime,
      );
      return;
    }
    const fmt = (ms) => {
      const d = new Date(ms);
      return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
    };
    const escIcs = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//WUST Talks//ZH', 'BEGIN:VEVENT',
      `UID:${t._id}@wust-talks`, `DTSTAMP:${fmt(Date.now())}`, `DTSTART:${fmt(t.startTime)}`, `DTEND:${fmt(t.endTime)}`,
      `SUMMARY:${escIcs(`${t.companyName} · ${t.title}`)}`,
      `LOCATION:${escIcs(`${t.campusName} ${t.originalPlace || t.location}`)}`,
      `DESCRIPTION:${escIcs(`岗位：${(t.positions || []).join('、')}`)}`,
      'END:VEVENT', 'END:VCALENDAR',
    ];
    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${t.companyName}-${t.dateKey}.ics`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已导出日历文件 (.ics)');
  }

  function recordHistory(id) {
    history = [{ id, at: Date.now() }, ...history.filter((x) => x.id !== id)].slice(0, 20);
    saveJSON(STORAGE.HIST, history);
  }

  function renderDetail(id, skipRemoteFetch = false) {
    const t = D.talks.find((x) => x._id === id);
    if (!t) return;
    state.detailId = id;
    recordHistory(id);

    if (!skipRemoteFetch && t.sourceId && !t.detailLoaded) {
      if (BRIDGE && typeof BRIDGE.fetchTalkDetail === 'function') {
        BRIDGE.fetchTalkDetail(String(t.sourceId));
      } else if (location.hostname !== 'appassets.androidplatform.net' && /^https?:$/i.test(location.protocol)) {
        fetchJsonWithBust(`/api/detail?id=${encodeURIComponent(t.sourceId)}`, 10000)
          .then((det) => { if (det && det.ok) window.onOfficialDetailDone(det); })
          .catch(() => {});
      }
    }

    const now = Date.now();
    const fav = favorites.has(t._id);
    const cancel = isCancelled(t);
    const ended = isEnded(t, now);
    const m = computeMatch(t);

    const matchHtml = m.configured ? (() => {
      const r = 24;
      const circ = 2 * Math.PI * r;
      const dash = (m.pct / 100) * circ;
      return `<div class="panel" style="margin-top:16px">
        <div class="panel-head" style="margin-bottom:10px"><h4>偏好匹配评估</h4></div>
        <div class="match-meter">
          <div class="ring"><svg viewBox="0 0 60 60"><circle cx="30" cy="30" r="${r}" fill="none" stroke="var(--fill)" stroke-width="5"/><circle cx="30" cy="30" r="${r}" fill="none" stroke="var(--accent)" stroke-width="5" stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}"/></svg><b>${m.pct}%</b></div>
          <div><p>${m.hits.length ? `命中项：<b>${esc(m.hits.join('、'))}</b>` : '该宣讲会与你当前设置的偏好暂未重合，可作为跨专业了解。'}</p></div>
        </div>
      </div>`;
    })() : '';

    const row = (icon, k, v, copyVal) => `<div class="info-row">
      <div class="ii">${icon}</div>
      <div style="flex:1;min-width:0"><div class="k">${k}</div><div class="v">${v || '—'}</div></div>
      ${copyVal ? `<button class="btn line sm copy" data-copy="${esc(copyVal)}">复制</button>` : ''}
    </div>`;

    const icoCal = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>';
    const icoPin = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6-5.4-6-10a6 6 0 1 1 12 0c0 4.6-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/></svg>';
    const icoEdu = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10l9-5 9 5-9 5-9-5z"/><path d="M6 12v5c3 2 9 2 12 0v-5"/></svg>';
    const icoBag = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

    document.getElementById('detail-content').innerHTML = `
      <div class="d-header-card">
        <div class="d-cover-top">
          <div class="logo lg" aria-hidden="true">${esc(shortCompany(t.companyName))}</div>
          <div style="min-width:0">
            <div class="d-company">${esc(t.companyName)}</div>
            <div class="d-industry">${esc(t.industryName || '校园招聘企业')}</div>
          </div>
        </div>
        <h2>${esc(t.title)}</h2>
        <div class="badges">${statusBadgesHtml(t, now)}</div>
        ${(!cancel && !ended) ? `<div class="d-count">
          <span class="txt">${isLive(t, now) ? '宣讲正在进行中' : '距离开始还有'}</span>
          <div class="countdown" data-countdown-start="${t.startTime}" data-countdown-end="${t.endTime}"></div>
        </div>` : ''}
      </div>

      ${cancel ? `<div class="cancel-note">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
        <div><b>本场宣讲会已取消</b>${t.cancelReason ? `：${esc(t.cancelReason)}` : ''}（保留归档信息供查阅）</div>
      </div>` : ''}

      <div class="actions">
        <button class="action ${fav ? 'on' : ''}" id="act-fav">
          <span class="ai"><svg viewBox="0 0 24 24" fill="${fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.85"><path d="M12 20.5s-7-4.35-9.2-8.4C1.1 8.9 2.9 5 6.6 5c2.1 0 3.6 1.1 4.4 2.3L12 8.7l1-1.4C13.8 6.1 15.3 5 17.4 5c3.7 0 5.5 3.9 3.8 7.1-2.2 4.05-9.2 8.4-9.2 8.4z"/></svg></span>
          <span>${fav ? '已收藏' : '收藏'}</span>
        </button>
        <button class="action" id="act-ics">
          <span class="ai">${icoCal}</span>
          <span>加入日历</span>
        </button>
        <button class="action" id="act-share">
          <span class="ai"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg></span>
          <span>分享</span>
        </button>
        <button class="action" id="act-url">
          <span class="ai"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></span>
          <span>复制链接</span>
        </button>
      </div>

      ${matchHtml}

      <div class="panel" style="margin-top:16px">
        <div class="panel-head" style="margin-bottom:8px"><h4>时间与地点</h4></div>
        <div class="info-rows">
          ${row(icoCal, '日期与时段', `<b>${esc(t.dateKey)} ${weekdayLabel(t.dateKey)}</b> · ${hhmm(t.startTime)}–${hhmm(t.endTime)}`)}
          ${row(icoPin, '举办教室', `${esc(t.campusName)} · ${esc(t.originalPlace || t.location)}`, `${t.campusName} ${t.originalPlace || t.location}`)}
          ${row(icoEdu, '面向学院与专业', `
            <div>${esc((t.collegeNames || []).join('、') || '全校相关学院')}</div>
            ${(t.majorNames || []).length ? `<div class="tags">${(t.majorNames || []).map((n) => `<span class="tag">${esc(n)}</span>`).join('')}</div>` : ''}
          `)}
          ${row(icoBag, '岗位方向与要求', `
            <div class="tags">${(t.jobCategories || []).map((n) => `<span class="tag">${esc(n)}</span>`).join('')}</div>
            <div style="margin-top:6px;font-size:13.5px;color:var(--muted)">${esc(t.requirements || '详见下方企业公告')}</div>
          `)}
        </div>
      </div>

      <div class="panel" style="margin-top:16px">
        <div class="panel-head">
          <h4>招聘岗位</h4>
          <span class="sub">${(t.positions || []).length} 个岗位</span>
        </div>
        <div class="tags">${(t.positions || []).map((p) => `<span class="tag">${esc(p)}</span>`).join('') || '<span style="font-size:13.5px;color:var(--muted)">详见下方公告正文或官网原文</span>'}</div>
      </div>

      <div class="panel" style="margin-top:16px">
        <div class="panel-head"><h4>招聘公告</h4></div>
        <p class="prose">${esc(t.announcement || '暂无详细公告正文')}</p>
      </div>

      <div class="panel" style="margin-top:16px">
        <div class="panel-head"><h4>官方信息来源</h4></div>
        <div class="source-box">
          <div>武汉科技大学本科生就业信息网</div>
          ${t.sourceUrl ? `<div class="source-url">
            <code>${esc(t.sourceUrl)}</code>
            <button class="btn line sm" id="btn-copy-source">复制</button>
            <button class="btn primary sm" id="btn-open-source">打开</button>
          </div>` : ''}
        </div>
      </div>
    `;

    const dbFav = document.getElementById('db-fav');
    dbFav.className = `btn ${fav ? 'fav-on' : 'primary'}`;
    dbFav.textContent = fav ? '已收藏宣讲会' : '收藏宣讲会';
    dbFav.onclick = () => toggleFavorite(t._id);
    document.getElementById('db-ics').onclick = () => addToCalendar(t);

    document.getElementById('act-fav').onclick = () => toggleFavorite(t._id);
    document.getElementById('act-ics').onclick = () => addToCalendar(t);
    document.getElementById('act-share').onclick = () => {
      const summary = [
        `【武科大宣讲会】${t.companyName}`,
        `主题：${t.title}`,
        `时间：${t.dateKey}（${weekdayLabel(t.dateKey)}）${hhmm(t.startTime)}-${hhmm(t.endTime)}`,
        `地点：${t.campusName} · ${t.originalPlace || t.location}`,
        `岗位：${(t.positions || []).join('、') || '详见公告'}`,
        t.sourceUrl ? `官网公告：${t.sourceUrl}` : '',
      ].filter(Boolean).join('\n');
      if (BRIDGE && typeof BRIDGE.shareText === 'function') {
        BRIDGE.shareText(`${t.companyName}宣讲会`, summary);
      } else {
        copyText(summary, '已复制宣讲会摘要');
      }
    };
    document.getElementById('act-url').onclick = () => {
      if (t.sourceUrl) copyText(t.sourceUrl, '已复制官方公告链接');
      else toast('暂无官网链接');
    };
    const copySourceBtn = document.getElementById('btn-copy-source');
    if (copySourceBtn) copySourceBtn.onclick = () => copyText(t.sourceUrl, '已复制官方公告链接');
    const openSourceBtn = document.getElementById('btn-open-source');
    if (openSourceBtn) {
      openSourceBtn.onclick = () => {
        if (BRIDGE && typeof BRIDGE.openExternalUrl === 'function') BRIDGE.openExternalUrl(t.sourceUrl);
        else copyText(t.sourceUrl, '已复制官方公告链接');
      };
    }

    document.querySelectorAll('#detail-content [data-copy]').forEach((b) => {
      b.onclick = () => copyText(b.dataset.copy, '已复制地点信息');
    });
    updateCountdowns();
  }

  function openJobfairSheet(f) {
    if (!f) return;
    const mask = document.getElementById('sheet-mask');
    const sheet = document.getElementById('sheet');
    sheet.innerHTML = `
      <div class="grip"></div>
      <h3>${esc(f.title)}</h3>
      <div class="info-rows" style="margin-top:14px">
        <div class="info-row"><div style="flex:1"><div class="k">举办时间</div><div class="v"><b>${esc(f.date)}</b></div></div></div>
        <div class="info-row"><div style="flex:1"><div class="k">举办地点</div><div class="v">${esc(f.place)}</div></div></div>
        <div class="info-row"><div style="flex:1"><div class="k">官方公告链接</div>
          <div class="source-url"><code>${esc(f.url)}</code></div>
        </div></div>
      </div>
      <div class="sheet-actions">
        <button class="btn line" id="sheet-copy-url">复制链接</button>
        <button class="btn primary" id="sheet-open-url">外部浏览器打开</button>
        <button class="btn line" id="sheet-close">关闭</button>
      </div>
    `;
    mask.classList.remove('hidden');
    requestAnimationFrame(() => mask.classList.add('show'));
    document.getElementById('sheet-copy-url').onclick = () => copyText(f.url, '已复制双选会链接');
    document.getElementById('sheet-open-url').onclick = () => {
      if (BRIDGE && typeof BRIDGE.openExternalUrl === 'function') BRIDGE.openExternalUrl(f.url);
      else copyText(f.url, '已复制双选会链接');
    };
    const close = () => {
      mask.classList.remove('show');
      setTimeout(() => mask.classList.add('hidden'), 260);
    };
    document.getElementById('sheet-close').onclick = close;
    mask.onclick = (e) => { if (e.target === mask) close(); };
  }

  function openCloudConfigSheet() {
    const mask = document.getElementById('sheet-mask');
    const sheet = document.getElementById('sheet');
    sheet.innerHTML = `
      <div class="grip"></div>
      <h3>云端自动同步源（替代 Muse）</h3>
      <p style="font-size:13px;color:var(--muted);margin-top:8px;line-height:1.6">
        将本项目推送到 GitHub 后，内置的 GitHub Actions 每 2 小时会自动抓取就业网并发布 <code>live-data.json</code>。在此填入该地址后，App 启动时将自动拉取云端最新排期（留空亦可通过手机端原生 HTTPS 直连官网）。
      </p>
      <div class="searchbox inline" style="margin-top:14px;height:44px;padding:0 12px">
        <input id="sheet-cloud-input" placeholder="https://<用户名>.github.io/<仓库名>/live-data.json" value="${esc(cloudFeedUrl)}" autocomplete="off">
      </div>
      <div class="sheet-actions">
        <button class="btn line" id="sheet-cloud-clear">恢复默认</button>
        <button class="btn primary" id="sheet-cloud-save">保存并测试</button>
      </div>
    `;
    mask.classList.remove('hidden');
    requestAnimationFrame(() => mask.classList.add('show'));
    const close = () => {
      mask.classList.remove('show');
      setTimeout(() => mask.classList.add('hidden'), 260);
    };
    document.getElementById('sheet-cloud-clear').onclick = () => {
      cloudFeedUrl = DEFAULT_CLOUD_URL;
      saveJSON(STORAGE.CLOUD, DEFAULT_CLOUD_URL);
      renderProfile();
      close();
      toast('已恢复默认 GitHub 云端同步源');
    };
    document.getElementById('sheet-cloud-save').onclick = () => {
      const val = document.getElementById('sheet-cloud-input').value.trim();
      if (val && !/^https?:\/\//i.test(val)) {
        toast('请输入以 https:// 开头的有效 JSON 地址');
        return;
      }
      cloudFeedUrl = val;
      saveJSON(STORAGE.CLOUD, cloudFeedUrl);
      renderProfile();
      close();
      if (cloudFeedUrl) syncViaWebOrCloud(false);
      else toast('已保存设置');
    };
    mask.onclick = (e) => { if (e.target === mask) close(); };
  }

  // ---------- 个人中心 ----------
  function renderProfile() {
    const cloudEl = document.getElementById('cloud-url-status');
    if (cloudEl) {
      cloudEl.textContent = cloudFeedUrl
        ? `已绑定云端源：${cloudFeedUrl}`
        : '默认启用手机端自动直连（可绑定 GitHub Pages 定时源）';
    }
    const doneSteps = [pref.campuses, pref.colleges, pref.majors, pref.jobs].filter((a) => a.length > 0).length;
    const activeMatched = hasPref() ? publicTalks(false).filter((t) => computeMatch(t).pct >= 50).length : 0;

    document.getElementById('me-pref-sub').textContent = doneSteps === 4
      ? '偏好已完整配置，宣讲列表与详情页均已启用匹配评分'
      : `已完成 ${doneSteps} / 4 项求职偏好设置`;
    document.getElementById('me-stats').innerHTML = `
      <button id="me-stat-fav"><b>${favorites.size}</b><span>收藏场次</span></button>
      <button id="me-stat-hist"><b>${history.length}</b><span>浏览足迹</span></button>
      <button id="me-stat-match"><b>${activeMatched}</b><span>偏好匹配</span></button>
    `;
    document.getElementById('me-stat-fav').onclick = () => { state.profile.tab = 'fav'; renderProfileCollections(); };
    document.getElementById('me-stat-hist').onclick = () => { state.profile.tab = 'hist'; renderProfileCollections(); };
    document.getElementById('me-stat-match').onclick = () => { applyPrefToFilter(); showPage('filter'); };

    document.getElementById('pref-progress-text').textContent = `${doneSteps} / 4`;
    document.getElementById('pref-progress-bar').style.width = `${doneSteps * 25}%`;

    const visibleMajors = pref.colleges.length ? pref.colleges.flatMap((c) => majorsByCollege[c] || []) : [];
    const steps = [
      {
        title: '意向校区',
        summary: pref.campuses.length ? pref.campuses.map((id) => campusById[id]?.name || id).join('、') : '未设置（可多选）',
        done: pref.campuses.length > 0,
        items: D.campuses.map((c) => [c._id, c.name]),
        selected: pref.campuses,
        onToggle: (v) => { toggleArr(pref.campuses, v); },
      },
      {
        title: '关注学院',
        summary: pref.colleges.length ? pref.colleges.map((id) => collegeById[id]?.name || id).join('、') : '未设置（共 24 个学院）',
        done: pref.colleges.length > 0,
        items: OFF.colleges.map((c) => [c.id, c.name]),
        selected: pref.colleges,
        onToggle: (v) => {
          toggleArr(pref.colleges, v);
          const allowed = new Set(pref.colleges.flatMap((cid) => (majorsByCollege[cid] || []).map((m) => m.id)));
          pref.majors = pref.majors.filter((m) => allowed.has(m));
        },
      },
      {
        title: '对应专业',
        summary: pref.majors.length ? pref.majors.map((id) => majorById[id]?.name || id).join('、') : (pref.colleges.length ? `已联动 ${visibleMajors.length} 个专业` : '请先在上一步选择学院'),
        done: pref.majors.length > 0,
        items: visibleMajors.map((m) => [m.id, m.name]),
        selected: pref.majors,
        onToggle: (v) => { toggleArr(pref.majors, v); },
      },
      {
        title: '岗位方向',
        summary: pref.jobs.length ? pref.jobs.join('、') : '未设置（共 9 类方向）',
        done: pref.jobs.length > 0,
        items: (D.jobCategories || []).map((j) => [j.name, j.name]),
        selected: pref.jobs,
        onToggle: (v) => { toggleArr(pref.jobs, v); },
      },
    ];

    const chevSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    const checkSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

    document.getElementById('pref-steps').innerHTML = steps.map((st, idx) => `
      <div class="step ${st.done ? 'done' : ''} ${state.profile.openStep === idx ? 'open' : ''}" data-step="${idx}">
        <button class="step-h" data-step-btn="${idx}">
          <span class="no">${st.done ? checkSvg : idx + 1}</span>
          <div class="tt"><b>${st.title}</b><span>${esc(st.summary)}</span></div>
          <span class="chev">${chevSvg}</span>
        </button>
        <div class="step-b">
          <div class="chips" style="padding-top:4px">
            ${st.items.length
              ? st.items.map(([v, l]) => `<button class="chip sm ${st.selected.includes(v) ? 'active' : ''}" data-step-opt="${idx}" data-v="${esc(v)}">${esc(l)}</button>`).join('')
              : '<span style="font-size:12.5px;color:var(--muted)">请先在「关注学院」中选择至少一个学院</span>'}
          </div>
        </div>
      </div>
    `).join('');

    document.querySelectorAll('[data-step-btn]').forEach((b) => {
      b.onclick = () => {
        const idx = Number(b.dataset.stepBtn);
        state.profile.openStep = state.profile.openStep === idx ? -1 : idx;
        renderProfile();
      };
    });
    document.querySelectorAll('[data-step-opt]').forEach((b) => {
      b.onclick = () => {
        const idx = Number(b.dataset.stepOpt);
        steps[idx].onToggle(b.dataset.v);
        saveJSON(STORAGE.PREF, pref);
        renderProfile();
      };
    });

    renderProfileCollections();
  }

  function renderProfileCollections() {
    document.querySelectorAll('#me-tab-seg button').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === state.profile.tab);
    });
    const body = document.getElementById('me-tab-body');
    if (state.profile.tab === 'fav') {
      const favs = D.talks.filter((t) => favorites.has(t._id));
      body.innerHTML = favs.length
        ? `<div class="list grid2">${favs.map(cardHtml).join('')}</div>`
        : '<div class="empty" style="border:0;padding:28px 16px"><b>暂无收藏宣讲会</b>点击卡片右上角心形图标或详情页底部按钮即可收藏</div>';
      bindTalkInteractions(body);
    } else {
      const items = history.map((h) => ({ ...h, talk: D.talks.find((t) => t._id === h.id) })).filter((x) => x.talk);
      body.innerHTML = items.length ? `<div class="history">${items.map((x) => `
        <div class="h-item" data-id="${esc(x.talk._id)}">
          <div class="logo" aria-hidden="true">${esc(shortCompany(x.talk.companyName))}</div>
          <div class="tt"><b>${esc(x.talk.companyName)}</b><span>${esc(x.talk.dateKey)} · ${esc(x.talk.campusName)}</span></div>
          <time>${hhmm(x.at)}</time>
        </div>
      `).join('')}</div>` : '<div class="empty" style="border:0;padding:28px 16px"><b>暂无浏览记录</b>查看任意宣讲会详情后将自动记录</div>';
      body.querySelectorAll('.h-item').forEach((el) => {
        el.onclick = () => showPage('detail', el.dataset.id);
      });
    }
  }

  // ---------- 页面切换 & Android 物理返回键 ----------
  function showPage(page, id) {
    if (page === 'detail' && state.page !== 'detail') state.prevPage = state.page;
    state.page = page;

    ['home', 'filter', 'calendar', 'detail', 'profile'].forEach((p) => {
      document.getElementById(`view-${p}`).classList.toggle('hidden', p !== page);
    });

    const isDetail = page === 'detail';
    document.body.classList.toggle('in-detail', isDetail);
    document.getElementById('appbar-back').classList.toggle('hidden', !isDetail);
    document.getElementById('appbar-brand').classList.toggle('hidden', isDetail);
    document.getElementById('appbar-title').classList.toggle('hidden', !isDetail);
    document.getElementById('tabbar').classList.toggle('hidden', isDetail);
    document.getElementById('detail-bottom').classList.toggle('hidden', !isDetail);

    document.querySelectorAll('#tabbar button').forEach((b) => {
      b.classList.toggle('active', b.dataset.page === page);
    });

    if (page === 'home') renderHome();
    if (page === 'filter') renderFilter();
    if (page === 'calendar') renderCalendar();
    if (page === 'detail') renderDetail(id);
    if (page === 'profile') renderProfile();

    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  window.handleAndroidBack = function () {
    const mask = document.getElementById('sheet-mask');
    if (mask && !mask.classList.contains('hidden')) {
      mask.classList.remove('show');
      setTimeout(() => mask.classList.add('hidden'), 240);
      return true;
    }
    if (state.page === 'detail') {
      showPage(state.prevPage || 'home');
      return true;
    }
    if (state.page !== 'home') {
      showPage('home');
      return true;
    }
    return false;
  };

  // ---------- 全局事件绑定 ----------
  function bindEvents() {
    document.querySelectorAll('#tabbar button').forEach((b) => {
      b.onclick = () => showPage(b.dataset.page);
    });
    document.getElementById('appbar-back').onclick = () => showPage(state.prevPage || 'home');
    document.getElementById('home-to-filter').onclick = () => showPage('filter');
    document.getElementById('btn-sync-official').onclick = () => window.syncOfficialFromAndroid(false);
    document.getElementById('btn-sync-profile').onclick = () => window.syncOfficialFromAndroid(false);
    document.getElementById('btn-open-official').onclick = () => {
      const url = 'https://wust.91wllm.cn/teachin/index';
      if (BRIDGE && typeof BRIDGE.openExternalUrl === 'function') BRIDGE.openExternalUrl(url);
      else copyText(url, '已复制武科大就业网链接');
    };

    const hs = document.getElementById('home-search');
    const hsClear = document.getElementById('home-search-clear');
    const runHomeSearch = () => {
      state.homeKeyword = hs.value.trim();
      hsClear.classList.toggle('hidden', !state.homeKeyword);
      renderHomeFeed();
    };
    hs.oninput = runHomeSearch;
    document.getElementById('home-search-go').onclick = runHomeSearch;
    hsClear.onclick = () => { hs.value = ''; runHomeSearch(); };

    document.getElementById('filter-toggle').onclick = () => {
      document.getElementById('filter-side').classList.toggle('collapsed');
      renderFilter();
    };
    document.getElementById('filter-search').oninput = (e) => {
      state.filter.keyword = e.target.value.trim();
      renderFilter();
    };
    document.getElementById('f-date-from').onchange = (e) => { state.filter.dateFrom = e.target.value; renderFilter(); };
    document.getElementById('f-date-to').onchange = (e) => { state.filter.dateTo = e.target.value; renderFilter(); };
    document.querySelectorAll('#f-sort-seg button').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.sort === 'match' && !hasPref()) { toast('请先在「我的」设置至少一项偏好'); return; }
        state.filter.sort = b.dataset.sort;
        renderFilter();
      };
    });
    document.querySelectorAll('#f-group-seg button').forEach((b) => {
      b.onclick = () => { state.filter.group = b.dataset.group; renderFilter(); };
    });
    document.getElementById('f-apply-pref').onclick = () => {
      if (!hasPref()) { toast('请先在「我的」设置偏好'); showPage('profile'); return; }
      applyPrefToFilter();
      renderFilter();
      toast('已套用求职偏好');
    };
    document.getElementById('f-include-expired').onclick = () => {
      state.filter.includeExpired = !state.filter.includeExpired;
      renderFilter();
    };
    document.getElementById('f-clear').onclick = resetFilter;

    document.getElementById('cal-prev').onclick = () => {
      state.calendar.month -= 1;
      if (state.calendar.month < 1) { state.calendar.month = 12; state.calendar.year -= 1; }
      renderCalendar();
    };
    document.getElementById('cal-next').onclick = () => {
      state.calendar.month += 1;
      if (state.calendar.month > 12) { state.calendar.month = 1; state.calendar.year += 1; }
      renderCalendar();
    };
    document.getElementById('cal-today').onclick = () => {
      const today = dateKeyOf(Date.now());
      const [y, m] = today.split('-').map(Number);
      state.calendar.year = y; state.calendar.month = m; state.calendar.selectedDay = today;
      renderCalendar();
    };

    document.getElementById('btn-use-pref').onclick = () => { applyPrefToFilter(); showPage('filter'); toast('已按个人偏好筛选'); };
    document.getElementById('btn-clear-pref').onclick = () => {
      pref = emptyPref();
      saveJSON(STORAGE.PREF, pref);
      renderProfile();
      toast('已清空求职偏好');
    };
    document.querySelectorAll('#me-tab-seg button').forEach((b) => {
      b.onclick = () => { state.profile.tab = b.dataset.tab; renderProfileCollections(); };
    });
    document.getElementById('btn-theme').onclick = () => {
      const order = ['auto', 'light', 'dark'];
      const next = order[(order.indexOf(theme) + 1) % order.length];
      applyTheme(next);
      toast(`外观已切换：${next === 'auto' ? '跟随系统' : next === 'light' ? '浅色模式' : '深色模式'}`);
    };
    document.querySelectorAll('#set-theme button').forEach((b) => {
      b.onclick = () => applyTheme(b.dataset.theme);
    });
    const cfgBtn = document.getElementById('btn-config-cloud');
    if (cfgBtn) cfgBtn.onclick = openCloudConfigSheet;

    document.getElementById('btn-reset-local').onclick = () => {
      Object.values(STORAGE).forEach((k) => localStorage.removeItem(k));
      favorites = new Set();
      pref = emptyPref();
      history = [];
      cloudFeedUrl = DEFAULT_CLOUD_URL;
      updateFavBadge();
      applyTheme('auto');
      renderProfile();
      toast('已还原本地缓存数据');
    };
  }

  function runStartupAutoSync() {
    // 1) 若绑定了 GitHub Actions 云端 JSON 或处于网页环境，启动后静默拉取最新快照
    if (cloudFeedUrl || (location.hostname !== 'appassets.androidplatform.net' && /^https?:$/i.test(location.protocol))) {
      syncViaWebOrCloud(true);
    }
    // 2) 若在 Android 客户端内且距离上次同步超过 2 小时，后台自动静默直连官网刷新一次
    if (BRIDGE && typeof BRIDGE.syncOfficialSiteSilent === 'function') {
      const latestMs = Math.max(lastSyncedAt, Date.parse(D.generatedAt || '') || 0);
      if (Date.now() - latestMs > 2 * 3600 * 1000) {
        BRIDGE.syncOfficialSiteSilent();
      }
    }
  }

  applyTheme(theme);
  updateFavBadge();
  bindEvents();
  showPage('home');
  runStartupAutoSync();
  countdownTimer = setInterval(updateCountdowns, 1000);
  window.addEventListener('beforeunload', () => clearInterval(countdownTimer));
})();
