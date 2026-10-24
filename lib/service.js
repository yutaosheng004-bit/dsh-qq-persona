/**
 * 业务编排：采集 → 摘要 → 落库 → 查询/改/删 → 注入文本。
 * 所有对外方法都不抛异常，返回 { ok, error } 形状，方便工具和 HTTP 层直接用。
 */
import path from 'node:path';
import {
  JsonDoc,
  appendJsonl,
  dataDir,
  fileInData,
  readJsonlTail,
} from './store.js';
import {
  applyDelta,
  decayIdle,
  effectiveAffection,
  tierOf,
} from './affection.js';
import {
  applyDigest,
  emptyPerson,
  personaPromptBlock,
  sanitizeDigest,
} from './persona.js';
import { buildDigestPrompt, requestDigest } from './summarize.js';
import { flattenContent, splitSender } from './collect.js';
import {
  applyMoodEvent,
  decayMood,
  describeMood,
  emptyMood,
  moodPromptBlock,
  normalizeMood,
  residueFor,
  setMoodManually,
} from './mood.js';

const PEOPLE_FILE = 'people.json';
const STATE_FILE = 'state.json';
const MOOD_FILE = 'mood.json';
const AUDIT_FILE = 'audit.jsonl';
const PEOPLE_FALLBACK = { v: 1, users: {} };
const STATE_FALLBACK = { v: 1, lastMergeAt: 0, callsThisHour: 0, hourBucket: 0 };
const MOOD_FALLBACK = {
  v: 1,
  valence: 12,
  energy: 60,
  label: '平静',
  reason: '',
  events: [],
  residue: {},
  lock: false,
};

function hourBucketOf(now) {
  return Math.floor(now / 3_600_000);
}

export class PersonaService {
  #ctx;
  #config;
  #log;
  #people;
  #state;
  #mood;
  #queue = Promise.resolve();
  #startedAt = Date.now();
  /** 内存镜像：系统提示词注入是同步的，不能 await 磁盘。 */
  #cache = new Map();
  /** 心情的内存镜像，同上。 */
  #moodCache = normalizeMood(MOOD_FALLBACK);

  constructor({ ctx, config, log }) {
    this.#ctx = ctx;
    this.#config = config;
    this.#log = log || (() => {});
    this.#people = new JsonDoc(fileInData(PEOPLE_FILE), PEOPLE_FALLBACK);
    this.#state = new JsonDoc(fileInData(STATE_FILE), STATE_FALLBACK);
    this.#mood = new JsonDoc(fileInData(MOOD_FILE), MOOD_FALLBACK);
  }

  get config() {
    return this.#config;
  }

  get dir() {
    return dataDir();
  }

  isMaster(qq) {
    return String(qq) === String(this.#config.masterQQ);
  }

  async #db() {
    const data = await this.#people.load();
    if (!data || typeof data !== 'object') return { v: 1, users: {} };
    if (!data.users || typeof data.users !== 'object') data.users = {};
    return data;
  }

  /** 串行化所有写操作。 */
  #serial(task) {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #savePerson(uqq, person) {
    await this.#people.update((data) => {
      const users = data?.users && typeof data.users === 'object' ? data.users : {};
      users[uqq] = person;
      return { ...data, v: 1, users };
    });
    if (person?.deleted) this.#cache.delete(uqq);
    else this.#cache.set(uqq, person);
  }

  async #readPerson(uqq) {
    const data = await this.#db();
    return data.users[uqq] || null;
  }

  /** 是否还有本次运行的模型调用余量。 */
  async #takeCallSlot() {
    const now = Date.now();
    const bucket = hourBucketOf(now);
    let allowed = false;
    await this.#state.update((state) => {
      const s = { ...STATE_FALLBACK, ...(state || {}) };
      if (s.hourBucket !== bucket) {
        s.hourBucket = bucket;
        s.callsThisHour = 0;
      }
      if (s.callsThisHour < this.#config.maxCallsPerHour) {
        s.callsThisHour += 1;
        allowed = true;
      }
      return s;
    });
    return allowed;
  }

  // ---------------------------------------------------------------- 情绪

  /** 当前心情（按时间衰减到此刻）。 */
  moodNow(now = Date.now()) {
    const decayed = decayMood(this.#moodCache, now, {
      halfLifeMs: (this.#config.moodHalflifeHours || 3) * 3_600_000,
    });
    this.#moodCache = decayed;
    return decayed;
  }

  /** 给管理页 / 工具的那一份：心情 + 最近的起伏 + 对人的残留。 */
  moodSnapshot(now = Date.now()) {
    const mood = this.moodNow(now);
    return {
      ok: true,
      ...describeMood(mood),
      since: mood.since,
      updatedAt: mood.updatedAt,
      lock: mood.lock,
      lockReason: mood.lockReason,
      events: mood.events.slice(0, 12),
      residue: Object.entries(mood.residue || {})
        .map(([qq, v]) => ({ qq, off: Math.round(residueFor(mood, qq, now)), note: v?.note || '' }))
        .filter((x) => x.off !== 0)
        .sort((a, b) => a.off - b.off)
        .slice(0, 12),
      enabled: this.#config.moodEnabled !== false,
      baseline: { valence: 12, energy: 60 },
    };
  }

  async #saveMood(mood) {
    const next = normalizeMood(mood);
    this.#moodCache = next;
    await this.#mood.update(() => next);
    return next;
  }

  /** 主人亲手哄 / 惹 / 复位；也能锁定（锁了自动流程就不动心情了）。 */
  async setMood(patch = {}, { by = 'master' } = {}) {
    const now = Date.now();
    const cur = this.moodNow(now);
    const next = setMoodManually(cur, patch, now);
    await this.#saveMood(next);
    await appendJsonl(fileInData(AUDIT_FILE), {
      ts: now,
      by,
      field: 'mood',
      from: Math.round(cur.valence),
      to: Math.round(next.valence),
      reason: typeof patch.reason === 'string' ? patch.reason.slice(0, 200) : 'manual',
    });
    return { ok: true, mood: this.moodSnapshot(now) };
  }

  /** 一键回到基线：心情和残留全清。 */
  async resetMood({ by = 'master' } = {}) {
    const now = Date.now();
    const cur = this.moodNow(now);
    const next = emptyMood(now);
    await this.#saveMood(next);
    await appendJsonl(fileInData(AUDIT_FILE), {
      ts: now,
      by,
      field: 'mood',
      from: Math.round(cur.valence),
      to: Math.round(next.valence),
      reason: 'reset',
    });
    return { ok: true, mood: this.moodSnapshot(now) };
  }

  /** 清掉本鲸对某个人的情绪残留（主人觉得这仇记歪了）。 */
  async clearResidue(qq, { by = 'master' } = {}) {
    const uqq = String(qq || '').trim();
    if (!uqq) return { ok: false, error: 'need qq' };
    const now = Date.now();
    const cur = this.moodNow(now);
    if (!cur.residue || !cur.residue[uqq]) return { ok: false, error: '没有这个人的情绪残留' };
    const residue = { ...cur.residue };
    delete residue[uqq];
    await this.#saveMood({ ...cur, residue });
    await appendJsonl(fileInData(AUDIT_FILE), { ts: now, by, qq: uqq, field: 'mood-residue', reason: 'cleared' });
    return { ok: true, mood: this.moodSnapshot(now) };
  }

  // ---------------------------------------------------------------- 采集

  /** 由 collector 交来的一段聊天。 */
  ingestBatch(batch) {
    return this.#serial(() => this.#digestOne(batch));
  }

  async #digestOne({ qq, chatKey, nickname, lines, msgCount }) {
    if (!this.#config.enabled) return { ok: false, error: 'disabled' };
    const uqq = String(qq);
    if (!uqq) return { ok: false, error: 'no qq' };
    const isMaster = this.isMaster(uqq);
    const person = (await this.#readPerson(uqq)) || emptyPerson(uqq, Date.now());
    if (person.deleted) return { ok: false, error: 'deleted' };

    if (!(await this.#takeCallSlot())) return { ok: false, error: 'rate limited' };

    const prompt = buildDigestPrompt({
      person,
      isMaster,
      botName: this.#config.botName,
      lines,
      chatLabel: chatKey.startsWith('group:') ? 'QQ 群聊' : 'QQ 私聊',
    });

    const result = await requestDigest(this.#ctx, { modelRef: this.#config.model, prompt });
    if (!result.ok) {
      this.#log('warn', `[qq-persona] 摘要失败 ${uqq}: ${result.error}`);
      return { ok: false, error: result.error };
    }

    const digest = sanitizeDigest(result.digest, { msgCount });
    if (isMaster) digest.affectionDelta = 0;

    const before = person.affection?.raw ?? this.#config.newPersonRaw;
    const after = applyDelta({
      raw: before,
      delta: digest.affectionDelta,
      mood: digest.affectionDelta < 0 ? 'down' : 'flat',
      isMaster,
    });

    let next = applyDigest(person, digest, { now: Date.now(), chatKey });
    if (!next.nickname && nickname) next.nickname = nickname;
    next.affection = { raw: after, manual: person.affection?.manual ?? null, updatedAt: Date.now() };

    await this.#savePerson(uqq, next);

    // 情绪跟着这一段一起动：折进「本鲸此刻的心情」，跟对这个人的好感分开记
    let moodLabel = '';
    if (this.#config.moodEnabled !== false && digest.moodDelta) {
      const now = Date.now();
      const cur = this.moodNow(now);
      const moved = applyMoodEvent(
        cur,
        {
          delta: digest.moodDelta,
          reason: digest.moodReason || digest.summary,
          who: next.nickname || uqq,
          qq: uqq,
          isMaster,
        },
        { now, masterWeight: this.#config.masterMoodWeight }
      );
      await this.#saveMood(moved);
      moodLabel = moved.label;
      await appendJsonl(fileInData(AUDIT_FILE), {
        ts: now,
        by: 'auto',
        qq: uqq,
        field: 'mood',
        from: Math.round(cur.valence),
        to: Math.round(moved.valence),
        reason: digest.moodReason || digest.summary,
      });
    }

    await appendJsonl(fileInData('summaries', `${uqq}.jsonl`), {
      ts: Date.now(),
      chatKey,
      msgCount,
      sentiment: digest.sentiment,
      delta: digest.affectionDelta,
      moodDelta: digest.moodDelta,
      moodLabel: moodLabel || undefined,
      reason: digest.reason,
      summary: digest.summary,
    });

    if (!isMaster && after !== before) {
      await appendJsonl(fileInData(AUDIT_FILE), {
        ts: Date.now(),
        by: 'auto',
        qq: uqq,
        field: 'affection',
        from: before,
        to: after,
        reason: digest.reason || `${digest.sentiment} ${digest.affectionDelta}`,
      });
    }
    return { ok: true, qq: uqq, delta: after - before, avoid: next.avoid, mood: moodLabel || undefined };
  }

  // ---------------------------------------------------------------- 查询

  scoreOf(person) {
    if (!person) return 0;
    return effectiveAffection({
      raw: person.affection?.raw ?? 0,
      isMaster: this.isMaster(person.qq),
      masterScore: this.#config.masterScore,
      globalMax: this.#config.globalMax,
    });
  }

  async list({ query = '', limit = 50 } = {}) {
    const data = await this.#db();
    const q = String(query || '').trim().toLowerCase();
    const rows = [];
    for (const [uqq, person] of Object.entries(data.users)) {
      if (!person || person.deleted) continue;
      if (q) {
        const hay = `${uqq} ${person.nickname || ''} ${person.card || ''} ${(person.traits || []).join(' ')} ${person.summary || ''}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const score = this.scoreOf(person);
      rows.push({
        qq: uqq,
        nickname: person.nickname || '',
        card: person.card || '',
        isMaster: this.isMaster(uqq),
        score,
        tier: tierOf(score, this.#config.tiers).name,
        avoid: !!person.avoid,
        pinned: !!person.pinned,
        turns: person.turns || 0,
        msgCount: person.msgCount || 0,
        lastSeen: person.lastSeen || 0,
        relationToMaster: person.relationToMaster || 'unknown',
        traits: person.traits || [],
        summary: person.summary || '',
      });
    }
    rows.sort((a, b) => b.score - a.score || b.lastSeen - a.lastSeen);
    return { ok: true, total: rows.length, rows: rows.slice(0, Math.max(1, Math.min(200, Number(limit) || 50))) };
  }

  async get(qq, { withHistory = true } = {}) {
    const uqq = String(qq || '').trim();
    if (!uqq) return { ok: false, error: 'need qq' };
    const person = await this.#readPerson(uqq);
    if (!person) return { ok: false, error: 'not found' };
    const score = this.scoreOf(person);
    const out = {
      ok: true,
      person: { ...person, deleted: !!person.deleted },
      score,
      ceiling: this.isMaster(uqq) ? this.#config.masterScore : Math.min(this.#config.globalMax, this.#config.masterScore),
      tier: tierOf(score, this.#config.tiers),
      isMaster: this.isMaster(uqq),
    };
    if (withHistory) out.history = await readJsonlTail(fileInData('summaries', `${uqq}.jsonl`), 30);
    return out;
  }

  // ---------------------------------------------------------------- 管理

  async update(qq, patch = {}, { by = 'master' } = {}) {
    const uqq = String(qq || '').trim();
    if (!uqq) return { ok: false, error: 'need qq' };
    const person = await this.#readPerson(uqq);
    if (!person) return { ok: false, error: 'not found' };
    const next = { ...person };
    const changes = [];

    const take = (key, value) => {
      if (value === undefined) return;
      changes.push({ key, from: person[key], to: value });
      next[key] = value;
    };

    if (typeof patch.nickname === 'string') take('nickname', patch.nickname.slice(0, 40));
    if (typeof patch.card === 'string') take('card', patch.card.slice(0, 40));
    if (typeof patch.summary === 'string') take('summary', patch.summary.slice(0, this.#config.summaryMaxChars));
    if (typeof patch.style === 'string') take('style', patch.style.slice(0, 60));
    if (typeof patch.attitudeToMe === 'string') take('attitudeToMe', patch.attitudeToMe.slice(0, 60));
    if (typeof patch.notes === 'string') take('notes', patch.notes.slice(0, 2000));
    if (Array.isArray(patch.traits)) take('traits', patch.traits.filter((x) => typeof x === 'string').slice(0, 6));
    if (Array.isArray(patch.topics)) take('topics', patch.topics.filter((x) => typeof x === 'string').slice(0, 6));
    if (typeof patch.avoid === 'boolean') take('avoid', patch.avoid);
    if (typeof patch.pinned === 'boolean') take('pinned', patch.pinned);
    if (typeof patch.relationToMaster === 'string') take('relationToMaster', patch.relationToMaster);

    if (patch.affection !== undefined) {
      const raw = Number(patch.affection);
      if (!Number.isFinite(raw)) return { ok: false, error: 'affection must be number' };
      if (this.isMaster(uqq)) {
        return { ok: false, error: '主人的好感是锚点，不允许手改' };
      }
      const clampedRaw = Math.max(0, Math.min(100, raw));
      changes.push({ key: 'affection', from: person.affection?.raw, to: clampedRaw });
      next.affection = { raw: clampedRaw, manual: true, updatedAt: Date.now() };
    }

    next.lastSeen = person.lastSeen || Date.now();
    await this.#savePerson(uqq, next);
    for (const c of changes) {
      await appendJsonl(fileInData(AUDIT_FILE), {
        ts: Date.now(),
        by,
        qq: uqq,
        field: c.key,
        from: c.from,
        to: c.to,
        reason: typeof patch.reason === 'string' ? patch.reason.slice(0, 200) : 'manual',
      });
    }
    return { ok: true, changed: changes.length, person: next, score: this.scoreOf(next) };
  }

  async remove(qq, { hard = false, by = 'master' } = {}) {
    const uqq = String(qq || '').trim();
    if (!uqq) return { ok: false, error: 'need qq' };
    if (this.isMaster(uqq)) return { ok: false, error: '主人不能被删' };
    const person = await this.#readPerson(uqq);
    if (!person) return { ok: false, error: 'not found' };
    if (hard) {
      await this.#people.update((data) => {
        const users = data?.users || {};
        delete users[uqq];
        return { ...data, v: 1, users };
      });
    } else {
      await this.#savePerson(uqq, { ...person, deleted: true, summary: '', traits: [], topics: [], style: '', attitudeToMe: '' });
    }
    await appendJsonl(fileInData(AUDIT_FILE), { ts: Date.now(), by, qq: uqq, field: 'delete', hard });
    return { ok: true, hard };
  }

  /** 用会话历史重做一遍画像（主人手点「重建」时用）。 */
  async rebuild(qq, { by = 'master' } = {}) {
    const uqq = String(qq || '').trim();
    if (!uqq) return { ok: false, error: 'need qq' };
    const person = (await this.#readPerson(uqq)) || emptyPerson(uqq, Date.now());
    const lines = await this.#collectHistory(uqq, person);
    if (!lines.length) return { ok: false, error: '这个号没有可用的历史消息' };
    if (!(await this.#takeCallSlot())) return { ok: false, error: 'rate limited' };
    const prompt = buildDigestPrompt({
      person,
      isMaster: this.isMaster(uqq),
      botName: this.#config.botName,
      lines,
      chatLabel: '历史回放',
    });
    const result = await requestDigest(this.#ctx, { modelRef: this.#config.model, prompt });
    if (!result.ok) return { ok: false, error: result.error };
    const digest = sanitizeDigest(result.digest, { msgCount: lines.length });
    const next = applyDigest(person, digest, { now: Date.now() });
    await this.#savePerson(uqq, next);
    await appendJsonl(fileInData(AUDIT_FILE), { ts: Date.now(), by, qq: uqq, field: 'rebuild', lines: lines.length });
    return { ok: true, person: next, lines: lines.length };
  }

  async #collectHistory(uqq, person) {
    const chats = Array.isArray(person.chats) && person.chats.length
      ? person.chats
      : [];
    const controller = this.#ctx.get ? this.#ctx.get('sessionController') : undefined;
    if (!controller || typeof controller.inspect !== 'function') return [];
    const lines = [];
    for (const chatKey of chats.slice(0, 3)) {
      const sid = `onebot-${String(chatKey).replace(/[^A-Za-z0-9-]/g, '-')}`;
      try {
        const report = await controller.inspect(sid);
        const events = Array.isArray(report?.events) ? report.events : [];
        for (const event of events.slice(-400)) {
          if (!event || event.type !== 'user/message') continue;
          const flat = flattenContent(event.data);
          if (!flat) continue;
          const { qq, text } = splitSender(flat, '');
          if (String(qq) !== uqq || !text) continue;
          lines.push(text.slice(0, 400));
          if (lines.length >= 200) break;
        }
      } catch (error) {
        this.#log('warn', `[qq-persona] 读历史失败 ${sid}: ${error instanceof Error ? error.message : error}`);
      }
      if (lines.length >= 200) break;
    }
    return lines;
  }

  // ---------------------------------------------------------------- 注入

  /** 启动时把画像载进内存：系统提示词注入是同步的，不能 await 磁盘。 */
  async bootstrap() {
    const data = await this.#db();
    this.#cache.clear();
    for (const [uqq, person] of Object.entries(data.users || {})) {
      if (person && !person.deleted) this.#cache.set(uqq, person);
    }
    this.#moodCache = normalizeMood(await this.#mood.load(), Date.now());
    return this.#cache.size;
  }

  /** 同步版注入文本。私聊按对方出整段，群聊出「这个群里认识的几个人」。 */
  syncBlock(sessionId) {
    if (!this.#config.injectPersona) return '';
    const m = /^onebot-(private|group)-(.+)$/.exec(String(sessionId || ''));
    if (!m) return '';
    const body = m[1] === 'private' ? this.#blockForPerson(m[2]) : this.#blockForGroup(m[2]);
    // 心情放最前面：它决定的是「用什么语气说」，优先级高于对某个人的具体印象
    const mood = this.#blockForMood(m[2], m[1] === 'private');
    return [mood, body].filter(Boolean).join('\n\n');
  }

  #blockForMood(peer, isPrivate) {
    if (this.#config.moodEnabled === false) return '';
    const mood = this.moodNow();
    return moodPromptBlock({
      mood,
      qq: isPrivate ? peer : '',
      isMaster: isPrivate && this.isMaster(peer),
      botName: this.#config.botName,
    });
  }

  #blockForPerson(uqq) {
    const person = this.#cache.get(uqq);
    if (!person) return '';
    const score = this.scoreOf(person);
    return personaPromptBlock({
      person,
      score,
      isMaster: this.isMaster(uqq),
      tier: tierOf(score, this.#config.tiers),
    });
  }

  #blockForGroup(gid) {
    const chatKey = `group:${gid}`;
    const members = [];
    for (const [uqq, person] of this.#cache) {
      if (!Array.isArray(person.chats) || !person.chats.includes(chatKey)) continue;
      members.push({ qq: uqq, person, score: this.scoreOf(person) });
    }
    if (!members.length) return '';
    members.sort((a, b) => (b.person.turns || 0) - (a.person.turns || 0));
    const lines = ['【这个群里你认识的几个人】'];
    for (const { qq, person, score } of members.slice(0, 8)) {
      const name = person.card || person.nickname || qq;
      const parts = [`${name}（${qq}）`, `${Math.round(score)}分`];
      if (this.isMaster(qq)) parts.push('主人');
      else if (person.avoid) parts.push('你不太想理他');
      if (person.traits?.length) parts.push(person.traits.slice(0, 3).join('/'));
      if (person.summary) parts.push(person.summary.slice(0, 50));
      lines.push(`· ${parts.join(' · ')}`);
    }
    lines.push('（这些是你自己的印象，别念出来；印象差的人可以冷一点。）');
    return lines.join('\n');
  }

  /** 给某个 QQ 号生成要注入对话的画像段落。 */
  async promptBlockFor(qq) {
    const uqq = String(qq || '').trim();
    if (!uqq) return '';
    const person = await this.#readPerson(uqq);
    if (!person || person.deleted) return '';
    const score = this.scoreOf(person);
    return personaPromptBlock({
      person,
      score,
      isMaster: this.isMaster(uqq),
      tier: tierOf(score, this.#config.tiers),
    });
  }

  // ---------------------------------------------------------------- 维护

  /** 每日：久不聊的降一点，主人不动。 */
  async dailyDecay() {
    const now = Date.now();
    let touched = 0;
    await this.#people.update((data) => {
      const users = data?.users || {};
      for (const [uqq, person] of Object.entries(users)) {
        if (!person || person.deleted || this.isMaster(uqq)) continue;
        const raw = person.affection?.raw ?? this.#config.newPersonRaw;
        const next = decayIdle({ raw, lastActiveAt: person.lastSeen, now });
        if (Math.abs(next - raw) >= 0.01) {
          person.affection = { raw: next, manual: person.affection?.manual ?? null, updatedAt: now };
          touched += 1;
        }
      }
      return { ...data, v: 1, users };
    });
    await this.#state.update((state) => ({ ...STATE_FALLBACK, ...(state || {}), lastMergeAt: now }));
    return { ok: true, touched };
  }

  /** 管理页总览：设置 + 统计。 */
  async overview() {
    const data = await this.#db();
    const users = Object.values(data.users || {}).filter((p) => p && !p.deleted);
    const state = await this.#state.load();
    return {
      ok: true,
      dir: this.dir,
      config: {
        masterQQ: this.#config.masterQQ,
        masterScore: this.#config.masterScore,
        globalMax: this.#config.globalMax,
        newPersonRaw: this.#config.newPersonRaw,
        botName: this.#config.botName,
        model: this.#config.model,
        enabled: this.#config.enabled,
        watch: this.#config.watch,
        injectPersona: this.#config.injectPersona,
        maxCallsPerHour: this.#config.maxCallsPerHour,
        dailyMergeHour: this.#config.dailyMergeHour,
        ceiling: Math.min(this.#config.globalMax, this.#config.masterScore),
        moodEnabled: this.#config.moodEnabled !== false,
        moodHalflifeHours: this.#config.moodHalflifeHours,
        masterMoodWeight: this.#config.masterMoodWeight,
      },
      mood: this.moodSnapshot(),
      stats: {
        people: users.length,
        turns: users.reduce((sum, p) => sum + (p.turns || 0), 0),
        messages: users.reduce((sum, p) => sum + (p.msgCount || 0), 0),
        avoiding: users.filter((p) => p.avoid).length,
        lastMergeAt: state.lastMergeAt || 0,
        uptimeMs: Date.now() - this.#startedAt,
      },
    };
  }

  /** 修改全局设置（主人）。 */
  async updateSettings(patch = {}) {
    const cfg = this.#config;
    const applied = {};
    if (typeof patch.enabled === 'boolean') applied.enabled = patch.enabled;
    if (typeof patch.watch === 'boolean') applied.watch = patch.watch;
    if (typeof patch.injectPersona === 'boolean') applied.injectPersona = patch.injectPersona;
    if (typeof patch.moodEnabled === 'boolean') applied.moodEnabled = patch.moodEnabled;
    if (patch.moodHalflifeHours !== undefined) {
      const v = Number(patch.moodHalflifeHours);
      if (Number.isFinite(v)) applied.moodHalflifeHours = Math.max(0.5, Math.min(24, v));
    }
    if (patch.masterMoodWeight !== undefined) {
      const v = Number(patch.masterMoodWeight);
      if (Number.isFinite(v)) applied.masterMoodWeight = Math.max(1, Math.min(3, v));
    }
    if (typeof patch.model === 'string') applied.model = patch.model.trim();
    if (patch.globalMax !== undefined) {
      const v = Number(patch.globalMax);
      if (Number.isFinite(v)) applied.globalMax = Math.max(0, Math.min(100, v));
    }
    if (patch.masterScore !== undefined) {
      const v = Number(patch.masterScore);
      if (Number.isFinite(v)) applied.masterScore = Math.max(0, Math.min(100, v));
    }
    if (patch.maxCallsPerHour !== undefined) {
      const v = Number(patch.maxCallsPerHour);
      if (Number.isFinite(v)) applied.maxCallsPerHour = Math.max(1, Math.min(500, v));
    }
    if (patch.dailyMergeHour !== undefined) {
      const v = Number(patch.dailyMergeHour);
      if (Number.isFinite(v)) applied.dailyMergeHour = Math.max(0, Math.min(23, v));
    }
    // 天花板永远钳在 min(globalMax, masterScore) 之下
    Object.assign(cfg, applied);
    await appendJsonl(fileInData(AUDIT_FILE), { ts: Date.now(), by: 'master', field: 'settings', patch: applied });
    return { ok: true, applied, config: cfg };
  }

  async auditTail(maxLines = 100) {
    return readJsonlTail(fileInData(AUDIT_FILE), maxLines);
  }
}