import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const WWW_DIR = path.join(ROOT_DIR, 'app', 'src', 'main', 'assets', 'www');
const DEMO_DATA_PATH = path.join(WWW_DIR, 'demo-data.js');
const LIVE_JSON_PATH = path.join(WWW_DIR, 'live-data.json');

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const BASE_URL = 'https://wust.91wllm.cn';

const TZ8 = 8 * 3600000;
const DAY = 86400000;
const pad2 = (n) => String(n).padStart(2, '0');

function dateKeyOf(ms) {
  const d = new Date(ms + TZ8);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function weekKeyOf(ms) {
  const [y, m, d] = dateKeyOf(ms).split('-').map(Number);
  const lm = Date.UTC(y, m - 1, d) - TZ8;
  const wd = (new Date(lm + TZ8).getUTCDay() + 6) % 7;
  const mon = lm - wd * DAY;
  const iy = new Date(mon + 3 * DAY + TZ8).getUTCFullYear();
  const j4 = Date.UTC(iy, 0, 4) - TZ8;
  const j4wd = (new Date(j4 + TZ8).getUTCDay() + 6) % 7;
  return `${iy}-W${pad2(Math.floor((mon - (j4 - j4wd * DAY)) / (7 * DAY)) + 1)}`;
}
function parseRange(dateStr, sClock, eClock) {
  const normDate = dateStr.replace(/\./g, '-');
  const [y, m, d] = normDate.split('-').map(Number);
  const [sh, sm] = sClock.split(':').map(Number);
  const [eh, em] = eClock.split(':').map(Number);
  return {
    dateKey: `${y}-${pad2(m)}-${pad2(d)}`,
    startTime: Date.UTC(y, m - 1, d, sh, sm) - TZ8,
    endTime: Date.UTC(y, m - 1, d, eh, em) - TZ8,
  };
}
function stripTags(s) {
  return String(s || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function balanceParens(val) {
  if (typeof val === 'string') {
    const opens = (val.match(/\(/g) || []).length;
    const closes = (val.match(/\)/g) || []).length;
    return opens > closes ? val + ')'.repeat(opens - closes) : val;
  }
  if (Array.isArray(val)) return val.map(balanceParens);
  if (val && typeof val === 'object') {
    for (const k of Object.keys(val)) val[k] = balanceParens(val[k]);
  }
  return val;
}

function normalizeCampus(text) {
  if (/青山/.test(text)) return 'campus_qingshan';
  if (/黄家湖|洪山|教十一楼|教一楼|北苑|南苑/.test(text)) return 'campus_hongshan';
  return 'campus_other';
}
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
function jobCategoriesOf(positions, title = '') {
  const labels = new Set();
  const list = positions?.length ? positions : [title];
  for (const p of list) {
    const hit = JOB_CATEGORIES.find((c) => c.match.test(p));
    if (hit) labels.add(hit.name);
  }
  return labels.size ? [...labels] : ['其他岗位'];
}

async function fetchHtml(urlPath, timeoutMs = 12000) {
  const url = urlPath.startsWith('http') ? urlPath : `${BASE_URL}${urlPath}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': MOBILE_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export function decode91wllmContent(html) {
  const m = html.match(/Base64\.decode\(unzip\("([^"]+)"\)\.substr\((\d+)\)\)\.substr\((\d+)\)/);
  if (!m) return '';
  try {
    const inflated = zlib.inflateSync(Buffer.from(m[1], 'base64')).toString('utf8');
    const step1 = inflated.slice(Number(m[2]));
    const rawHtml = Buffer.from(step1, 'base64').toString('utf8');
    const slicedHtml = [...rawHtml].slice(Number(m[3])).join('');
    const text = stripTags(slicedHtml);
    if (text) return text.slice(0, 1800);
    if (/<img\b/i.test(slicedHtml)) {
      return '企业已发布图文招聘海报简章，点击下方官方公告链接可查看完整高清原图。';
    }
    return '';
  } catch {
    return '';
  }
}

export function parseMobileTeachinList(html) {
  const out = [];
  const liRe = /<li>\s*<a href="\/teachin\/view\/id\/(\d+)">([\s\S]*?)<\/a>\s*<\/li>/g;
  for (const m of html.matchAll(liRe)) {
    const sourceId = m[1];
    const body = m[2];
    const stateText = stripTags(body.match(/<span class="State[^"]*">([\s\S]*?)<\/span>/)?.[1] || '');
    const companyName = stripTags(body.match(/<span class="text-titles">([\s\S]*?)<\/span>/)?.[1] || '');
    const locText = stripTags(body.match(/<span class="icon-map-marker[^"]*">([\s\S]*?)<\/span>/)?.[1] || '');
    const timeRaw = stripTags(body.match(/<p class="icon-time">([\s\S]*?)<\/p>/)?.[1] || '');
    const tm = timeRaw.match(/(\d{4}[-.]\d{2}[-.]\d{2})\s+(\d{2}:\d{2})-(\d{2}:\d{2})/);
    if (!companyName || !tm) continue;
    out.push({
      sourceId,
      companyName,
      statusText: stateText,
      location: locText || (stateText.includes('空') ? '线上宣讲' : '校内宣讲'),
      timeText: `${tm[1].replace(/\./g, '-')} ${tm[2]}-${tm[3]}`,
      dateStr: tm[1],
      sClock: tm[2],
      eClock: tm[3],
      sourceUrl: `${BASE_URL}/teachin/view/id/${sourceId}`,
    });
  }
  return out;
}

export function parseMobileJobfairList(html) {
  const out = [];
  const liRe = /<li>\s*<a href="\/jobfair\/view\/id\/(\d+)">([\s\S]*?)<\/a>\s*<\/li>/g;
  for (const m of html.matchAll(liRe)) {
    const sid = m[1];
    const body = m[2];
    const h5Spans = [...body.matchAll(/<span(?![^>]*class="State)[^>]*>([\s\S]*?)<\/span>/g)];
    const rawTitle = stripTags(h5Spans[h5Spans.length - 1]?.[1] || '');
    const place = stripTags(body.match(/<p class="icon-map-marker">([\s\S]*?)<\/p>/)?.[1] || '');
    const dateRaw = stripTags(body.match(/<p class="icon-time">([\s\S]*?)<\/p>/)?.[1] || '').replace(/\./g, '-');
    if (!rawTitle) continue;
    out.push({
      title: rawTitle.replace(/^【学生邀请函】/, '').trim(),
      date: dateRaw,
      place: place || '武汉科技大学',
      url: `${BASE_URL}/jobfair/view/id/${sid}`,
    });
  }
  return out;
}

export function parseMobileTeachinDetail(html, sourceId) {
  const cancelReasonRaw = stripTags(html.match(/取消原因：([^<]+)/)?.[1] || '').replace(/[。.\s]+$/, '');
  const isCancelled = Boolean(cancelReasonRaw) || /活动已取消/.test(html);
  const addrMatch = html.match(/<span class="label">宣讲地址：<\/span>\s*<span>([\s\S]*?)<\/span>/);
  const addr = stripTags(addrMatch?.[1] || '');
  const catMatch = html.match(/<span class="label">宣讲类别：<\/span>\s*<span>([\s\S]*?)<\/span>/);
  const category = stripTags(catMatch?.[1] || '');

  const posSet = new Set();
  for (const pm of html.matchAll(/onclick="setJid\(\d+\)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const p = stripTags(pm[1]);
    if (p) posSet.add(p);
  }
  const announcement = decode91wllmContent(html);

  return {
    sourceId: String(sourceId),
    isCancelled,
    cancelReason: cancelReasonRaw || (isCancelled ? '官网已标注活动取消' : ''),
    location: addr && addr !== '地址待定' ? addr : '',
    category,
    positions: [...posSet].slice(0, 12),
    announcement,
  };
}

export async function runOfficialSync({ writeFiles = true, maxDetails = 10 } = {}) {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(DEMO_DATA_PATH, 'utf8'), ctx);
  const baseData = ctx.window.DEMO_DATA;
  const official = baseData.official || { colleges: [], majors: [], groups: [] };

  const majorName = Object.fromEntries(official.majors.map((m) => [m.id, m.name]));
  const majorById = Object.fromEntries(official.majors.map((m) => [m.id, m]));
  const collegeName = Object.fromEntries(official.colleges.map((c) => [c.id, c.name]));

  function matchMajorsFromText(text) {
    const matched = [];
    for (const m of official.majors) {
      const clean = m.name.replace(/\(.*?\)/g, '');
      if (clean.length >= 2 && text.includes(clean)) matched.push(m.id);
    }
    if (!matched.length && /计算机|软件|IT|人工智能|信息|通信|电子/.test(text)) {
      matched.push(...official.majors.filter((m) => m.collegeId === 'jsjkx' || m.collegeId === 'dzxx').slice(0, 5).map((m) => m.id));
    }
    if (!matched.length && /机械|电气|自动化|工程|制造|材料|半导体|陶瓷/.test(text)) {
      matched.push(...official.majors.filter((m) => m.collegeId === 'jxzdh' || m.collegeId === 'cl').slice(0, 5).map((m) => m.id));
    }
    if (!matched.length && /钢铁|冶金|化工|化学/.test(text)) {
      matched.push(...official.majors.filter((m) => m.collegeId === 'cl' || m.collegeId === 'hxyhg').slice(0, 4).map((m) => m.id));
    }
    if (!matched.length && /医药|药学|护理|医学|生物/.test(text)) {
      matched.push(...official.majors.filter((m) => m.collegeId === 'yxb' || m.collegeId === 'smkxyjk').slice(0, 4).map((m) => m.id));
    }
    if (!matched.length && /管理|管培|营销|市场|商务|外贸|教育|升学/.test(text)) {
      matched.push(...official.majors.filter((m) => m.collegeId === 'som' || m.collegeId === 'fxyjj').slice(0, 4).map((m) => m.id));
    }
    return [...new Set(matched)].slice(0, 10);
  }

  const [page1Html, page2Html, jfHtml] = await Promise.all([
    fetchHtml('/teachin/index?page=1'),
    fetchHtml('/teachin/index?page=2').catch(() => ''),
    fetchHtml('/jobfair/index?page=1').catch(() => ''),
  ]);

  const rawList = [...parseMobileTeachinList(page1Html), ...parseMobileTeachinList(page2Html)];
  const seenSid = new Set();
  const uniqueList = rawList.filter((item) => {
    if (seenSid.has(item.sourceId)) return false;
    seenSid.add(item.sourceId);
    return true;
  }).slice(0, 26);

  const now = Date.now();
  const today = dateKeyOf(now);
  const prevBySid = Object.fromEntries((baseData.talks || []).map((t) => [String(t.sourceId), t]));

  const talks = [];
  let detailCount = 0;

  for (const item of uniqueList) {
    const { dateKey, startTime, endTime } = parseRange(item.dateStr, item.sClock, item.eClock);
    const prev = prevBySid[item.sourceId];
    let positions = prev?.positions ? [...prev.positions] : [];
    let announcement = prev?.announcement || '';
    let isCancelled = /取消/.test(item.statusText) || /取消/.test(item.companyName);
    let cancelReason = isCancelled ? (prev?.cancelReason || '官网已标注取消') : '';
    let location = item.location;

    const needsDetail = detailCount < maxDetails && (endTime >= now || !prev || !positions.length || !announcement);
    if (needsDetail) {
      try {
        detailCount += 1;
        const dHtml = await fetchHtml(`/teachin/view/id/${item.sourceId}`);
        const det = parseMobileTeachinDetail(dHtml, item.sourceId);
        if (det.isCancelled) {
          isCancelled = true;
          cancelReason = det.cancelReason;
        }
        if (det.location) location = det.location;
        if (det.positions.length) positions = det.positions;
        if (det.announcement) announcement = det.announcement;
      } catch {
        // Keep list metadata on transient detail timeout
      }
    }

    const majorIds = prev?.majorIds?.length
      ? prev.majorIds
      : matchMajorsFromText(`${item.companyName} ${positions.join(' ')} ${announcement}`);
    const collegeIds = [...new Set(majorIds.map((id) => majorById[id]?.collegeId).filter(Boolean))];
    const campusId = normalizeCampus(`${item.statusText} ${location}`);
    const status = isCancelled ? 'cancelled' : (endTime < now ? 'expired' : 'published');

    talks.push({
      _id: `wust_${item.sourceId}`,
      sourceId: String(item.sourceId),
      sourceUrl: item.sourceUrl,
      title: prev?.title || `${item.companyName.replace(/校园招聘.*$/, '')}校园招聘宣讲会`,
      companyId: prev?.companyId || `co_${item.sourceId}`,
      companyName: item.companyName,
      campusId,
      campusName: CAMPUS_LABEL[campusId],
      location,
      originalPlace: location,
      dateKey,
      originalDateKey: dateKey,
      weekKey: weekKeyOf(startTime),
      startTime,
      endTime,
      industryName: prev?.industryName || (/空|线上/.test(item.statusText + location) ? '线上空中宣讲' : '校园专场招聘'),
      positions,
      requirements: prev?.requirements || `${item.statusText ? item.statusText + '宣讲 · ' : ''}详见招聘公告`,
      announcement: announcement || `举办地点：${location}。详见学校就业信息网官方公告。`,
      status,
      isCancelled,
      cancelReason,
      collegeIds,
      collegeNames: collegeIds.map((id) => collegeName[id]).filter(Boolean),
      majorIds,
      majorNames: majorIds.map((id) => majorName[id]).filter(Boolean),
      jobCategories: jobCategoriesOf(positions, item.companyName),
      sourceType: 'external',
      detailLoaded: Boolean(positions.length || announcement),
      createdAt: prev?.createdAt || now - DAY,
      updatedAt: now,
    });
  }

  for (const prev of baseData.talks || []) {
    const sid = String(prev.sourceId || '');
    if (!sid || seenSid.has(sid)) continue;
    if (prev.endTime >= now - 2 * DAY) {
      try {
        const dHtml = await fetchHtml(`/teachin/view/id/${sid}`);
        const det = parseMobileTeachinDetail(dHtml, sid);
        if (det.isCancelled) {
          talks.push({
            ...prev,
            status: 'cancelled',
            isCancelled: true,
            cancelReason: det.cancelReason || '企业申请取消',
            positions: det.positions.length ? det.positions : (prev.positions || []),
            announcement: det.announcement || prev.announcement,
            updatedAt: now,
          });
          seenSid.add(sid);
        }
      } catch {
        if (prev.isCancelled) {
          talks.push(prev);
          seenSid.add(sid);
        }
      }
    }
  }

  talks.sort((a, b) => b.startTime - a.startTime);

  const parsedFairs = jfHtml ? parseMobileJobfairList(jfHtml).slice(0, 10) : [];
  const jobfairs = parsedFairs.length ? parsedFairs : (baseData.jobfairs || []);

  const generatedAt = new Date(now).toISOString();
  const livePayload = balanceParens({
    ok: true,
    generatedAt,
    syncedAt: now,
    today,
    talks,
    jobfairs,
  });

  if (writeFiles) {
    const nextDemoData = balanceParens({
      ...baseData,
      generatedAt,
      today,
      talks,
      jobfairs,
    });
    fs.writeFileSync(LIVE_JSON_PATH, JSON.stringify(livePayload, null, 2) + '\n', 'utf8');
    fs.writeFileSync(DEMO_DATA_PATH, 'window.DEMO_DATA = ' + JSON.stringify(nextDemoData, null, 2) + ';\n', 'utf8');
  }

  return livePayload;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runOfficialSync({ writeFiles: true })
    .then((res) => {
      const pub = res.talks.filter((t) => t.status === 'published').length;
      const can = res.talks.filter((t) => t.isCancelled).length;
      console.log(`[sync-official] OK at ${res.generatedAt}: total=${res.talks.length}, published=${pub}, cancelled=${can}, jobfairs=${res.jobfairs.length}`);
    })
    .catch((err) => {
      console.error('[sync-official] FAILED:', err);
      process.exit(1);
    });
}
