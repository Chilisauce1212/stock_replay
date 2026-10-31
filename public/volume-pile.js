// 量堆识别算法：图表（public/index.html）和 volume-pile-report.js 共用这一份实现，
// 参数默认值也只在这里定义，避免两边各改各的。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VolumePile = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_SETTINGS = Object.freeze({
    baselineQuantile: 45,
    volumeMultiple: 2.0,
    medianMultiple: 2,
    minimumPeakShare: 27,
    contrastThresholdMultiple: 1.5,
    mergeGap: 7,
    minimumWidth: 3,
    strongPeakMultiple: 3.5,
    profitThresholdPct: 20,
    // 「天天放大量」也算获利兑现：量堆区间（第一根有效量日到最后一根）至少 3 天，
    // 成交量 ≥ 候选放量倍数 的天数占比 ≥ churnDayShare，且每天量/底噪的中位数 ≥ churnMedianMultiple。
    // 主力拿着大仓位来回高抛低吸，而不是集中吸筹后缩量锁仓。2024–2026 一进二紧挨首板的这类量堆三年均值都为负。
    // churnMedianMultiple 拉到 CHURN_OFF_MULTIPLE 即关闭这条规则。
    churnDayShare: 90,
    churnMedianMultiple: 3,
  });
  const CHURN_OFF_MULTIPLE = 10;
  const CHURN_MIN_DAYS = 3;

  function normalizeDate(value) {
    const text = String(value || '').trim().split('T')[0];
    if (/^\d{8}$/.test(text)) {
      return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
    }
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
  }

  // 活跃度：以检测数据最后一根 K 线为终点（用例中即首板前一日）。
  // 常态量取倒数第 6～125 根的成交量中位数，排除最近 5 日，避免首板前的异动抬高基准。
  // 2024–2026 一进二检验中两者都是越活跃越好，但效果不大，只适合排序或排除冷清票。
  const ACTIVITY_MIN_BARS = 125;

  function computeActivity(bars) {
    const volumes = bars.map(bar => {
      const volume = Number(bar.volume);
      return Number.isFinite(volume) && volume > 0 ? volume : 0;
    });
    if (volumes.length < ACTIVITY_MIN_BARS) {
      return { normalVolume: NaN, vol20VsNormal: NaN, spikeDays60: NaN, barCount: volumes.length };
    }
    const normalVolume = quantile(volumes.slice(-ACTIVITY_MIN_BARS, -5), 0.5);
    const recent20 = volumes.slice(-20);
    const average20 = recent20.reduce((sum, volume) => sum + volume, 0) / recent20.length;
    return {
      normalVolume,
      vol20VsNormal: normalVolume > 0 ? average20 / normalVolume : NaN,
      spikeDays60: normalVolume > 0
        ? volumes.slice(-60).filter(volume => volume >= 2 * normalVolume).length
        : NaN,
      barCount: volumes.length,
    };
  }

  // 首板当天单独处理，不参与量堆识别：只保留信号日之前的 K 线。
  function barsBeforeSignal(bars, signalDate) {
    const signal = normalizeDate(signalDate);
    return signal ? bars.filter(bar => normalizeDate(bar.date) < signal) : bars;
  }

  function quantile(values, fraction) {
    if (!values.length) return NaN;
    const sorted = [...values].sort((left, right) => left - right);
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  }

  function summarizeTopHalfVolume(points) {
    const volumes = points
      .map(point => point.volume)
      .filter(volume => Number.isFinite(volume) && volume > 0)
      .sort((left, right) => right - left);
    const topCount = Math.ceil(volumes.length / 2);
    return {
      average: topCount
        ? volumes.slice(0, topCount).reduce((sum, volume) => sum + volume, 0) / topCount
        : NaN,
      validDays: volumes.length,
      topDays: topCount,
    };
  }

  function roundPrice(price) {
    return Math.round((price + Number.EPSILON) * 100) / 100;
  }

  const LIMIT_UP_PERCENTS = [5, 10, 20, 30];

  function isLimitUpBar(points, index) {
    if (index <= 0) return false;
    const point = points[index];
    const previous = points[index - 1];
    if (!Number.isFinite(point.close) || !Number.isFinite(point.high)
      || !Number.isFinite(previous.close) || previous.close <= 0) return false;
    // 涨停板必须收在最高价；盘中触板但回落的 K 线不算。
    if (Math.abs(point.close - point.high) >= 0.000001) return false;
    if (point.limitStatus === 'limit-up') return true;
    return LIMIT_UP_PERCENTS.some(percent => {
      const limitPrice = roundPrice(previous.close * (1 + percent / 100));
      const diff = point.close - limitPrice;
      // 允许复权造成的轻微低估，但不接受明显高于理论涨停价的收盘，避免把 +5.48% 这类高收盘误判为 5% 涨停。
      return diff >= -0.011 && diff <= 0.002;
    });
  }

  function computeVolumePiles(data, settings) {
    const points = data.map((item, index) => {
      const volume = Number(item.volume);
      const open = Number(item.open);
      const high = Number(item.high);
      const low = Number(item.low);
      const close = Number(item.close);
      const amount = item.amount === null || item.amount === undefined || item.amount === ''
        ? NaN
        : Number(item.amount);
      return {
        index,
        date: normalizeDate(item.date),
        volume: Number.isFinite(volume) && volume > 0 ? volume : 0,
        amount,
        open,
        high,
        low,
        close,
        limitStatus: item.limitStatus || '',
        typicalPrice: (high + low + close) / 3,
        globalBaseline: NaN,
        globalMedian: NaN,
        excess: 0,
        ratio: NaN,
        medianRatio: NaN,
      };
    });

    const allVolumes = points.map(point => point.volume).filter(volume => volume > 0);
    const globalBaseline = quantile(allVolumes, settings.baselineQuantile / 100);
    const globalMedian = quantile(allVolumes, 0.5);
    if (globalBaseline > 0 && globalMedian > 0) {
      for (const point of points) {
        point.globalBaseline = globalBaseline;
        point.globalMedian = globalMedian;
        point.excess = Math.max(point.volume - globalBaseline, 0);
        point.ratio = point.volume / globalBaseline;
        point.medianRatio = point.volume / globalMedian;
      }
    }

    const candidateIndices = points
      .filter(point => (
        point.ratio >= settings.volumeMultiple
        && point.medianRatio >= settings.medianMultiple
      ))
      .map(point => point.index);
    const candidateIndexSet = new Set(candidateIndices);
    const timeGroups = [];
    for (const index of candidateIndices) {
      const group = timeGroups[timeGroups.length - 1];
      if (group && index - group.endIndex <= settings.mergeGap + 1) {
        group.endIndex = index;
        group.candidateIndices.push(index);
      } else {
        timeGroups.push({ startIndex: index, endIndex: index, candidateIndices: [index] });
      }
    }

    const groups = [];
    for (const timeGroup of timeGroups) {
      const peakExcess = Math.max(...timeGroup.candidateIndices.map(index => points[index].excess));
      const significantIndices = timeGroup.candidateIndices.filter(index => (
        points[index].excess >= peakExcess * settings.minimumPeakShare / 100
      ));
      let group = null;
      for (const index of significantIndices) {
        if (group && index - group.endIndex > settings.mergeGap + 1) {
          groups.push(group);
          group = null;
        }
        if (!group) group = { startIndex: index, endIndex: index, candidateIndices: [] };
        group.endIndex = index;
        group.candidateIndices.push(index);
      }
      if (group) groups.push(group);
    }

    const piles = [];
    const volumePileByDate = new Map();
    const priceAnchorByDate = new Map();
    const contrastByDate = new Map();
    const contrastFilteredByDate = new Map();
    let previousPileEndIndex = -1;
    for (const group of groups) {
      const groupCandidates = group.candidateIndices.map(index => points[index]);
      const peakExcess = Math.max(...groupCandidates.map(point => point.excess));
      const members = groupCandidates.filter(point => (
        point.excess >= peakExcess * settings.minimumPeakShare / 100
      ));
      if (!members.length) continue;
      const peak = members.reduce((highest, point) => (
        point.volume > highest.volume ? point : highest
      ));
      const shortCluster = members.length < settings.minimumWidth;
      if (shortCluster && peak.ratio < settings.strongPeakMultiple) continue;
      const candidateSet = new Set(group.candidateIndices);
      const includedSet = new Set(members.map(point => point.index));
      const lastVolumeMember = members[members.length - 1];
      const pileVolumeSummary = summarizeTopHalfVolume(
        points.slice(members[0].index, lastVolumeMember.index + 1),
      );
      const contractionPoints = points.slice(previousPileEndIndex + 1, members[0].index);
      const contractionVolumeSummary = summarizeTopHalfVolume(contractionPoints);
      const contrastRatio = Number.isFinite(pileVolumeSummary.average)
        && Number.isFinite(contractionVolumeSummary.average)
        && contractionVolumeSummary.average > 0
        ? pileVolumeSummary.average / contractionVolumeSummary.average
        : NaN;
      const contrastDetails = {
        pileTopHalfAverageVolume: pileVolumeSummary.average,
        pileVolumeValidDays: pileVolumeSummary.validDays,
        pileTopHalfDayCount: pileVolumeSummary.topDays,
        contractionTopHalfAverageVolume: contractionVolumeSummary.average,
        contractionVolumeValidDays: contractionVolumeSummary.validDays,
        contractionTopHalfDayCount: contractionVolumeSummary.topDays,
        contrastRatio,
        contrastThresholdMultiple: settings.contrastThresholdMultiple,
        contrastReferenceStartDate: contractionPoints[0]?.date || null,
        contrastReferenceEndDate: contractionPoints[contractionPoints.length - 1]?.date || null,
      };
      if (Number.isFinite(contrastRatio) && contrastRatio < settings.contrastThresholdMultiple) {
        for (const point of members) contrastFilteredByDate.set(point.date, contrastDetails);
        continue;
      }
      const weightedCenter = members.reduce((sum, point) => (
        sum + point.typicalPrice * point.excess
      ), 0);
      const excessTotal = members.reduce((sum, point) => sum + point.excess, 0);
      const centerPrice = excessTotal > 0 ? weightedCenter / excessTotal : NaN;
      const firstVolumeMember = members[0];
      const priceAnchorBars = [];
      let firstRangeMember = firstVolumeMember;
      while (firstRangeMember.index > 0) {
        const previous = points[firstRangeMember.index - 1];
        if (volumePileByDate.has(previous.date)
          || priceAnchorByDate.has(previous.date)
          || !isLimitUpBar(points, previous.index)) break;
        firstRangeMember = previous;
        priceAnchorBars.push(previous);
      }
      const priceAnchorIndexSet = new Set(priceAnchorBars.map(point => point.index));
      const startIndex = firstRangeMember.index;
      const endIndex = lastVolumeMember.index;
      const auditBars = points.slice(startIndex, endIndex + 1).map(point => ({
        date: point.date,
        open: point.open,
        high: point.high,
        low: point.low,
        close: point.close,
        volume: point.volume,
        amount: Number.isFinite(point.amount) ? point.amount : null,
        globalBaselineVolume: Number.isFinite(point.globalBaseline) ? point.globalBaseline : null,
        effectiveVolume: point.excess,
        relativeToGlobalBaseline: Number.isFinite(point.ratio) ? point.ratio : null,
        globalMedianVolume: Number.isFinite(point.globalMedian) ? point.globalMedian : null,
        relativeToGlobalMedian: Number.isFinite(point.medianRatio) ? point.medianRatio : null,
        isVolumeCandidate: candidateSet.has(point.index),
        meetsGlobalMedianFilter: point.medianRatio >= settings.medianMultiple,
        isPriceAnchor: priceAnchorIndexSet.has(point.index),
        includedInPile: includedSet.has(point.index),
        ...contrastDetails,
      }));
      const firstBarMidPrice = (firstRangeMember.high + firstRangeMember.low) / 2;
      const firstVolumeBarMidPrice = (firstVolumeMember.high + firstVolumeMember.low) / 2;
      const peakMidPrice = (peak.high + peak.low) / 2;
      const peakMidVsFirstMidPct = Number.isFinite(firstBarMidPrice) && firstBarMidPrice > 0
        ? Number(((peakMidPrice / firstBarMidPrice - 1) * 100).toFixed(4))
        : NaN;
      const rangeBars = points.slice(startIndex, endIndex + 1);
      // 先找区间内收盘价最高的 K 线，只在它及其左侧找收盘价最低的 K 线。
      // 「先小涨后大跌」的区间，右侧下跌末端的低点不能当成起涨点，否则会被误判为获利兑现。
      const highestCloseBar = rangeBars.reduce((highest, point) => (
        Number.isFinite(point.close) && (!highest || point.close > highest.close) ? point : highest
      ), null);
      const lowestCloseBar = rangeBars
        .filter(point => highestCloseBar && point.index <= highestCloseBar.index)
        .reduce((lowest, point) => (
          Number.isFinite(point.close) && (!lowest || point.close < lowest.close) ? point : lowest
        ), null);
      const lowestCloseMid = lowestCloseBar
        ? (lowestCloseBar.high + lowestCloseBar.low) / 2
        : NaN;
      const lowestToCenterPct = Number.isFinite(lowestCloseMid) && lowestCloseMid > 0
        ? (centerPrice / lowestCloseMid - 1) * 100
        : NaN;
      const lastBarMid = (points[endIndex].high + points[endIndex].low) / 2;
      const lastBarToCenterPct = Number.isFinite(centerPrice) && centerPrice > 0
        ? (lastBarMid / centerPrice - 1) * 100
        : NaN;
      const priceRuleMet = (Number.isFinite(lowestToCenterPct)
        && lowestToCenterPct >= settings.profitThresholdPct)
        || (Number.isFinite(lastBarToCenterPct)
          && lastBarToCenterPct >= settings.profitThresholdPct);
      // 每天都算，包括区间中没放量的日子，单根巨量拉不高中位数
      const churnRatios = points.slice(firstVolumeMember.index, endIndex + 1)
        .map(point => point.ratio)
        .filter(Number.isFinite);
      const churnShare = churnRatios.length
        ? churnRatios.filter(ratio => ratio >= settings.volumeMultiple).length / churnRatios.length
        : NaN;
      const churnMedianRatio = quantile(churnRatios, 0.5);
      const churnRuleMet = settings.churnMedianMultiple < CHURN_OFF_MULTIPLE
        && churnRatios.length >= CHURN_MIN_DAYS
        && churnShare * 100 >= settings.churnDayShare
        && churnMedianRatio >= settings.churnMedianMultiple;
      const profitTaking = priceRuleMet || churnRuleMet;
      const pile = {
        startDate: points[startIndex].date,
        firstVolumeDate: firstVolumeMember.date,
        firstVolumeBarMidPrice,
        endDate: points[endIndex].date,
        durationDays: members.length,
        peakDate: peak.date,
        peakVolume: peak.volume,
        peakRatio: peak.ratio,
        peakMedianRatio: peak.medianRatio,
        ...contrastDetails,
        centerPrice,
        firstRangeMidPrice: firstBarMidPrice,
        priceAnchorDate: priceAnchorBars.length ? firstRangeMember.date : null,
        priceAnchorMidPrice: priceAnchorBars.length ? firstBarMidPrice : null,
        priceAnchorCount: priceAnchorBars.length,
        priceAnchorDates: [...priceAnchorBars].reverse().map(point => point.date),
        peakMidPrice,
        peakMidVsFirstMidPct,
        highestCloseDate: highestCloseBar?.date || null,
        lowestCloseDate: lowestCloseBar?.date || null,
        lowestCloseMidPrice: Number.isFinite(lowestCloseMid) ? lowestCloseMid : null,
        lowestCloseToCenterPct: Number.isFinite(lowestToCenterPct) ? lowestToCenterPct : null,
        lastBarDate: points[endIndex].date,
        lastBarMidPrice: Number.isFinite(lastBarMid) ? lastBarMid : null,
        lastBarToCenterPct: Number.isFinite(lastBarToCenterPct) ? lastBarToCenterPct : null,
        profitThresholdPct: settings.profitThresholdPct,
        profitRuleMet: priceRuleMet,
        churnDays: churnRatios.length,
        churnShare,
        churnMedianRatio,
        churnDayShare: settings.churnDayShare,
        churnMedianMultiple: settings.churnMedianMultiple,
        churnRuleMet,
        shortCluster,
        auditBars,
        kind: profitTaking ? 'profit-taking' : 'accumulation-candidate',
      };
      piles.push(pile);
      previousPileEndIndex = lastVolumeMember.index;
      for (const point of members) volumePileByDate.set(point.date, pile);
      for (const point of priceAnchorBars) priceAnchorByDate.set(point.date, pile);
      for (const point of [...members, ...priceAnchorBars]) {
        contrastByDate.set(point.date, contrastDetails);
      }
    }
    const auditByDate = new Map(points.map(point => {
      const pile = volumePileByDate.get(point.date);
      const anchorPile = priceAnchorByDate.get(point.date);
      const auditPile = pile || anchorPile;
      const contrastDetails = contrastByDate.get(point.date) || contrastFilteredByDate.get(point.date);
      const firstVolumeBar = auditPile?.auditBars.find(bar => bar.date === auditPile.firstVolumeDate);
      const isVolumeCandidate = candidateIndexSet.has(point.index);
      const filterResult = anchorPile && !pile
        ? 'price-anchor-only'
        : !Number.isFinite(point.globalBaseline)
        ? 'insufficient-history'
        : point.ratio < settings.volumeMultiple
            ? 'below-global-low-quantile-threshold'
            : point.medianRatio < settings.medianMultiple
              ? 'below-global-median-threshold'
            : contrastFilteredByDate.has(point.date)
              ? 'below-previous-contraction-volume-contrast'
            : pile
              ? 'included'
              : 'filtered-by-cluster-rules';
      return [point.date, {
        globalBaselineVolume: Number.isFinite(point.globalBaseline) ? point.globalBaseline : null,
        globalMedianVolume: Number.isFinite(point.globalMedian) ? point.globalMedian : null,
        effectiveVolume: point.excess,
        relativeToGlobalBaseline: Number.isFinite(point.ratio) ? point.ratio : null,
        relativeToGlobalMedian: Number.isFinite(point.medianRatio) ? point.medianRatio : null,
        isVolumeCandidate,
        includedInPile: Boolean(pile),
        pileTopHalfAverageVolume: Number.isFinite(contrastDetails?.pileTopHalfAverageVolume)
          ? contrastDetails.pileTopHalfAverageVolume
          : null,
        pileVolumeValidDays: contrastDetails?.pileVolumeValidDays || 0,
        pileTopHalfDayCount: contrastDetails?.pileTopHalfDayCount || 0,
        contractionTopHalfAverageVolume: Number.isFinite(contrastDetails?.contractionTopHalfAverageVolume)
          ? contrastDetails.contractionTopHalfAverageVolume
          : null,
        contractionVolumeValidDays: contrastDetails?.contractionVolumeValidDays || 0,
        contractionTopHalfDayCount: contrastDetails?.contractionTopHalfDayCount || 0,
        volumeContrastRatio: Number.isFinite(contrastDetails?.contrastRatio)
          ? contrastDetails.contrastRatio
          : null,
        requiredVolumeContrastRatio: settings.contrastThresholdMultiple,
        contrastReferenceStartDate: contrastDetails?.contrastReferenceStartDate || null,
        contrastReferenceEndDate: contrastDetails?.contrastReferenceEndDate || null,
        isPriceAnchor: Boolean(anchorPile && !pile),
        priceAnchorForPileStart: anchorPile?.startDate || null,
        filterResult,
        classification: auditPile
          ? auditPile.kind === 'profit-taking' ? '获利兑现倾向' : '吸筹/承接倾向候选'
          : null,
        maximumVolumeDate: auditPile?.peakDate || null,
        firstPileBarMidPrice: Number.isFinite(auditPile?.firstRangeMidPrice)
          ? auditPile.firstRangeMidPrice
          : null,
        firstVolumeDate: auditPile?.firstVolumeDate || null,
        firstVolumeBarMidPrice: Number.isFinite(auditPile?.firstVolumeBarMidPrice)
          ? auditPile.firstVolumeBarMidPrice
          : null,
        maximumVolumeBarMidPrice: Number.isFinite(auditPile?.peakMidPrice)
          ? auditPile.peakMidPrice
          : null,
        maximumMidVsFirstMidPct: Number.isFinite(auditPile?.peakMidVsFirstMidPct)
          ? auditPile.peakMidVsFirstMidPct
          : null,
        centerPrice: Number.isFinite(auditPile?.centerPrice) ? auditPile.centerPrice : null,
        highestCloseDate: auditPile?.highestCloseDate || null,
        lowestCloseDate: auditPile?.lowestCloseDate || null,
        lowestCloseMidPrice: Number.isFinite(auditPile?.lowestCloseMidPrice)
          ? auditPile.lowestCloseMidPrice
          : null,
        lowestCloseToCenterPct: Number.isFinite(auditPile?.lowestCloseToCenterPct)
          ? auditPile.lowestCloseToCenterPct
          : null,
        lastBarDate: auditPile?.lastBarDate || null,
        lastBarMidPrice: Number.isFinite(auditPile?.lastBarMidPrice)
          ? auditPile.lastBarMidPrice
          : null,
        lastBarToCenterPct: Number.isFinite(auditPile?.lastBarToCenterPct)
          ? auditPile.lastBarToCenterPct
          : null,
        requiredProfitRisePct: settings.profitThresholdPct,
        priceAnchorDate: auditPile?.priceAnchorDate || null,
        priceAnchorCount: auditPile?.priceAnchorCount || 0,
        priceAnchorDates: auditPile?.priceAnchorDates || [],
        priceAnchorMidPrice: Number.isFinite(auditPile?.priceAnchorMidPrice)
          ? auditPile.priceAnchorMidPrice
          : null,
        firstVolumeBarClose: Number.isFinite(firstVolumeBar?.close) ? firstVolumeBar.close : null,
        profitRuleMet: auditPile?.kind === 'profit-taking',
      }];
    }));
    return {
      piles,
      byDate: volumePileByDate,
      anchorByDate: priceAnchorByDate,
      auditByDate,
      globalBaseline,
      globalMedian,
      activity: computeActivity(points),
      barCount: points.length,
      startDate: points[0]?.date || '',
      endDate: points[points.length - 1]?.date || '',
    };
  }

  return {
    CHURN_OFF_MULTIPLE,
    DEFAULT_SETTINGS,
    barsBeforeSignal,
    computeActivity,
    computeVolumePiles,
    isLimitUpBar,
    normalizeDate,
    quantile,
    summarizeTopHalfVolume,
  };
});
