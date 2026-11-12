'use strict';

// 题材内部分化提示（2026-11-11 用户要求，11-12 改口径）：同一题材里，今天的首板和二板及以上的票可能是不同的发酵
// （如 2026-09-15 电力：闽东电力 5 板来自新型电网，当天首板都是欧洲海风涨价；2026-03-27 创新药：首板都有
// 「生物医药首入新兴支柱产业」，4 板的美诺华没有）。不替用户下结论，只做标记和高亮，让用户点开详情自己判断。
//
// 做法见下面 divergence() 的注释：首板之间共有、高位票当初没有的新闻标题。

const COMMON_SHARE = 0.5;
const MIN_SUPPORT = 3;
const MIN_FIRST = 3; // 当天首板少于 3 只时「共同关键词」太偶然，不判断（2026-11-11 用户定）
const STOP = new Set(['涨停', '板块', '概念', '多股', '个股', '公司', '股份', '受益', '发布', '相关', '行业', '产业', '市场', '加速', '推动', '提速',
  '利好', '走强', '走高', '大涨', '拉升', '异动', '活跃', '催化', '订单', '业绩', '增长', '项目', '持续', '有望', '迎来', '全面', '重磅', '最新',
  '机构', '看好', '布局', '业务', '领域', '方向', '龙头', '集体', '爆发', '涨价', '中国', '国内', '全球', '首次', '今年', '上半', '半年', '年报',
  '科技', '技术', '发展', '建设', '实施', '方案', '政策', '支持', '推进', '落地', '应用', '需求', '供应', '能力', '合作', '签署', '协议', '大单',
  '直线', '封板', '连板', '二连', '三连', '四连', '五连', '涨幅', '上涨', '新高', '引爆', '突破', '主线', '题材', '热点', '资金', '主力',
  '再度', '延续', '强势', '价格', '亿元', '万元', '股价', '午后', '早盘', '尾盘', '盘中', '收盘', '开盘', '一图', '看懂', '梳理', '复盘', '盘点', '名单',
  '证券', '研报', '周报', '点评', '报告', '深度', '跟踪', '关注', '投资', '机会', '逻辑', '解读', '风口', '直击', '快讯', '消息', '获悉', '记者',
  '净利', '营收', '同比', '环比', '季度', '净流', '流入', '流出', '融资', '买入', '卖出', '龙虎', '成交', '换手', '振幅', '指数', '大盘', '沪指',
  '今日', '昨日', '本周', '近期', '目前', '已经', '正在', '进入', '成为', '实现', '提升', '显著', '大幅', '超过', '达到', '以上', '以来', '有限',
  '红盘', '概率', '人气', '明日', '明天', '今天', '早知道', '要闻', '晚报', '早报', '午报', '收评', '午评', '早评', '盘前', '盘后', '竞价', '打板', '情绪',
  '封单', '翻红', '涨超', '涨逾', '跌超', '暴涨', '大跌', '跌停', '批量', '只股', '概念股', '一览', '汇总', '月报', '公告', '摘要', '追踪', '股东', '减持', '增持']);
// 先把套话整词挖掉再两字一组切，免得「算力租赁概念再度拉升」切出「赁概」「度拉」这种跨词碎片
const STOP_PATTERN = new RegExp([...STOP].join('|'), 'g');

function keywords(text, themeName = '') {
  const words = new Set();
  const cleaned = (themeName ? String(text).split(themeName).join(' ') : String(text)).replace(STOP_PATTERN, ' ');
  for (const run of cleaned.match(/[一-龥]+|[A-Za-z][A-Za-z0-9.+-]+/g) || []) {
    if (/^[一-龥]/.test(run)) {
      for (let index = 0; index + 1 < run.length; index++) words.add(run.slice(index, index + 2));
    } else if (run.length >= 2 && !themeName.toUpperCase().includes(run.toUpperCase())) {
      // 题材名里的英文词（如 AI应用 的 AI）同题材必然都有，不算
      words.add(run.toUpperCase());
    }
  }
  return words;
}

// 按公司自身事项归的通用题材：每只票本来就是各自的事，比关键词没有意义
const GENERIC_THEMES = new Set(['并购重组', '控制权变更', '业绩增长', '股份回购', '中报预增', '业绩预增', '年报预增', '资产注入', '股权转让', '摘帽', '高送转']);

// 复盘、榜单、股东类标题：一篇挂一串票，讲的是盘面或持股，不是催化，不算「首板共同的新催化」
const RECAP_TITLE = /复盘|收评|午评|早评|盘前|盘后|龙虎榜|人气|红盘|涨停分析|异动解读|涨停原因|早知道|要闻|晚报|早报|午报|十大|股东|减持|增持|融资|资金|主力|研报|周报|月报|晨会|ETF|指数|一览|汇总|名单|梳理|盘点|一图|全景|图谱/;

// first / high: [{ name, streak, titles: [全部新闻标题], evidence: [归进这个题材时模型引用的依据标题], e: 事件描述 }]
// 判断：同一条标题挂在至少 need 只首板上（复盘、榜单类除外），高位票当初（它们首板那几天）的新闻里没有这条，就是首板共同的新催化，标「可能分化」。
// 返回 null 或 { fe: 首板里最多的事件描述, fc, f: 首板只数, t: [[共同新标题, 挂了几只首板]], w: 这些标题里高位票没出现过的两字词（页面高亮用）, h: [{ n, s, e }] 高位票 }
function divergence(themeName, first, high) {
  if (GENERIC_THEMES.has(themeName)) return null;
  high = high.filter(item => item.titles.length); // 高位票没有新闻时判断不了，不算
  if (first.length < MIN_FIRST || !high.length) return null;
  const need = Math.max(MIN_SUPPORT, Math.ceil(first.length * COMMON_SHARE));
  const highTitles = new Set(high.flatMap(item => item.titles));
  // 还要被模型当作这个题材的依据引用过（至少一只首板），保证是和这个题材有关的催化，不是「直线涨停！多只股票异动」这种盘面标题
  const cited = new Set(first.flatMap(item => item.evidence || []));
  const support = new Map();
  for (const item of first) for (const title of new Set(item.titles)) support.set(title, (support.get(title) || 0) + 1);
  const shared = [...support.entries()]
    .filter(([title, count]) => count >= need && cited.has(title) && !highTitles.has(title) && !RECAP_TITLE.test(title))
    .sort((left, right) => right[1] - left[1]);
  if (!shared.length) return null;
  const highWords = new Set();
  for (const item of high) for (const word of keywords(item.titles.join(' '), themeName)) highWords.add(word);
  const words = new Set();
  for (const [title] of shared.slice(0, 3)) for (const word of keywords(title, themeName)) if (!highWords.has(word)) words.add(word);
  const events = new Map();
  for (const item of first) if (item.e) events.set(item.e, (events.get(item.e) || 0) + 1);
  const [topEvent, topCount] = [...events.entries()].sort((left, right) => right[1] - left[1])[0] || ['', 0];
  return {
    fe: topEvent, fc: topCount, f: first.length,
    t: shared.slice(0, 3),
    w: [...words],
    h: high.map(item => ({ n: item.name, s: item.streak, e: item.e || '' })),
  };
}

module.exports = { keywords, divergence, GENERIC_THEMES };
