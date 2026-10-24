/**
 * 纯逻辑冒烟测试（不碰网络、不碰 LLM、不写用户数据目录）。
 * 跑法：node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import {
  applyDelta,
  ceilingOf,
  decayIdle,
  effectiveAffection,
  tierOf,
} from '../lib/affection.js';
import { applyDigest, emptyPerson, sanitizeDigest } from '../lib/persona.js';
import { ChatCollector, parseOnebotSessionId, splitSender } from '../lib/collect.js';
import { normalizeConfig } from '../lib/config.js';
import {
  applyMoodEvent,
  BASELINE_VALENCE,
  decayMood,
  effectiveValence,
  emptyMood,
  labelOf,
  moodPromptBlock,
  residueFor,
  setMoodManually,
} from '../lib/mood.js';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
};

console.log('[affection] 硬规则');
test('主人永远等于锚点，哪怕 raw 很低', () => {
  assert.equal(effectiveAffection({ raw: 0, isMaster: true, masterScore: 100, globalMax: 80 }), 100);
});
test('别人不超过 min(globalMax, masterScore)', () => {
  assert.equal(effectiveAffection({ raw: 100, isMaster: false, masterScore: 100, globalMax: 80 }), 80);
  assert.equal(effectiveAffection({ raw: 100, isMaster: false, masterScore: 40, globalMax: 80 }), 40);
});
test('天花板随主人锚点变化', () => {
  assert.equal(ceilingOf({ masterScore: 55, globalMax: 80 }), 55);
  assert.equal(ceilingOf({ masterScore: 100, globalMax: 30 }), 30);
});
test('单轮涨幅封顶 +6', () => {
  assert.equal(applyDelta({ raw: 20, delta: 99 }), 26);
});
test('单轮跌幅封顶 -15', () => {
  assert.equal(applyDelta({ raw: 50, delta: -99, mood: 'down' }), 35);
});
test('分数不越界', () => {
  assert.equal(applyDelta({ raw: 98, delta: 6 }), 100);
  assert.equal(applyDelta({ raw: 3, delta: -15, mood: 'down' }), 0);
});
test('主人加不上去', () => {
  assert.equal(applyDelta({ raw: 100, delta: 6, isMaster: true }), 100);
});
test('久不聊会衰减但有地板', () => {
  const now = Date.now();
  const raw = 60;
  const idle = decayIdle({ raw, lastActiveAt: now - 10 * 86_400_000, now });
  assert.ok(idle < raw, '应该降');
  assert.ok(idle >= 12, '不该低于地板');
  assert.equal(decayIdle({ raw, lastActiveAt: now, now }), raw);
});
test('档位命中', () => {
  assert.equal(tierOf(100).key, 'bonded');
  assert.equal(tierOf(0).key, 'cold');
});

console.log('[persona] 合并与清洗');
test('越界字段被丢弃', () => {
  const d = sanitizeDigest({ sentiment: '想删库', affectionDelta: -999, traits: ['a', 1, 'b'], relationToMaster: 'hate' });
  assert.equal(d.sentiment, 'neutral');
  assert.equal(d.affectionDelta, -15);
  assert.deepEqual(d.traits, ['a', 'b']);
  assert.equal(d.relationToMaster, 'unknown');
});
test('traits 去重且截到 6 个', () => {
  const p = emptyPerson('1');
  const next = applyDigest(p, sanitizeDigest({ traits: ['贪吃', '贪吃', 'a', 'b', 'c', 'd', 'e', 'f'] }), { now: 1 });
  assert.deepEqual(next.traits, ['贪吃', 'a', 'b', 'c', 'd', 'e']);
});
test('轮数与消息数累加', () => {
  const p = emptyPerson('1');
  p.msgCount = 5;
  const next = applyDigest(p, sanitizeDigest({ summary: 'hi' }, { msgCount: 3 }), { now: 2 });
  assert.equal(next.turns, 1);
  assert.equal(next.msgCount, 8);
});
test('pinned 时不改 avoid', () => {
  const p = { ...emptyPerson('1'), pinned: true, avoid: true };
  const next = applyDigest(p, sanitizeDigest({ wantsToAvoid: false }), { now: 1 });
  assert.equal(next.avoid, true);
});
test('摘要长度受限', () => {
  const p = emptyPerson('1');
  const next = applyDigest(p, sanitizeDigest({ mergedSummary: 'x'.repeat(2000) }), { now: 1 });
  assert.ok(next.summary.length <= 320, `实际 ${next.summary.length}`);
});

console.log('[collect] 解析');
test('私有会话 id', () => {
  assert.deepEqual(parseOnebotSessionId('onebot-private-10000001'), { kind: 'private', peer: '10000001', chatKey: 'private:10000001' });
  assert.equal(parseOnebotSessionId('local-web-1'), null);
});
test('剥 user_message 标签', () => {
  const r = splitSender('<user_message qq="123" nickname="小明">\n你好啊\n</user_message>', '');
  assert.equal(r.qq, '123');
  assert.equal(r.nickname, '小明');
  assert.equal(r.text, '你好啊');
});
test('剥群聊前缀', () => {
  const r = splitSender('[12:34 阿花(10001)][@我] 在吗', '');
  assert.equal(r.qq, '10001');
  assert.equal(r.nickname, '阿花');
  assert.equal(r.text, '在吗');
});
test('私聊无标签时用 peer 兜底', () => {
  const r = splitSender('随便说句话', '777');
  assert.equal(r.qq, '777');
});
test('采集器按发言人分线并成批', () => {
  const batches = [];
  const c = new ChatCollector({ idleMs: 60_000, maxLines: 3, onBatch: (b) => batches.push(b) });
  c.ingest('onebot-private-1', { content: [{ type: 'text', text: '<user_message qq="1" nickname="甲">话1</user_message>' }] });
  c.ingest('onebot-private-1', { content: [{ type: 'text', text: '<user_message qq="1" nickname="甲">话2</user_message>' }] });
  assert.equal(batches.length, 0, '还没到阈值');
  c.ingest('onebot-private-1', { content: [{ type: 'text', text: '<user_message qq="1" nickname="甲">话3</user_message>' }] });
  assert.equal(batches.length, 1, '到 3 条应立刻交批');
  assert.equal(batches[0].qq, '1');
  assert.equal(batches[0].msgCount, 3);
  c.dispose();
});
test('非 QQ 会话不采集', () => {
  const c = new ChatCollector({ idleMs: 1000, maxLines: 3, onBatch: () => {} });
  assert.equal(c.ingest('local-web-1', { content: [{ type: 'text', text: 'hi' }] }), false);
  c.dispose();
});

console.log('[mood] 情绪（跟好感分开记）');
test('基线是平静、偏正一点', () => {
  const m = emptyMood(1000);
  assert.equal(m.label, '平静');
  assert.equal(m.valence, BASELINE_VALENCE);
  assert.deepEqual(m.residue, {});
});
test('心情标签按二维判档', () => {
  assert.equal(labelOf({ valence: 80, energy: 70 }), '兴奋');
  assert.equal(labelOf({ valence: 80, energy: 20 }), '得意');
  assert.equal(labelOf({ valence: 40, energy: 70 }), '开心');
  assert.equal(labelOf({ valence: 30, energy: 70 }), '平静');
  assert.equal(labelOf({ valence: -30, energy: 60 }), '烦躁');
  assert.equal(labelOf({ valence: -30, energy: 10 }), '委屈');
  assert.equal(labelOf({ valence: -90, energy: 50 }), '生气');
  assert.equal(labelOf({ valence: -90, energy: 5 }), '低落');
});
test('被冒犯会掉心情，单次最多掉 20', () => {
  const m = applyMoodEvent(emptyMood(1000), { delta: -8 }, { now: 2000 });
  assert.ok(m.valence < BASELINE_VALENCE, '心情没掉');
  const worse = applyMoodEvent(emptyMood(1000), { delta: -99 }, { now: 2000 });
  assert.equal(worse.valence, BASELINE_VALENCE - 20);
});
test('单次最多涨 15（不许一次被捧上天）', () => {
  const m = applyMoodEvent(emptyMood(1000), { delta: 99 }, { now: 2000 });
  assert.equal(m.valence, BASELINE_VALENCE + 15);
});
test('主人哄一下加倍，但主人凶了不加倍', () => {
  const plain = applyMoodEvent(emptyMood(1000), { delta: 5 }, { now: 2000 });
  const master = applyMoodEvent(emptyMood(1000), { delta: 5, isMaster: true }, { now: 2000, masterWeight: 2 });
  assert.equal(master.valence - BASELINE_VALENCE, (plain.valence - BASELINE_VALENCE) * 2);
  const scold = applyMoodEvent(emptyMood(1000), { delta: -5, isMaster: true }, { now: 2000, masterWeight: 2 });
  assert.equal(scold.valence, BASELINE_VALENCE - 5);
});
test('锁定后自动事件不再改心情', () => {
  const locked = setMoodManually(emptyMood(1000), { valence: 70, lock: true, reason: '主人哄好了' }, 2000);
  const after = applyMoodEvent(locked, { delta: -15 }, { now: 3000 });
  assert.equal(after.valence, 70);
  assert.equal(after.lock, true);
});
test('情绪残留只记在非主人头上，主人不吃残留', () => {
  const m = applyMoodEvent(emptyMood(1000), { delta: -10, qq: '999', who: '路人' }, { now: 2000 });
  assert.ok(residueFor(m, '999', 2000) < 0, '没留下残留');
  assert.ok(effectiveValence(m, '999', { now: 2000 }) < m.valence, '见他时起点没变低');
  const masterBad = applyMoodEvent(emptyMood(1000), { delta: -10, qq: '10000001', isMaster: true }, { now: 2000 });
  assert.equal(residueFor(masterBad, '10000001', 2000), 0, '不该给主人记账');
});
test('残留会随时间淡掉', () => {
  const m = applyMoodEvent(emptyMood(0), { delta: -12, qq: '999' }, { now: 1000 });
  const nowOff = Math.abs(residueFor(m, '999', 1000));
  const laterOff = Math.abs(residueFor(m, '999', 1000 + 20 * 3_600_000));
  assert.ok(laterOff < nowOff * 0.6, `20 小时后没淡下去：${nowOff} -> ${laterOff}`);
});
test('心情会随时间回落到基线', () => {
  const angry = setMoodManually(emptyMood(0), { valence: -80 }, 1000);
  const later = decayMood(angry, 1000 + 3 * 3_600_000);
  assert.ok(Math.abs(later.valence - (BASELINE_VALENCE + (-80 - BASELINE_VALENCE) / 2)) < 6, `没回到一半：${later.valence}`);
  assert.ok(later.valence > angry.valence, '没回升');
});
test('注入段落自带约束，不会变成念出来的台词', () => {
  const block = moodPromptBlock({ mood: setMoodManually(emptyMood(0), { valence: -70 }, 1000), botName: '鲸鲸' });
  assert.ok(block.includes('鲸鲸此刻的状态'));
  assert.ok(block.includes('不许骂人'));
  assert.ok(block.includes('不改变谁是主人'));
  assert.ok(block.includes('不要报心情分数'));
});
test('心情差的时候会明确要求少聊', () => {
  const m = setMoodManually(emptyMood(0), { valence: -60 }, 1000);
  const block = moodPromptBlock({ mood: m, botName: '鲸鲸' });
  assert.ok(block.includes('不太想多聊'), block);
});
test('见到惹过自己的人会多一句沉', () => {
  const m = applyMoodEvent(emptyMood(0), { delta: -14, qq: '999', reason: '他骂人' }, { now: 1000 });
  const block = moodPromptBlock({ mood: m, qq: '999', botName: '鲸鲸', now: 1000 });
  assert.ok(block.includes('心里还沉一点'), block);
});

console.log('[config] 归一化');
test('超范围值被钳住', () => {
  const c = normalizeConfig({ masterScore: 999, globalMax: -5, idleMs: 1, maxLines: 0 });
  assert.equal(c.masterScore, 100);
  assert.equal(c.globalMax, 0);
  assert.equal(c.idleMs, 20_000);
  assert.equal(c.maxLines, 3);
});
test('webPath 必须以 / 开头', () => {
  assert.equal(normalizeConfig({ webPath: 'qq-persona' }).webPath, '/qq-persona');
});

console.log(`\n通过 ${passed} 项`);