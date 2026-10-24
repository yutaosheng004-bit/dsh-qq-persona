/**
 * 宿主模拟自检：用假的 ctx 真跑一遍 apply()，验证装配形状是否正确。
 * 不联网、不调真模型、不碰真实数据目录（DSH_HOME 指向临时目录）。
 * 跑法：node test/host-sim.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qqp-'));
process.env.DSH_HOME = home;

const MASTER = '10000001';
const PEER = '12345';
const SID = `onebot-private-${PEER}`;

const DIGEST = JSON.stringify({
  summary: '随便聊了几句游戏',
  mergedSummary: '一个话挺多、爱聊游戏、说话客气的人。',
  traits: ['话多', '客气'],
  topics: ['游戏'],
  style: '随意的短句',
  attitudeToMe: '客气',
  sentiment: 'friendly',
  affectionDelta: 2,
  wantsToAvoid: false,
  relationToMaster: 'unknown',
  reason: '聊天有礼貌，没有冒犯',
  moodDelta: 3,
  moodReason: '聊游戏聊得挺开心',
});

const registrations = { sections: [], tools: [], routes: [], handlers: [], effects: [] };

const services = {};

const ctx = {
  effect(fn) {
    registrations.effects.push(fn);
    return fn() || (() => {});
  },
  on(event, fn) {
    registrations.handlers.push([event, fn]);
    return () => {};
  },
  inject(_names, cb) {
    cb(ctx);
    return () => {};
  },
  get(name) {
    return services[name];
  },
  systemPrompt: {
    section(options) {
      registrations.sections.push(options);
      return () => {};
    },
  },
  tools: {
    register(tool) {
      registrations.tools.push(tool);
      return () => {};
    },
  },
  webServer: {
    register(route) {
      registrations.routes.push(route);
      return () => {};
    },
  },
};

services.llm = {
  stream() {
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', text: DIGEST };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };
  },
};
services.agentDefaultModel = { currentSelection: () => ({ provider: 'mock', model: 'mock' }) };
services.systemPrompt = ctx.systemPrompt;
services.tools = ctx.tools;
services.webServer = ctx.webServer;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, label, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    if (check()) return;
    await sleep(100);
  }
  throw new Error(`等待超时：${label}`);
}

const { apply, name } = await import('../lib/index.js');

let passed = 0;
const test = async (label, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${label}`);
  } catch (error) {
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
};

console.log('[装配]');
await test('插件名正确', () => assert.equal(name, 'dsh-qq-persona'));

apply(ctx, { masterQQ: MASTER, maxLines: 3, idleMs: 600_000, model: 'mock/mock' });
await sleep(120);

await test('注册了 systemPrompt 段落（order 95，text 为函数）', () => {
  const section = registrations.sections.find((s) => s.name === 'qq-persona:memory');
  assert.ok(section, '没找到注入段落');
  assert.equal(section.order, 95);
  assert.equal(typeof section.text, 'function');
});

await test('注册了 7 个工具', () => {
  assert.equal(registrations.tools.length, 7);
  assert.deepEqual(
    registrations.tools.map((t) => t.name).sort(),
    ['qq_mood_get', 'qq_mood_set', 'qq_persona_delete', 'qq_persona_get', 'qq_persona_list', 'qq_persona_rebuild', 'qq_persona_update'],
  );
});

await test('管理页路由全部是 exact 且以 /qq-persona 开头', () => {
  assert.ok(registrations.routes.length >= 10, `只注册了 ${registrations.routes.length} 条`);
  for (const route of registrations.routes) {
    assert.equal(route.kind, 'exact', `${route.path} 不是 exact`);
    assert.ok(route.path.startsWith('/qq-persona'), `${route.path} 前缀不对`);
    assert.equal(typeof route.handler, 'function');
  }
});

await test('订阅了 session/event', () => {
  assert.ok(registrations.handlers.some(([event]) => event === 'session/event'));
});

console.log('[采集 → 小结 → 落盘]');
await test('3 条消息触发一批小结并写出画像', async () => {
  const handler = registrations.handlers.find(([event]) => event === 'session/event')[1];
  for (let i = 1; i <= 3; i += 1) {
    handler({ id: SID }, {
      type: 'user/message',
      data: {
        message_id: 1000 + i,
        user_id: Number(PEER),
        sender: { nickname: '小白' },
        content: [{ type: 'text', text: `<user_message qq="${PEER}" nickname="小白">第${i}句话</user_message>` }],
      },
    });
  }
  const peoplePath = path.join(home, 'qq-persona', 'people.json');
  await waitFor(() => fs.existsSync(peoplePath), 'people.json');
  await waitFor(() => {
    try {
      return Boolean(JSON.parse(fs.readFileSync(peoplePath, 'utf8'))?.users?.[PEER]);
    } catch {
      return false;
    }
  }, '12345 的画像');
});

await test('画像内容正确（摘要/标签/好感 22）', () => {
  const people = JSON.parse(fs.readFileSync(path.join(home, 'qq-persona', 'people.json'), 'utf8'));
  const person = people.users[PEER];
  assert.equal(person.nickname, '小白');
  assert.ok(person.summary.includes('游戏'), `摘要不对：${person.summary}`);
  assert.deepEqual(person.traits, ['话多', '客气']);
  assert.equal(person.turns, 1);
  assert.equal(person.msgCount, 3);
  assert.equal(person.affection.raw, 22, `好感应为 20+2=22，实际 ${person.affection.raw}`);
});

await test('写了小结流水与审计', () => {
  const dir = path.join(home, 'qq-persona');
  assert.ok(fs.existsSync(path.join(dir, 'summaries', `${PEER}.jsonl`)), '缺 summaries/<qq>.jsonl');
  assert.ok(fs.existsSync(path.join(dir, 'audit.jsonl')), '缺 audit.jsonl');
});

console.log('[注入文本]');
await test('该会话能算出画像段落', () => {
  const section = registrations.sections.find((s) => s.name === 'qq-persona:memory');
  const text = section.text({ agent: { session: { id: SID } } });
  assert.ok(text.includes('小白'), `没带上昵称：${text}`);
  assert.ok(text.includes('游戏'), `没带上印象：${text}`);
});

await test('注入里带上了此刻的心情，而且排在画像前面', () => {
  const section = registrations.sections.find((s) => s.name === 'qq-persona:memory');
  const text = section.text({ agent: { session: { id: SID } } });
  assert.ok(text.includes('此刻的状态'), `没带心情段：${text}`);
  assert.ok(text.includes('【你在 QQ 上认识的这个人】'), '画像段丢了');
  assert.ok(text.indexOf('此刻的状态') < text.indexOf('【你在 QQ 上认识的这个人】'), '心情段应该在最前面');
});

await test('心情和好感是两笔账（小结里分开记）', () => {
  const mood = JSON.parse(fs.readFileSync(path.join(home, 'qq-persona', 'mood.json'), 'utf8'));
  assert.ok(mood.valence > 12, `心情没涨：${mood.valence}`);
  const people = JSON.parse(fs.readFileSync(path.join(home, 'qq-persona', 'people.json'), 'utf8'));
  assert.equal(people.users[PEER].affection.raw, 22, '好感不该被心情带跑');
});

await test('非 QQ 会话返回空串', () => {
  const section = registrations.sections.find((s) => s.name === 'qq-persona:memory');
  assert.equal(section.text({ agent: { session: { id: 'local-web-1' } } }), '');
});

console.log('[工具]');
await test('qq_persona_list 能列出来', async () => {
  const tool = registrations.tools.find((t) => t.name === 'qq_persona_list');
  const value = await tool.execute({}, { agent: { session: { id: 'local-web-1' } } });
  const text = JSON.stringify(value);
  assert.ok(text.includes(PEER), `列表里没有 ${PEER}：${text}`);
});

await test('qq_mood_get 读得到心情，qq_mood_set 改得动', async () => {
  const get = registrations.tools.find((t) => t.name === 'qq_mood_get');
  const set = registrations.tools.find((t) => t.name === 'qq_mood_set');
  const ctxArg = { agent: { session: { id: 'local-web-1' } } };
  const before = await get.execute({}, ctxArg);
  assert.ok(before.ok, `读心情失败：${JSON.stringify(before)}`);
  assert.ok(typeof before.label === 'string' && before.label.length > 0, '缺 label');
  const up = await set.execute({ delta: 10, reason: '主人哄了一下' }, ctxArg);
  assert.ok(up.ok, `改心情失败：${JSON.stringify(up)}`);
  assert.equal(Math.round(up.mood.valence), Math.round(before.valence) + 10);
  const down = await set.execute({ delta: -10, reason: '主人惹了一下' }, ctxArg);
  assert.equal(Math.round(down.mood.valence), Math.round(before.valence));
});

await test('陌生私聊不能改（权限闸生效）', async () => {
  const tool = registrations.tools.find((t) => t.name === 'qq_persona_update');
  let blocked = false;
  try {
    const value = await tool.execute({ qq: PEER, notes: 'x' }, { agent: { session: { id: 'onebot-private-99999' } } });
    blocked = JSON.stringify(value).includes('主人') || JSON.stringify(value).includes('失败') || JSON.stringify(value).includes('不能');
  } catch (error) {
    blocked = true;
  }
  assert.ok(blocked, '陌生私聊竟然改成功了');
});

console.log('[管理页]');
function callWeb(routePath, method = 'GET', body = null) {
  const route = registrations.routes.find((r) => r.path === routePath);
  assert.ok(route, `没有路由 ${routePath}`);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const req = {
      url: routePath,
      method,
      headers: { host: '127.0.0.1:62546', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
      on(event, fn) {
        if (event === 'data' && body !== null) fn(Buffer.from(JSON.stringify(body)));
        if (event === 'end') fn();
        return this;
      },
      setTimeout() {},
    };
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(code, headers) {
        this.statusCode = code;
        Object.assign(this.headers, headers || {});
        return this;
      },
      setHeader(k, v) {
        this.headers[k] = v;
        return this;
      },
      write(chunk) {
        chunks.push(Buffer.from(chunk));
        return true;
      },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk));
        resolve({ status: this.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      },
      on() {
        return this;
      },
    };
    try {
      route.handler(req, res);
    } catch (error) {
      reject(error);
    }
  });
}

await test('GET /qq-persona/api/list 返回 200 + JSON', async () => {
  const res = await callWeb('/qq-persona/api/list');
  assert.equal(res.status, 200, `状态 ${res.status}：${res.body.slice(0, 200)}`);
  const data = JSON.parse(res.body);
  assert.ok(JSON.stringify(data).includes(PEER), '列表里没有目标');
});

await test('GET /qq-persona 返回 HTML 页面', async () => {
  const res = await callWeb('/qq-persona');
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('<html') || res.body.includes('<!doctype'), '不是 HTML');
});

await test('路由表全是精确路径（未知路径交给宿主 404）', () => {
  const paths = registrations.routes.map((r) => r.path).sort();
  assert.deepEqual(paths, [
    '/qq-persona',
    '/qq-persona/',
    '/qq-persona/api/audit',
    '/qq-persona/api/delete',
    '/qq-persona/api/list',
    '/qq-persona/api/mood',
    '/qq-persona/api/mood/reset',
    '/qq-persona/api/mood/residue',
    '/qq-persona/api/overview',
    '/qq-persona/api/person',
    '/qq-persona/api/rebuild',
    '/qq-persona/api/settings',
    '/qq-persona/api/update',
    '/qq-persona/index.html',
  ]);
});

console.log('[回收]');
await test('所有 disposer 都能跑不抛错', () => {
  for (const fn of registrations.effects) {
    const dispose = fn();
    if (typeof dispose === 'function') dispose();
  }
});

console.log(`\n通过 ${passed} 项`);
try {
  fs.rmSync(home, { recursive: true, force: true });
} catch {
  // 临时目录残留无害
}
process.exit(process.exitCode || 0);