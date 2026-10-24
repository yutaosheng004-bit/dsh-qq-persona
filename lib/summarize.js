/**
 * 小结（digest）：把一段 QQ 聊天 + 旧画像，交给模型压成一份结构化 JSON。
 * 这里只管「问模型 → 拿 JSON」，落库交给 persona.js，调度交给 index.js。
 */
import { sanitizeDigest } from './persona.js';

const DEFAULT_TIMEOUT_MS = 90_000;

export const DIGEST_SYSTEM = `你是「鲸鲸」的记忆整理器。鲸鲸是一个有脾气的 AI 女仆，不是客服。
给你一段 QQ 聊天记录（对方说的话，必要时含鲸鲸的回复）、这个人已有的画像摘要，输出一份 JSON 小结。

只输出一个 JSON 对象，键名严格如下，不要加解释、不要加 markdown 代码块：
{
  "summary": "这一段聊了什么，一两句，忽略寒暄和表情",
  "mergedSummary": "把旧摘要和这一段合成一段『这个人的长期印象』，≤280字，写人不写流水账",
  "traits": ["性格标签，最多6个，每个≤6字"],
  "topics": ["常聊话题，最多6个"],
  "style": "他的说话风格，一句话",
  "attitudeToMe": "他对鲸鲸的态度，一句话",
  "sentiment": "friendly|neutral|mocking|rude|harass",
  "affectionDelta": 0,
  "wantsToAvoid": false,
  "relationToMaster": "ally|neutral|strained|hostile|unknown",
  "reason": "一句话说明你为什么给这个分数，扣分时必须点出他哪句话让你不舒服",
  "moodDelta": 0,
  "moodReason": "这段对话让你自己的心情怎么变了，一句话，点出具体那句"
}

判定标准：
- affectionDelta 范围 -15..+6。真诚聊天 +1~+3；表达喜欢/关心 +4~+6；阴阳怪气 -1~-4；辱骂、人身攻击、性骚扰 -5~-12；反复骚扰或明确辱骂 -13~-15。纯水群、刷表情、无实质内容给 0。
- moodDelta 范围 -20..+15，是**你自己此刻的心情**，不是对他的好感：被冒犯、被凶、被恶心到 -5~-20；被哄、被夸、聊到开心的事 +3~+10；普通聊天 0~+2；纯水群 0。
- 好感是这个人的长期账本，心情是你自己此刻的状态，**必须分开判**：同一个人也可能「好感不掉但心情被他烦到了」，反过来心情好也不许给辱骂放水。
- 阴阳怪气、反串、口嗨要看语境：熟人之间互相打趣不算辱骂。
- wantsToAvoid：只有你确实觉得「跟这人说话很累/被冒犯」时才 true，正常的玩笑不要设。
- relationToMaster：他从没提过主人就写 unknown，别瞎猜。
- 不要编造聊天里没有的事实。`;

function pickJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const slice = s.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    // 常见病：尾逗号
    try {
      return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

/**
 * 调一次模型拿 JSON。失败/超时/解析不出都返回 null，从不抛。
 */
export async function requestDigest(ctx, { modelRef, system = DIGEST_SYSTEM, prompt, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const llm = ctx.get ? ctx.get('llm') : ctx.llm;
  if (!llm || typeof llm.stream !== 'function') return { ok: false, error: 'llm service unavailable' };
  const selection = resolveSelection(ctx, modelRef);
  if (!selection) return { ok: false, error: 'no model selection' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`digest timed out after ${timeoutMs}ms`)), timeoutMs);
  let text = '';
  let failure = '';
  try {
    const stream = llm.stream({
      provider: selection.provider,
      model: selection.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }],
      temperature: 0.3,
      maxTokens: 700,
      signal: controller.signal,
    });
    for await (const chunk of stream) {
      if (chunk && chunk.type === 'text-delta') text += chunk.text ?? '';
      else if (chunk && chunk.type === 'finish') {
        const kind = chunk.reason?.kind;
        if (kind && kind !== 'stop' && kind !== 'length') {
          failure = chunk.reason?.failure?.message || String(kind);
        }
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }

  const parsed = pickJson(text);
  if (!parsed) return { ok: false, error: failure || 'unparseable model output', raw: text.slice(0, 400) };
  return { ok: true, digest: parsed, model: selection };
}

export function resolveSelection(ctx, modelRef) {
  const ref = String(modelRef || '').trim();
  if (ref) {
    const [provider, ...rest] = ref.split('/');
    if (provider && rest.length) return { provider, model: rest.join('/') };
  }
  try {
    const svc = ctx.get ? ctx.get('agentDefaultModel') : ctx.agentDefaultModel;
    const sel = svc?.currentSelection?.();
    if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model };
  } catch {
    // 忽略：下面还有兜底
  }
  return null;
}

/**
 * 组装给模型的输入：旧画像 + 这一段的新内容。
 */
export function buildDigestPrompt({ person, isMaster, botName, lines, chatLabel }) {
  const head = [
    `鲸鲸自称：${botName || '鲸鲸'}`,
    `对话场景：${chatLabel || 'QQ 私聊'}`,
    person?.summary ? `【这个人已有的画像摘要】\n${person.summary}` : '【这个人已有的画像摘要】\n（还没有，这是第一次）',
    person ? `已有标签：${(person.traits || []).join('、') || '无'}` : '',
    person?.notes ? `主人亲自备注（事实，必须保留）：${person.notes}` : '',
    isMaster ? '注意：这个人是鲸鲸的主人，好感是锚点，affectionDelta 一律给 0。' : '',
  ].filter(Boolean);
  const body = lines.join('\n');
  return `${head.join('\n')}\n\n【这一段的新聊天】\n${body}\n\n按系统要求只输出 JSON。`;
}

export { sanitizeDigest };