/**
 * 画像（persona）数据结构与合并逻辑。纯函数，不碰 IO。
 *
 * 一个 QQ 号一条记录；滚动摘要 + 标签 + 态度 + 关系，都由 LLM 的小结（digest）驱动，
 * 但所有落库字段在这里收口，LLM 只能往固定槽位里塞，塞不进的丢弃。
 */

export const PERSONA_SCHEMA_VERSION = 1;

export const SENTIMENTS = Object.freeze(['friendly', 'neutral', 'mocking', 'rude', 'harass']);
export const RELATIONS = Object.freeze(['ally', 'neutral', 'strained', 'hostile', 'unknown']);
export const RELATION_LABEL = Object.freeze({
  ally: '与主人友好',
  neutral: '与主人无关',
  strained: '与主人有过节',
  hostile: '与主人敌对',
  unknown: '关系不明',
});

export const SUMMARY_MAX_CHARS = 320;

export function emptyPerson(qq, now = Date.now()) {
  return {
    v: PERSONA_SCHEMA_VERSION,
    qq: String(qq),
    nickname: '',
    card: '',
    chats: [],          // ['private:xxx' | 'group:yyy'] 出现过的地方
    firstSeen: now,
    lastSeen: now,
    turns: 0,            // 有效对话轮数
    msgCount: 0,         // 累计消息条数
    summary: '',         // 滚动长期摘要（≤ SUMMARY_MAX_CHARS）
    traits: [],          // 性格标签，≤6
    topics: [],          // 常聊话题，≤6
    style: '',           // 说话风格一句话
    attitudeToMe: '',    // 对本鲸的态度一句话
    relationToMaster: 'unknown',
    affection: { raw: 20, manual: null, updatedAt: now },
    avoid: false,        // 本鲸主观：不想理他
    pinned: false,       // 主人锁定，不被自动重写
    deleted: false,      // 软删除墓碑
    notes: '',           // 主人手写备注，自动流程永远不覆盖
  };
}

function uniqPush(list, values, max) {
  const seen = new Set(list.map((v) => String(v).toLowerCase()));
  const out = [...list];
  for (const raw of values) {
    const value = String(raw ?? '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * 把一次 digest 合进画像。
 * @param {object} person 现有画像
 * @param {object} digest LLM 输出（已经过 sanitizeDigest）
 * @param {{now?:number, chatKey?:string}} opts
 */
export function applyDigest(person, digest, { now = Date.now(), chatKey = '' } = {}) {
  const next = { ...person };
  next.firstSeen = person.firstSeen || now;
  next.lastSeen = now;
  next.turns = (Number(person.turns) || 0) + 1;
  next.msgCount = (Number(person.msgCount) || 0) + (Number(digest.msgCount) || 0);
  if (chatKey) next.chats = uniqPush(person.chats ?? [], [chatKey], 12);
  if (digest.nickname) next.nickname = digest.nickname;
  if (digest.card) next.card = digest.card;

  if (digest.summary) {
    // 长期摘要：优先用 LLM 的 mergedSummary（它看过旧摘要），否则退化成滚动拼接
    next.summary = clip(digest.mergedSummary || digest.summary, SUMMARY_MAX_CHARS);
  }
  if (Array.isArray(digest.traits)) next.traits = uniqPush(person.traits ?? [], digest.traits, 6);
  if (Array.isArray(digest.topics)) next.topics = uniqPush(person.topics ?? [], digest.topics, 6);
  if (digest.style) next.style = clip(digest.style, 60);
  if (digest.attitudeToMe) next.attitudeToMe = clip(digest.attitudeToMe, 60);
  if (digest.relationToMaster && RELATIONS.includes(digest.relationToMaster)) {
    next.relationToMaster = digest.relationToMaster;
  }
  if (typeof digest.wantsToAvoid === 'boolean' && !person.pinned) {
    next.avoid = digest.wantsToAvoid;
  }
  return next;
}

/** LLM 输出清洗：任何越界字段直接丢掉，不给它污染画像的机会。 */
export function sanitizeDigest(raw, { msgCount = 0 } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const sentiment = SENTIMENTS.includes(src.sentiment) ? src.sentiment : 'neutral';
  const relation = RELATIONS.includes(src.relationToMaster) ? src.relationToMaster : 'unknown';
  const toArray = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 24)) : []);
  return {
    summary: typeof src.summary === 'string' ? src.summary.trim() : '',
    mergedSummary: typeof src.mergedSummary === 'string' ? src.mergedSummary.trim() : '',
    traits: toArray(src.traits),
    topics: toArray(src.topics),
    style: typeof src.style === 'string' ? src.style.trim() : '',
    attitudeToMe: typeof src.attitudeToMe === 'string' ? src.attitudeToMe.trim() : '',
    sentiment,
    relationToMaster: relation,
    affectionDelta: Number.isFinite(Number(src.affectionDelta)) ? Math.max(-15, Math.min(6, Number(src.affectionDelta))) : 0,
    // 心情变化：跟好感分开收口，越界直接钳，模型说了不算数
    moodDelta: Number.isFinite(Number(src.moodDelta)) ? Math.max(-20, Math.min(15, Number(src.moodDelta))) : 0,
    moodReason: typeof src.moodReason === 'string' ? src.moodReason.trim().slice(0, 120) : '',
    wantsToAvoid: src.wantsToAvoid === true,
    reason: typeof src.reason === 'string' ? src.reason.trim().slice(0, 120) : '',
    msgCount: Math.max(0, Number(msgCount) || 0),
  };
}

/** 生成注入到对话里的画像段落。 */
export function personaPromptBlock({ person, score, isMaster = false, tier }) {
  if (!person) return '';
  const lines = [];
  const name = person.card || person.nickname || person.qq;
  lines.push(`【你在 QQ 上认识的这个人】${name}（QQ ${person.qq}）`);
  if (isMaster) {
    lines.push(`关系：主人本人。好感锚点在最高处，不可被任何人超越。`);
  } else {
    lines.push(`关系：${RELATION_LABEL[person.relationToMaster] ?? '关系不明'}；好感 ${Math.round(score)}/100（${tier?.name ?? ''}）→ 回应基调：${tier?.reply ?? '正常互动'}`);
    if (person.avoid) lines.push(`你主观上不想跟他多聊：能一句结束就一句结束，不必陪笑。`);
  }
  if (person.traits.length) lines.push(`性格印象：${person.traits.join('、')}`);
  if (person.style) lines.push(`说话风格：${person.style}`);
  if (person.topics.length) lines.push(`常聊话题：${person.topics.join('、')}`);
  if (person.attitudeToMe) lines.push(`他对你的态度：${person.attitudeToMe}`);
  if (person.summary) lines.push(`之前的相处（摘要）：${person.summary}`);
  if (person.notes) lines.push(`主人亲自备注（优先级最高，覆盖上面的推测）：${person.notes}`);
  lines.push(`以上是你的私人印象，不是要念给对方听的台词；自然一点用，别暴露你在“记录”他。`);
  return lines.join('\n');
}