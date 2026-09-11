// production-archive · ComfyUI 侧边栏面板
// 数据来自 /productionarchive/*（后端实时扫描输出目录里 PNG/MP4 的内嵌元数据）
// 功能：多条件筛选（项目 / 类别 / 时间 / 关键词）、多选批量归类、项目归类管理、图片视频预览
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const LIST_API = "/productionarchive/list";
const PROJ_API = "/productionarchive/projects";
const ASSIGN_API = "/productionarchive/assign";
const FILE_API = "/productionarchive/file";
const ASSET_API = "/productionarchive/asset";    // 资产：删 / 移 / 改名（v1.1.0）
const DIR_API = "/productionarchive/dir";        // 目录改名（v1.1.0）
const TRASH_API = "/productionarchive/trash";    // 回收站（v1.1.0）
const PAGE_SIZE = 150;
const UNASSIGNED = "\u0000未归类";   // 内部哨兵：代表「未归类」这个筛选项

const S = {
  rows: [],
  dirs: {},
  store: null,        // {projects:[{name,color}], rules:[], assign:{}}
  stats: null,
  outDir: "",
  version: "",
  notes: [],
  q: "",
  fProj: new Set(),   // 项目筛选（多选）
  fKind: new Set(),   // 类别筛选：png / mp4（多选）
  fDir: new Set(),    // 目录筛选（多选）
  fDirDeep: true,     // 目录筛选是否包含子目录
  fFrom: "",
  fTo: "",
  sel: new Set(),     // 批量选择
  dirMore: false,     // 目录 chips 是否展开
  shown: PAGE_SIZE,
  loading: false,
  error: "",
  openKey: null,
  mounts: [],
  thumbs: true,       // 列表缩略图开关（v1.1.0）
  redraw: null,       // paint() 里注册的列表重绘函数，供工具栏开关复用
};

// 缩略图开关记忆（localStorage 不可用时静默降级成默认开）
try {
  if (localStorage.getItem("pa.thumbs") === "0") S.thumbs = false;
} catch (e) { /* 没有 localStorage 就算了 */ }

function setThumbs(on) {
  S.thumbs = !!on;
  try { localStorage.setItem("pa.thumbs", on ? "1" : "0"); } catch (e) { /* 忽略 */ }
  if (S.redraw) S.redraw();
  else repaint();
}

/* ------------------------------------------------------------------ 样式 */
const CSS = `
.pa-root{display:flex;flex-direction:column;height:100%;font-size:12px;color:var(--fg-color,#ddd);min-width:0}
.pa-bar{display:flex;gap:6px;padding:8px;border-bottom:1px solid var(--border-color,#3a3a3a);flex-wrap:wrap}
.pa-ver{cursor:pointer;color:#7ea6d8;border-bottom:1px dotted #7ea6d8}
.pa-in,.pa-sel{flex:1 1 auto;min-width:0;background:var(--comfy-input-bg,#1e1e1e);color:var(--input-text,#ddd);
  border:1px solid var(--border-color,#3a3a3a);border-radius:5px;padding:5px 8px;font-size:12px;outline:none}
.pa-in:focus,.pa-sel:focus{border-color:var(--p-primary-color,#4a7dc4)}
.pa-btn{background:var(--comfy-input-bg,#252525);color:var(--input-text,#ccc);border:1px solid var(--border-color,#3a3a3a);
  border-radius:5px;padding:4px 9px;font-size:11.5px;cursor:pointer;white-space:nowrap}
.pa-btn:hover{background:var(--comfy-menu-bg,#333);color:#fff}
.pa-btn:disabled{opacity:.45;cursor:default}
.pa-btn.pri{background:#2f4f7f;border-color:#4a7dc4;color:#fff}
.pa-btn.pri:hover{background:#3a5f95}
.pa-btn.danger{background:rgba(150,50,50,.26);border-color:#a05050;color:#ffd9d9}
.pa-btn.danger:hover{background:rgba(180,60,60,.4)}
.pa-btn:disabled{opacity:.45;cursor:default}
.pa-filt{padding:7px 8px;border-bottom:1px solid var(--border-color,#3a3a3a);display:flex;flex-direction:column;gap:6px}
.pa-frow{display:flex;gap:5px;align-items:center;flex-wrap:wrap}
.pa-flab{font-size:10.5px;opacity:.55;flex:0 0 auto;width:30px}
.pa-chip{padding:2px 8px;border-radius:11px;font-size:11px;cursor:pointer;user-select:none;
  border:1px solid var(--border-color,#3d3d3d);background:var(--comfy-input-bg,#242424);color:#bbb;white-space:nowrap}
.pa-chip:hover{border-color:#6a6a6a;color:#fff}
.pa-chip.on{background:#2f4f7f;border-color:#5b8fd0;color:#fff;font-weight:600}
.pa-dt{background:var(--comfy-input-bg,#1e1e1e);color:var(--input-text,#ddd);border:1px solid var(--border-color,#3a3a3a);
  border-radius:5px;padding:3px 5px;font-size:11px;outline:none;width:118px}
.pa-stat{padding:6px 9px;font-size:11px;opacity:.62;line-height:1.5;word-break:break-all;
  border-bottom:1px solid var(--border-color,#3a3a3a)}
.pa-selbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 8px;
  background:transparent;border-bottom:1px solid var(--border-color,#3a3a3a);font-size:11px}
.pa-selbar.act{background:rgba(70,110,180,.16)}
.pa-selbar b{color:#9cc4ff}
.pa-list{flex:1 1 auto;overflow-y:auto;overflow-x:hidden}
.pa-item{padding:6px 9px;border-bottom:1px solid var(--border-color,#333);cursor:pointer;display:flex;gap:7px;align-items:flex-start}
.pa-item:hover{background:var(--comfy-menu-bg,#2a2a2a)}
.pa-item.on{background:var(--comfy-input-bg,#262626)}
.pa-item.picked{background:rgba(70,110,180,.14)}
.pa-cb{margin:2px 0 0 0;flex:0 0 auto;cursor:pointer;accent-color:#4a7dc4}
.pa-main{flex:1 1 auto;min-width:0}
.pa-r1{display:flex;gap:6px;align-items:center;font-size:11px;opacity:.85}
.pa-tag{padding:0 6px;border-radius:3px;font-size:10px;background:rgba(125,125,125,.22);white-space:nowrap;
  color:#dcdcdc;border:1px solid transparent}
.pa-tag.empty{background:rgba(125,125,125,.13);color:#999}
.pa-tag.man{border-color:rgba(200,170,90,.6)}
.pa-name{font-family:ui-monospace,Consolas,monospace;font-size:11px;opacity:.9;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}
.pa-eye{flex:0 0 auto;background:none;border:none;color:#8fb8e8;cursor:pointer;font-size:13px;padding:0 2px;opacity:.75}
/* 列表缩略图（v1.1.0）：默认 58x33 小图，点它直接开大预览 */
.parc-thumb{flex:0 0 auto;width:58px;height:33px;border-radius:4px;overflow:hidden;background:#101010;
  border:1px solid var(--border-color,#3a3a3a);display:flex;align-items:center;justify-content:center;
  cursor:pointer}
.parc-thumb img,.parc-thumb video{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}
.parc-thumb.off{color:#5a5a5a;font-size:11px;cursor:default}
/* 行内操作菜单（v1.1.0）：改名 / 移动 / 删除
   ★ 类名踩过坑：原来叫 .pa-more，结果跟用户装的另一个插件撞了 ——
     对方写着 width:100%;padding:9px;text-align:center，把我们的 ⋯ 按钮撑满整行，
     又把主体挤成 0 宽（标签叠到缩略图上、作品名消失）。
     CSS 同优先级下后加载的赢，光靠 flex:0 0 auto 拦不住。
     所以：新类统一用 parc- 前缀（production archive），且按钮写死宽度。 */
.parc-more{flex:0 0 22px;width:22px;min-width:22px;max-width:22px;box-sizing:border-box;background:none;border:none;color:#9a9a9a;cursor:pointer;font-size:15px;
  padding:0 3px;opacity:.7;line-height:1}
.parc-more:hover{opacity:1;color:#fff}
.parc-menu{position:fixed;z-index:99997;background:var(--comfy-menu-bg,#222);border:1px solid #4a4a4a;
  border-radius:7px;padding:3px;box-shadow:0 8px 26px rgba(0,0,0,.55);min-width:136px}
.parc-menu button{display:block;width:100%;text-align:left;background:none;border:none;color:#ddd;
  font-size:12px;padding:6px 9px;border-radius:5px;cursor:pointer;white-space:nowrap}
.parc-menu button:hover{background:rgba(74,125,196,.22)}
.parc-menu button.danger{color:#e08a8a}
.parc-menu button.danger:hover{background:rgba(200,80,80,.22)}
.parc-menu .sep{height:1px;background:rgba(125,125,125,.2);margin:3px 2px}
/* 目录行（归类管理里，带改名按钮） */
.pam-dir{cursor:default}
.pam-dir .g{font-family:ui-monospace,Consolas,monospace;font-size:11.5px}
/* 回收站 */
.pat{font-size:11.5px;opacity:.6;margin:2px 0 8px}
.pat-bar{display:flex;gap:6px;align-items:center;margin-bottom:9px;flex-wrap:wrap}
.pa-eye:hover{opacity:1}
.pa-r2{font-size:11px;opacity:.62;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pa-body{padding:8px 9px 11px;background:rgba(0,0,0,.16);border-bottom:1px solid var(--border-color,#333)}
.pa-meta{font-size:11px;opacity:.66;line-height:1.7;word-break:break-all;margin-bottom:7px}
.pa-pre{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;
  line-height:1.75;max-height:340px;overflow:auto;background:rgba(0,0,0,.28);border-radius:5px;padding:9px;
  border:1px solid var(--border-color,#333)}
.pa-acts{display:flex;gap:6px;margin-bottom:7px;flex-wrap:wrap}
.parc-more{display:block;width:100%;padding:9px;text-align:center;opacity:.7;cursor:pointer;
  background:none;border:none;color:inherit;font-size:11.5px}
.parc-more:hover{opacity:1;text-decoration:underline}
.pa-empty{padding:34px 14px;text-align:center;opacity:.55;font-size:12px;line-height:1.8}
.pa-load{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.42);font-size:12px;z-index:20;flex-direction:column;gap:8px}
.pa-spin{width:18px;height:18px;border:2px solid rgba(255,255,255,.25);border-top-color:#7ab;
  border-radius:50%;animation:pa-sp .8s linear infinite}
@keyframes pa-sp{to{transform:rotate(360deg)}}

/* ---- 通用弹层 ---- */
.pam{position:fixed;inset:0;z-index:99990;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center}
.pam-panel{width:min(720px,94vw);max-height:88vh;background:var(--comfy-menu-bg,#1e1e1e);color:var(--fg-color,#ddd);
  border:1px solid var(--border-color,#444);border-radius:10px;display:flex;flex-direction:column;
  box-shadow:0 12px 48px rgba(0,0,0,.6);font-size:12px}
.pam-head{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;
  border-bottom:1px solid var(--border-color,#3a3a3a);font-size:13px}
.pam-body{padding:11px 12px;overflow:auto;flex:1 1 auto}
.pam-sec{margin-bottom:16px}
.pam-sec>h4{margin:0 0 7px;font-size:11.5px;opacity:.6;font-weight:600;letter-spacing:.5px}
.pam-row{display:flex;gap:6px;align-items:center;padding:4px 0;border-bottom:1px solid rgba(125,125,125,.12)}
.pam-row .g{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pam-dot{width:10px;height:10px;border-radius:50%;flex:0 0 auto}
.pam-cnt{opacity:.5;font-size:11px;flex:0 0 auto}
.pam-hint{opacity:.5;font-size:11px;line-height:1.7;margin:5px 0 0}

/* ---- 预览窗 ---- */
.papv{position:fixed;z-index:99995;background:rgba(14,14,14,.97);border:1px solid #4a4a4a;border-radius:9px;
  display:flex;flex-direction:column;overflow:hidden;box-shadow:0 14px 56px rgba(0,0,0,.75);min-width:260px;min-height:190px}
.papv.full{left:0!important;top:0!important;width:100vw!important;height:100vh!important;border-radius:0}
.papv-head{display:flex;align-items:center;gap:6px;padding:6px 9px;cursor:move;user-select:none;
  background:rgba(255,255,255,.06);border-bottom:1px solid #3a3a3a;flex:0 0 auto}
.papv-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:11.5px;font-family:ui-monospace,Consolas,monospace;color:#ddd}
.papv-tools{display:flex;gap:4px;align-items:center;flex:0 0 auto}
.papv-body{flex:1 1 auto;min-height:0;overflow:auto;display:flex;align-items:center;justify-content:center;
  background:repeating-conic-gradient(#1b1b1b 0 25%,#202020 0 50%) 50%/22px 22px}
.papv-body>*{transform-origin:center center;transition:transform .08s linear;max-width:none}
/* 光标必须用 !important 抢回来：
   comfyui-custom-scripts（pysssss）的灯箱给所有 img 设了 cursor:zoom-in，
   会盖掉我们设的 grab —— 表现就是"拖动时鼠标还是放大镜"。
   顺便禁掉原生拖拽与选中，免得拖动时拖动的是元素本身。 */
.papv-body{cursor:default}
.papv-body.can-pan{cursor:grab}
.papv-body.can-pan.dragging{cursor:grabbing}
.papv .papv-body > *{cursor:inherit !important;-webkit-user-drag:none;user-select:none}
/* 轻提示（删除反馈等），2.6 秒自动消失 */
.parc-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:26px;z-index:99998;
  background:rgba(30,34,42,.97);border:1px solid #4a7dc4;color:#e6eefc;font-size:12.5px;
  padding:9px 16px;border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.55);max-width:80vw;
  pointer-events:none}
/* 缩略图开关 */
.parc-thumbopt{display:flex;align-items:center;gap:4px;font-size:11px;opacity:.75;
  cursor:pointer;white-space:nowrap;flex:0 0 auto}
.parc-thumbopt input{margin:0;cursor:pointer;accent-color:#4a7dc4}
/* 说明条：把「文件到底在哪」摊开讲，免得用户去系统回收站白找 */
.parc-note{margin:2px 0 10px;padding:7px 9px;border-radius:5px;font-size:10.5px;line-height:1.6;
  background:rgba(125,125,125,.10);border:1px solid rgba(125,125,125,.18);
  opacity:.9;word-break:break-all}
.parc-note code{font-family:ui-monospace,Consolas,monospace;font-size:10px;
  background:rgba(125,125,125,.18);padding:1px 4px;border-radius:3px}
.papv img{display:block;max-width:100%;max-height:100%}
.papv video{display:block;max-width:100%;max-height:100%;background:#000}
.papv-resize{position:absolute;right:0;bottom:0;width:17px;height:17px;cursor:nwse-resize;
  background:linear-gradient(135deg,transparent 45%,#5a5a5a 45%,#5a5a5a 55%,transparent 55%,transparent 68%,#5a5a5a 68%,#5a5a5a 78%,transparent 78%)}
.papv-zoom{font-size:10.5px;opacity:.6;min-width:38px;text-align:center}
`;

function injectCSS() {
  if (document.getElementById("pa-style")) return;
  const st = document.createElement("style");
  st.id = "pa-style";
  st.textContent = CSS;
  document.head.appendChild(st);
}

const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fileUrl = f => FILE_API + "?f=" + encodeURIComponent(f);

/* ------------------------------------------------- 列表缩略图（v1.1.0）

150 行一起发请求会把面板卡住，所以用 IntersectionObserver 懒加载：
只有滚到视口附近的那些行才真的去拉文件。
视频用 preload="metadata" + #t=0.12 取第一帧，不会把整段视频下下来。
*/
let THUMB_IO = null;

function mountThumb(box) {
  const r = box.__rec;
  if (!r || box.dataset.done) return;
  box.dataset.done = "1";
  const ks = kindsOf(r);
  let node = null;
  if (ks.has("png")) {
    node = document.createElement("img");
    node.src = fileUrl(r.f + ".png");
  } else if (ks.has("mp4")) {
    node = document.createElement("video");
    node.src = fileUrl(r.f + (r.a ? "-audio.mp4" : ".mp4")) + "#t=0.12";
    node.preload = "metadata";
    node.muted = true;
    node.playsInline = true;
  }
  if (!node) {
    box.classList.add("off");
    box.textContent = "—";
    return;
  }
  node.onerror = () => { box.classList.add("off"); box.textContent = "—"; };
  box.appendChild(node);
}

function thumbBox(r) {
  const box = document.createElement("div");
  box.className = "parc-thumb";
  box.title = "点一下看大图 / 放视频";
  box.__rec = r;
  box.onclick = ev => { ev.stopPropagation(); openPreview(r); };
  if (THUMB_IO) THUMB_IO.observe(box);
  else mountThumb(box);
  return box;
}

if (typeof IntersectionObserver === "function") {
  THUMB_IO = new IntersectionObserver(es => {
    es.forEach(en => {
      if (!en.isIntersecting) return;
      THUMB_IO.unobserve(en.target);
      mountThumb(en.target);
    });
  }, { rootMargin: "150px" });
}

/* ------------------------------------------------------------- 数据加载 */
async function load(mode) {
  if (S.loading) return;
  S.loading = true;
  S.error = "";
  repaint();
  try {
    const qs = mode === "full" ? "?full=1" : mode === "refresh" ? "?refresh=1" : "";
    const [r1, r2] = await Promise.all([
      fetch(LIST_API + qs, { cache: "no-store" }),
      fetch(PROJ_API, { cache: "no-store" }),
    ]);
    const j = await r1.json();
    if (!j.ok) throw new Error(j.error || "接口返回失败");
    S.rows = j.rows || [];
    S.stats = j.stats || null;
    S.dirs = j.dirs || {};
    S.outDir = j.output_dir || "";
    S.version = j.version || "";
    S.notes = j.notes || [];
    try {
      const p = await r2.json();
      if (p.ok) S.store = p.store;
    } catch (e) { /* 项目接口失败不影响列表 */ }

    const alive = new Set(S.rows.map(r => r.f));
    [...S.sel].forEach(k => { if (!alive.has(k)) S.sel.delete(k); });
    // 项目被删掉后，清掉失效的筛选项
    const names = new Set(projects().map(p => p.name));
    [...S.fProj].forEach(n => { if (n !== UNASSIGNED && !names.has(n)) S.fProj.delete(n); });
  } catch (e) {
    S.error = String(e && e.message ? e.message : e);
  } finally {
    S.loading = false;
    repaint();
  }
}

function repaint() {
  S.mounts = S.mounts.filter(m => m.el && m.el.isConnected);
  // 首挂载兜底（2026-09-11 修）：
  // 前端在注册后可能把 render(el) 交给我们那个容器替换掉，于是 S.mounts 里的元素
  // 变成脱链状态被上面这行过滤掉，而这时 load() 已经拿到数据并调用 repaint() ——
  // 结果就是「面板第一次打开永远是空的，切走再切回才出数据」。
  // 表现是空的但按钮已是「刷新」（说明 load 早完成了），极具迷惑性。
  // 这里按 DOM 里真实存在的面板根把容器找回来，保证数据回来一定有人重绘。
  if (!S.mounts.length) {
    const root = document.querySelector(".pa-root");
    if (root) S.mounts.push({ el: root });
  }
  S.mounts.forEach(m => paint(m));
}

const projects = () => (S.store && S.store.projects) || [];
const rules = () => (S.store && S.store.rules) || [];
const projColor = name => {
  const p = projects().find(x => x.name === name);
  return p ? p.color : "#7a7a7a";
};

async function postJSON(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let j = {};
  try { j = await r.json(); } catch (e) { /* 非 JSON 响应 */ }
  if (!r.ok || !j.ok) throw new Error(j.error || ("请求失败 " + r.status));
  return j;
}

// 归类改动后重新拉列表（后端走增量缓存，0.2 秒左右）
async function reloadAfterChange(keepMode) {
  await load(keepMode || "refresh");
  if (MG && MG.root && MG.root.isConnected) drawManager();
}

/* --------------------------------------------------------------- 过滤 */
function kindsOf(r) {
  const k = r.k || "";
  const s = new Set();
  if (k.indexOf("png") >= 0) s.add("png");
  if (k.indexOf("mp4") >= 0) s.add("mp4");
  return s;
}

// 目录命中：勾选「含子目录」时，选中 A 会连带 A/B 一起命中。
// 根目录（空串）只做精确匹配——否则一勾就等于全选。
function dirHit(r) {
  const d0 = r.d || "";
  let hit = false;
  S.fDir.forEach(d => {
    if (d0 === d) hit = true;
    else if (S.fDirDeep && d && d0.indexOf(d + "/") === 0) hit = true;
  });
  return hit;
}

const dirLabel = d => d || "(输出根目录)";

function filtered() {
  const q = S.q.trim().toLowerCase();
  return S.rows.filter(r => {
    if (S.fProj.size) {
      const key = r.e || UNASSIGNED;
      if (!S.fProj.has(key)) return false;
    }
    if (S.fKind.size) {
      const ks = kindsOf(r);
      let hit = false;
      S.fKind.forEach(k => { if (ks.has(k)) hit = true; });
      if (!hit) return false;
    }
    if (S.fDir.size && !dirHit(r)) return false;
    if (S.fFrom && r.t.slice(0, 10) < S.fFrom) return false;
    if (S.fTo && r.t.slice(0, 10) > S.fTo) return false;
    if (!q) return true;
    return (r.p + " " + r.f + " " + r.r + " " + r.s + " " + (r.e || ""))
      .toLowerCase().indexOf(q) >= 0;
  });
}

/* --------------------------------------------------------------- 绘制 */
function paint(mount) {
  const el = mount.el;
  el.innerHTML = "";
  el.className = "pa-root";
  el.style.position = "relative";

  const bar = document.createElement("div");
  bar.className = "pa-bar";

  const q = document.createElement("input");
  q.className = "pa-in";
  q.placeholder = "搜提示词 / 文件名 / 参考图 / seed";
  q.value = S.q;
  q.oninput = () => { S.q = q.value; S.shown = PAGE_SIZE; drawList(); };
  bar.appendChild(q);

  const btn = document.createElement("button");
  btn.className = "pa-btn";
  btn.textContent = S.loading ? "扫描中…" : "刷新";
  btn.disabled = S.loading;
  btn.title = "增量扫描新生成的文件（已索引的不会重复解析，通常 1 秒内）";
  btn.onclick = () => load("refresh");
  bar.appendChild(btn);

  const btnFull = document.createElement("button");
  btnFull.className = "pa-btn";
  btnFull.textContent = "全量";
  btnFull.title = "忽略缓存，重新解析全部文件（较慢，仅在索引异常时用）";
  btnFull.disabled = S.loading;
  btnFull.onclick = () => load("full");
  bar.appendChild(btnFull);

  const btnMg = document.createElement("button");
  btnMg.className = "pa-btn";
  btnMg.textContent = "归类管理";
  btnMg.title = "新建项目、设置目录自动归类规则";
  btnMg.onclick = openManager;
  bar.appendChild(btnMg);

  // 回收站：删掉的东西都在这儿，能恢复（v1.1.0）
  const btnTrash = document.createElement("button");
  btnTrash.className = "pa-btn";
  btnTrash.textContent = "回收站";
  btnTrash.title = "查看 / 恢复 / 彻底删除被你删掉的资产";
  btnTrash.onclick = openTrash;
  bar.appendChild(btnTrash);

  // 缩略图开关（v1.1.0）：不想要小图的可以关掉，选择会被记住
  const thLab = document.createElement("label");
  thLab.className = "parc-thumbopt";
  thLab.title = "在每条作品左边显示一张小预览图；关掉列表更紧凑";
  const thCb = document.createElement("input");
  thCb.type = "checkbox";
  thCb.checked = S.thumbs;
  thCb.onchange = () => setThumbs(thCb.checked);
  thLab.append(thCb, document.createTextNode("缩略图"));
  bar.appendChild(thLab);

  el.appendChild(bar);

  // ---- 筛选区
  const filt = document.createElement("div");
  filt.className = "pa-filt";

  const rowP = document.createElement("div");
  rowP.className = "pa-frow";
  const chipsP = document.createElement("div");
  chipsP.className = "pa-frow";
  chipsP.style.flex = "1 1 auto";
  const headP = document.createElement("div");
  headP.className = "pa-frow";
  const labP = document.createElement("span");
  labP.className = "pa-flab";
  labP.textContent = "项目";
  const clr = document.createElement("button");
  clr.className = "pa-btn";
  clr.textContent = "清空筛选";
  clr.style.marginLeft = "auto";
  clr.onclick = () => {
    S.fProj.clear(); S.fKind.clear(); S.fDir.clear(); S.fFrom = ""; S.fTo = "";
    S.shown = PAGE_SIZE; drawFilter(); drawList();
  };
  headP.append(labP, clr);
  rowP.appendChild(headP);

  const rowD = document.createElement("div");
  rowD.className = "pa-frow";
  const labD = document.createElement("span");
  labD.className = "pa-flab";
  labD.textContent = "目录";
  const chipsD = document.createElement("div");
  chipsD.className = "pa-frow";
  chipsD.style.flex = "1 1 auto";
  const deepL = document.createElement("label");
  deepL.style.cssText =
    "font-size:10.5px;display:flex;gap:3px;align-items:center;opacity:.72;flex:0 0 auto;cursor:pointer";
  deepL.title = "勾选后，选中上级目录会连带匹配它下面的所有子目录";
  const deepCb = document.createElement("input");
  deepCb.type = "checkbox";
  deepCb.checked = S.fDirDeep;
  deepCb.style.cssText = "margin:0;cursor:pointer;accent-color:#4a7dc4";
  deepCb.onchange = () => { S.fDirDeep = deepCb.checked; S.shown = PAGE_SIZE; drawList(); };
  deepL.append(deepCb, document.createTextNode("含子目录"));
  rowD.append(labD, chipsD, deepL);

  const rowK = document.createElement("div");
  rowK.className = "pa-frow";
  const labK = document.createElement("span");
  labK.className = "pa-flab";
  labK.textContent = "类别";
  const chipsK = document.createElement("div");
  chipsK.className = "pa-frow";
  chipsK.style.flex = "1 1 auto";

  const rowT = document.createElement("div");
  rowT.className = "pa-frow";
  const labT = document.createElement("span");
  labT.className = "pa-flab";
  labT.textContent = "时间";
  const dFrom = document.createElement("input");
  dFrom.type = "date"; dFrom.className = "pa-dt"; dFrom.title = "起始日期";
  const dTo = document.createElement("input");
  dTo.type = "date"; dTo.className = "pa-dt"; dTo.title = "结束日期";
  const dash = document.createElement("span");
  dash.textContent = "→"; dash.style.opacity = ".5";
  const qToday = document.createElement("button");
  qToday.className = "pa-btn"; qToday.textContent = "今天";
  const q7 = document.createElement("button");
  q7.className = "pa-btn"; q7.textContent = "近 7 天";
  const q30 = document.createElement("button");
  q30.className = "pa-btn"; q30.textContent = "近 30 天";

  const ymd = d => {
    const p = n => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  };
  const quick = days => {
    const t = new Date();
    const f = new Date(t.getTime() - days * 86400000);
    S.fFrom = ymd(f); S.fTo = ymd(t);
    dFrom.value = S.fFrom; dTo.value = S.fTo;
    S.shown = PAGE_SIZE; drawList();
  };
  qToday.onclick = () => quick(0);
  q7.onclick = () => quick(6);
  q30.onclick = () => quick(29);

  dFrom.onchange = () => { S.fFrom = dFrom.value; S.shown = PAGE_SIZE; drawList(); };
  dTo.onchange = () => { S.fTo = dTo.value; S.shown = PAGE_SIZE; drawList(); };
  dFrom.value = S.fFrom; dTo.value = S.fTo;

  rowT.append(labT, dFrom, dash, dTo, qToday, q7, q30);
  rowK.append(labK, chipsK);
  rowP.appendChild(chipsP);
  filt.append(rowP, rowD, rowK, rowT);
  el.appendChild(filt);

  // ---- 状态行 + 批量操作条
  const stat = document.createElement("div");
  stat.className = "pa-stat";
  stat.onclick = (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains("pa-ver") && S.version) {
      alert("production-archive v" + S.version + "\n\n本版内容：\n· " +
        ((S.notes && S.notes.length) ? S.notes.join("\n· ") : "（无说明）"));
    }
  };
  el.appendChild(stat);

  const selbar = document.createElement("div");
  selbar.className = "pa-selbar";
  el.appendChild(selbar);

  const list = document.createElement("div");
  list.className = "pa-list";
  el.appendChild(list);

  if (S.loading) {
    const m = document.createElement("div");
    m.className = "pa-load";
    m.innerHTML = '<div class="pa-spin"></div><div>正在扫描输出目录…</div>';
    el.appendChild(m);
  }

  // ---- 筛选 chips
  function drawFilter() {
    chipsP.innerHTML = "";
    const ps = projects();
    if (!ps.length) {
      const s = document.createElement("span");
      s.style.cssText = "opacity:.5;font-size:11px";
      s.textContent = "（还没有项目，点「归类管理」新建）";
      chipsP.appendChild(s);
    }
    ps.forEach(p => {
      const c = document.createElement("span");
      c.className = "pa-chip" + (S.fProj.has(p.name) ? " on" : "");
      c.textContent = p.name;
      c.title = "按项目筛选（可多选）";
      if (S.fProj.has(p.name)) c.style.borderColor = p.color;
      c.onclick = () => {
        S.fProj.has(p.name) ? S.fProj.delete(p.name) : S.fProj.add(p.name);
        S.shown = PAGE_SIZE; drawFilter(); drawList();
      };
      chipsP.appendChild(c);
    });
    if (S.rows.some(r => !r.e)) {
      const c = document.createElement("span");
      c.className = "pa-chip" + (S.fProj.has(UNASSIGNED) ? " on" : "");
      c.textContent = "未归类";
      c.style.opacity = ".8";
      c.onclick = () => {
        S.fProj.has(UNASSIGNED) ? S.fProj.delete(UNASSIGNED) : S.fProj.add(UNASSIGNED);
        S.shown = PAGE_SIZE; drawFilter(); drawList();
      };
      chipsP.appendChild(c);
    }

    chipsK.innerHTML = "";
    [["png", "图片"], ["mp4", "视频"]].forEach(([k, label]) => {
      const c = document.createElement("span");
      c.className = "pa-chip" + (S.fKind.has(k) ? " on" : "");
      c.textContent = label;
      c.onclick = () => {
        S.fKind.has(k) ? S.fKind.delete(k) : S.fKind.add(k);
        S.shown = PAGE_SIZE; drawFilter(); drawList();
      };
      chipsK.appendChild(c);
    });

    // ---- 目录 chips（按作品数降序；超过 14 个折叠）
    chipsD.innerHTML = "";
    const DIR_LIMIT = 14;
    const ds = Object.keys(S.dirs || {}).sort((a, b) => {
      const ca = S.dirs[a] || 0, cb = S.dirs[b] || 0;
      if (ca !== cb) return cb - ca;
      return a.localeCompare(b);
    });
    if (!ds.length) {
      const s = document.createElement("span");
      s.style.cssText = "opacity:.5;font-size:11px";
      s.textContent = "（尚未扫描到目录）";
      chipsD.appendChild(s);
    }
    const showDirs = (S.dirMore || ds.length <= DIR_LIMIT) ? ds : ds.slice(0, DIR_LIMIT);
    showDirs.forEach(d => {
      const n = S.dirs[d] || 0;
      const c = document.createElement("span");
      c.className = "pa-chip" + (S.fDir.has(d) ? " on" : "");
      c.textContent = dirLabel(d) + " " + n;
      c.title = (d ? "目录：" + d : "输出根目录（作品直接放在 output 下）") +
        "　共 " + n + " 条　点击筛选（可多选）";
      c.onclick = () => {
        S.fDir.has(d) ? S.fDir.delete(d) : S.fDir.add(d);
        S.shown = PAGE_SIZE; drawFilter(); drawList();
      };
      chipsD.appendChild(c);
    });
    if (ds.length > DIR_LIMIT) {
      const m = document.createElement("span");
      m.className = "pa-chip";
      m.style.opacity = ".7";
      m.textContent = S.dirMore ? "收起" : "更多 " + (ds.length - DIR_LIMIT) + " 个";
      m.onclick = () => { S.dirMore = !S.dirMore; drawFilter(); };
      chipsD.appendChild(m);
    }
    if (S.fDir.size) {
      const c = document.createElement("button");
      c.className = "pa-btn";
      c.style.cssText = "padding:1px 7px;font-size:10.5px;border-radius:11px";
      c.textContent = "清除目录";
      c.onclick = () => { S.fDir.clear(); S.shown = PAGE_SIZE; drawFilter(); drawList(); };
      chipsD.appendChild(c);
    }
  }

  function drawStat() {
    if (S.error) {
      stat.innerHTML = '<span style="color:#e08a8a">出错：' + esc(S.error) + "</span>";
      return;
    }
    const rows = filtered();
    const st = S.stats || {};
    const nProj = projects().length;
    stat.innerHTML =
      "<b>" + rows.length + "</b> / " + S.rows.length + " 条 · " + nProj + " 个项目" +
      (st.reused != null ? " · 缓存命中 " + st.reused + " · 新解析 " + st.parsed : "") +
      '<br><span style="opacity:.6">' + esc(S.outDir || "") + "</span>" +
      (S.version
        ? ' <span class="pa-ver" title="点击查看本版新增内容">v' + esc(S.version) + "</span>"
        : "");
  }

  function drawSelbar() {
    selbar.innerHTML = "";
    const rows = filtered();
    const n = S.sel.size;
    selbar.className = "pa-selbar" + (n ? " act" : "");

    const t = document.createElement("span");
    t.style.cssText = "flex:0 0 auto;opacity:.85";
    if (n) {
      const inView = rows.reduce((a, r) => a + (S.sel.has(r.f) ? 1 : 0), 0);
      t.innerHTML = "已选 <b>" + n + "</b> 条" +
        (n > inView
          ? ' <span style="opacity:.55">（' + (n - inView) + " 条在当前筛选之外）</span>"
          : "");
    } else {
      t.innerHTML = "共 <b>" + rows.length + "</b> 条";
    }
    selbar.appendChild(t);

    // 全选：常驻显示（没勾任何东西时也能一键全选当前筛选结果）
    const all = document.createElement("button");
    all.className = "pa-btn pri";
    all.textContent = "全选 " + rows.length + " 条";
    all.title = "选中当前筛选出的全部记录。先按项目/目录/类别/时间筛，再点这里即可整批归类。";
    all.disabled = !rows.length;
    all.onclick = () => {
      rows.forEach(r => S.sel.add(r.f));
      drawList();
    };
    selbar.appendChild(all);

    if (!n) {
      const hint = document.createElement("span");
      hint.style.cssText = "opacity:.45;font-size:10.5px";
      hint.textContent = "（或逐条勾选，选中后可批量归类 / 删除）";
      selbar.appendChild(hint);
      return;
    }

    const selp = document.createElement("select");
    selp.className = "pa-sel";
    selp.style.cssText = "flex:1 1 90px;min-width:80px";
    selp.innerHTML = '<option value="">归类到…</option>' +
      '<option value="__none__">取消归类</option>' +
      projects().map(p => '<option value="' + esc(p.name) + '">' + esc(p.name) + "</option>").join("");
    selbar.appendChild(selp);

    const go = document.createElement("button");
    go.className = "pa-btn pri";
    go.textContent = "应用";
    go.onclick = async () => {
      const v = selp.value;
      if (!v) { alert("先选一个项目"); return; }
      go.disabled = true; go.textContent = "处理中…";
      try {
        await postJSON(ASSIGN_API, {
          keys: [...S.sel],
          project: v === "__none__" ? "" : v,
        });
        S.sel.clear();
        await reloadAfterChange("refresh");
      } catch (e) {
        alert("归类失败：" + (e && e.message ? e.message : e));
        go.disabled = false; go.textContent = "应用";
      }
    };
    selbar.appendChild(go);

    const inv = document.createElement("button");
    inv.className = "pa-btn";
    inv.textContent = "反选";
    inv.title = "在当前筛选结果里反转选中状态";
    inv.onclick = () => {
      filtered().forEach(r => S.sel.has(r.f) ? S.sel.delete(r.f) : S.sel.add(r.f));
      drawList();
    };
    selbar.appendChild(inv);

    // 批量删除（软删除，进回收站）
    const del = document.createElement("button");
    del.className = "pa-btn danger";
    del.textContent = "删除";
    del.title = "把选中的资产移进回收站 —— 可恢复，不会真删";
    del.onclick = async () => {
      const keys = [...S.sel];
      if (!keys.length) return;
      if (!confirm("把选中的 " + keys.length + " 条资产移进回收站？\n\n" +
                   "· 每条的图 / 视频 / 音轨会一起移走\n" +
                   "· 只是移进回收站，随时能从「回收站」恢复，不会真删\n\n" +
                   "确定吗？")) return;
      del.disabled = true;
      del.textContent = "处理中…";
      try {
        await postJSON(ASSET_API, { action: "trash", keys: keys });
        S.sel.clear();
        await reloadAfterChange("refresh");
        refreshTrashSoon();
        toast("已把 " + keys.length + " 条移进回收站（顶部「回收站」可恢复）");
      } catch (e) {
        alert("删除失败：" + (e && e.message ? e.message : e));
        del.disabled = false;
        del.textContent = "删除";
      }
    };
    selbar.appendChild(del);

    const clr2 = document.createElement("button");
    clr2.className = "pa-btn";
    clr2.textContent = "清除选择";
    clr2.onclick = () => { S.sel.clear(); drawList(); };
    selbar.appendChild(clr2);
  }

  function item(r) {
    const box = document.createDocumentFragment();
    const row = document.createElement("div");
    const picked = S.sel.has(r.f);
    row.className = "pa-item" + (S.openKey === r.f ? " on" : "") + (picked ? " picked" : "");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "pa-cb";
    cb.checked = picked;
    cb.title = "选中后可在顶部批量归类";
    cb.onclick = ev => {
      ev.stopPropagation();
      cb.checked ? S.sel.add(r.f) : S.sel.delete(r.f);
      row.classList.toggle("picked", cb.checked);
      drawSelbar();
    };
    row.appendChild(cb);
    if (S.thumbs) row.appendChild(thumbBox(r));

    const main = document.createElement("div");
    main.className = "pa-main";
    const col = r.e ? projColor(r.e) : "";
    main.innerHTML =
      '<div class="pa-r1">' +
        '<span class="pa-tag' + (r.e ? " man" : " empty") + '"' +
          (col ? ' style="background:' + esc(col) + '33;border-color:' + esc(col) + '"' : "") +
          ' title="' + (r.as === "manual" ? "手动归类" : r.as === "rule" ? "目录规则自动归类" : "未归类") + '">' +
          esc(r.e || "未归类") +
        "</span>" +
        '<span class="pa-name" title="' + esc(r.f) + '">' + esc(r.f) + "</span>" +
      "</div>" +
      '<div class="pa-r2">' + esc(r.t.slice(5, 16)) + " · " + r.n + "字" +
        (r.rc ? " · " + r.rc + "图" : "") +
        (r.m ? " · " + r.m + "MB" : "") +
        (kindsOf(r).has("mp4") ? " · 视频" : " · 图") +
      "</div>";
    row.appendChild(main);

    const eye = document.createElement("button");
    eye.className = "pa-eye";
    eye.textContent = "◉";
    eye.title = "预览（图片 / 视频）";
    eye.onclick = ev => { ev.stopPropagation(); openPreview(r); };
    row.appendChild(eye);

    const more = document.createElement("button");
    more.className = "parc-more";
    more.textContent = "⋯";
    more.title = "改名 / 移动 / 删除这条资产";
    more.onclick = ev => {
      ev.stopPropagation();
      openRowMenu(r, more);
    };
    row.appendChild(more);

    row.onclick = () => {
      S.openKey = S.openKey === r.f ? null : r.f;
      drawList();
    };
    box.appendChild(row);
    if (S.openKey === r.f) box.appendChild(body(r));
    return box;
  }

  function body(r) {
    const b = document.createElement("div");
    b.className = "pa-body";

    const acts = document.createElement("div");
    acts.className = "pa-acts";

    const pv = document.createElement("button");
    pv.className = "pa-btn pri";
    pv.textContent = "预览";
    pv.disabled = !r.k;
    pv.onclick = ev => { ev.stopPropagation(); openPreview(r); };
    acts.appendChild(pv);

    const cp = document.createElement("button");
    cp.className = "pa-btn";
    cp.textContent = "复制提示词";
    cp.disabled = !r.n;
    cp.onclick = ev => {
      ev.stopPropagation();
      copy(r.p).then(ok => {
        cp.textContent = ok ? "已复制 ✓" : "复制失败";
        setTimeout(() => (cp.textContent = "复制提示词"), 1400);
      });
    };
    acts.appendChild(cp);

    const cpPath = document.createElement("button");
    cpPath.className = "pa-btn";
    cpPath.textContent = "复制路径";
    cpPath.onclick = ev => {
      ev.stopPropagation();
      copy(S.outDir.replace(/[\\/]+$/, "") + "\\" + r.f.replace(/\//g, "\\")).then(ok => {
        cpPath.textContent = ok ? "已复制 ✓" : "复制失败";
        setTimeout(() => (cpPath.textContent = "复制路径"), 1400);
      });
    };
    acts.appendChild(cpPath);

    const asg = document.createElement("button");
    asg.className = "pa-btn";
    asg.textContent = "归类到…";
    asg.onclick = ev => {
      ev.stopPropagation();
      pickProject("把「" + r.f + "」归类到哪个项目？", r.e).then(name => {
        if (name === null) return;
        postJSON(ASSIGN_API, { keys: [r.f], project: name })
          .then(() => reloadAfterChange("refresh"))
          .catch(e => alert("归类失败：" + (e && e.message ? e.message : e)));
      });
    };
    acts.appendChild(asg);

    b.appendChild(acts);

    const meta = document.createElement("div");
    meta.className = "pa-meta";
    meta.innerHTML =
      "<b>seed</b> " + esc(r.s || "-") +
      (r.z ? " · <b>规格</b> " + esc(r.z) : "") +
      (r.k ? " · <b>文件</b> " + esc(r.k) : "") +
      (r.d ? " · <b>目录</b> " + esc(r.d) : "") +
      (r.r ? "<br><b>参考图</b> " + esc(r.r) : "");
    b.appendChild(meta);

    const pre = document.createElement("div");
    pre.className = "pa-pre";
    pre.textContent = r.p || "（该次生成没有文本提示词）";
    b.appendChild(pre);
    return b;
  }

  function drawList() {
    S.redraw = drawList;      // 留给工具栏的缩略图开关用
    drawStat();
    drawSelbar();
    list.innerHTML = "";
    const rows = filtered();
    if (!S.rows.length && !S.loading) {
      list.innerHTML = '<div class="pa-empty">还没有索引到任何记录。<br>先在 ComfyUI 里生成一次，再点「刷新」。</div>';
      return;
    }
    if (!rows.length) {
      list.innerHTML = '<div class="pa-empty">没有匹配的记录</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    rows.slice(0, S.shown).forEach(r => frag.appendChild(item(r)));
    if (rows.length > S.shown) {
      const more = document.createElement("button");
      more.className = "parc-more";
      more.textContent = "显示更多（还有 " + (rows.length - S.shown) + " 条）";
      more.onclick = () => { S.shown += PAGE_SIZE; drawList(); };
      frag.appendChild(more);
    }
    list.appendChild(frag);
  }

  drawFilter();
  drawList();
  mount.draw = () => { drawFilter(); drawList(); };
  return el;
}

/* ---------------------------------------------------------- 选项目的弹层 */
function pickProject(title, current) {
  return new Promise(resolve => {
    injectCSS();
    const m = document.createElement("div");
    m.className = "pam";
    const panel = document.createElement("div");
    panel.className = "pam-panel";
    panel.style.width = "min(340px,92vw)";
    const head = document.createElement("div");
    head.className = "pam-head";
    head.innerHTML = "<b>" + esc(title) + "</b>";
    const x = document.createElement("button");
    x.className = "pa-btn"; x.textContent = "✕";
    head.appendChild(x);
    const bodyEl = document.createElement("div");
    bodyEl.className = "pam-body";
    panel.append(head, bodyEl);
    m.appendChild(panel);
    document.body.appendChild(m);

    const done = v => { m.remove(); resolve(v); };
    x.onclick = () => done(null);
    m.onclick = e => { if (e.target === m) done(null); };

    const ps = projects();
    if (current) {
      const b = document.createElement("button");
      b.className = "pa-btn"; b.textContent = "取消归类（回落到目录规则）";
      b.style.cssText += ";width:100%;margin-bottom:8px";
      b.onclick = () => done("");
      bodyEl.appendChild(b);
    }
    if (!ps.length) {
      const d = document.createElement("div");
      d.className = "pam-hint";
      d.textContent = "还没有项目，请先到「归类管理」新建。";
      bodyEl.appendChild(d);
      return;
    }
    ps.forEach(p => {
      const r = document.createElement("div");
      r.className = "pam-row";
      r.style.cursor = "pointer";
      r.innerHTML = '<span class="pam-dot" style="background:' + esc(p.color) + '"></span>' +
        '<span class="g">' + esc(p.name) + "</span>" +
        (p.name === current ? '<span class="pam-cnt">当前</span>' : "");
      r.onclick = () => done(p.name);
      bodyEl.appendChild(r);
    });
  });
}

/* ------------------------------------------------------------ 归类管理 */
/* ------------------------------------------------- 行内操作（v1.1.0）

改名 / 移动 / 删除。这三件事**会真的动文件**，所以每一个都先问清楚再动手；
删除一律软删除（进回收站），并明确告诉用户「能恢复」。
*/

/* 轻提示：2.6 秒自动消失。
   删除之后**必须**给反馈 —— 东西凭空从列表里消失，用户会以为被真删了。
   （v1.1.0 上线当天就踩到这个，反馈就是这么来的。） */
function toast(msg) {
  injectCSS();
  document.querySelectorAll(".parc-toast").forEach(t => t.remove());
  const el = document.createElement("div");
  el.className = "parc-toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// 回收站面板开着的话，动完文件立刻刷新它，否则用户看到的是过期清单
function refreshTrashSoon() {
  if (TG && TG.root && TG.root.style.display !== "none") drawTrash();
}

function closeMenus() {
  document.querySelectorAll(".parc-menu").forEach(m => m.remove());
}

function openRowMenu(r, anchor) {
  closeMenus();
  const menu = document.createElement("div");
  menu.className = "parc-menu";
  const mk = (label, fn, cls) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = () => { closeMenus(); fn(); };
    menu.appendChild(b);
  };
  mk("改名…", () => askRename(r));
  mk("移动到…", () => askMove(r));
  const sep = document.createElement("div");
  sep.className = "sep";
  menu.appendChild(sep);
  mk("删除（进回收站）", () => askTrash(r), "danger");

  document.body.appendChild(menu);
  const a = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.max(6, Math.min(window.innerWidth - mw - 6, a.right - mw)) + "px";
  menu.style.top = Math.max(6, Math.min(window.innerHeight - mh - 6, a.bottom + 4)) + "px";
  // 点空白处关掉
  setTimeout(() => {
    const off = ev => {
      if (!menu.contains(ev.target)) {
        closeMenus();
        document.removeEventListener("mousedown", off);
      }
    };
    document.addEventListener("mousedown", off);
  }, 0);
}

/* 通用小弹层：一个输入框 + 确定/取消 */
function askInput(opts) {
  return new Promise(resolve => {
    injectCSS();
    const root = document.createElement("div");
    root.className = "pam";
    const panel = document.createElement("div");
    panel.className = "pam-panel";
    panel.style.width = "min(440px,92vw)";
    const head = document.createElement("div");
    head.className = "pam-head";
    head.innerHTML = "<b>" + esc(opts.title || "") + "</b>";
    const xb = document.createElement("button");
    xb.className = "pa-btn";
    xb.textContent = "取消";
    head.appendChild(xb);
    const bodyEl = document.createElement("div");
    bodyEl.className = "pam-body";
    if (opts.hint) {
      const h = document.createElement("div");
      h.className = "pam-hint";
      h.textContent = opts.hint;
      bodyEl.appendChild(h);
    }
    const inp = document.createElement("input");
    inp.className = "pa-in";
    inp.style.cssText = "width:100%;margin-top:9px";
    inp.value = opts.value || "";
    inp.placeholder = opts.placeholder || "";
    bodyEl.appendChild(inp);
    const bar = document.createElement("div");
    bar.className = "pam-row";
    bar.style.marginTop = "11px";
    const ok = document.createElement("button");
    ok.className = "pa-btn pri";
    ok.textContent = opts.okText || "确定";
    const cancel = document.createElement("button");
    cancel.className = "pa-btn";
    cancel.textContent = "取消";
    const err = document.createElement("span");
    err.style.cssText = "color:#e08a8a;font-size:11px";
    bar.append(ok, cancel, err);
    bodyEl.appendChild(bar);
    const done = v => { root.remove(); resolve(v); };
    xb.onclick = cancel.onclick = () => done(null);
    root.onclick = e => { if (e.target === root) done(null); };
    const submit = () => {
      const v = inp.value.trim();
      if (!v) { err.textContent = "不能为空"; return; }
      done(v);
    };
    ok.onclick = submit;
    inp.onkeydown = e => {
      if (e.key === "Enter") submit();
      else if (e.key === "Escape") done(null);
    };
    panel.append(head, bodyEl);
    root.appendChild(panel);
    document.body.appendChild(root);
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  });
}

async function askRename(r) {
  const stem = r.f.split("/").pop();
  const name = await askInput({
    title: "改资产名",
    value: stem,
    hint: "同一次生成的图 / 视频 / 音轨会一起改名。名字里不能出现 \\ / : * ? \" < > |",
    okText: "改名",
  });
  if (!name) return;
  try {
    const j = await postJSON(ASSET_API, { action: "rename", key: r.f, name: name });
    await reloadAfterChange();
    toast("已改名：" + ((j.result && j.result.key) || name));
  } catch (e) {
    alert("改名失败：" + e.message);
  }
}

function askMove(r) {
  injectCSS();
  const dirs = Object.keys(S.dirs || {}).filter(d => d).sort();
  const root = document.createElement("div");
  root.className = "pam";
  const panel = document.createElement("div");
  panel.className = "pam-panel";
  panel.style.width = "min(480px,92vw)";
  const head = document.createElement("div");
  head.className = "pam-head";
  head.innerHTML = "<b>移动资产</b>";
  const xb = document.createElement("button");
  xb.className = "pa-btn";
  xb.textContent = "取消";
  head.appendChild(xb);
  const bodyEl = document.createElement("div");
  bodyEl.className = "pam-body";

  const hint = document.createElement("div");
  hint.className = "pam-hint";
  hint.textContent = "把「" + r.f + "」移到 —— 同一次生成的图 / 视频 / 音轨会一起搬过去。";
  bodyEl.appendChild(hint);

  const sel = document.createElement("select");
  sel.className = "pa-sel";
  sel.style.cssText = "width:100%;margin-top:9px";
  sel.innerHTML =
    '<option value="__root__">（输出根目录）</option>' +
    dirs.map(d => '<option value="' + esc(d) + '">' + esc(d) + "</option>").join("") +
    '<option value="__new__">＋ 新建子目录…</option>';
  const inList = r.d && dirs.indexOf(r.d) >= 0;
  sel.value = inList ? r.d : (r.d ? "__new__" : "__root__");
  bodyEl.appendChild(sel);

  const newInp = document.createElement("input");
  newInp.className = "pa-in";
  newInp.style.cssText = "width:100%;margin-top:9px";
  newInp.placeholder = "新目录名，可以带层级，例如：归档/第一集";
  if (r.d && !inList) newInp.value = r.d;
  bodyEl.appendChild(newInp);

  const err = document.createElement("div");
  err.style.cssText = "color:#e08a8a;font-size:11px;margin-top:6px;min-height:14px";
  bodyEl.appendChild(err);

  const bar = document.createElement("div");
  bar.className = "pam-row";
  bar.style.marginTop = "6px";
  const ok = document.createElement("button");
  ok.className = "pa-btn pri";
  ok.textContent = "移动";
  const cancel = document.createElement("button");
  cancel.className = "pa-btn";
  cancel.textContent = "取消";
  bar.append(ok, cancel);
  bodyEl.appendChild(bar);

  const sync = () => {
    const isNew = sel.value === "__new__";
    newInp.style.display = isNew ? "" : "none";
    if (isNew) newInp.focus();
  };
  sel.onchange = sync;
  sync();

  const close = () => root.remove();
  xb.onclick = cancel.onclick = close;
  root.onclick = e => { if (e.target === root) close(); };
  ok.onclick = async () => {
    const target = sel.value === "__new__" ? newInp.value.trim()
                 : sel.value === "__root__" ? "" : sel.value;
    if (sel.value === "__new__" && !target) { err.textContent = "请填新目录名"; return; }
    try {
      await postJSON(ASSET_API, { action: "move", keys: [r.f], target: target });
      close();
      await reloadAfterChange();
      toast("已移动到：" + (target || "(输出根目录)"));
    } catch (e) {
      err.textContent = e.message;
    }
  };
  panel.append(head, bodyEl);
  root.appendChild(panel);
  document.body.appendChild(root);
}

async function askTrash(r) {
  const n = r.rc ? r.rc + " 张参考图" : "";
  const ok = confirm(
    "删除「" + r.f + "」？\n\n" +
    "· 同一次生成的图 / 视频 / 音轨会一起删\n" +
    "· 文件只是移进回收站，不会真的删掉，随时能恢复\n" +
    (r.n ? "· 这条的 " + r.n + " 字提示词会从列表里消失（恢复后回来）\n" : "") +
    (n ? "· 用到的 " + n + " 名单也会一起离开列表\n" : "") +
    "\n确定删除吗？");
  if (!ok) return;
  try {
    await postJSON(ASSET_API, { action: "trash", keys: [r.f] });
    await reloadAfterChange();
    refreshTrashSoon();
    toast("已移进回收站：" + r.f + "　（顶部「回收站」可恢复）");
  } catch (e) {
    alert("删除失败：" + e.message);
  }
}

let MG = null;

function openManager() {
  injectCSS();
  if (!MG) {
    const root = document.createElement("div");
    root.className = "pam";
    const panel = document.createElement("div");
    panel.className = "pam-panel";
    const head = document.createElement("div");
    head.className = "pam-head";
    head.innerHTML = "<b>归类管理</b>";
    const x = document.createElement("button");
    x.className = "pa-btn"; x.textContent = "关闭";
    head.appendChild(x);
    const bodyEl = document.createElement("div");
    bodyEl.className = "pam-body";
    panel.append(head, bodyEl);
    root.appendChild(panel);
    root.onclick = e => { if (e.target === root) root.style.display = "none"; };
    x.onclick = () => { root.style.display = "none"; };
    document.body.appendChild(root);
    MG = { root, body: bodyEl };
  }
  MG.root.style.display = "flex";
  drawManager();
}

function drawManager() {
  if (!MG) return;
  const b = MG.body;
  b.innerHTML = "";

  const cnt = {};
  S.rows.forEach(r => { const k = r.e || ""; cnt[k] = (cnt[k] || 0) + 1; });

  /* ---- 项目 ---- */
  const s1 = document.createElement("div");
  s1.className = "pam-sec";
  s1.innerHTML = "<h4>项目</h4>";

  const addRow = document.createElement("div");
  addRow.className = "pam-row";
  const inp = document.createElement("input");
  inp.className = "pa-in";
  inp.placeholder = "新项目名，例如：第五集 / 客户A / 测试";
  const addBtn = document.createElement("button");
  addBtn.className = "pa-btn pri";
  addBtn.textContent = "新建";
  const doAdd = async () => {
    const name = inp.value.trim();
    if (!name) return;
    try {
      await postJSON(PROJ_API, { action: "add", name });
      inp.value = "";
      await reloadAfterChange("refresh");
    } catch (e) { alert(e && e.message ? e.message : e); }
  };
  addBtn.onclick = doAdd;
  inp.onkeydown = e => { if (e.key === "Enter") doAdd(); };
  addRow.append(inp, addBtn);
  s1.appendChild(addRow);

  const ps = projects();
  if (!ps.length) {
    const d = document.createElement("div");
    d.className = "pam-hint";
    d.textContent = "还没有项目。新建一个之后，可以用下面的「目录规则」把整个目录自动归到它名下。";
    s1.appendChild(d);
  }
  ps.forEach(p => {
    const r = document.createElement("div");
    r.className = "pam-row";
    const dot = document.createElement("span");
    dot.className = "pam-dot";
    dot.style.background = p.color;
    dot.title = "点击改颜色";
    dot.style.cursor = "pointer";
    dot.onclick = () => {
      const c = document.createElement("input");
      c.type = "color"; c.value = p.color;
      c.style.cssText = "position:fixed;left:-100px";
      document.body.appendChild(c);
      c.oninput = async () => {
        try { await postJSON(PROJ_API, { action: "color", name: p.name, color: c.value }); }
        catch (e) { /* 颜色写失败不打断 */ }
      };
      c.onchange = () => { c.remove(); reloadAfterChange("refresh"); };
      c.click();
    };
    const g = document.createElement("span");
    g.className = "g";
    g.textContent = p.name;
    const c = document.createElement("span");
    c.className = "pam-cnt";
    c.textContent = (cnt[p.name] || 0) + " 条";
    const rn = document.createElement("button");
    rn.className = "pa-btn"; rn.textContent = "改名";
    rn.onclick = async () => {
      const nv = prompt("把「" + p.name + "」改成：", p.name);
      if (nv == null || !nv.trim() || nv.trim() === p.name) return;
      try {
        await postJSON(PROJ_API, { action: "rename", old: p.name, new: nv.trim() });
        [...S.fProj].forEach(k => { if (k === p.name) { S.fProj.delete(k); S.fProj.add(nv.trim()); } });
        await reloadAfterChange("refresh");
      } catch (e) { alert(e && e.message ? e.message : e); }
    };
    const del = document.createElement("button");
    del.className = "pa-btn"; del.textContent = "删除";
    del.title = "删除项目；它的目录规则和手动归类也会一并移除，但不影响你的输出文件";
    del.onclick = async () => {
      if (!confirm("删除项目「" + p.name + "」？\n\n它的目录规则与手动归类会一并移除，输出文件不受影响。")) return;
      try {
        await postJSON(PROJ_API, { action: "del", name: p.name });
        await reloadAfterChange("refresh");
      } catch (e) { alert(e && e.message ? e.message : e); }
    };
    r.append(dot, g, c, rn, del);
    s1.appendChild(r);
  });
  b.appendChild(s1);

  /* ---- 目录（改名） ---- */
  const sD = document.createElement("div");
  sD.className = "pam-sec";
  sD.innerHTML = "<h4>目录（改名）</h4>";
  const dd = document.createElement("div");
  dd.className = "pam-hint";
  dd.textContent = "改的是输出目录里真实的文件夹名。改完目录规则会自动跟着更新，归类不会丢。";
  sD.appendChild(dd);
  const allDirs = Object.keys(S.dirs || {}).filter(d => d).sort();
  if (!allDirs.length) {
    const e = document.createElement("div");
    e.className = "pam-hint";
    e.textContent = "输出目录现在是平的，还没有子目录。";
    sD.appendChild(e);
  }
  allDirs.forEach(d => {
    const row = document.createElement("div");
    row.className = "pam-row pam-dir";
    const g = document.createElement("span");
    g.className = "g";
    g.textContent = d;
    const cnt = document.createElement("span");
    cnt.className = "pam-cnt";
    cnt.textContent = (S.dirs[d] || 0) + " 条";
    const rn = document.createElement("button");
    rn.className = "pa-btn";
    rn.textContent = "改名";
    rn.title = "改这个目录的名字（只能改最后一级，整棵子树一起搬）";
    rn.onclick = async () => {
      const last = d.split("/").pop();
      const name = await askInput({
        title: "改目录名",
        value: last,
        hint: "正在改：" + d + "。只能改最后一级，名字里不能出现 \\ / : * ? \" < > |",
        okText: "改名",
      });
      if (!name || name === last) return;
      try {
        await postJSON(DIR_API, { action: "rename", dir: d, name: name });
        await reloadAfterChange("refresh");
      } catch (e) {
        alert("目录改名失败：" + e.message);
      }
    };
    row.append(g, cnt, rn);
    sD.appendChild(row);
  });
  b.appendChild(sD);

  /* ---- 目录规则 ---- */
  const s2 = document.createElement("div");
  s2.className = "pam-sec";
  s2.innerHTML = "<h4>目录规则（自动归类）</h4>";

  const rs = rules();
  if (!rs.length) {
    const d = document.createElement("div");
    d.className = "pam-hint";
    d.textContent = "还没有规则。加一条规则后，该目录（含子目录）里所有作品会自动归到指定项目，今后新生成的作品也会自动进来。";
    s2.appendChild(d);
  }
  rs.forEach(r => {
    const row = document.createElement("div");
    row.className = "pam-row";
    const dot = document.createElement("span");
    dot.className = "pam-dot";
    dot.style.background = projColor(r.project);
    const g = document.createElement("span");
    g.className = "g";
    g.innerHTML = esc(r.dir || "(输出根目录)") + " → <b>" + esc(r.project) + "</b>" +
      (r.deep ? "" : ' <span class="pam-cnt">仅本层</span>');
    const del = document.createElement("button");
    del.className = "pa-btn"; del.textContent = "删除";
    del.onclick = async () => {
      try {
        await postJSON(PROJ_API, { action: "rule_del", dir: r.dir, project: r.project });
        await reloadAfterChange("refresh");
      } catch (e) { alert(e && e.message ? e.message : e); }
    };
    row.append(dot, g, del);
    s2.appendChild(row);
  });

  if (projects().length) {
    const nw = document.createElement("div");
    nw.className = "pam-row";
    nw.style.flexWrap = "wrap";

    const dirSel = document.createElement("select");
    dirSel.className = "pa-sel";
    dirSel.style.cssText = "flex:1 1 130px;min-width:110px";
    // 根目录不进下拉：把整个输出目录归成一个项目没有区分意义
    const dirs = Object.keys(S.dirs || {}).filter(d => d).sort();
    dirSel.innerHTML = '<option value="">选择目录…</option>' +
      dirs.map(d => '<option value="' + esc(d) + '">' + esc(d) +
        "（" + S.dirs[d] + "）</option>").join("");

    const projSel = document.createElement("select");
    projSel.className = "pa-sel";
    projSel.style.cssText = "flex:1 1 100px;min-width:90px";
    projSel.innerHTML = '<option value="">归到…</option>' +
      projects().map(p => '<option value="' + esc(p.name) + '">' + esc(p.name) + "</option>").join("");

    const deep = document.createElement("label");
    deep.style.cssText = "font-size:11px;display:flex;gap:4px;align-items:center;opacity:.8";
    const deepCb = document.createElement("input");
    deepCb.type = "checkbox"; deepCb.checked = true;
    deep.append(deepCb, document.createTextNode("含子目录"));

    const addR = document.createElement("button");
    addR.className = "pa-btn pri"; addR.textContent = "添加规则";
    addR.onclick = async () => {
      if (!dirSel.value) { alert("先选目录"); return; }
      if (!projSel.value) { alert("先选项目"); return; }
      try {
        await postJSON(PROJ_API, {
          action: "rule_add",
          dir: dirSel.value,
          project: projSel.value,
          deep: deepCb.checked,
        });
        await reloadAfterChange("refresh");
      } catch (e) { alert(e && e.message ? e.message : e); }
    };
    nw.append(dirSel, projSel, deep, addR);
    s2.appendChild(nw);

    const hint = document.createElement("div");
    hint.className = "pam-hint";
    hint.textContent = "目录更长者优先。例如同时有「A」和「A/B」两条规则时，B 里的作品归后者。";
    s2.appendChild(hint);
  }
  b.appendChild(s2);

  /* ---- 手动归类 ---- */
  const s3 = document.createElement("div");
  s3.className = "pam-sec";
  s3.innerHTML = "<h4>单个作品的手动归类</h4>";
  const d3 = document.createElement("div");
  d3.className = "pam-hint";
  d3.textContent = "在列表里勾选作品后，顶部会出现「归类到…」批量栏；也可以展开单条，点「归类到…」。手动的优先级高于目录规则。";
  s3.appendChild(d3);
  b.appendChild(s3);

  const sp = document.createElement("div");
  sp.className = "pam-hint";
  sp.style.cssText += ";border-top:1px solid rgba(125,125,125,.2);padding-top:8px";
  sp.textContent = "归类数据存在 ComfyUI 的 user 目录，重装或升级本插件都不会丢。";
  b.appendChild(sp);
}

/* -------------------------------------------------------------- 预览窗 */
let PV = null;

function ensurePreview() {
  if (PV) return PV;
  injectCSS();
  const wrap = document.createElement("div");
  wrap.className = "papv";
  wrap.style.display = "none";
  wrap.innerHTML =
    '<div class="papv-head">' +
      '<span class="papv-title"></span>' +
      '<span class="papv-tools">' +
        '<select class="pa-sel papv-src" style="display:none"></select>' +
        '<button class="pa-btn papv-zout" title="缩小（也可在画面上滚轮）">−</button>' +
        '<span class="pa-btn papv-zoom">100%</span>' +
        '<button class="pa-btn papv-zin" title="放大（也可在画面上滚轮）">＋</button>' +
        '<button class="pa-btn papv-fit" title="适应窗口">适应</button>' +
        '<button class="pa-btn papv-full" title="全屏 / 还原">⛶</button>' +
        '<button class="pa-btn papv-close" title="关闭">✕</button>' +
      "</span>" +
    "</div>" +
    '<div class="papv-body"></div>' +
    '<div class="papv-resize" title="拖动调整窗口大小"></div>';
  document.body.appendChild(wrap);

  const head = wrap.querySelector(".papv-head");
  const bodyEl = wrap.querySelector(".papv-body");
  const rsz = wrap.querySelector(".papv-resize");
  const zl = wrap.querySelector(".papv-zoom");

  PV = { wrap, head, body: bodyEl, scale: 1, px: 0, py: 0,
         title: wrap.querySelector(".papv-title"),
         src: wrap.querySelector(".papv-src"), items: [], idx: 0 };

  // 平移 + 缩放必须一起用 translate：
  // 只写 scale 的话，CSS transform **不改变元素的布局尺寸**，外层那个
  // overflow:auto 永远不知道内容变大了 → 不产生滚动条 → 放大后画面被裁掉却拖不过去。
  // （v1.0.0 就是这个毛病，v1.1.0 改成 translate + 鼠标拖动。）
  const applyZoom = () => {
    const el = bodyEl.firstElementChild;
    if (!el) return;
    el.style.transform =
      "translate(" + PV.px + "px," + PV.py + "px) scale(" + PV.scale + ")";
    zl.textContent = Math.round(PV.scale * 100) + "%";
    // 放大后才提示可拖；适应窗口时是普通箭头。
    // 用 class 而不是 inline style —— CSS 里那条带 !important，才压得住 pysssss 灯箱的 zoom-in
    bodyEl.classList.toggle("can-pan", PV.scale > 1);
  };
  PV.applyZoom = applyZoom;

  const setScale = v => {
    PV.scale = Math.min(10, Math.max(0.08, v));
    if (PV.scale <= 1) { PV.px = 0; PV.py = 0; }   // 回到适应窗口就归位
    applyZoom();
  };
  PV.resetPan = () => { PV.px = 0; PV.py = 0; applyZoom(); };

  wrap.querySelector(".papv-zin").onclick = () => setScale(PV.scale * 1.25);
  wrap.querySelector(".papv-zout").onclick = () => setScale(PV.scale / 1.25);
  wrap.querySelector(".papv-fit").onclick = () => { setScale(1); };
  wrap.querySelector(".papv-close").onclick = () => closePreview();
  wrap.querySelector(".papv-full").onclick = () => {
    if (wrap.classList.contains("full")) {
      // 还原成进全屏前的窗口大小与位置
      wrap.classList.remove("full");
      const s = wrap.dataset.prev;
      if (s) {
        const p = JSON.parse(s);
        wrap.style.left = p.l; wrap.style.top = p.t;
        wrap.style.width = p.w; wrap.style.height = p.h;
        delete wrap.dataset.prev;
      }
    } else {
      wrap.dataset.prev = JSON.stringify({
        l: wrap.style.left, t: wrap.style.top,
        w: wrap.style.width, h: wrap.style.height,
      });
      wrap.classList.add("full");
    }
  };

  // 滚轮缩放
  bodyEl.addEventListener("wheel", e => {
    if (!bodyEl.firstElementChild) return;
    e.preventDefault();
    e.stopPropagation();
    setScale(PV.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
  }, { passive: false });

  // 放大后按住画面拖动平移（上下左右随便拉）
  // 用 PV.dragged 而不是局部变量 —— 更新媒体时绑在 img 上的「点图=全屏」也要读它。
  // 那一击发生在 target 阶段，比下面的冒泡拦截更早，只能在源头挡。
  PV.dragged = false;

  bodyEl.addEventListener("mousedown", e => {
    if (e.button !== 0 || PV.scale <= 1) return;   // 没放大就不平移，避免误触
    const el = bodyEl.firstElementChild;
    if (!el) return;
    if (el.tagName === "IMG") el.draggable = false;   // 禁掉原生图片拖拽
    // 视频的原生控件压在画面底部，那一条要让它们能点
    if (e.target.tagName === "VIDEO") {
      const r = e.target.getBoundingClientRect();
      if (e.clientY > r.bottom - 46) return;
    }
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = PV.px, oy = PV.py;
    bodyEl.classList.add("dragging");
    const move = ev => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      // 真的移动了才算「拖动」；手抖一两像素不算，免得吃掉正常的单击
      if (Math.abs(dx) + Math.abs(dy) > 3) PV.dragged = true;
      PV.px = ox + dx;
      PV.py = oy + dy;
      applyZoom();
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      bodyEl.classList.remove("dragging");
      // click 是 mouseup 之后同步派发的，必须延到下一个宏任务再复位，
      // 否则 img.onclick 读到的已经是 false，一松手又全屏。
      if (PV.dragged) setTimeout(() => { PV.dragged = false; }, 0);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  // 掐断冒泡：comfyui-custom-scripts（pysssss）的灯箱在 document 上监听图片点击，
  // 一冒上去就把画面换成它自己的全屏大图。
  // 注意这条只是补刀 —— 拦不住我们自己的 img.onclick，那个在 target 阶段就跑完了。
  ["click", "dblclick", "auxclick"].forEach(t => {
    bodyEl.addEventListener(t, e => {
      e.stopPropagation();
      if (PV.dragged) e.preventDefault();
    });
  });

  // 拖动移动
  head.addEventListener("mousedown", e => {
    if (e.target.closest("button,select")) return;
    if (wrap.classList.contains("full")) return;
    e.preventDefault();
    const r = wrap.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = ev => {
      wrap.style.left = Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - dx)) + "px";
      wrap.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy)) + "px";
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  // 拖拽改大小
  rsz.addEventListener("mousedown", e => {
    e.preventDefault(); e.stopPropagation();
    const r = wrap.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY, sw = r.width, sh = r.height;
    const move = ev => {
      wrap.style.width = Math.max(260, sw + ev.clientX - sx) + "px";
      wrap.style.height = Math.max(190, sh + ev.clientY - sy) + "px";
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  return PV;
}

function closePreview() {
  if (!PV) return;
  PV.body.innerHTML = "";
  PV.wrap.style.display = "none";
  PV.wrap.classList.remove("full");
}

/* ------------------------------------------------- 回收站（v1.1.0）

删除是软删除：文件被移进 user 目录下的回收站，这里负责看清单 / 恢复 / 彻底删。
*/

let TG = null;

function openTrash() {
  injectCSS();
  if (!TG) {
    const root = document.createElement("div");
    root.className = "pam";
    const panel = document.createElement("div");
    panel.className = "pam-panel";
    const head = document.createElement("div");
    head.className = "pam-head";
    head.innerHTML = "<b>回收站</b> <span class='pat'></span>";
    const x = document.createElement("button");
    x.className = "pa-btn";
    x.textContent = "关闭";
    head.appendChild(x);
    const bodyEl = document.createElement("div");
    bodyEl.className = "pam-body";
    panel.append(head, bodyEl);
    root.appendChild(panel);
    root.onclick = e => { if (e.target === root) root.style.display = "none"; };
    x.onclick = () => { root.style.display = "none"; };
    document.body.appendChild(root);
    TG = { root, body: bodyEl, sum: head.querySelector(".pat") };
  }
  TG.root.style.display = "flex";
  drawTrash();
}

async function drawTrash() {
  if (!TG) return;
  const b = TG.body;
  b.innerHTML = '<div class="pam-hint">读取中…</div>';

  const act = async body => {
    try {
      await postJSON(TRASH_API, body);
      await drawTrash();
      await load("refresh");
    } catch (e) {
      alert("操作失败：" + e.message);
    }
  };

  let d = null;
  try {
    const r = await fetch(TRASH_API, { cache: "no-store" });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "读取失败");
    d = j.data;
  } catch (e) {
    b.innerHTML = '<div class="pam-hint">读取出错：' + esc(e.message) + "</div>";
    return;
  }
  const items = (d && d.items) || [];
  TG.sum.textContent = items.length
    ? "共 " + items.length + " 条 · " + d.mb + " MB —— 文件已移出输出目录，随时可恢复"
    : "空的。这里会存放你删掉的资产，不占输出目录";

  b.innerHTML = "";
  const bar = document.createElement("div");
  bar.className = "pat-bar";
  const refresh = document.createElement("button");
  refresh.className = "pa-btn";
  refresh.textContent = "刷新";
  refresh.onclick = drawTrash;
  const empty = document.createElement("button");
  empty.className = "pa-btn danger";
  empty.textContent = "清空回收站";
  empty.disabled = !items.length;
  empty.onclick = () => {
    if (!confirm("彻底删除回收站里的全部资产？\n\n" +
                 "这一步不可恢复 —— 文件会真的从磁盘上消失。")) return;
    act({ action: "empty" });
  };
  const openDir = document.createElement("button");
  openDir.className = "pa-btn";
  openDir.textContent = "打开文件夹";
  openDir.title = "在文件管理器里打开回收站目录 —— 亲眼确认文件还在";
  openDir.onclick = async () => {
    try {
      const r = await postJSON(TRASH_API, { action: "open" });
      const res = r.result || {};
      if (!res.opened) alert("没能自动打开文件管理器。\n\n路径：\n" + (res.path || ""));
    } catch (e) {
      alert("打开失败：" + e.message);
    }
  };
  bar.append(openDir, refresh, empty);
  b.appendChild(bar);

  // 这句必须写死在这里：用户看到「回收站」三个字会去 Windows 系统回收站找，
  // 而删除走的是 shutil.move（移动，不是系统删除 API）—— 系统回收站里本来就不会有，
  // 于是很容易误以为文件被真删了。把真实路径摊开最省事。
  const note = document.createElement("div");
  note.className = "parc-note";
  note.innerHTML = "文件真实保存在 <code>" +
    esc(d.dir || "…\\ComfyUI\\user\\production_archive\\_trash") + "</code><br>" +
    "这是插件自己的目录，<b>不是 Windows 系统回收站</b> —— " +
    "删除是「移动」而不是系统删除，所以系统回收站里不会有；" +
    "点「打开文件夹」就能看到它们。";
  b.appendChild(note);

  if (!items.length) {
    const e = document.createElement("div");
    e.className = "pam-hint";
    e.textContent = "回收站是空的，说明你还没删过东西（或者已经清空了）。";
    b.appendChild(e);
    return;
  }

  items.forEach(it => {
    const row = document.createElement("div");
    row.className = "pam-row";
    const g = document.createElement("div");
    g.className = "g";
    g.innerHTML = "<b>" + esc(it.name) + "</b>" +
      '<div class="pam-cnt">' + esc(it.dir || "(输出根目录)") + " · " + esc(it.at) +
      " · " + it.n + " 个文件 · " + it.mb + " MB" +
      (it.plen ? " · 提示词 " + it.plen + " 字" : "") + "</div>";
    const r1 = document.createElement("button");
    r1.className = "pa-btn";
    r1.textContent = "恢复";
    r1.title = "放回原来的目录；万一重名会自动加后缀，绝不覆盖";
    r1.onclick = () => act({ action: "restore", ids: [it.id] });
    const r2 = document.createElement("button");
    r2.className = "pa-btn danger";
    r2.textContent = "彻底删除";
    r2.title = "直接删掉，不可恢复";
    r2.onclick = () => {
      if (!confirm("彻底删除「" + it.name + "」？这一步不可恢复。")) return;
      act({ action: "purge", ids: [it.id] });
    };
    row.append(g, r1, r2);
    b.appendChild(row);
  });
}

function openPreview(r, startIdx) {
  const pv = ensurePreview();
  const ks = kindsOf(r);
  const items = [];
  if (ks.has("mp4")) {
    items.push({
      label: r.a ? "视频（带音轨）" : "视频",
      url: fileUrl(r.f + (r.a ? "-audio.mp4" : ".mp4")),
      type: "video",
    });
  }
  if (ks.has("png")) {
    items.push({ label: "图片", url: fileUrl(r.f + ".png"), type: "image" });
  }
  if (!items.length) { alert("这条记录没有可预览的图片或视频"); return; }

  pv.items = items;
  pv.idx = startIdx || 0;
  pv.title.textContent = r.f;
  pv.title.title = r.f;

  if (items.length > 1) {
    pv.src.style.display = "";
    pv.src.innerHTML = items.map((it, i) =>
      '<option value="' + i + '">' + esc(it.label) + "</option>").join("");
    pv.src.value = String(pv.idx);
    pv.src.onchange = () => { pv.idx = Number(pv.src.value); renderPreview(); };
  } else {
    pv.src.style.display = "none";
  }

  // 只在首次打开时给默认尺寸与位置；之后保留你自己拖动/缩放的结果
  if (!pv.sized) {
    pv.sized = true;
    const w = Math.min(640, Math.round(window.innerWidth * 0.62));
    const h = Math.min(460, Math.round(window.innerHeight * 0.6));
    pv.wrap.style.width = w + "px";
    pv.wrap.style.height = h + "px";
    pv.wrap.style.left = Math.max(12, Math.round((window.innerWidth - w) / 2)) + "px";
    pv.wrap.style.top = Math.max(12, Math.round((window.innerHeight - h) / 3)) + "px";
  }
  pv.wrap.style.display = "flex";
  renderPreview();
}

function renderPreview() {
  const pv = PV;
  if (!pv) return;
  const it = pv.items[pv.idx];
  if (!it) return;
  pv.body.innerHTML = "";

  if (it.type === "video") {
    const v = document.createElement("video");
    v.src = it.url;
    v.controls = true;
    v.autoplay = true;
    v.loop = true;
    v.preload = "metadata";
    v.onerror = () => {
      pv.body.innerHTML = '<div style="padding:20px;color:#e08a8a;font-size:12px;text-align:center">' +
        "读取失败。该文件可能已被移动或删除。</div>";
    };
    pv.body.appendChild(v);
  } else {
    const img = document.createElement("img");
    img.src = it.url;
    img.alt = pv.title.textContent;
    img.onerror = () => {
      pv.body.innerHTML = '<div style="padding:20px;color:#e08a8a;font-size:12px;text-align:center">' +
        "读取失败。该文件可能已被移动或删除。</div>";
    };
    // 点一下图片 = 全屏。但「拖动收尾」的那一下不能算点击：
    // onclick 绑在 img 自己身上（target 阶段），比 bodyEl 上的冒泡拦截更早执行，
    // 所以必须在源头用 PV.dragged 挡掉 —— 否则拖一次全屏、再拖一次还原，来回跳。
    img.style.cursor = "zoom-in";
    img.onclick = () => {
      if (PV.dragged) return;
      pv.wrap.classList.toggle("full");
    };
    pv.body.appendChild(img);
  }
  pv.scale = 1;
  pv.applyZoom();
}

/* ------------------------------------------------------------------ 杂项 */
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

function mountTab(el) {
  injectCSS();
  S.mounts = S.mounts.filter(m => m.el && m.el.isConnected);
  const mount = { el };
  S.mounts.push(mount);
  paint(mount);
  if (!S.rows.length && !S.loading) load(null);
  return mount;
}

/* ------------------------------------------------- 注册侧边栏 / 兜底浮层 */
function registerSidebar() {
  const ext = app.extensionManager;
  if (!ext || typeof ext.registerSidebarTab !== "function") return false;
  ext.registerSidebarTab({
    id: "production-archive",
    icon: "pi pi-book",
    title: "制作档案",
    tooltip: "查看 / 搜索 / 预览 / 归类历史生成用过的提示词（读取输出文件内嵌元数据）",
    type: "custom",
    render: (el) => { mountTab(el); },
  });
  return true;
}

function fallbackOverlay() {
  injectCSS();
  const btn = document.createElement("button");
  btn.textContent = "📚 制作档案";
  btn.style.cssText =
    "position:fixed;right:14px;bottom:14px;z-index:9998;padding:8px 14px;border-radius:7px;" +
    "background:#2f4f7f;color:#fff;border:1px solid #4a7dc4;cursor:pointer;font-size:12px;" +
    "box-shadow:0 3px 12px rgba(0,0,0,.4)";
  const ov = document.createElement("div");
  ov.style.cssText =
    "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);display:none;" +
    "align-items:center;justify-content:center";
  const panel = document.createElement("div");
  panel.style.cssText =
    "width:min(880px,92vw);height:min(84vh,900px);background:var(--comfy-menu-bg,#1e1e1e);" +
    "border:1px solid var(--border-color,#444);border-radius:10px;overflow:hidden;display:flex;" +
    "flex-direction:column;box-shadow:0 12px 48px rgba(0,0,0,.6)";
  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;justify-content:space-between;" +
    "padding:9px 12px;border-bottom:1px solid var(--border-color,#3a3a3a);font-size:13px";
  head.innerHTML = "<b>制作档案</b>";
  const x = document.createElement("button");
  x.className = "pa-btn";
  x.textContent = "关闭";
  x.onclick = () => { ov.style.display = "none"; };
  head.appendChild(x);
  const box = document.createElement("div");
  box.style.cssText = "flex:1 1 auto;min-height:0;display:flex";
  panel.append(head, box);
  ov.appendChild(panel);
  ov.onclick = e => { if (e.target === ov) ov.style.display = "none"; };
  btn.onclick = () => {
    ov.style.display = "flex";
    if (!box.dataset.mounted) {
      const m = document.createElement("div");
      m.style.cssText = "flex:1 1 auto;min-width:0;display:flex";
      box.appendChild(m);
      mountTab(m);
      box.dataset.mounted = "1";
    }
  };
  document.body.append(btn, ov);
}

app.registerExtension({
  name: "production-archive",
  async setup() {
    if (!registerSidebar()) {
      console.warn("[production-archive] 当前前端不支持 registerSidebarTab，改用浮动按钮。");
      fallbackOverlay();
    }
    // 每次出片后自动增量索引（走 refresh，1 秒内完成）
    const onDone = () => {
      setTimeout(() => { if (!S.loading) load("refresh"); }, 2500);
    };
    try {
      api.addEventListener("execution_success", onDone);
      api.addEventListener("executed", onDone);
    } catch (e) { /* 事件 API 不可用则跳过 */ }
  },
});
