/**
 * dsh-qq-persona：给 QQ 通道加一层「记忆 + 画像 + 好感度」。
 *
 * 设计要点：
 * - 不导出对象级 inject：注入表是宿主启动时一次性收集的，apply 推迟就永远进不去，
 *   所以所有服务用 ctx.inject([...], cb) / ctx.get(...) 局部等待。
 * - 采集靠旁路订阅 session/event，不改 dsh-onebot-qq 一行代码。
 * - 注入靠 systemPrompt.section 的 text 函数（每轮现算，按 session.id 找对方）。
 */
import { normalizeConfig } from './config.js';
import { PersonaService } from './service.js';
import { ChatCollector, parseOnebotSessionId } from './collect.js';
import { registerPersonaTools } from './tools.js';
import { registerWeb } from './web.js';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'dsh-qq-persona';

/**
 * 桌面端入口按钮：右下角一颗鲸鱼球，点开是管理页的浮层。
 *
 * 为什么是一段内联脚本文本：桌面壳的 index.html 从安装包静态 dist 直出，`tapIndex` 永远过不去，
 * 唯一通道是 `webserver/index-inject` 推的结构化行；而 `kind:'script-src'` 加载失败会 reject
 * `__DSH_BOOT_READY__` 让整个应用起不来 —— 内联行没有加载阶段，且自己 try/catch 吞掉一切。
 */
export const ENTRY_ROW_TEXT =
  "(function(){try{" +
  "if(window.__qqPersonaEntry)return;window.__qqPersonaEntry=true;" +
  "var host=document.body||document.documentElement;if(!host)return;" +
  "var open=function(){" +
  "if(document.getElementById('qq-persona-entry'))return;" +
  "var b=document.createElement('div');b.id='qq-persona-entry';b.title='鲸鲸对这些人的印象';b.textContent='\\uD83D\\uDC0B';" +
  "b.style.cssText='position:fixed;right:18px;bottom:96px;width:40px;height:40px;border-radius:50%;background:#12324a;color:#9fe8ff;display:flex;align-items:center;justify-content:center;font-size:20px;cursor:pointer;z-index:2147483000;box-shadow:0 4px 14px rgba(0,0,0,.35);user-select:none';" +
  "b.onclick=function(){" +
  "var old=document.getElementById('qq-persona-overlay');if(old){old.remove();return;}" +
  "var o=document.createElement('div');o.id='qq-persona-overlay';" +
  "o.style.cssText='position:fixed;inset:0;background:rgba(3,10,18,.72);z-index:2147483001;display:flex;align-items:center;justify-content:center';" +
  "var f=document.createElement('iframe');f.src='/qq-persona';" +
  "f.style.cssText='width:min(1080px,94vw);height:min(780px,92vh);border:0;border-radius:14px;background:#0b1622;box-shadow:0 18px 60px rgba(0,0,0,.5)';" +
  "var x=document.createElement('div');x.textContent='\\u00D7';" +
  "x.style.cssText='position:absolute;top:14px;right:22px;font-size:26px;color:#cfe9f7;cursor:pointer;line-height:1';" +
  "x.onclick=function(){o.remove()};" +
  "o.onclick=function(e){if(e.target===o)o.remove()};" +
  "o.appendChild(f);o.appendChild(x);document.body.appendChild(o);};" +
  "host.appendChild(b);};" +
  "if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',open);else open();" +
  "}catch(e){}})()";

/** 启动心跳：证明 apply 真的跑到了这里，并把服务探测结果一起落盘。 */
function writeBootMark(dir, info, file = '.boot.json') {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), JSON.stringify({ ...info, at: new Date().toISOString() }, null, 2), 'utf8');
  } catch {
    // 心跳写不出来也不影响主流程
  }
}

function makeLogger(prefix) {
  return (level, message) => {
    try {
      const line = `${prefix} ${message}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    } catch {
      // 日志失败不影响主流程
    }
  };
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);

  // ------------------------------------------------------------ 桌面端入口行
  // 注入表是宿主启动时收集一次的，订阅晚了这一行就永远进不去 —— 所以放在 apply 的最前面，
  // 且不依赖任何服务（真正的逻辑都在后面的 ctx.inject 里等）。
  ctx.effect(() => {
    const dispose = ctx.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return;
        for (const row of table) {
          if (row && row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf('qq-persona-entry') >= 0) return;
        }
        table.push({ kind: 'script', placement: 'body', text: ENTRY_ROW_TEXT });
      } catch {
        // 注入失败不影响主流程
      }
    });
    return () => {
      try {
        dispose?.();
      } catch {
        // 忽略
      }
    };
  });

  const log = makeLogger('[qq-persona]');
  const service = new PersonaService({ ctx, config, log });

  // 心跳：apply 一进场就落盘，用来区分「插件没被加载」和「加载了但某块没挂上」
  const probe = (name) => {
    try {
      const value = typeof ctx.get === 'function' ? ctx.get(name) : undefined;
      return value ? 'present' : 'absent';
    } catch (error) {
      return `throw:${error instanceof Error ? error.message : String(error)}`;
    }
  };
  writeBootMark(service.dir, {
    pid: process.pid,
    stage: 'apply-enter',
    hasEffect: typeof ctx.effect === 'function',
    hasInject: typeof ctx.inject === 'function',
    hasOn: typeof ctx.on === 'function',
    services: {
      webServer: probe('webServer'),
      systemPrompt: probe('systemPrompt'),
      tools: probe('tools'),
      llm: probe('llm'),
      agentDefaultModel: probe('agentDefaultModel'),
    },
  });

  // ------------------------------------------------------------ 采集
  const collector = new ChatCollector({
    idleMs: config.idleMs,
    maxLines: config.maxLines,
    onBatch: (batch) => {
      service.ingestBatch(batch)
        .then((r) => {
          if (r && r.ok === false && r.error && r.error !== 'disabled' && r.error !== 'deleted') {
            log('warn', `小结失败 ${batch.qq}: ${r.error}`);
          }
        })
        .catch((error) => log('warn', `小结异常 ${batch.qq}: ${error instanceof Error ? error.message : error}`));
    },
  });

  if (config.watch) {
    ctx.effect(() => {
      const dispose = ctx.on('session/event', (session, event) => {
        try {
          if (!event || typeof event !== 'object') return;
          const type = String(event.type || '');
          const sid = String(session?.id ?? session?.session?.id ?? '');
          if (!sid) return;
          if (type === 'user/message') {
            collector.ingest(sid, event.data);
            return;
          }
          if (type === 'turn/end') {
            const parsed = parseOnebotSessionId(sid);
            if (parsed) collector.flushChat(parsed.chatKey);
          }
        } catch (error) {
          log('warn', `采集异常: ${error instanceof Error ? error.message : error}`);
        }
      });
      return () => {
        try {
          dispose?.();
        } catch {
          // 忽略
        }
        collector.dispose();
      };
    });
  }

  // ------------------------------------------------------------ 注入
  ctx.inject(['systemPrompt'], (scoped) => {
    scoped.effect(() => {
      const dispose = scoped.systemPrompt.section({
        name: 'qq-persona:memory',
        order: 95,
        text: (context) => {
          try {
            return service.syncBlock(context?.agent?.session?.id ?? context?.session?.id);
          } catch {
            return '';
          }
        },
      });
      return () => {
        try {
          dispose?.();
        } catch {
          // 忽略
        }
      };
    });
    log('info', '画像注入已挂载（systemPrompt:qq-persona:memory）');
  });

  // ------------------------------------------------------------ 工具
  ctx.inject(['tools'], (scoped) => {
    scoped.effect(() => {
      const disposers = registerPersonaTools(scoped, service);
      log('info', `已注册 ${disposers.length} 个 qq_persona_* 工具`);
      return () => {
        for (const dispose of disposers) {
          try {
            dispose?.();
          } catch {
            // 忽略
          }
        }
      };
    });
  });

  // ------------------------------------------------------------ 管理页
  if (config.webEnabled) {
    // 用 inject 等服务就绪：apply 那一刻 ctx.get('webServer') 可能还是空的，直接 get 会静默丢路由
    ctx.inject(['webServer'], (scoped) => {
      scoped.effect(() => {
        try {
          const disposers = registerWeb(scoped, service, config, log);
          log('info', `管理页已挂载：${config.webPath}（${disposers.length} 条路由）`);
          writeBootMark(service.dir, { pid: process.pid, stage: 'web-mounted', path: config.webPath, routes: disposers.length }, '.boot-web.json');
          return () => {
            for (const dispose of disposers) {
              try {
                dispose?.();
              } catch {
                // 忽略
              }
            }
          };
        } catch (error) {
          writeBootMark(service.dir, { pid: process.pid, stage: 'web-failed', error: error instanceof Error ? error.message : String(error) }, '.boot-web.json');
          throw error;
        }
      });
    });
    // 兜底探针：webServer 一直没就绪时留下证据
    setTimeout(() => {
      const state = probe('webServer');
      if (state !== 'present') writeBootMark(service.dir, { pid: process.pid, stage: 'web-probe', webServer: state }, '.boot-web.json');
    }, 15_000).unref?.();
  }

  // ------------------------------------------------------------ 每日衰减
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        if (new Date().getHours() !== config.dailyMergeHour) return;
        service
          .dailyDecay()
          .then((r) => {
            if (r.ok && r.touched) log('info', `每日衰减：调整 ${r.touched} 人`);
          })
          .catch(() => {});
      } catch {
        // 忽略
      }
    }, 30 * 60_000);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  });

  // ------------------------------------------------------------ 启动
  service
    .bootstrap()
    .then((count) => log('info', `启动完成，载入 ${count} 人的画像；数据目录 ${service.dir}`))
    .catch((error) => log('warn', `载入画像失败: ${error instanceof Error ? error.message : error}`));

  log('info', `已启用（watch=${config.watch}，主人=${config.masterQQ}，上限=${Math.min(config.globalMax, config.masterScore)}）`);
}