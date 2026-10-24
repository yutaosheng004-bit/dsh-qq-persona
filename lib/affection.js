/**
 * 好感度纯逻辑层（不碰 IO，可单测）。
 *
 * 三条硬规则：
 * 1. 主人的好感是**锚点**，恒定等于 config.masterScore，不受任何加减影响。
 * 2. 非主人的生效值 = clamp(raw, 0, min(globalMax, masterScore)) —— 谁也翻不过主人。
 * 3. 单轮变化有闸：涨不超过 +maxGainPerTurn，跌不超过 -15（误判不至于把人一次砍没）。
 */

export const AFFECTION_RAW_MAX = 100;
export const MASTER_ANCHOR_DEFAULT = 100;
export const GLOBAL_MAX_DEFAULT = 80;
export const MAX_GAIN_PER_TURN = 6;
export const MAX_DROP_PER_TURN = 15;
export const DECAY_PER_IDLE_DAY = 0.5;
export const DECAY_FLOOR = 12;

/** 档位表（从高到低，命中第一个 min 即可）。主人可整表覆盖。 */
export const DEFAULT_TIERS = Object.freeze([
  { min: 90, key: 'bonded', name: '贴心', reply: '热情、会主动多说两句、会关心对方近况' },
  { min: 75, key: 'close', name: '亲近', reply: '亲切、放松、愿意接梗和闲聊' },
  { min: 55, key: 'warm', name: '熟络', reply: '友好、正常互动、偶尔开个玩笑' },
  { min: 35, key: 'normal', name: '普通', reply: '礼貌、简洁、按需回应' },
  { min: 15, key: 'cool', name: '冷淡', reply: '简短、少接话、不主动延伸话题' },
  { min: 0, key: 'cold', name: '生疏', reply: '疏离、只答不问、能一句话结束就一句话' },
]);

export function clamp(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

export function tierOf(score, tiers = DEFAULT_TIERS) {
  const s = clamp(score, 0, AFFECTION_RAW_MAX);
  for (const tier of tiers) if (s >= tier.min) return tier;
  return tiers[tiers.length - 1];
}

/** 非主人的天花板：全局上限与主人锚点取小。 */
export function ceilingOf({ masterScore = MASTER_ANCHOR_DEFAULT, globalMax = GLOBAL_MAX_DEFAULT } = {}) {
  return clamp(Math.min(Number(globalMax) || 0, Number(masterScore) || 0), 0, AFFECTION_RAW_MAX);
}

/**
 * 计算某人在此刻的**生效好感**。
 * @param {{raw:number, isMaster?:boolean, masterScore?:number, globalMax?:number}} input
 */
export function effectiveAffection({ raw, isMaster = false, masterScore = MASTER_ANCHOR_DEFAULT, globalMax = GLOBAL_MAX_DEFAULT }) {
  const anchor = clamp(masterScore, 0, AFFECTION_RAW_MAX);
  if (isMaster) return anchor;
  return clamp(raw, 0, ceilingOf({ masterScore: anchor, globalMax }));
}

/**
 * 应用一轮变化。返回新的 raw（未钳位，交给 effectiveAffection 出对外的值）。
 * @param {{raw:number, delta:number, mood?:'up'|'down'|'flat', isMaster?:boolean}} input
 */
export function applyDelta({ raw, delta, mood = 'flat', isMaster = false }) {
  if (isMaster) return clamp(raw, 0, AFFECTION_RAW_MAX);
  const d = Number(delta);
  if (!Number.isFinite(d) || d === 0) return clamp(raw, 0, AFFECTION_RAW_MAX);
  const capped = mood === 'down' || d < 0
    ? -clamp(Math.abs(d), 0, MAX_DROP_PER_TURN)
    : clamp(d, 0, MAX_GAIN_PER_TURN);
  return clamp(Number(raw) + capped, 0, AFFECTION_RAW_MAX);
}

/**
 * 久不聊的自然衰减：每满一个空闲日扣 DECAY_PER_IDLE_DAY，最低 DECAY_FLOOR。
 * 主人不衰减。
 */
export function decayIdle({ raw, lastActiveAt, now = Date.now(), isMaster = false }) {
  if (isMaster) return clamp(raw, 0, AFFECTION_RAW_MAX);
  const base = clamp(raw, 0, AFFECTION_RAW_MAX);
  if (!lastActiveAt || !Number.isFinite(Number(lastActiveAt))) return base;
  const idleDays = Math.max(0, (now - Number(lastActiveAt)) / 86_400_000);
  if (idleDays < 1) return base;
  return Math.max(DECAY_FLOOR, base - idleDays * DECAY_PER_IDLE_DAY);
}

/** 给提示词用的一行描述。 */
export function describeAffection({ score, isMaster = false, tiers = DEFAULT_TIERS }) {
  if (isMaster) return `好感 ${score}/100（主人锚点 · 不可超越 · 永远最高）`;
  const tier = tierOf(score, tiers);
  return `好感 ${Math.round(score)}/100（${tier.name}）`;
}