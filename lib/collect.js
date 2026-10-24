/**
 * 采集层：旁路订阅宿主的 session/event，把 QQ 消息按「发言人」攒成小段。
 *
 * 不碰 dsh-onebot-qq 的任何代码：
 * - 会话 id：onebot-private-<qq> / onebot-group-<gid>（dsh-onebot-qq/lib/chat.js:38）
 * - 正文带身份：<user_message qq="…" nickname="…">…</user_message>
 * - 群聊前缀：[HH:MM 昵称(QQ号)][@我] …
 */

const SESSION_RE = /^onebot-(private|group)-(.+)$/;

export function parseOnebotSessionId(sessionId) {
  const m = SESSION_RE.exec(String(sessionId || ''));
  if (!m) return null;
  return { kind: m[1], peer: m[2], chatKey: `${m[1]}:${m[2]}` };
}

/** 把 dsh 的 content 数组/字符串拍平成纯文本。 */
export function flattenContent(data) {
  const parts = [];
  const walk = (content) => {
    if (typeof content === 'string') {
      parts.push(content);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const el of content) {
      if (!el) continue;
      if (typeof el === 'string') parts.push(el);
      else if (typeof el?.text === 'string') parts.push(el.text);
    }
  };
  walk(data?.content);
  if (!parts.length && typeof data?.text === 'string') parts.push(data.text);
  return parts.join('\n').trim();
}

const TAG_RE = /<user_message\b([^>]*)>([\s\S]*?)<\/user_message>/i;
const GROUP_PREFIX_RE = /^\[(\d{1,2}:\d{2})\s+([^\]]*?)\]\s*(?:\[顶置\])?\s*(?:\[@我\])?\s*/;

function attr(src, name) {
  const m = new RegExp(`${name}="([^"]*)"`, 'i').exec(src || '');
  return m ? m[1] : '';
}

/**
 * 从一条 user/message 正文里剥出「谁说的」「说了什么」。
 * @returns {{qq:string, nickname:string, text:string}}
 */
export function splitSender(text, fallbackQQ = '') {
  const raw = String(text || '').trim();
  const tag = TAG_RE.exec(raw);
  if (tag) {
    return {
      qq: attr(tag[1], 'qq') || fallbackQQ,
      nickname: attr(tag[1], 'nickname') || '',
      text: tag[2].trim(),
    };
  }
  const prefixed = GROUP_PREFIX_RE.exec(raw);
  if (prefixed) {
    const who = prefixed[2] || '';
    const inner = /\((\d{5,12})\)\s*$/.exec(who);
    return {
      qq: inner ? inner[1] : fallbackQQ,
      nickname: inner ? who.slice(0, inner.index).trim() : who.trim(),
      text: raw.slice(prefixed[0].length).trim(),
    };
  }
  return { qq: fallbackQQ, nickname: '', text: raw };
}

/**
 * 按发言人攒段。每个 QQ 号一条线，空闲 idleMs 或攒够 maxLines 就交出去。
 */
export class ChatCollector {
  #buffers = new Map(); // qq -> { chatKey, nickname, lines, msgCount, timer }
  #idleMs;
  #maxLines;
  #onBatch;
  #disposed = false;

  constructor({ idleMs = 120_000, maxLines = 16, onBatch }) {
    this.#idleMs = idleMs;
    this.#maxLines = maxLines;
    this.#onBatch = onBatch;
  }

  /** 喂一条入站消息。返回 false 表示这条没被采集（非 QQ 会话 / 无关事件）。 */
  ingest(sessionId, data) {
    if (this.#disposed) return false;
    const parsed = parseOnebotSessionId(sessionId);
    if (!parsed) return false;
    const flat = flattenContent(data);
    if (!flat) return false;
    const fallbackQQ = parsed.kind === 'private' ? parsed.peer : '';
    const { qq, nickname, text } = splitSender(flat, fallbackQQ);
    if (!qq || !text) return false;
    // 过滤纯占位/噪声
    if (/^\[CQ:[^\]]+\]$/.test(text) || text.length > 4000) return false;

    let buf = this.#buffers.get(qq);
    if (!buf) {
      buf = { chatKey: parsed.chatKey, nickname, lines: [], msgCount: 0, timer: null };
      this.#buffers.set(qq, buf);
    }
    if (nickname) buf.nickname = nickname;
    buf.chatKey = parsed.chatKey;
    buf.lines.push(text.slice(0, 600));
    buf.msgCount += 1;
    this.#arm(qq, buf);

    if (buf.lines.length >= this.#maxLines) this.flush(qq);
    return true;
  }

  #arm(qq, buf) {
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => this.flush(qq), this.#idleMs);
    if (typeof buf.timer.unref === 'function') buf.timer.unref();
  }

  /** 立刻交出某个人的这一段。 */
  flush(qq) {
    const buf = this.#buffers.get(qq);
    if (!buf) return null;
    if (buf.timer) clearTimeout(buf.timer);
    this.#buffers.delete(qq);
    if (!buf.lines.length) return null;
    const batch = {
      qq,
      chatKey: buf.chatKey,
      nickname: buf.nickname,
      lines: buf.lines.slice(),
      msgCount: buf.msgCount,
    };
    try {
      this.#onBatch?.(batch);
    } catch {
      // 采集不能因为下游炸掉而停摆
    }
    return batch;
  }

  flushAll() {
    const out = [];
    for (const qq of [...this.#buffers.keys()]) {
      const batch = this.flush(qq);
      if (batch) out.push(batch);
    }
    return out;
  }

  /** 某个会话结束（turn/end）时把该会话的人都清一遍。 */
  flushChat(chatKey) {
    if (!chatKey) return [];
    const out = [];
    for (const [qq, buf] of [...this.#buffers.entries()]) {
      if (buf.chatKey === chatKey) {
        const batch = this.flush(qq);
        if (batch) out.push(batch);
      }
    }
    return out;
  }

  pending() {
    return this.#buffers.size;
  }

  dispose() {
    this.#disposed = true;
    for (const buf of this.#buffers.values()) if (buf.timer) clearTimeout(buf.timer);
    this.#buffers.clear();
  }
}