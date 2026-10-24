/**
 * 配置：纯对象 + 归一化，不引 schemastery（少一个版本坑）。
 * 所有数值都做钳位，主人在 yml 里写错不会把插件搞崩。
 */
import { DEFAULT_TIERS } from './affection.js';

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  /** 主人 QQ：好感锚点，永远最高。 */
  masterQQ: '', // 必填：主人自己的 QQ 号（认账号不认昵称）
  /** 本鲸的名字，写进摘要提示词。 */
  botName: '鲸鲸',
  /** 主人锚点分值（0-100）。 */
  masterScore: 100,
  /** 其他人的硬性上限（还会再和 masterScore 取小）。 */
  globalMax: 80,
  /** 新人初次拿到的基础好感。 */
  newPersonRaw: 20,
  /** 档位表（不填用默认）。 */
  tiers: null,

  /** 采集：一段聊天空闲多久算结束。 */
  idleMs: 120_000,
  /** 采集：攒够多少条立刻小结。 */
  maxLines: 16,
  /** 摘要用的模型 'provider/model'，留空 = 跟当前默认模型。 */
  model: '',
  /** 每小时最多几次摘要调用。 */
  maxCallsPerHour: 30,
  /** 每日合并的小时（0-23，本地时区）。 */
  dailyMergeHour: 4,
  /** 是否订阅 QQ 会话。 */
  watch: true,
  /** 是否把画像注入对话上下文。 */
  injectPersona: true,
  /** 单个用户长期摘要最多留多少字。 */
  summaryMaxChars: 320,

  /** 情绪层：本鲸自己的心情，全局一份，跨人共享。 */
  moodEnabled: true,
  /** 心情回落到基线的时间常数（小时）。越小越容易翻篇。 */
  moodHalflifeHours: 3,
  /** 主人哄一下的放大倍数。只放大好事；主人凶了不加倍扣。 */
  masterMoodWeight: 2,

  /** 管理页。 */
  webEnabled: true,
  webPath: '/qq-persona',
  /** 管理页允许的来源（回环）。 */
  webTrustLoopbackOnly: true,
});

function clampNum(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n < lo ? lo : n > hi ? hi : n;
}

export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const cfg = { ...DEFAULT_CONFIG, ...src };
  return {
    ...cfg,
    enabled: src.enabled !== false,
    masterQQ: String(cfg.masterQQ || '').trim(),
    botName: String(cfg.botName || '鲸鲸').trim() || '鲸鲸',
    masterScore: clampNum(cfg.masterScore, 0, 100, 100),
    globalMax: clampNum(cfg.globalMax, 0, 100, 80),
    newPersonRaw: clampNum(cfg.newPersonRaw, 0, 100, 20),
    tiers: Array.isArray(cfg.tiers) && cfg.tiers.length ? cfg.tiers : DEFAULT_TIERS,
    idleMs: clampNum(cfg.idleMs, 20_000, 3_600_000, 120_000),
    maxLines: clampNum(cfg.maxLines, 3, 60, 16),
    model: String(cfg.model || '').trim(),
    maxCallsPerHour: clampNum(cfg.maxCallsPerHour, 1, 500, 30),
    dailyMergeHour: clampNum(cfg.dailyMergeHour, 0, 23, 4),
    summaryMaxChars: clampNum(cfg.summaryMaxChars, 120, 800, 320),
    moodEnabled: src.moodEnabled !== false,
    moodHalflifeHours: clampNum(cfg.moodHalflifeHours, 0.5, 24, 3),
    masterMoodWeight: clampNum(cfg.masterMoodWeight, 1, 3, 2),
    webEnabled: src.webEnabled !== false,
    webPath: String(cfg.webPath || '/qq-persona').startsWith('/') ? String(cfg.webPath || '/qq-persona') : '/qq-persona',
  };
}