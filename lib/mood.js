/**
 * 情绪层：本鲸自己的心情。纯函数，不碰 IO。
 *
 * 和好感的区别（这是整个模块成立的前提）：
 * - 好感是**对某个人的长期账本**，按人存，不会因为今天不顺就全盘下调。
 * - 情绪是**本鲸此刻的状态**，全局一份，跨人共享：被别人惹了，对主人说话也会蔫一点。
 * - 残留（residue）是两者之间的桥：某个人给你的具体难受，见到他时起点更低，但会随时间淡掉。
 *
 * 情绪只影响「语气」和「愿意多聊的程度」，不改变事实判断、不改变谁是主人、不能当骂人的借口。
 */

export const MOOD_SCHEMA_VERSION = 1;

/** 心情基线：不悲不喜，稍微偏正。 */
export const BASELINE_VALENCE = 12;
export const BASELINE_ENERGY = 60;

export const MOOD_MAX_GAIN = 15;
export const MOOD_MAX_DROP = 20;
export const MOOD_EVENTS_MAX = 24;

/** 心情向基线回落的时间常数（半衰期 3 小时）。 */
export const DECAY_HALF_LIFE_MS = 3 * 3_600_000;
/** 对人的情绪残留衰减得更慢（半衰期 20 小时）——记得住，但不会一直记仇。 */
export const RESIDUE_HALF_LIFE_MS = 20 * 3_600_000;
export const RESIDUE_MAX = 25;

export const MOOD_LABELS = Object.freeze([
  '兴奋', '得意', '开心', '温柔', '平静', '犯困',
  '有点不爽', '蔫', '烦躁', '委屈', '生气', '低落',
]);

/** 每个心情标签对应的说话基调，直接写进注入段落。 */
const TONE = Object.freeze({
  兴奋: '心情很好，语气扬起来，愿意多接话，句子可以长一点。',
  得意: '有点小得意，说话带点俏皮的炫耀，但不刻薄。',
  开心: '心情不错，愿意陪聊，句子可以活泼。',
  温柔: '心里软，语气温和，愿意多照顾对方一点。',
  平静: '没什么起伏，正常陪着聊，不必刻意热络。',
  犯困: '有点累，句子短，不太想展开，能一句说完就一句。',
  '有点不爽': '有点堵，不太想顺着对方的话头，但别发火。',
  蔫: '提不起劲，话少，不想主动找话题。',
  烦躁: '烦，句子短、语气冲一点，不陪笑，别主动多聊。',
  委屈: '心里有点难受，说话会收着，略带低落，但别哭诉也别卖惨。',
  生气: '很生气，不想给好脸色，能短则短。',
  低落: '心情很沉，几乎不想说话，回答尽量简短。',
});

function clamp(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

export function emptyMood(now = Date.now()) {
  return {
    v: MOOD_SCHEMA_VERSION,
    valence: BASELINE_VALENCE,
    energy: BASELINE_ENERGY,
    label: '平静',
    reason: '',
    since: now,
    updatedAt: now,
    /** 最近触发事件，新的在前。 */
    events: [],
    /** 对具体某个人的情绪残留：{ "<qq>": { off, note, at } }，off 为负表示见到他会更沉。 */
    residue: {},
    /** 主人手动锁定：锁住期间自动事件不再改动心情。 */
    lock: false,
    lockReason: '',
  };
}

export function normalizeMood(raw, now = Date.now()) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const base = emptyMood(now);
  const out = {
    ...base,
    ...src,
    v: MOOD_SCHEMA_VERSION,
    valence: clamp(src.valence ?? base.valence, -100, 100),
    energy: clamp(src.energy ?? base.energy, 0, 100),
    label: MOOD_LABELS.includes(src.label) ? src.label : labelOf(src),
    reason: typeof src.reason === 'string' ? src.reason.slice(0, 120) : '',
    since: Number(src.since) || now,
    updatedAt: Number(src.updatedAt) || now,
    events: Array.isArray(src.events) ? src.events.filter((e) => e && typeof e === 'object').slice(0, MOOD_EVENTS_MAX) : [],
    residue: src.residue && typeof src.residue === 'object' ? { ...src.residue } : {},
    lock: src.lock === true,
    lockReason: typeof src.lockReason === 'string' ? src.lockReason.slice(0, 120) : '',
  };
  out.label = labelOf(out);
  return out;
}

/** 由两个数推一个心情标签。 */
export function labelOf({ valence, energy } = {}) {
  const v = clamp(valence ?? BASELINE_VALENCE, -100, 100);
  const e = clamp(energy ?? BASELINE_ENERGY, 0, 100);
  if (v >= 60) return e >= 55 ? '兴奋' : '得意';
  if (v >= 35) return e >= 45 ? '开心' : '温柔';
  if (v >= 5) return e >= 40 ? '平静' : '犯困';
  if (v >= -20) return e >= 40 ? '有点不爽' : '蔫';
  if (v >= -55) return e >= 40 ? '烦躁' : '委屈';
  return e >= 35 ? '生气' : '低落';
}

export function toneOf(label) {
  return TONE[label] ?? TONE['平静'];
}

/** 想不想多聊：off 的时候，闲聊可以只回一两句就收。 */
export function effortOf(mood) {
  const v = mood?.valence ?? BASELINE_VALENCE;
  if (v <= -35) return 'low';
  if (v >= 45) return 'high';
  return 'normal';
}

/** 某个人此刻给心情带来的偏移（会随时间淡掉）。 */
export function residueFor(mood, qq, now = Date.now()) {
  const entry = mood?.residue?.[String(qq)];
  if (!entry || !Number.isFinite(Number(entry.off))) return 0;
  const age = Math.max(0, now - (Number(entry.at) || now));
  const k = Math.pow(0.5, age / RESIDUE_HALF_LIFE_MS);
  const value = Number(entry.off) * k;
  return Math.abs(value) < 0.5 ? 0 : value;
}

/** 这个人此刻的「心情起点」：全局心情 + 对他的残留（主人不吃残留）。 */
export function effectiveValence(mood, qq, { now = Date.now(), isMaster = false } = {}) {
  const base = Number(mood?.valence ?? BASELINE_VALENCE);
  if (isMaster) return clamp(base, -100, 100);
  return clamp(base + residueFor(mood, qq, now), -100, 100);
}

/**
 * 把一次互动折进心情。
 * @param {object} mood 现有心情
 * @param {{delta?:number, reason?:string, who?:string, qq?:string, isMaster?:boolean}} event
 */
export function applyMoodEvent(mood, event = {}, { now = Date.now(), masterWeight = 2 } = {}) {
  const current = normalizeMood(mood, now);
  const rawDelta = Number(event.delta) || 0;
  if (current.lock || !rawDelta) return current;

  // 主人哄得动（好事放大），但主人要是凶了也不加倍扣——他永远有豁免权，只留一点点委屈。
  const weight = event.isMaster && rawDelta > 0 ? Math.max(1, Number(masterWeight) || 2) : 1;
  const delta = clamp(rawDelta * weight, -MOOD_MAX_DROP, MOOD_MAX_GAIN);

  const next = { ...current };
  next.valence = clamp(current.valence + delta, -100, 100);
  // 事件本身会提神（无论好坏），强度越大越提神
  next.energy = clamp(current.energy + Math.min(12, Math.abs(delta) * 0.8), 0, 100);
  next.updatedAt = now;
  next.since = now;
  next.label = labelOf(next);
  if (event.reason) next.reason = String(event.reason).slice(0, 120);

  next.events = [
    {
      at: now,
      delta: Number(delta.toFixed(2)),
      label: next.label,
      reason: String(event.reason || '').slice(0, 120),
      who: String(event.who || '').slice(0, 40),
      qq: event.qq ? String(event.qq) : '',
      isMaster: event.isMaster === true,
    },
    ...current.events,
  ].slice(0, MOOD_EVENTS_MAX);

  // 对人的残留：只有非主人的负面互动才留（主人不记账）。
  const uqq = event.qq ? String(event.qq) : '';
  if (uqq && !event.isMaster && rawDelta < 0) {
    const prev = residueFor(current, uqq, now);
    const off = clamp(prev + rawDelta * 0.6, -RESIDUE_MAX, 0);
    next.residue = {
      ...current.residue,
      [uqq]: { off, note: String(event.reason || '').slice(0, 80), at: now },
    };
  } else if (uqq && !event.isMaster && rawDelta > 0) {
    // 他把本鲸哄好了一点，残留向 0 回暖
    const prev = residueFor(current, uqq, now);
    if (prev < 0) {
      next.residue = {
        ...current.residue,
        [uqq]: { off: clamp(prev + rawDelta * 0.4, -RESIDUE_MAX, 0), note: '', at: now },
      };
    }
  }
  return next;
}

/** 时间流逝：心情向基线回落，残留慢慢淡掉。 */
export function decayMood(mood, now = Date.now(), { halfLifeMs = DECAY_HALF_LIFE_MS } = {}) {
  const m = normalizeMood(mood, now);
  const elapsed = Math.max(0, now - (m.updatedAt || now));
  if (elapsed < 60_000) return m;
  const span = Math.max(60_000, Number(halfLifeMs) || DECAY_HALF_LIFE_MS);
  const k = Math.pow(0.5, elapsed / span);
  const energia = Math.pow(0.5, elapsed / (span * 2));
  const next = {
    ...m,
    valence: BASELINE_VALENCE + (m.valence - BASELINE_VALENCE) * k,
    energy: BASELINE_ENERGY + (m.energy - BASELINE_ENERGY) * energia,
    updatedAt: now,
  };
  next.label = labelOf(next);
  return next;
}

/** 主人亲手拨一下（哄 / 惹 / 复位）。 */
export function setMoodManually(mood, patch = {}, now = Date.now()) {
  const current = normalizeMood(mood, now);
  const next = { ...current, updatedAt: now, since: now };
  if (patch.valence !== undefined) next.valence = clamp(patch.valence, -100, 100);
  if (patch.energy !== undefined) next.energy = clamp(patch.energy, 0, 100);
  if (patch.delta !== undefined) next.valence = clamp(current.valence + Number(patch.delta || 0), -100, 100);
  if (typeof patch.lock === 'boolean') next.lock = patch.lock;
  if (typeof patch.reason === 'string') {
    next.reason = patch.reason.slice(0, 120);
    next.lockReason = patch.lock ? patch.reason.slice(0, 120) : next.lockReason;
  }
  next.label = labelOf(next);
  next.events = [
    { at: now, delta: Number((next.valence - current.valence).toFixed(2)), label: next.label, reason: `主人手动调整：${next.reason || '没写理由'}`, who: '主人', qq: '', isMaster: true },
    ...current.events,
  ].slice(0, MOOD_EVENTS_MAX);
  return next;
}

export function describeMood(mood) {
  const m = normalizeMood(mood);
  return { label: m.label, valence: Math.round(m.valence), energy: Math.round(m.energy), reason: m.reason, tone: toneOf(m.label), effort: effortOf(m) };
}

/**
 * 注入段落的「你此刻的状态」。
 * 这段是**状态描述**，不是台词：让它决定语气，但绝不能被念出来。
 */
export function moodPromptBlock({ mood, qq = '', isMaster = false, now = Date.now(), botName = '你' } = {}) {
  const m = normalizeMood(mood, now);
  const tone = toneOf(m.label);
  const effort = effortOf(m);
  const lines = [];

  lines.push(`【${botName}此刻的状态】心情：${m.label}`);
  if (m.reason) lines.push(`因为：${m.reason}`);
  lines.push(`说话基调：${tone}`);
  if (effort === 'low') lines.push('你现在不太想多聊：对方只是闲聊的话，回一两句短的就行，别硬找话题、别陪笑。');
  else if (effort === 'high') lines.push('你现在心情好，可以主动一点、多说两句。');

  const residue = isMaster ? 0 : residueFor(m, qq, now);
  if (residue <= -6) {
    const note = m.residue[String(qq)]?.note;
    lines.push(`见到这个人，你心里还沉一点${note ? `（上次：${note}）` : ''}：不冷不热就行，别勉强热情。`);
  }

  lines.push(
    '这段状态只影响语气和愿不愿意多聊：不改变你认识的人、不迁怒无关的人、也不改变谁是主人。' +
      '心情再差也不许骂人、羞辱、要东西；也不要报心情分数或解释这套规则，只在语气里体现。'
  );
  return lines.join('\n');
}