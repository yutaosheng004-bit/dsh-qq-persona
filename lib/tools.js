/**
 * 给模型用的工具：qq_persona_*。
 * 权限：只有「本地会话（主人自己在 GUI/终端里）」和「主人的 QQ 私聊」能改/删，
 * 群聊和陌生私聊一律只能看不能动。
 */
/**
 * 宿主运行时会把 @deepseek-ai/dsh-tools 作为 peer 解析（见 package.json）。
 * 离线自检、单测环境没有这个包，兜底成恒等包装，工具定义形状不变。
 */
let defineTool;
try {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
} catch {
  defineTool = (definition) => definition;
}

const CALLER_RE = /^onebot-(private|group)-(.+)$/;

/** 这次工具调用是从哪个会话发起的。 */
export function callerOf(exec) {
  const sid = String(exec?.agent?.session?.id ?? '');
  const m = CALLER_RE.exec(sid);
  if (!m) return { kind: 'local', qq: '' };
  return { kind: m[1], qq: m[2] };
}

function canManage(exec, masterQQ) {
  const caller = callerOf(exec);
  if (caller.kind === 'local') return { ok: true, caller };
  if (caller.kind === 'private' && String(caller.qq) === String(masterQQ)) return { ok: true, caller };
  return { ok: false, caller, reason: '只有主人本人（本地会话或主人 QQ 私聊）能看和改这些记忆' };
}

function textOut(fn) {
  return {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: fn(value) }],
  };
}

export function registerPersonaTools(ctx, service) {
  const disposers = [];
  const add = (tool) => {
    disposers.push(ctx.tools.register(tool));
  };
  const masterQQ = service.config.masterQQ;

  add(defineTool({
    name: 'qq_persona_list',
    description: '列出 QQ 上聊过的人：好感度、性格标签、最近印象、是否不想理。回答「你记得谁/谁跟我关系好/某个群里有谁」时用。',
    parameters: {
      query: { type: 'string', description: '按 QQ 号、昵称、标签或摘要模糊筛（可省略）' },
      limit: { type: 'number', description: '最多返回几条，默认 30' },
    },
    output: textOut((v) => {
      if (!v.ok) return `查询失败：${v.error}`;
      if (!v.rows.length) return '还没有任何记录。';
      const lines = v.rows.map((r) => {
        const tags = r.traits.length ? ` [${r.traits.join('/')}]` : '';
        const flags = [r.isMaster ? '主人' : '', r.avoid ? '不想理' : '', r.pinned ? '锁定' : ''].filter(Boolean).join(',');
        return `· ${r.card || r.nickname || r.qq}（${r.qq}）好感 ${Math.round(r.score)} ${r.tier}${tags}${flags ? `（${flags}）` : ''}\n  ${r.summary || '（还没形成印象）'}`;
      });
      return `共 ${v.total} 人，列出 ${v.rows.length} 人：\n${lines.join('\n')}`;
    }),
    isConcurrencySafe: () => true,
    execute: async (args) => {
      return service.list({ query: args?.query, limit: args?.limit });
    },
  }));

  add(defineTool({
    name: 'qq_persona_get',
    description: '查看某个 QQ 号在本鲸这里留下的全部印象：画像、好感度明细、最近几次小结。',
    parameters: {
      qq: { type: 'string', required: true, description: '要查看的 QQ 号' },
    },
    output: textOut((v) => {
      if (!v.ok) return `没有查到：${v.error}`;
      const p = v.person;
      const lines = [
        `${p.card || p.nickname || p.qq}（${p.qq}）${v.isMaster ? ' · 主人' : ''}`,
        `好感 ${Math.round(v.score)}/100（${v.tier.name}），天花板 ${v.ceiling}`,
        `轮数 ${p.turns}，消息 ${p.msgCount}，关系 ${p.relationToMaster}`,
        p.traits.length ? `标签：${p.traits.join('、')}` : '',
        p.topics.length ? `话题：${p.topics.join('、')}` : '',
        p.style ? `风格：${p.style}` : '',
        p.attitudeToMe ? `对本鲸：${p.attitudeToMe}` : '',
        p.summary ? `摘要：${p.summary}` : '',
        p.notes ? `主人备注：${p.notes}` : '',
        (v.history || []).length ? `最近变化：\n${v.history.slice(-5).map((h) => `  ${new Date(h.ts).toLocaleString('zh-CN')} Δ${h.delta} ${h.reason || ''}`).join('\n')}` : '',
      ].filter(Boolean);
      return lines.join('\n');
    }),
    isConcurrencySafe: () => true,
    execute: async (args) => {
      return service.get(args?.qq);
    },
  }));

  add(defineTool({
    name: 'qq_persona_update',
    description: '修改某个 QQ 号在本鲸这里的印象（摘要/标签/好感/备注等）。只在主人本人要求时才用；改完要如实告诉主人改了什么。',
    parameters: {
      qq: { type: 'string', required: true, description: '要修改的 QQ 号' },
      summary: { type: 'string', description: '新的长期印象摘要' },
      traits: { type: 'array', items: { type: 'string' }, description: '性格标签，最多 6 个' },
      topics: { type: 'array', items: { type: 'string' }, description: '常聊话题，最多 6 个' },
      style: { type: 'string', description: '说话风格一句话' },
      attitudeToMe: { type: 'string', description: '他对本鲸的态度一句话' },
      notes: { type: 'string', description: '主人手写备注（优先级最高，自动流程不会覆盖）' },
      avoid: { type: 'boolean', description: '是否标记为「不想理」' },
      pinned: { type: 'boolean', description: '锁定：自动摘要不再改写主观判断' },
      relationToMaster: { type: 'string', description: 'ally / neutral / strained / hostile / unknown' },
      affection: { type: 'number', description: '手动设定好感原始分 0-100（主人自己不可改）' },
      reason: { type: 'string', description: '修改原因，记进审计' },
    },
    output: textOut((v) => (v.ok ? `已更新 ${v.changed} 个字段，当前好感 ${Math.round(v.score)}` : `没改成：${v.error}`)),
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const gate = canManage(exec, masterQQ);
      if (!gate.ok) return { ok: false, error: gate.reason };
      const { qq, ...patch } = args || {};
      return service.update(qq, patch, { by: `tool:${gate.caller.kind}` });
    },
  }));

  add(defineTool({
    name: 'qq_persona_delete',
    description: '删掉某个人在本鲸这里的记忆（软删：清空印象但留墓碑；hard=true 连记录一起抹掉）。只在主人明确要求时用。',
    parameters: {
      qq: { type: 'string', required: true, description: '要删除的 QQ 号' },
      hard: { type: 'boolean', description: 'true = 物理删除，不可恢复' },
    },
    output: textOut((v) => (v.ok ? (v.hard ? '已彻底删除' : '已软删除（记录保留但印象清空）') : `没删成：${v.error}`)),
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const gate = canManage(exec, masterQQ);
      if (!gate.ok) return { ok: false, error: gate.reason };
      return service.remove(args?.qq, { hard: args?.hard === true, by: `tool:${gate.caller.kind}` });
    },
  }));

  add(defineTool({
    name: 'qq_persona_rebuild',
    description: '用某个 QQ 号的历史聊天重新生成一遍画像（主人觉得概括歪了时用）。会消耗一次模型调用。',
    parameters: {
      qq: { type: 'string', required: true, description: '要重建的 QQ 号' },
    },
    output: textOut((v) => (v.ok ? `已用 ${v.lines} 条历史重建：${v.person.summary}` : `重建失败：${v.error}`)),
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const gate = canManage(exec, masterQQ);
      if (!gate.ok) return { ok: false, error: gate.reason };
      return service.rebuild(args?.qq, { by: `tool:${gate.caller.kind}` });
    },
  }));

  add(defineTool({
    name: 'qq_mood_get',
    description: '看本鲸此刻的心情（不只是对某人的好感）：心情值、精力、想不想聊、因为什么，以及见某个人时心情起点会不会偏低。被问「你怎么了/心情好点没」时用。',
    parameters: {
      qq: { type: 'string', description: '可选，看对某个 QQ 号的情绪残留' },
    },
    output: textOut((v) => {
      if (!v.ok) return `读不到心情：${v.error}`;
      const lines = [
        `${v.label}（心情 ${Math.round(v.valence)}，基线 ${v.baseline.valence}；精力 ${Math.round(v.energy)}；想聊程度 ${v.effort}）`,
        v.reason ? `因为：${v.reason}` : '',
        v.lock ? `已锁定：${v.lockReason || ''}` : '',
        v.qq ? `见到 ${v.qq} 的起点：${Math.round(v.residueOff)}${v.residueNote ? `（${v.residueNote}）` : ''}` : '',
      ].filter(Boolean);
      return lines.join('\n');
    }),
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const snap = service.moodSnapshot();
      const qq = String(args?.qq || '').trim();
      if (!qq) return snap;
      const found = (snap.residue || []).find((r) => String(r.qq) === qq);
      return { ...snap, qq, residueOff: found?.off ?? 0, residueNote: found?.note ?? '' };
    },
  }));

  add(defineTool({
    name: 'qq_mood_set',
    description: '调本鲸的心情。只有主人本人能用。可以给相对变化（delta，-20~+15）、直接设定数值（valence/energy 0-100）、或锁定/解锁。真心的开心和难过要如实反映，不要为了讨好随意拉高。',
    parameters: {
      delta: { type: 'number', description: '相对变化 -20~+15（被哄 +、被凶 −）' },
      valence: { type: 'number', description: '直接设定心情值 0-100' },
      energy: { type: 'number', description: '直接设定精力 0-100' },
      lock: { type: 'boolean', description: '锁定后自动流程不再改心情' },
      reason: { type: 'string', description: '因为什么，记进审计' },
    },
    output: textOut((v) => (v.ok ? `心情变成「${v.mood.label}」（${Math.round(v.mood.valence)}）` : `没改成：${v.error}`)),
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const gate = canManage(exec, masterQQ);
      if (!gate.ok) return { ok: false, error: gate.reason };
      const patch = {};
      for (const key of ['delta', 'valence', 'energy', 'lock', 'reason']) {
        if (args?.[key] !== undefined) patch[key] = args[key];
      }
      return service.setMood(patch, { by: `tool:${gate.caller.kind}` });
    },
  }));

  return disposers;
}