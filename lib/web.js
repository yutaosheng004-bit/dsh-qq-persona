/**
 * Web 管理页：一个 prefix 路由搞定页面 + API。
 * 安全：只认回环地址与同源请求（不依赖宿主是否有 requestRejection）。
 */
const MAX_BODY = 512 * 1024;

function sendJson(res, code, value) {
  const body = JSON.stringify(value);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function sendText(res, code, contentType, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** 回环 + 同源校验。挡不住本机恶意进程，但挡住跨站请求。 */
export function trustedRequest(req) {
  const host = String(req.headers?.host || '');
  const hostname = host.split(':')[0];
  if (hostname && !LOOPBACK.has(hostname)) return false;
  const origin = req.headers?.origin;
  if (origin) {
    try {
      const u = new URL(origin);
      if (!LOOPBACK.has(u.hostname)) return false;
    } catch {
      return false;
    }
  }
  if (String(req.headers?.['sec-fetch-site'] || '') === 'cross-site') return false;
  return true;
}

export function registerWeb(ctx, service, config, log) {
  const disposers = [];
  const base = config.webPath;

  const handler = async (req, res) => {
    try {
      if (!trustedRequest(req)) {
        sendJson(res, 403, { ok: false, error: 'forbidden' });
        return;
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const sub = url.pathname.startsWith(base) ? url.pathname.slice(base.length) || '/' : url.pathname;

      if (req.method === 'GET' && (sub === '/' || sub === '/index.html')) {
        sendText(res, 200, 'text/html; charset=utf-8', ADMIN_HTML);
        return;
      }
      if (req.method === 'GET' && sub === '/api/overview') {
        sendJson(res, 200, await service.overview());
        return;
      }
      if (req.method === 'GET' && sub === '/api/list') {
        sendJson(res, 200, await service.list({
          query: url.searchParams.get('q') || '',
          limit: Number(url.searchParams.get('limit')) || 60,
        }));
        return;
      }
      if (req.method === 'GET' && sub === '/api/person') {
        sendJson(res, 200, await service.get(url.searchParams.get('qq') || ''));
        return;
      }
      if (req.method === 'GET' && sub === '/api/audit') {
        sendJson(res, 200, { ok: true, rows: await service.auditTail(120) });
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        let payload = {};
        try {
          payload = body ? JSON.parse(body) : {};
        } catch {
          sendJson(res, 400, { ok: false, error: '不是合法 JSON' });
          return;
        }
        if (sub === '/api/update') {
          const { qq, patch, reason } = payload;
          sendJson(res, 200, await service.update(qq, { ...(patch || {}), reason }, { by: 'web' }));
          return;
        }
        if (sub === '/api/delete') {
          sendJson(res, 200, await service.remove(payload.qq, { hard: payload.hard === true, by: 'web' }));
          return;
        }
        if (sub === '/api/rebuild') {
          sendJson(res, 200, await service.rebuild(payload.qq, { by: 'web' }));
          return;
        }
        if (sub === '/api/settings') {
          sendJson(res, 200, await service.updateSettings(payload.patch || {}));
          return;
        }
        if (sub === '/api/mood') {
          sendJson(res, 200, await service.setMood(payload.patch || payload || {}, { by: 'web' }));
          return;
        }
        if (sub === '/api/mood/reset') {
          sendJson(res, 200, await service.resetMood({ by: 'web' }));
          return;
        }
        if (sub === '/api/mood/residue') {
          sendJson(res, 200, await service.clearResidue(payload.qq, { by: 'web' }));
          return;
        }
        sendJson(res, 404, { ok: false, error: 'no such endpoint' });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log?.('warn', `[qq-persona] web: ${message}`);
      try {
        sendJson(res, 500, { ok: false, error: message });
      } catch {
        // 响应已经发过了
      }
    }
  };

  // 只实证过 kind:'exact'，所以逐条注册，不用未证实的 'prefix'
  const paths = [
    base,
    `${base}/`,
    `${base}/index.html`,
    `${base}/api/overview`,
    `${base}/api/list`,
    `${base}/api/person`,
    `${base}/api/audit`,
    `${base}/api/update`,
    `${base}/api/delete`,
    `${base}/api/rebuild`,
    `${base}/api/settings`,
    `${base}/api/mood`,
    `${base}/api/mood/reset`,
    `${base}/api/mood/residue`,
  ];
  for (const routePath of paths) {
    disposers.push(ctx.webServer.register({ kind: 'exact', path: routePath, handler }));
  }
  return disposers;
}

const ADMIN_HTML = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QQ 记忆与画像 · 鲸鲸</title>
<style>
:root{--bg:#0e1726;--panel:#141f33;--panel2:#1b2941;--line:#26364f;--text:#dce7f7;--dim:#7f93b0;--accent:#4fa8d8;--good:#4cc38a;--bad:#e0607e;--warn:#e0a94f}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif}
header{display:flex;align-items:center;gap:16px;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--panel)}
header h1{font-size:16px;margin:0;font-weight:600;letter-spacing:.5px}
header .stat{color:var(--dim);font-size:12px}
header .grow{flex:1}
main{display:grid;grid-template-columns:320px 1fr;height:calc(100vh - 57px)}
aside{border-right:1px solid var(--line);display:flex;flex-direction:column;background:var(--panel)}
aside .search{padding:10px}
aside input[type=search]{width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel2);color:var(--text);outline:none}
#list{overflow:auto;flex:1}
.item{padding:10px 12px;border-bottom:1px solid rgba(38,54,79,.6);cursor:pointer}
.item:hover{background:var(--panel2)}
.item.active{background:#1d3350;border-left:3px solid var(--accent);padding-left:9px}
.item .top{display:flex;align-items:center;gap:8px}
.item .name{font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item .qq{color:var(--dim);font-size:11px}
.badge{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
.badge.master{color:#ffd479;border-color:#6b5323;background:#2a2113}
.badge.avoid{color:var(--bad);border-color:#5b2b39;background:#2a141c}
.bar{height:4px;border-radius:2px;background:#20304a;margin-top:6px;overflow:hidden}
.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--good))}
section{overflow:auto;padding:18px 22px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}
.card h2{font-size:13px;margin:0 0 12px;color:var(--dim);font-weight:600;letter-spacing:.5px}
label{display:block;font-size:12px;color:var(--dim);margin:10px 0 4px}
input[type=text],input[type=number],textarea,select{width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel2);color:var(--text);outline:none;font:inherit}
textarea{resize:vertical;min-height:70px}
.row{display:flex;gap:12px}
.row>div{flex:1}
button{padding:7px 14px;border-radius:8px;border:1px solid var(--line);background:var(--panel2);color:var(--text);cursor:pointer;font:inherit}
button:hover{border-color:var(--accent)}
button.primary{background:#1e5b7d;border-color:#2b7fa8}
button.danger{color:var(--bad);border-color:#5b2b39}
.muted{color:var(--dim);font-size:12px}
.hint{color:var(--dim);font-size:11px;margin-top:4px}
.toast{position:fixed;right:18px;bottom:18px;background:#1e5b7d;padding:10px 16px;border-radius:10px;opacity:0;transition:.25s;pointer-events:none}
.toast.show{opacity:1}
.hist{font-size:12px;color:var(--dim);border-top:1px dashed var(--line);padding-top:8px;margin-top:8px}
.empty{color:var(--dim);text-align:center;padding:40px 0}
.moodpill{font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--line);background:var(--panel2);cursor:pointer;white-space:nowrap;transition:.2s}
.moodpill:hover{border-color:var(--accent)}
.moods{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.gauge{flex:1;min-width:120px;height:8px;border-radius:4px;background:#20304a;overflow:hidden}
.gauge i{display:block;height:100%;transition:width .3s}
</style></head><body>
<header>
  <h1>QQ 记忆与画像</h1>
  <span class="stat" id="stat">载入中…</span>
  <span class="grow"></span>
  <span class="moodpill" id="moodPill" title="点开看本鲸此刻的心情">心情…</span>
  <button id="btnSettings">设置</button>
</header>
<main>
  <aside>
    <div class="search"><input type="search" id="q" placeholder="搜 QQ 号 / 昵称 / 标签 / 印象"></div>
    <div id="list"></div>
  </aside>
  <section id="detail"><div class="empty">左边选一个人</div></section>
</main>
<div class="toast" id="toast"></div>
<script>
(function(){
  var API = location.pathname.replace(/\/$/,'') + '/api';
  var state = { rows: [], current: null, config: {}, mood: null };
  var el = function(id){ return document.getElementById(id); };
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function toast(msg){ var t = el('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(function(){ t.classList.remove('show'); }, 1800); }
  function api(path, opts){
    return fetch(API + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}))
      .then(function(r){ return r.json(); });
  }
  function post(path, body){ return api(path, { method: 'POST', body: JSON.stringify(body || {}) }); }

  function loadOverview(){
    return api('/overview').then(function(v){
      if (!v.ok) return;
      state.config = v.config;
      state.mood = v.mood || null;
      var m = state.mood;
      el('stat').textContent = v.stats.people + ' 人 · ' + v.stats.messages + ' 条消息 · ' + v.stats.turns + ' 轮 · 天花板 ' + v.config.ceiling;
      if (m && m.ok) {
        var pill = el('moodPill');
        var text = '心情 ' + m.label + ' · ' + Math.round(m.valence);
        if (m.lock) text += ' · 锁定';
        if (m.enabled === false) text += ' · 已关';
        pill.textContent = text;
        pill.style.borderColor = m.valence <= -20 ? '#5b2b39' : (m.valence >= 25 ? '#2b7fa8' : 'var(--line)');
        pill.style.color = m.valence <= -35 ? 'var(--bad)' : 'var(--text)';
      } else {
        el('moodPill').textContent = '心情 · 未启用';
      }
    });
  }
  function loadList(){
    var q = el('q').value.trim();
    return api('/list?limit=200&q=' + encodeURIComponent(q)).then(function(v){
      state.rows = v.rows || [];
      renderList();
    });
  }
  function renderList(){
    var box = el('list');
    if (!state.rows.length) { box.innerHTML = '<div class="empty">还没有记录</div>'; return; }
    box.innerHTML = state.rows.map(function(r){
      var active = state.current === r.qq ? ' active' : '';
      var cls = 'badge' + (r.isMaster ? ' master' : r.avoid ? ' avoid' : '');
      var label = r.isMaster ? '主人' : (r.avoid ? '不想理' : r.tier);
      var pct = Math.max(0, Math.min(100, r.score));
      return '<div class="item' + active + '" data-qq="' + esc(r.qq) + '">'
        + '<div class="top"><span class="name">' + esc(r.card || r.nickname || r.qq) + '</span>'
        + '<span class="' + cls + '">' + esc(label) + '</span></div>'
        + '<div class="qq">' + esc(r.qq) + ' · ' + Math.round(r.score) + '/100 · ' + esc(r.tier) + '</div>'
        + '<div class="bar"><i style="width:' + pct + '%"></i></div></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.item'), function(node){
      node.addEventListener('click', function(){ select(node.getAttribute('data-qq')); });
    });
  }

  function field(id, label, value, hint){
    return '<label>' + esc(label) + '</label><input type="text" id="' + id + '" value="' + esc(value) + '">' + (hint ? '<div class="hint">' + esc(hint) + '</div>' : '');
  }
  function area(id, label, value, hint){
    return '<label>' + esc(label) + '</label><textarea id="' + id + '">' + esc(value) + '</textarea>' + (hint ? '<div class="hint">' + esc(hint) + '</div>' : '');
  }

  function select(qq){
    state.current = qq;
    renderList();
    api('/person?qq=' + encodeURIComponent(qq)).then(function(v){
      if (!v.ok) { el('detail').innerHTML = '<div class="empty">' + esc(v.error) + '</div>'; return; }
      renderDetail(v);
    });
  }

  function renderDetail(v){
    var p = v.person;
    var hist = (v.history || []).slice(-8).reverse().map(function(h){
      return '<div>· ' + new Date(h.ts).toLocaleString() + ' Δ' + h.delta + ' ' + esc(h.reason || '') + '</div>';
    }).join('');
    var html = ''
      + '<div class="card"><h2>' + esc(p.card || p.nickname || p.qq) + ' · ' + esc(p.qq) + (v.isMaster ? ' · 主人' : '') + '</h2>'
      + '<div class="muted">好感 ' + Math.round(v.score) + '/100 · ' + esc(v.tier.name) + ' · 天花板 ' + v.ceiling + ' · ' + p.turns + ' 轮 / ' + p.msgCount + ' 条</div>'
      + '<div class="row"><div>' + field('f-nick', '昵称', p.nickname) + '</div><div>' + field('f-card', '群名片', p.card) + '</div></div>'
      + '<div class="row"><div>' + field('f-aff', '好感原始分（0-100）', p.affection && p.affection.raw) + '</div>'
      + '<div><label>与主人的关系</label><select id="f-rel">'
      + ['unknown','ally','neutral','strained','hostile'].map(function(k){
          return '<option value="' + k + '"' + (p.relationToMaster === k ? ' selected' : '') + '>' + k + '</option>';
        }).join('') + '</select></div></div>'
      + '</div>'
      + '<div class="card"><h2>印象</h2>'
      + area('f-summary', '长期摘要', p.summary, '这段是自动滚出来的，改完就以此为准')
      + area('f-traits', '性格标签（顿号分隔）', (p.traits || []).join('、'))
      + area('f-topics', '常聊话题（顿号分隔）', (p.topics || []).join('、'))
      + field('f-style', '说话风格', p.style)
      + field('f-attitude', '他对本鲸的态度', p.attitudeToMe)
      + area('f-notes', '主人备注（优先级最高，自动流程永不覆盖）', p.notes)
      + '</div>'
      + '<div class="card"><h2>操作</h2>'
      + '<label><input type="checkbox" id="f-avoid"' + (p.avoid ? ' checked' : '') + '> 标记「不想理」</label>'
      + '<label><input type="checkbox" id="f-pinned"' + (p.pinned ? ' checked' : '') + '> 锁定（自动摘要不再改主观判断）</label>'
      + '<div class="row" style="margin-top:12px"><div><button class="primary" id="btnSave">保存修改</button></div>'
      + '<div><button id="btnRebuild">用历史重建</button></div>'
      + '<div><button class="danger" id="btnDelete">删除记忆</button></div></div>'
      + '<div class="hist">' + (hist || '还没有变化记录') + '</div></div>';
    el('detail').innerHTML = html;
    el('btnSave').addEventListener('click', save);
    el('btnRebuild').addEventListener('click', rebuild);
    el('btnDelete').addEventListener('click', del);
  }

  function splitList(text){
    return String(text || '').split(/[、,，\n]/).map(function(s){ return s.trim(); }).filter(Boolean);
  }

  function save(){
    var qq = state.current;
    var patch = {
      nickname: el('f-nick').value,
      card: el('f-card').value,
      summary: el('f-summary').value,
      traits: splitList(el('f-traits').value),
      topics: splitList(el('f-topics').value),
      style: el('f-style').value,
      attitudeToMe: el('f-attitude').value,
      notes: el('f-notes').value,
      avoid: el('f-avoid').checked,
      pinned: el('f-pinned').checked,
      relationToMaster: el('f-rel').value,
      reason: 'web 手改'
    };
    var aff = Number(el('f-aff').value);
    if (Number.isFinite(aff)) patch.affection = aff;
    post('/update', { qq: qq, patch: patch }).then(function(v){
      if (!v.ok) { toast('没改成：' + v.error); return; }
      toast('已保存');
      select(qq); loadList(); loadOverview();
    });
  }
  function rebuild(){
    if (!confirm('用该号的历史聊天重新生成画像？会覆盖现在的摘要。')) return;
    toast('重建中…');
    post('/rebuild', { qq: state.current }).then(function(v){
      toast(v.ok ? '重建完成' : ('失败：' + v.error));
      if (v.ok) { select(state.current); loadList(); }
    });
  }
  function del(){
    if (!confirm('删除这个人的记忆？')) return;
    post('/delete', { qq: state.current, hard: false }).then(function(v){
      toast(v.ok ? '已删除' : ('失败：' + v.error));
      state.current = null; el('detail').innerHTML = '<div class="empty">左边选一个人</div>';
      loadList(); loadOverview();
    });
  }

  function gauge(value, min, max, color){
    var pct = Math.max(0, Math.min(100, ((Number(value) || 0) - min) / (max - min) * 100));
    return '<div class="gauge"><i style="width:' + pct + '%;background:' + color + '"></i></div>';
  }

  function moodPanel(){
    api('/overview').then(function(v){
      if (!v.ok) { toast('读不到心情'); return; }
      state.mood = v.mood || null;
      if (v.config) state.config = v.config;
      var m = state.mood;
      if (!m || !m.ok) { el('detail').innerHTML = '<div class="empty">情绪层没开</div>'; return; }
      var events = (m.events || []).map(function(e){
        return '<div>· ' + new Date(e.at).toLocaleString() + ' Δ' + e.delta + ' ' + esc(e.who || '') + ' ' + esc(e.reason || '') + '</div>';
      }).join('');
      var residue = (m.residue || []).map(function(r){
        return '<div class="moods" style="padding:4px 0"><span style="flex:1">' + esc(r.qq) + ' · 起点 ' + Math.round(r.off) + ' · ' + esc(r.note || '') + '</span>'
          + '<button data-clear="' + esc(r.qq) + '">清掉</button></div>';
      }).join('');
      var html = '<div class="card"><h2>本鲸此刻的心情</h2>'
        + '<div class="moods"><b style="font-size:18px">' + esc(m.label) + '</b>'
        + '<span class="badge">' + (m.lock ? '锁定' : (m.enabled === false ? '已关闭' : '自动')) + '</span>'
        + '<span class="muted">想聊程度 ' + esc(m.effort) + '</span></div>'
        + '<label>心情值 ' + Math.round(m.valence) + '（基线 ' + m.baseline.valence + '）</label>'
        + gauge(m.valence, -100, 100, 'linear-gradient(90deg,#e0607e,#4fa8d8)')
        + '<label>精力 ' + Math.round(m.energy) + '</label>'
        + gauge(m.energy, 0, 100, 'linear-gradient(90deg,#4fa8d8,#4cc38a)')
        + (m.reason ? '<div class="hint">因为：' + esc(m.reason) + '</div>' : '')
        + '<div class="hint">说话基调：' + esc(m.tone) + '</div>'
        + (m.lock && m.lockReason ? '<div class="hint">锁着的原因：' + esc(m.lockReason) + '</div>' : '')
        + '<div class="row" style="margin-top:14px">'
        + '<div><button class="primary" id="mUp">哄一下 +10</button></div>'
        + '<div><button id="mDown">惹一下 -10</button></div>'
        + '<div><button id="mLock">' + (m.lock ? '解锁' : '锁定心情') + '</button></div>'
        + '<div><button class="danger" id="mReset">复位</button></div></div>'
        + '<div class="hist">' + (events || '还没有起伏记录') + '</div></div>'
        + (residue ? '<div class="card"><h2>对某个人的情绪残留</h2><div class="muted">见到这个人时心情起点会偏低，会自己淡掉；主人不受影响。</div>' + residue + '</div>' : '');
      el('detail').innerHTML = html;
      el('mUp').addEventListener('click', function(){ moodSet({ delta: 10, reason: '主人哄了一下' }); });
      el('mDown').addEventListener('click', function(){ moodSet({ delta: -10, reason: '主人惹了一下' }); });
      el('mLock').addEventListener('click', function(){ moodSet({ lock: !m.lock, reason: m.lock ? '主人解锁' : '主人锁定心情' }); });
      el('mReset').addEventListener('click', function(){
        if (!confirm('把心情复位到基线？')) return;
        post('/mood/reset', {}).then(function(r){
          toast(r.ok ? '已复位' : ('失败：' + r.error));
          loadOverview(); moodPanel();
        });
      });
      Array.prototype.forEach.call(el('detail').querySelectorAll('button[data-clear]'), function(node){
        node.addEventListener('click', function(){
          post('/mood/residue', { qq: node.getAttribute('data-clear') }).then(function(r){
            toast(r.ok ? '已清掉' : ('失败：' + r.error));
            loadOverview(); moodPanel();
          });
        });
      });
    });
  }

  function moodSet(patch){
    post('/mood', { patch: patch }).then(function(r){
      toast(r.ok ? '心情变了' : ('失败：' + r.error));
      loadOverview(); moodPanel();
    });
  }

  function settings(){
    var c = state.config;
    var html = '<div class="card"><h2>全局设置</h2>'
      + '<div class="muted">主人的好感是锚点，任何人的生效值都不会超过 min(全局上限, 主人锚点)。</div>'
      + '<div class="row"><div>' + field('s-master', '主人 QQ', c.masterQQ) + '</div>'
      + '<div>' + field('s-masterscore', '主人锚点分', c.masterScore) + '</div></div>'
      + '<div class="row"><div>' + field('s-globalmax', '其他人的上限', c.globalMax) + '</div>'
      + '<div>' + field('s-model', '摘要模型（留空=默认）', c.model) + '</div></div>'
      + '<div class="row"><div>' + field('s-calls', '每小时最多摘要次数', c.maxCallsPerHour) + '</div>'
      + '<div>' + field('s-merge', '每日合并小时（0-23）', c.dailyMergeHour) + '</div></div>'
      + '<h2 style="margin-top:18px">情绪层</h2>'
      + '<label><input type="checkbox" id="s-moodon"' + (c.moodEnabled === false ? '' : ' checked') + '> 启用情绪层（按聊天内容自己变心情）</label>'
      + '<div class="row"><div>' + field('s-moodhl', '心情回落半衰期（小时）', c.moodHalflifeHours, '越小忘得越快，0.5-24') + '</div>'
      + '<div>' + field('s-moodweight', '主人哄一下的倍数（1-3）', c.masterMoodWeight, '只放大好事，凶了不加倍') + '</div></div>'
      + '<div class="row" style="margin-top:12px"><div><button class="primary" id="btnSaveSettings">保存设置</button></div>'
      + '<div><button id="btnBack">返回</button></div></div></div>';
    el('detail').innerHTML = html;
    el('btnBack').addEventListener('click', function(){ state.current = null; el('detail').innerHTML = '<div class="empty">左边选一个人</div>'; });
    el('btnSaveSettings').addEventListener('click', function(){
      var patch = {
        masterScore: Number(el('s-masterscore').value),
        globalMax: Number(el('s-globalmax').value),
        model: el('s-model').value,
        maxCallsPerHour: Number(el('s-calls').value),
        dailyMergeHour: Number(el('s-merge').value),
        moodEnabled: el('s-moodon').checked,
        moodHalflifeHours: Number(el('s-moodhl').value),
        masterMoodWeight: Number(el('s-moodweight').value)
      };
      post('/settings', { patch: patch }).then(function(v){
        toast(v.ok ? '设置已保存' : ('失败：' + v.error));
        if (v.ok) loadOverview();
      });
    });
  }

  el('btnSettings').addEventListener('click', settings);
  el('moodPill').addEventListener('click', moodPanel);
  var timer = null;
  el('q').addEventListener('input', function(){ clearTimeout(timer); timer = setTimeout(loadList, 220); });
  loadOverview(); loadList();
})();
</script>
</body></html>`;

export { ADMIN_HTML };