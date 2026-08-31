// ani-rs 前端：搜索 → 条目 → 剧集 → 选源 → BT 下载
// 类型契约来自后端 tauri command（字段只加不改名）。

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const state = {
  subjects: [],
  subject: null,
  episodes: [],
  candidates: [],
};

// ---------- 通用 ----------

function setStatus(text) {
  $("status").textContent = text || "";
}

let toastTimer = null;
function toast(msg, ok = false) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("ok", ok);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

function fmtSize(bytes) {
  if (!bytes) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtSpeed(bps) {
  return bps > 0 ? fmtSize(bps) + "/s" : "—";
}

// showView 在文件尾部（设置界面一节）定义，覆盖三个视图

// ---------- 首页：新番时间表 + 最近搜索 ----------

const homeState = { calendar: [], today: 0, loaded: false };

// JS getDay(): 0=周日…6=周六；Bangumi weekday id: 1=周一…7=周日
function todayWeekdayId() {
  const d = new Date().getDay();
  return d === 0 ? 7 : d;
}

async function loadHome(force = false) {
  // 最近搜索总是刷新（搜索会随时产生新记录）
  refreshHistory();
  if (homeState.loaded && !force) return;
  // 时间表
  $("calendar-grid").innerHTML = `<div class="empty">加载时间表中…</div>`;
  try {
    const cal = await invoke("get_calendar");
    homeState.calendar = cal;
    homeState.today = todayWeekdayId();
    homeState.loaded = true;
    renderCalendar();
  } catch (e) {
    $("calendar-grid").innerHTML = `<div class="empty">时间表加载失败：${escapeHtml(String(e))}</div>`;
  }
}

async function refreshHistory() {
  try {
    const hist = await invoke("list_search_history");
    const wrap = $("history-chips");
    wrap.innerHTML = "";
    $("clear-history").classList.toggle("hidden", hist.length === 0);
    if (!hist.length) {
      wrap.innerHTML = `<span class="meta">还没有搜索记录</span>`;
      return;
    }
    for (const kw of hist) {
      const chip = document.createElement("span");
      chip.className = "hist-chip";
      chip.textContent = kw;
      chip.onclick = () => {
        $("search-input").value = kw;
        doSearch();
      };
      wrap.appendChild(chip);
    }
  } catch (e) {
    /* 历史加载失败不阻塞首页 */
  }
}

function renderCalendar() {
  const tabs = $("weekday-tabs");
  const grid = $("calendar-grid");
  tabs.innerHTML = "";
  const days = [...homeState.calendar].sort((a, b) => a.weekday.id - b.weekday.id);
  let selected = homeState.selected ?? homeState.today;
  for (const day of days) {
    const tab = document.createElement("div");
    tab.className = "wd-tab" + (day.weekday.id === selected ? " active" : "");
    tab.innerHTML = `${escapeHtml(day.weekday.cn)}<span class="cnt">${day.items.length}</span>${day.weekday.id === homeState.today ? " ·今天" : ""}`;
    tab.onclick = () => {
      homeState.selected = day.weekday.id;
      renderCalendar();
    };
    tabs.appendChild(tab);
  }
  const current = days.find((d) => d.weekday.id === selected) ?? days[0];
  grid.innerHTML = "";
  if (!current || !current.items.length) {
    grid.innerHTML = `<div class="empty">这一天没有放送条目</div>`;
    return;
  }
  for (const s of current.items) {
    grid.appendChild(subjectCard(s));
  }
}

function subjectCard(s) {
  const card = document.createElement("div");
  card.className = "card";
  const img = s.cover_url
    ? `<img src="${escapeAttr(s.cover_url)}" loading="lazy" referrerpolicy="no-referrer" />`
    : `<img src="" style="visibility:hidden" />`;
  card.innerHTML = `
    ${img}
    <div class="card-body">
      <div class="t">${escapeHtml(s.display_title)}</div>
      <div class="m">${escapeHtml(s.air_date ?? "")}</div>
    </div>`;
  card.onclick = () => openSubject(s);
  return card;
}

function showHomeSection() {
  $("home-section").classList.remove("hidden");
  $("search-section").classList.add("hidden");
  state.subView = "home";
  loadHome(); // 回首页时刷新最近搜索
}

function showSearchSection() {
  $("home-section").classList.add("hidden");
  $("search-section").classList.remove("hidden");
  state.subView = "results";
}

// ---------- 第一步：搜索条目 ----------

// 请求令牌：慢返回的旧请求不得覆盖新数据
let searchSeq = 0, subjectSeq = 0, fetchSeq = 0;
// 候选列表过滤（字幕组/分辨率），配合选源页的筛选下拉
const candFilter = { group: "", res: "" };
let lastSelection = null;

function fillSelect(sel, values, current, label) {
  sel.innerHTML =
    `<option value="">${label}</option>` +
    [...values]
      .map(
        (v) =>
          `<option value="${escapeAttr(v)}"${String(v) === String(current) ? " selected" : ""}>${escapeHtml(v)}</option>`,
      )
      .join("");
}

function updateCandFilter(sel) {
  const groups = new Set(), ress = new Set();
  for (const c of sel.candidates) {
    if (c.media.properties.subtitle_group) groups.add(c.media.properties.subtitle_group);
    if (c.media.properties.resolution) ress.add(c.media.properties.resolution.height);
  }
  fillSelect($("cand-filter-group"), [...groups].sort(), candFilter.group, "全部字幕组");
  fillSelect($("cand-filter-res"), [...ress].sort((a, b) => b - a), candFilter.res, "全部分辨率");
}

$("cand-filter-group").onchange = (e) => {
  candFilter.group = e.target.value;
  if (lastSelection) renderSelection(lastSelection);
};
$("cand-filter-res").onchange = (e) => {
  candFilter.res = e.target.value;
  if (lastSelection) renderSelection(lastSelection);
};

async function doSearch() {
  const q = $("search-input").value.trim();
  if (!q) return;
  const my = ++searchSeq;
  setStatus("搜索中…");
  $("search-btn").disabled = true;
  try {
    const subjects = await invoke("search_subjects", { q });
    if (my !== searchSeq) return; // 已有更新的搜索发出
    state.subjects = subjects;
    showView("subjects"); // 从详情/设置/播放器页发起搜索时切回条目视图
    showSearchSection();
    renderSubjects(subjects, q);
  } catch (e) {
    if (my === searchSeq) toast("搜索失败：" + e);
  } finally {
    if (my === searchSeq) {
      $("search-btn").disabled = false;
      setStatus("");
    }
  }
}

function renderSubjects(subjects, q) {
  $("subjects-title").textContent = subjects.length ? `“${q}” 的搜索结果（${subjects.length}）` : "没有结果，换个关键词试试";
  const wrap = $("subjects");
  wrap.innerHTML = "";
  if (!subjects.length) {
    wrap.innerHTML = `<div class="empty">换个关键词，或返回首页从时间表挑一部</div>`;
    return;
  }
  for (const s of subjects) {
    wrap.appendChild(subjectCard(s));
  }
}

// ---------- 第二步：条目详情 + 剧集 ----------

async function openSubject(s) {
  const my = ++subjectSeq;
  state.subject = s;
  $("subject-name").textContent = s.display_title;
  $("subject-meta").textContent = [s.original_title, s.air_date].filter(Boolean).join(" · ");
  $("candidates").innerHTML = `<div class="empty">从下方剧集列表选择一集开始找资源</div>`;
  $("cand-count").textContent = "";
  $("source-errors").classList.add("hidden");
  $("episodes").innerHTML = `<div class="empty">加载中…</div>`;
  showView("detail");
  try {
    const eps = await invoke("episode_list", { subjectId: s.id.id ?? s.id });
    if (my !== subjectSeq) return; // 用户已切换到其它条目
    state.episodes = eps;
    renderEpisodes(eps);
  } catch (e) {
    if (my !== subjectSeq) return;
    $("episodes").innerHTML = "";
    toast("加载剧集失败：" + e);
  }
}

function renderEpisodes(eps) {
  const wrap = $("episodes");
  wrap.innerHTML = "";
  const mains = eps.filter((e) => e.kind === "main");
  const list = mains.length ? mains : eps;
  if (!list.length) {
    wrap.innerHTML = `<div class="empty">该条目没有剧集数据（可能是漫画/画集等非动画条目，换动画条目即可找资源）</div>`;
    $("candidates").innerHTML = "";
    return;
  }
  for (const e of list) {
    const chip = document.createElement("div");
    chip.className = "ep";
    chip.innerHTML = `<span class="epno">${e.ep}</span>${escapeHtml(e.display_title)}`;
    chip.title = e.display_title;
    chip.onclick = () => {
      document.querySelectorAll(".ep.active").forEach((n) => n.classList.remove("active"));
      chip.classList.add("active");
      fetchMedias(e.ep);
    };
    wrap.appendChild(chip);
  }
}

// ---------- 第三步：多源聚合 + 自动选源 ----------

async function fetchMedias(ep) {
  const my = ++fetchSeq;
  state.currentEp = ep;
  const subjectId = state.subject.id.id ?? state.subject.id;
  setStatus("正在检索数据源（dmhy / mikan）…");
  $("candidates").innerHTML = `<div class="empty">检索中，多源并发请求需要几秒…</div>`;
  try {
    const sel = await invoke("fetch_medias", { subjectId, ep });
    if (my !== fetchSeq) return; // 用户已切换到其它集，旧结果作废
    state.candidates = sel.candidates;
    renderSelection(sel);
  } catch (e) {
    if (my !== fetchSeq) return;
    $("candidates").innerHTML = "";
    toast("选源失败：" + e);
  } finally {
    if (my === fetchSeq) setStatus("");
  }
}

function renderSelection(sel) {
  lastSelection = sel;
  updateCandFilter(sel);
  const errs = $("source-errors");
  if (sel.source_errors.length) {
    errs.textContent = "部分数据源失败：" + sel.source_errors.join("；");
    errs.classList.remove("hidden");
  } else {
    errs.classList.add("hidden");
  }

  const avail = sel.candidates.filter((c) => c.type === "available");
  const excluded = sel.candidates.filter((c) => c.type === "excluded");
  const filtered = sel.candidates.filter(
    (c) =>
      (!candFilter.group || c.media.properties.subtitle_group === candFilter.group) &&
      (!candFilter.res ||
        (c.media.properties.resolution &&
          String(c.media.properties.resolution.height) === candFilter.res)),
  );
  const filterNote = candFilter.group || candFilter.res ? `（筛选后 ${filtered.length} 条）` : "";
  const clipped = filtered.length > 40 ? `（显示前 40 条）` : "";
  $("cand-count").textContent = `${avail.length} 可用 · ${excluded.length} 已排除${filterNote}${clipped}`;

  const wrap = $("candidates");
  wrap.innerHTML = "";
  if (!sel.candidates.length) {
    wrap.innerHTML = `<div class="empty">没有候选结果（网络或站点问题，稍后重试）</div>`;
    return;
  }
  if (!filtered.length) {
    wrap.innerHTML = `<div class="empty">没有符合筛选条件的候选，调整上方字幕组/分辨率筛选</div>`;
    return;
  }

  filtered.slice(0, 40).forEach((c, i) => {
    const m = c.media;
    const p = m.properties;
    const tags = [
      `<span class="tag src">${escapeHtml(m.media_source_id)}</span>`,
      p.resolution ? `<span class="tag res">${p.resolution.height}p</span>` : "",
      p.subtitle_group ? `<span class="tag">${escapeHtml(p.subtitle_group)}</span>` : "",
      fmtSize(p.size_bytes) ? `<span class="tag">${fmtSize(p.size_bytes)}</span>` : "",
      c.type === "available"
        ? `<span class="tag score">得分 ${c.score.toFixed(1)}</span>`
        : `<span class="tag bad">已排除：${reasonText(c.reason)}</span>`,
    ].join("");
    const magnet = m.download?.type === "torrent" ? m.download.uri : null;
    const httpUrl = m.download?.type === "http" ? m.download.url : null;
    const learnAttrs = ` data-group="${escapeAttr(p.subtitle_group ?? "")}" data-res="${p.resolution ? p.resolution.height : ""}"`;
    const cacheBtn = httpUrl
      ? `<button class="btn secondary" data-cachebtn="${escapeAttr(httpUrl)}" data-title="${escapeAttr(m.title)}">⤓ 缓存</button>`
      : "";
    const actions = magnet || httpUrl
      ? `<div class="actions">
           ${httpUrl
             ? `<button class="btn" data-play="${escapeAttr(httpUrl)}" data-title="${escapeAttr(m.title)}"${learnAttrs}>▶ 在线播放</button>`
             : `<button class="btn" data-stream="${escapeAttr(magnet)}" data-title="${escapeAttr(m.title)}"${learnAttrs}>▶ 在线播放</button>
                <button class="btn secondary" data-magnet="${escapeAttr(magnet)}" data-title="${escapeAttr(m.title)}"${learnAttrs}>下载</button>`}
           ${magnet ? `<button class="btn secondary" data-copy="${escapeAttr(magnet)}">复制磁力</button>` : ""}
           ${cacheBtn}
         </div>`
      : "";
    const el = document.createElement("div");
    el.className = "cand" + (c.type === "excluded" ? " excluded" : "");
    el.innerHTML = `
      <div class="rank">${i + 1}</div>
      <div class="info">
        <div class="title">${escapeHtml(m.title)}</div>
        <div class="tags">${tags}</div>
      </div>
      ${actions}`;
    wrap.appendChild(el);
  });

  wrap.querySelectorAll("[data-magnet]").forEach((b) => {
    b.onclick = () => { learnPreference(b.dataset); startTorrent(b.dataset.magnet, b.dataset.title); };
  });
  wrap.querySelectorAll("[data-stream]").forEach((b) => {
    b.onclick = () => { learnPreference(b.dataset); startStream(b.dataset.stream, b.dataset.title); };
  });
  wrap.querySelectorAll("[data-play]").forEach((b) => {
    b.onclick = () => { learnPreference(b.dataset); openPlayer(b.dataset.play, b.dataset.title); };
  });
  wrap.querySelectorAll("[data-copy]").forEach((b) => {
    b.onclick = async () => {
      await navigator.clipboard.writeText(b.dataset.copy);
      toast("磁力链接已复制", true);
    };
  });
  wrap.querySelectorAll("[data-cachebtn]").forEach((b) => {
    b.onclick = async () => {
      try {
        await invoke("cache_start", { url: b.dataset.cachebtn, title: b.dataset.title || "离线缓存" });
        toast("已开始缓存：" + (b.dataset.title || "视频"), true);
      } catch (e) {
        toast("缓存失败：" + e);
      }
    };
  });
}

const REASON_LABELS = {
  episode_mismatch: "剧集不匹配",
  blacklisted: "命中黑名单",
  resolution_too_low: "分辨率过低",
  previously_failed: "尝试过且失败",
};

function reasonText(r) {
  const key = typeof r === "string" ? r : Object.values(r || {})[0];
  return REASON_LABELS[key] || key || "不匹配";
}

// ---------- 第四步：BT 下载 ----------

let dlVisible = false;

function openDlPanel() {
  dlVisible = true;
  $("download-panel").classList.remove("hidden");
  invoke("list_downloads")
    .then((tasks) => {
      dlTasks.clear();
      tasks.forEach((t) => dlTasks.set(t.id, t));
      renderDownloads();
    })
    .catch(() => {});
}

const dlTasks = new Map();
const finishedToasted = new Set();
// 增量渲染：id → DOM 引用。800ms 一次的进度事件只改数值，不再全量重建（防滚动跳动/GC 抖动）
const dlNodes = new Map();

function buildDlNode(t) {
  const el = document.createElement("div");
  el.className = "dl-task";
  el.innerHTML = `
    <div class="dl-task-top">
      <div class="dl-task-title"></div>
      <span class="dl-status"></span>
    </div>
    <div class="bar"><div class="bar-fill" style="width:0%"></div></div>
    <div class="dl-task-mid meta">
      <span class="dl-pct">0.0%</span>
      <span class="dl-size"></span>
      <span class="dl-dl">↓ —</span>
      <span class="dl-ul">↑ —</span>
    </div>
    <div class="dl-task-actions"></div>`;
  const node = {
    el,
    title: el.querySelector(".dl-task-title"),
    status: el.querySelector(".dl-status"),
    bar: el.querySelector(".bar-fill"),
    pct: el.querySelector(".dl-pct"),
    size: el.querySelector(".dl-size"),
    dl: el.querySelector(".dl-dl"),
    ul: el.querySelector(".dl-ul"),
    actions: el.querySelector(".dl-task-actions"),
    stateKey: null,
  };
  node.title.textContent = t.title || t.id;
  updateDlNode(node, t);
  return node;
}

function updateDlNode(node, t) {
  const pct = t.total_bytes ? Math.min(100, (t.progress_bytes / t.total_bytes) * 100) : 0;
  node.bar.style.width = pct.toFixed(1) + "%";
  node.pct.textContent = pct.toFixed(1) + "%";
  node.size.textContent = `${fmtSize(t.progress_bytes) ?? "0"} / ${fmtSize(t.total_bytes) ?? "?"}`;
  node.dl.textContent = `↓ ${fmtSpeed(t.download_speed_bps)}`;
  node.ul.textContent = `↑ ${fmtSpeed(t.upload_speed_bps)}`;
  const key = `${!!t.finished}|${!!t.paused}`;
  if (key !== node.stateKey) {
    node.stateKey = key;
    node.status.innerHTML = t.finished
      ? `<span class="tag res">完成</span>`
      : t.paused
        ? `<span class="tag">已暂停</span>`
        : `<span class="tag src">下载中</span>`;
    rebuildDlActions(node, t);
  }
}

function rebuildDlActions(node, t) {
  node.actions.innerHTML = "";
  const mkBtn = (label, fn, secondary) => {
    const b = document.createElement("button");
    b.className = "btn small" + (secondary ? " secondary" : "");
    b.textContent = label;
    b.onclick = fn;
    node.actions.appendChild(b);
  };
  if (t.finished) {
    mkBtn("▶ 播放", async () => {
      try {
        const path = await invoke("download_video_path", { id: t.id });
        if (!path) return toast("未找到视频文件");
        const via = await invoke("spawn_player", { path });
        toast("已在" + via + "中播放", true);
      } catch (e) { toast("播放失败：" + e); }
    });
    mkBtn("打开目录", async () => {
      try {
        const path = await invoke("download_video_path", { id: t.id });
        if (!path) return toast("未找到视频文件");
        // 后端对文件路径用 explorer /select 定位到所在目录
        await invoke("reveal_path", { path });
      } catch (e) { toast("打开失败：" + e); }
    }, true);
  } else {
    mkBtn(t.paused ? "▶ 继续" : "⏸ 暂停", async () => {
      try {
        const cur = dlTasks.get(t.id) || t; // 进度事件会替换任务对象，取最新的
        await invoke("set_download_paused", { id: cur.id, paused: !cur.paused });
        cur.paused = !cur.paused;
        updateDlNode(node, cur);
      } catch (e) { toast("操作失败：" + e); }
    }, t.paused);
  }
  mkBtn("移除", async () => {
    try {
      await invoke("remove_download", { id: t.id });
      dlTasks.delete(t.id);
      renderDownloads();
      toast("已移除任务（文件保留）", true);
    } catch (e) { toast("移除失败：" + e); }
  }, true);
}

function renderDownloads() {
  const wrap = $("dl-list");
  const tasks = [...dlTasks.values()];
  $("dl-count").textContent = tasks.length ? `(${tasks.length})` : "";
  // 移除已消失任务的节点
  for (const [id, node] of [...dlNodes]) {
    if (!dlTasks.has(id)) {
      node.el.remove();
      dlNodes.delete(id);
    }
  }
  if (!tasks.length) {
    dlNodes.clear();
    wrap.innerHTML = `<div class="meta">暂无任务</div>`;
    return;
  }
  const placeholder = wrap.querySelector(".meta");
  if (placeholder) placeholder.remove();
  for (const t of tasks) {
    let node = dlNodes.get(t.id);
    if (!node) {
      node = buildDlNode(t);
      dlNodes.set(t.id, node);
      wrap.appendChild(node.el);
    } else {
      updateDlNode(node, t);
    }
    if (t.finished && !finishedToasted.has(t.id)) {
      finishedToasted.add(t.id);
      toast("下载完成：" + (t.title || t.id), true);
    }
  }
}

listen("downloads-progress", (ev) => {
  if (!dlVisible) return;
  for (const t of ev.payload) dlTasks.set(t.id, t);
  renderDownloads();
}).catch(() => {});

async function startTorrent(uri, title) {
  openDlPanel();
  try {
    await invoke("start_torrent", { uri, title: title || null });
    setStatus("BT 下载已开始");
  } catch (e) {
    toast("下载启动失败：" + e);
  }
}

listen("torrent-files", (ev) => {
  const files = ev.payload;
  const videos = files.filter((f) => /\.(mp4|mkv|avi|ts|flv|wmv|webm|mov|m2ts)$/i.test(f.name));
  const list = videos.length ? videos : files;
  if (dlVisible && list.length) {
    toast(`元数据就绪：${list.length} 个视频文件`, true);
  }
}).catch(() => {});

// ---------- 杂项 ----------

/** 偏好学习（M5）：用户手选某候选 → 把字幕组/分辨率记为偏好，参与后续自动选源 */
function learnPreference(ds) {
  invoke("learn_media_preference", {
    group: ds.group || null,
    resolution: ds.res ? { width: Math.round((ds.res * 16) / 9), height: +ds.res } : null,
  }).catch(() => {});
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, "&#96;");
}

$("search-btn").onclick = doSearch;
$("search-input").addEventListener("keydown", (e) => e.key === "Enter" && doSearch());
$("back-btn").onclick = () => {
  state.subject = null;
  showView("subjects");
  state.subView === "results" ? showSearchSection() : showHomeSection();
};
$("home-back").onclick = showHomeSection;
$("clear-history").onclick = async () => {
  try {
    await invoke("clear_search_history");
    refreshHistory();
    toast("搜索历史已清空", true);
  } catch (e) {
    toast("清空失败：" + e);
  }
};
$("dl-close").onclick = () => {
  dlVisible = false;
  $("download-panel").classList.add("hidden");
};

// ---------- 窗口控制（无边框窗口，顶栏即标题栏） ----------
// 走应用自己的 invoke/listen 通道，不依赖注入时机不稳定的 __TAURI__.window 全局包
(() => {
  const MAX_SVG =
    '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.7" y="1.7" width="8.6" height="8.6" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
  const RESTORE_SVG =
    '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.7" y="3.7" width="6.6" height="6.6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.2 1.7h4.1a2 2 0 0 1 2 2v4.1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  $("win-min").onclick = () => invoke("win_minimize").catch(() => {});
  $("win-max").onclick = () => invoke("win_toggle_maximize").catch(() => {});
  $("win-close").onclick = () => invoke("win_close").catch(() => {});
  // 关闭窗口 = 隐藏到托盘（Rust 侧拦截 CloseRequested，下载/做种继续）；首次给出提示
  listen("hidden-to-tray", () => {
    if (!localStorage.getItem("ani_tray_hint")) {
      localStorage.setItem("ani_tray_hint", "1");
      toast("已最小化到托盘，下载/做种继续运行；托盘图标右键可退出", true);
    }
  }).catch(() => {});
  // 托盘菜单「退出」：有未完成任务时挽留确认
  listen("app-quit-requested", async () => {
    const active = [...dlTasks.values()].filter((t) => !t.finished).length;
    if (active > 0) {
      const ok = await window.confirm(`还有 ${active} 个下载任务未完成，确定退出吗？（重启后会自动恢复任务）`);
      if (!ok) return;
    }
    invoke("app_quit").catch(() => {});
  }).catch(() => {});
  const syncMaxIcon = () =>
    invoke("win_is_maximized")
      .then((m) => { $("win-max").innerHTML = m ? RESTORE_SVG : MAX_SVG; })
      .catch(() => {});
  listen("tauri://resize", syncMaxIcon).catch(() => {});
  syncMaxIcon();
})();

// 启动：进入首页
showHomeSection();

// ---------- 设置界面 ----------

const settingsState = { loaded: false, data: null, sources: [], paths: {} };

function showView(name) {
  // 离开播放器视图时必须销毁媒体（display:none 不会暂停，音频会在后台继续播），
  // 销毁前保存一次进度（v.load() 之后 duration 就没了）
  if (name !== "player" && !$("view-player").classList.contains("hidden")) {
    saveProgress(false);
    destroyPlayer();
  }
  $("view-subjects").classList.toggle("hidden", name !== "subjects");
  $("view-detail").classList.toggle("hidden", name !== "detail");
  $("view-settings").classList.toggle("hidden", name !== "settings");
  $("view-player").classList.toggle("hidden", name !== "player");
}

async function openSettings() {
  settingsState.prevView = $("view-detail").classList.contains("hidden")
    ? (state.subView === "results" ? "results" : "subjects")
    : "detail";
  showView("settings");
  if (!settingsState.loaded) {
    try {
      const resp = await invoke("get_settings");
      settingsState.data = resp.settings;
      settingsState.sources = resp.sources;
      settingsState.paths = resp.paths;
      settingsState.loaded = true;
      bindSettings();
    } catch (e) {
      toast("加载设置失败：" + e);
    }
  }
}

let saveTimer = null;
function scheduleSave() {
  $("save-hint").textContent = "保存中…";
  $("save-hint").classList.add("show");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await invoke("save_settings", { settings: settingsState.data });
      $("save-hint").textContent = "已保存 ✓";
      setTimeout(() => $("save-hint").classList.remove("show"), 1500);
    } catch (e) {
      $("save-hint").textContent = "";
      toast("保存设置失败：" + e);
    }
  }, 400);
}

function bindSettings() {
  const d = settingsState.data;

  // --- 选源偏好 ---
  $("set-group").value = d.selector.subtitle_group ?? "";
  $("set-group").oninput = () => {
    const v = $("set-group").value.trim();
    d.selector.subtitle_group = v || null;
    scheduleSave();
  };
  $("set-res").value = d.selector.resolution ? String(d.selector.resolution.height) : "";
  $("set-res").onchange = () => {
    const v = $("set-res").value;
    // width 必须是整数（后端 u32）：480*16/9=853.33，不取整会让保存设置永远失败
    d.selector.resolution = v ? { width: Math.round((v * 16) / 9), height: +v } : null;
    scheduleSave();
  };
  $("set-min-res").value = d.selector.min_resolution_height ? String(d.selector.min_resolution_height) : "";
  $("set-min-res").onchange = () => {
    const v = $("set-min-res").value;
    d.selector.min_resolution_height = v ? +v : null;
    scheduleSave();
  };
  bindTagEditor("tags-blacklist-kw", d.selector.blacklist_keywords, "添加关键词");
  bindTagEditor("tags-blacklist-group", d.selector.blacklist_groups, "添加字幕组");

  // --- 数据源 ---
  renderSources();

  // --- BT 下载 ---
  $("set-dl-dir").value = d.torrent.download_dir ?? "";
  $("set-dl-dir").oninput = () => {
    d.torrent.download_dir = $("set-dl-dir").value.trim();
    scheduleSave();
  };
  $("set-seeding").checked = !!d.torrent.seeding;
  $("set-seeding").onchange = () => {
    d.torrent.seeding = $("set-seeding").checked;
    scheduleSave();
  };
  const clampNum = (v, lo, hi, dflt) => {
    const n = Math.round(+v);
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  };
  $("set-port").value = d.torrent.listen_port ?? 0;
  $("set-port").oninput = () => {
    // u16：越界值会让后端反序列化失败，保存设置永远报错
    d.torrent.listen_port = clampNum($("set-port").value, 0, 65535, 0);
    scheduleSave();
  };
  $("set-head").value = d.torrent.stream_head_mb ?? 8;
  $("set-head").oninput = () => {
    d.torrent.stream_head_mb = clampNum($("set-head").value, 1, 4096, 8);
    scheduleSave();
  };
  $("set-timeout").value = d.torrent.stream_timeout_min ?? 15;
  $("set-timeout").oninput = () => {
    d.torrent.stream_timeout_min = clampNum($("set-timeout").value, 1, 1440, 15);
    scheduleSave();
  };
  $("set-dl-dir-open").onclick = () => {
    invoke("reveal_path", { path: settingsState.paths.downloads })
      .catch((e) => toast("打开失败：" + e));
  };
  $("set-mpv").value = d.torrent.mpv_path ?? "";
  $("set-mpv").oninput = () => {
    d.torrent.mpv_path = $("set-mpv").value.trim();
    scheduleSave();
  };
  $("set-mpv-check").onclick = async () => {
    // 先保存再检测（检测用的是已保存的设置）
    scheduleSave();
    const el = $("mpv-check-result");
    el.textContent = "检测中…";
    try {
      await new Promise((r) => setTimeout(r, 600));
      const found = await invoke("check_mpv");
      el.textContent = found ? `✓ 找到 mpv：${found}` : "未找到 mpv，将使用系统默认播放器（可在上方填路径）";
    } catch (e) {
      el.textContent = "检测失败：" + e;
    }
  };

  // --- Bangumi 账号 ---
  $("set-bg-id").value = d.bangumi?.client_id ?? "";
  $("set-bg-id").oninput = () => {
    d.bangumi.client_id = $("set-bg-id").value.trim();
    scheduleSave();
  };
  $("set-bg-secret").value = d.bangumi?.client_secret ?? "";
  $("set-bg-secret").oninput = () => {
    d.bangumi.client_secret = $("set-bg-secret").value;
    scheduleSave();
  };
  $("set-bg-redirect").value = d.bangumi?.redirect_uri ?? "";
  $("set-bg-redirect").oninput = () => {
    d.bangumi.redirect_uri = $("set-bg-redirect").value.trim();
    scheduleSave();
  };
  $("set-bg-auth").onclick = async () => {
    try {
      scheduleSave();
      await new Promise((r) => setTimeout(r, 600)); // 等防抖保存完成
      const url = await invoke("bangumi_auth_url");
      await invoke("open_url", { url });
      toast("已在浏览器打开授权页：登录后复制授权码，回到这里完成登录");
    } catch (e) {
      toast("打开授权页失败：" + e);
    }
  };
  $("set-bg-exchange").onclick = async () => {
    try {
      const nick = await invoke("bangumi_auth_exchange", { code: $("set-bg-code").value });
      $("set-bg-code").value = "";
      toast(`Bangumi 已登录：${nick}`, true);
      refreshBangumiStatus();
    } catch (e) {
      toast("登录失败：" + e);
    }
  };
  $("set-bg-logout").onclick = async () => {
    try {
      await invoke("bangumi_logout");
      refreshBangumiStatus();
      toast("已退出 Bangumi 登录", true);
    } catch (e) {
      toast("操作失败：" + e);
    }
  };
  refreshBangumiStatus();

  // --- Jellyfin ---
  $("set-jf-url").value = d.jellyfin?.server_url ?? "";
  $("set-jf-url").oninput = () => {
    d.jellyfin.server_url = $("set-jf-url").value.trim();
    scheduleSave();
  };
  $("set-jf-user").value = d.jellyfin?.username ?? "";
  $("set-jf-user").oninput = () => {
    d.jellyfin.username = $("set-jf-user").value.trim();
    scheduleSave();
  };
  $("set-jf-pass").value = d.jellyfin?.password ?? "";
  $("set-jf-pass").oninput = () => {
    d.jellyfin.password = $("set-jf-pass").value;
    scheduleSave();
  };
  $("set-jf-key").value = d.jellyfin?.api_key ?? "";
  $("set-jf-key").oninput = () => {
    d.jellyfin.api_key = $("set-jf-key").value.trim();
    scheduleSave();
  };
  $("set-jf-test").onclick = async () => {
    const el = $("jf-test-result");
    el.textContent = "连接中…";
    try {
      const msg = await invoke("test_jellyfin", {
        cfg: {
          server_url: $("set-jf-url").value.trim(),
          username: $("set-jf-user").value.trim(),
          password: $("set-jf-pass").value,
          api_key: $("set-jf-key").value.trim(),
        },
      });
      el.textContent = "✓ " + msg;
    } catch (e) {
      el.textContent = "✕ " + e;
    }
  };

  // --- 弹幕 ---
  $("set-dm-enable").checked = !!d.danmaku_source?.enabled;
  $("set-dm-enable").onchange = () => {
    d.danmaku_source.enabled = $("set-dm-enable").checked;
    scheduleSave();
  };
  $("set-dm-appid").value = d.danmaku_source?.app_id ?? "";
  $("set-dm-appid").oninput = () => {
    d.danmaku_source.app_id = $("set-dm-appid").value.trim();
    scheduleSave();
  };
  $("set-dm-secret").value = d.danmaku_source?.app_secret ?? "";
  $("set-dm-secret").oninput = () => {
    d.danmaku_source.app_secret = $("set-dm-secret").value;
    scheduleSave();
  };
  $("set-hide-scroll").checked = !!d.danmaku.hide_scroll;
  $("set-hide-scroll").onchange = () => {
    d.danmaku.hide_scroll = $("set-hide-scroll").checked;
    scheduleSave();
  };
  $("set-hide-topbottom").checked = !!d.danmaku.hide_top_bottom;
  $("set-hide-topbottom").onchange = () => {
    d.danmaku.hide_top_bottom = $("set-hide-topbottom").checked;
    scheduleSave();
  };
  bindTagEditor("tags-danmaku-kw", d.danmaku.keywords, "添加关键词");
  bindTagEditor("tags-danmaku-user", d.danmaku.blocked_users, "添加用户");

  // --- 关于 ---
  $("path-settings").textContent = settingsState.paths.settings ?? "";
  $("path-db").textContent = settingsState.paths.db ?? "";
  $("path-downloads").textContent = settingsState.paths.downloads ?? "";
  document.querySelectorAll("[data-reveal]").forEach((b) => {
    b.onclick = () => invoke("reveal_path", { path: settingsState.paths[b.dataset.reveal] })
      .catch((e) => toast("打开失败：" + e));
  });
}

async function refreshBangumiStatus() {
  try {
    const st = await invoke("bangumi_status");
    $("bg-status").textContent = st.logged_in ? `✓ 已登录：${st.nickname}` : "";
    $("set-bg-logout").classList.toggle("hidden", !st.logged_in);
  } catch (e) { /* 状态获取失败不阻塞设置页 */ }
}

// 标签编辑器：数组增删 + 自动保存
function bindTagEditor(containerId, arr, placeholder) {
  const wrap = $(containerId);
  wrap.innerHTML = "";
  const render = () => {
    wrap.innerHTML = "";
    [...arr].sort().forEach((item) => {
      const chip = document.createElement("span");
      chip.className = "tag-chip";
      chip.innerHTML = `${escapeHtml(item)} <span class="x" title="移除">✕</span>`;
      chip.querySelector(".x").onclick = () => {
        arr.splice(arr.indexOf(item), 1);
        render();
        scheduleSave();
      };
      wrap.appendChild(chip);
    });
    const add = document.createElement("span");
    add.className = "tag-add";
    add.innerHTML = `<input type="text" placeholder="${placeholder}" />
      <button>添加</button>`;
    const input = add.querySelector("input");
    const commit = () => {
      const v = input.value.trim();
      if (!v) return;
      if (!arr.includes(v)) arr.push(v);
      render();
      scheduleSave();
    };
    add.querySelector("button").onclick = commit;
    input.addEventListener("keydown", (e) => e.key === "Enter" && commit());
    wrap.appendChild(add);
  };
  render();
}

const TIER_LABEL = { high: "高优先", medium: "中优先", low: "低优先" };

function renderSources() {
  const wrap = $("source-list");
  wrap.innerHTML = "";
  const KIND = { torrent: "BT", web: "Web", local: "本地" };
  for (const s of settingsState.sources) {
    const row = document.createElement("div");
    row.className = "source-row";
    const override = settingsState.data.sources.find((x) => x.id === s.id)?.tier;
    const curTier = override || s.tier;
    row.innerHTML = `
      <div class="s-name">${escapeHtml(s.display_name)}</div>
      <div class="s-tags">
        <span class="tag src">${escapeHtml(s.id)}</span>
        <span class="tag">${KIND[s.kind] ?? s.kind}</span>
        <span id="st-res-${escapeHtml(s.id)}" class="meta"></span>
      </div>
      <select class="select tier-sel" title="选源优先级（参与评分）">
        ${["high", "medium", "low"].map((t) =>
          `<option value="${t}" ${curTier === t ? "selected" : ""}>${TIER_LABEL[t]}</option>`).join("")}
      </select>
      <button class="ghost small st-test">测试</button>
      <label class="switch"><input type="checkbox" ${s.enabled ? "checked" : ""} /><span class="slider"></span></label>`;
    row.querySelector("input").onchange = (ev) => {
      s.enabled = ev.target.checked;
      upsertSourceState(s.id, { enabled: s.enabled });
      scheduleSave();
      toast(`${s.display_name} 已${s.enabled ? "启用" : "停用"}`, s.enabled);
    };
    row.querySelector(".tier-sel").onchange = (ev) => {
      upsertSourceState(s.id, { tier: ev.target.value });
      scheduleSave();
      toast(`${s.display_name} 优先级已设为${TIER_LABEL[ev.target.value]}`, true);
    };
    row.querySelector(".st-test").onclick = async (ev) => {
      const res = document.getElementById(`st-res-${s.id}`) || row.querySelector(".meta");
      res.textContent = "测试中…";
      try {
        const r = await invoke("test_source", { id: s.id });
        res.textContent = r.ok ? `✓ ${r.count} 条 / ${r.ms}ms` : `✕ ${r.error ?? "失败"}`;
      } catch (e) {
        res.textContent = "✕ " + e;
      }
    };
    wrap.appendChild(row);
  }
}

function upsertSourceState(id, patch) {
  const d = settingsState.data;
  const found = d.sources.find((x) => x.id === id);
  if (found) Object.assign(found, patch);
  else d.sources.push({ id, enabled: true, tier: null, ...patch });
}

// ---------- 缓存管理（M5 HTTP/HLS 离线缓存） ----------

const cacheDownloading = new Map(); // id -> {downloaded, total}

async function refreshCacheList() {
  const wrap = $("cache-list");
  try {
    const items = await invoke("cache_list");
    if (!items.length) {
      wrap.innerHTML = `<div class="meta">还没有缓存。在候选列表点「⤓ 缓存」把在线视频存到本地</div>`;
      $("cache-total").textContent = "";
      return;
    }
    wrap.innerHTML = "";
    let total = 0;
    for (const it of items) {
      const downloading = it.kind === "pending" || cacheDownloading.has(it.id);
      const prog = cacheDownloading.get(it.id);
      const pct = prog && prog.total ? Math.min(100, (prog.downloaded / prog.total) * 100).toFixed(0) : null;
      const sizeText = it.size_bytes ? fmtSize(it.size_bytes) : pct != null ? `${pct}%` : "下载中…";
      total += it.size_bytes;
      const row = document.createElement("div");
      row.className = "source-row";
      row.id = `cache-item-${it.id}`;
      row.innerHTML = `
        <div class="s-name">${escapeHtml(it.title)}${downloading ? ` <span class="meta">${pct != null ? pct + "%" : "下载中…"}</span>` : ""}</div>
        <div class="s-tags"><span class="tag">${it.kind === "hls" ? "HLS" : it.kind === "file" ? "直链" : "下载中"}</span>
          <span class="tag">${sizeText}</span>
          <span class="meta">${new Date(it.created_at).toLocaleDateString()}</span></div>
        <div class="inline-ctl">
          ${downloading ? "" : `<button class="btn small" data-cplay="${escapeAttr(it.id)}" data-entry="${escapeAttr(it.entry)}">▶ 播放</button>`}
          <button class="ghost small" data-cdir="${escapeAttr(it.id)}">目录</button>
          <button class="ghost small" data-cdel="${escapeAttr(it.id)}">删除</button>
        </div>`;
      row.querySelector("[data-cplay]")?.addEventListener("click", () => {
        openPlayer(`http://anicache.localhost/${it.id}/${it.entry}`, it.title);
      });
      row.querySelector("[data-cdir]")?.addEventListener("click", async () => {
        try {
          const path = await invoke("cache_dir_path", { id: it.id });
          await invoke("reveal_path", { path });
        } catch (e) { toast("打开失败：" + e); }
      });
      row.querySelector("[data-cdel]")?.addEventListener("click", async () => {
        try {
          await invoke("cache_delete", { id: it.id });
          cacheDownloading.delete(it.id);
          refreshCacheList();
          toast("缓存已删除", true);
        } catch (e) { toast("删除失败：" + e); }
      });
      wrap.appendChild(row);
    }
    $("cache-total").textContent = `共 ${items.length} 项，${fmtSize(total) ?? "0"}`;
  } catch (e) {
    wrap.innerHTML = `<div class="meta">缓存列表加载失败：${escapeHtml(String(e))}</div>`;
  }
}

listen("cache-progress", (ev) => {
  const { id, downloaded, total } = ev.payload;
  cacheDownloading.set(id, { downloaded, total });
  const row = $(`cache-item-${id}`);
  if (row) {
    const pct = total ? Math.min(100, (downloaded / total) * 100).toFixed(0) : "…";
    const meta = row.querySelector(".meta");
    if (meta) meta.textContent = `${pct}%`;
  }
}).catch(() => {});

listen("cache-done", (ev) => {
  cacheDownloading.delete(ev.payload);
  refreshCacheList();
  toast("缓存完成，可在 设置 → 缓存 里播放", true);
}).catch(() => {});

listen("cache-failed", (ev) => {
  const id = String(ev.payload).split("|")[0];
  cacheDownloading.delete(id);
  refreshCacheList();
  toast("缓存失败：" + String(ev.payload).split("|")[1]);
}).catch(() => {});

// 设置导航
document.querySelectorAll(".nav-item").forEach((n) => {
  n.onclick = () => {
    document.querySelectorAll(".nav-item").forEach((x) => x.classList.remove("active"));
    n.classList.add("active");
    document.querySelectorAll(".pane").forEach((p) => p.classList.add("hidden"));
    $("pane-" + n.dataset.pane).classList.remove("hidden");
    if (n.dataset.pane === "cache") refreshCacheList();
  };
});

$("settings-btn").onclick = openSettings;
$("settings-back").onclick = () => {
  const prev = settingsState.prevView || "subjects";
  if (prev === "detail") {
    showView("detail");
  } else {
    showView("subjects");
    prev === "results" ? showSearchSection() : showHomeSection();
  }
};


// ---------- 在线播放器 ----------

// ---------- 弹幕渲染层（Canvas 覆盖层；过滤已在后端完成，这里只管画） ----------
const DanmakuOverlay = (() => {
  const SCROLL_MS = 9000, STATIC_MS = 5000, MAX_ITEMS = 80;
  let events = [];   // 按时间升序
  let cursor = 0;    // 下一条待上屏的下标
  let items = [];    // 活动中的弹幕 {text,color,mode,lane,born,width}
  let scrollLanes = [], staticLanes = [];  // 各轨道的占用截止时刻（video 时间秒）
  let raf = null, lastT = 0, W = 0, H = 0, fontPx = 24;

  const cv = () => $("danmaku-canvas");
  const vid = () => $("video");

  function resize() {
    const c = cv(), v = vid();
    if (!c || !v) return;
    W = c.width = v.clientWidth;
    H = c.height = v.clientHeight;
    fontPx = Math.max(16, Math.min(32, Math.round(H / 22)));
  }

  function resetLanes() {
    const scrollLaneCount = Math.max(4, Math.floor((H * 0.8) / (fontPx + 4)));
    scrollLanes = Array(scrollLaneCount).fill(0);
    staticLanes = Array(3).fill(0);
  }

  function takeLane(lanes, now, duration) {
    const i = lanes.findIndex((free) => free <= now);
    if (i === -1) return -1;
    lanes[i] = now + duration;
    return i;
  }

  function spawn(e, now) {
    if (items.length >= MAX_ITEMS) return;
    const lane = e.mode === "scroll"
      ? takeLane(scrollLanes, now, SCROLL_MS / 1000)
      : takeLane(staticLanes, now, STATIC_MS / 1000);
    if (lane === -1) return; // 轨道满则丢弃（高峰期自动限流）
    items.push({ text: e.text, color: e.color, mode: e.mode, lane, born: now });
  }

  function frame() {
    raf = null;
    const c = cv(), v = vid();
    if (!c || !v || c.classList.contains("hidden")) return;
    const ctx = c.getContext("2d");
    const now = v.currentTime;
    // 上屏 (lastT, now] 内的弹幕；暂停时 now 不前进自然冻结
    while (cursor < events.length && events[cursor].time_ms / 1000 <= now) {
      const t = events[cursor].time_ms / 1000;
      if (t > lastT) spawn(events[cursor], now);
      cursor++;
    }
    lastT = now;
    ctx.clearRect(0, 0, W, H);
    ctx.font = `600 ${fontPx}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    ctx.textBaseline = "top";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,.7)";
    const next = [];
    for (const it of items) {
      const age = (now - it.born) * 1000;
      const w = ctx.measureText(it.text).width;
      let alpha = 1, x = 0, y = 0;
      if (it.mode === "scroll") {
        x = W - (age / SCROLL_MS) * (W + w);
        y = it.lane * (fontPx + 4) + 2;
        if (x < -w) continue;
      } else {
        if (age > STATIC_MS) continue;
        alpha = age > STATIC_MS - 600 ? (STATIC_MS - age) / 600 : 1;
        y = it.mode === "top" ? it.lane * (fontPx + 4) + 2 : H - (it.lane + 1) * (fontPx + 4) - 6;
        x = (W - w) / 2;
      }
      ctx.globalAlpha = alpha;
      ctx.strokeText(it.text, x, y);
      ctx.fillStyle = "#" + (it.color || 0xffffff).toString(16).padStart(6, "0");
      ctx.fillText(it.text, x, y);
      next.push(it);
    }
    ctx.globalAlpha = 1;
    items = next;
    raf = requestAnimationFrame(frame);
  }

  function ensureRunning() {
    if (raf == null) raf = requestAnimationFrame(frame);
  }

  return {
    /** 载入弹幕（升序数组），并按当前开关决定是否显示 */
    load(list) {
      this.clear();
      events = [...list].sort((a, b) => a.time_ms - b.time_ms);
      this.setEnabled(this.enabled);
    },
    clear() {
      events = []; cursor = 0; items = []; lastT = 0;
      const c = cv();
      if (c) c.getContext("2d").clearRect(0, 0, c.width, c.height);
    },
    /** seek 后重定位游标并清空已上屏内容 */
    seekTo(sec) {
      lastT = sec;
      items = [];
      let lo = 0, hi = events.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; events[mid].time_ms / 1000 <= sec ? lo = mid + 1 : hi = mid; }
      cursor = lo;
    },
    setEnabled(on) {
      this.enabled = on;
      const c = cv();
      if (!c) return;
      c.classList.toggle("hidden", !on || !events.length);
      if (on && events.length) { resize(); resetLanes(); ensureRunning(); }
      if (!on && raf != null) { cancelAnimationFrame(raf); raf = null; }
    },
    enabled: false,
    resize,
  };
})();

let hls = null;
let playerPrev = "subjects";
let currentMediaKey = null;
let resumeListener = null;
let lastSavedSec = -10;
// 应用内 BT 播放（anibt://）失败时回落外部播放器用的本地路径
let btFallbackPath = null;
let btErrorListener = null;
const RATES = [1.0, 1.25, 1.5, 2.0];

function mediaKey(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

function fmtTime(sec) {
  if (!isFinite(sec)) return "--:--";
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), ss = sec % 60;
  const mm = String(m).padStart(2, "0"), ss2 = String(ss).padStart(2, "0");
  return h ? `${h}:${mm}:${ss2}` : `${m}:${ss2}`;
}

function saveProgress(finished = false) {
  if (!currentMediaKey) return;
  const v = $("video");
  if (!v.duration || !isFinite(v.duration)) return;
  invoke("save_progress", {
    key: currentMediaKey,
    positionSeconds: v.currentTime,
    durationSeconds: v.duration,
    finished,
  }).catch(() => {});
}

function destroyPlayer() {
  const v = $("video");
  v.pause();
  DanmakuOverlay.clear();
  // 媒体加载失败的 once 监听器不会自焚，滞留会污染下一次播放的 seek
  if (resumeListener) {
    v.removeEventListener("loadedmetadata", resumeListener);
    resumeListener = null;
  }
  if (btErrorListener) {
    v.removeEventListener("error", btErrorListener);
    btErrorListener = null;
  }
  if (hls) {
    hls.destroy();
    hls = null;
  }
  v.removeAttribute("src");
  v.load();
}

function openPlayer(url, title) {
  playerPrev = $("view-detail").classList.contains("hidden")
    ? (state.subView === "results" ? "results" : "subjects")
    : "detail";
  showPlayer(url, title);
}

function showPlayerEmpty() {
  playerPrev = "subjects";
  showPlayer("", "在线播放");
}

function showPlayer(url, title) {
  destroyPlayer();
  $("player-title").textContent = title || "在线播放";
  showView("player");
  const v = $("video");
  if (!url) return;

  // 断点续播：加载后跳到上次位置（看完的从头播）。
  // 元数据加载与进度查询的完成顺序不定，两侧都要能触发，且只 seek 一次
  currentMediaKey = mediaKey(url);
  lastSavedSec = -10;
  let resumeAt = null;
  let resumeDone = false;
  const tryResume = () => {
    if (resumeDone || !resumeAt) return;
    if (!v.duration || !isFinite(v.duration)) return;
    resumeDone = true;
    if (resumeAt < v.duration * 0.95) {
      v.currentTime = resumeAt;
      toast(`已从 ${fmtTime(resumeAt)} 继续播放`, true);
    }
  };
  invoke("load_progress", { key: currentMediaKey })
    .then((pos) => {
      if (pos && pos > 30) resumeAt = pos;
      tryResume();
    })
    .catch(() => {});
  resumeListener = tryResume;
  v.addEventListener("loadedmetadata", resumeListener, { once: true });

  const isHls = /\.m3u8(\?|$)/i.test(url);
  $("player-quality").classList.add("hidden");
  if (isHls && window.Hls && Hls.isSupported()) {
    hls = new Hls({ maxBufferLength: 30 });
    hls.loadSource(url);
    hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      // 画质选择（多码率 HLS）
      const sel = $("player-quality");
      const levels = data.levels ?? [];
      if (levels.length > 1) {
        sel.classList.remove("hidden");
        sel.innerHTML =
          `<option value="-1">画质 自动</option>` +
          levels
            .map((l, i) => `<option value="${i}">${l.height ? l.height + "p" : "码率 " + Math.round((l.bitrate ?? 0) / 1000) + "k"}</option>`)
            .join("");
      }
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      // 可恢复的错误自动重试，避免网络闪断后播放卡死
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        hls.startLoad();
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else {
        toast("HLS 播放出错：" + data.details);
      }
    });
  } else {
    if (url.startsWith("http://anibt.localhost/")) {
      // 应用内 BT 播放失败（容器不受支持/区间长时间无数据）→ 自动回落外部播放器
      btErrorListener = () => {
        if (!btFallbackPath) {
          toast("播放失败：该视频格式可能不受 WebView 支持");
          return;
        }
        toast("应用内播放失败，改用外部播放器…");
        invoke("spawn_player", { path: btFallbackPath })
          .then((via) => toast("已在" + via + "中播放", true))
          .catch(() => {});
      };
      v.addEventListener("error", btErrorListener, { once: true });
    }
    v.src = url;
  }
  // 记住的音量/倍速
  const savedVol = parseFloat(localStorage.getItem("ani_vol"));
  if (!isNaN(savedVol)) v.volume = Math.min(1, Math.max(0, savedVol));
  const savedRate = parseFloat(localStorage.getItem("ani_rate"));
  if (!isNaN(savedRate) && RATES.includes(savedRate)) {
    v.playbackRate = savedRate;
    $("player-rate").textContent = `倍速 ${savedRate}x`;
  } else {
    $("player-rate").textContent = "倍速 1.0x";
  }
  v.play().catch(() => {});

  // 弹幕：有番剧上下文时按 番名+集号 从 dandanplay 拉取（未配置时后端静默返回未匹配）
  syncDanmakuToggle();
  DanmakuOverlay.clear();
  const subjectName = state.subject?.display_title;
  if (subjectName && state.currentEp != null) {
    invoke("danmaku_fetch", { subjectName, ep: state.currentEp })
      .then((r) => {
        if (r.matched) {
          DanmakuOverlay.load(r.comments);
          if (r.comments.length) toast(`弹幕已加载：${r.comments.length} 条（${r.title}）`, true);
        }
      })
      .catch(() => {});
  }
}

$("player-btn").onclick = showPlayerEmpty;

async function startStream(uri, title) {
  openDlPanel();
  setStatus("在线播放准备中…");
  toast("BT 边下边播：先缓冲视频头部数据…");
  try {
    await invoke("start_torrent_stream", { uri, title, ep: state.currentEp ?? null });
  } catch (e) {
    setStatus("");
    toast("启动失败：" + e);
  }
}

listen("stream-wait", (ev) => {
  // percent 可能是 null（0 字节视频时后端 NaN 序列化结果）
  setStatus(`在线播放准备中：${Number(ev.payload.percent ?? 0).toFixed(0)}%（${ev.payload.file}）`);
});

listen("stream-file", (f) => {
  // 文件已选定，状态由 stream-wait 持续更新
  void f;
}).catch(() => {});

listen("stream-ready", async (ev) => {
  const { url, path, title } = ev.payload;
  setStatus("");
  if (url) {
    // 应用内边下边播（anibt:// 协议）：弹幕/断点续播/倍速全可用
    btFallbackPath = path || null;
    openPlayer(url, title);
    toast("BT 边下边播：正在应用内播放器缓冲…", true);
    return;
  }
  try {
    const via = await invoke("spawn_player", { path });
    toast("已在" + via + "中播放（边下边播，请勿关闭下载面板）", true);
  } catch (e) {
    toast("启动播放器失败：" + e);
  }
}).catch(() => {});

listen("stream-failed", (ev) => {
  setStatus("");
  toast(String(ev.payload));
}).catch(() => {});

$("player-back").onclick = () => {
  // 先存进度再销毁：destroyPlayer 的 v.load() 会把 duration 变 NaN
  saveProgress(false);
  destroyPlayer();
  if (playerPrev === "detail") showView("detail");
  else {
    showView("subjects");
    playerPrev === "results" ? showSearchSection() : showHomeSection();
  }
};
$("player-url-btn").onclick = () => {
  const u = $("player-url-input").value.trim();
  if (!u) return;
  openPlayer(u, "直链播放");
};
$("player-url-input").addEventListener("keydown", (e) => e.key === "Enter" && $("player-url-btn").onclick());

// 进度保存：每 5 秒 + 退出时 + 看完标记；顺带更新时间显示
$("video").addEventListener("timeupdate", () => {
  const v = $("video");
  $("player-time").textContent = `${fmtTime(v.currentTime)} / ${fmtTime(v.duration)}`;
  if (v.currentTime - lastSavedSec >= 5) {
    lastSavedSec = v.currentTime;
    saveProgress(false);
  }
});
$("video").addEventListener("volumechange", () => {
  localStorage.setItem("ani_vol", String($("video").volume));
});
$("video").addEventListener("waiting", () => setStatus("缓冲中…"));
$("video").addEventListener("playing", () => setStatus(""));
$("video").addEventListener("click", (e) => {
  const v = $("video");
  // 原生控制条在 shadow DOM 里，click 会重定向到 video 元素本身；
  // 命中底部控制条区域时不翻转播放状态，否则"点暂停=没点"
  const rect = v.getBoundingClientRect();
  if (e.clientY - rect.top > rect.height - 60) return;
  v.paused ? v.play().catch(() => {}) : v.pause();
});
$("video").addEventListener("dblclick", () => toggleFullscreen());

function toggleFullscreen() {
  const v = $("video");
  if (document.fullscreenElement) document.exitFullscreen();
  else v.requestFullscreen?.().catch(() => {});
}
$("player-fs").onclick = toggleFullscreen;

// ---------- 弹幕开关与联动 ----------

function danmakuEnabled() {
  if (settingsState.data?.danmaku_source) return !!settingsState.data.danmaku_source.enabled;
  return localStorage.getItem("ani_dm") === "1";
}

function syncDanmakuToggle() {
  const on = danmakuEnabled();
  $("player-danmaku").textContent = on ? "弹幕 开" : "弹幕 关";
  DanmakuOverlay.setEnabled(on);
}

$("player-danmaku").onclick = () => {
  const on = !danmakuEnabled();
  localStorage.setItem("ani_dm", on ? "1" : "0");
  if (settingsState.data?.danmaku_source) {
    settingsState.data.danmaku_source.enabled = on;
    scheduleSave();
  }
  syncDanmakuToggle();
};

// seek 后重定位弹幕游标；窗口尺寸变化时重排画布
$("video").addEventListener("seeked", () => DanmakuOverlay.seekTo($("video").currentTime));
window.addEventListener("resize", () => DanmakuOverlay.resize());
document.addEventListener("fullscreenchange", () => setTimeout(() => DanmakuOverlay.resize(), 60));

// 画质切换
$("player-quality").onchange = (e) => {
  if (hls) hls.currentLevel = +e.target.value;
};

// 键盘快捷键：空格暂停 / ←→ 快退快进 10s / ↑↓ 音量 / F 全屏
document.addEventListener("keydown", (e) => {
  if ($("view-player").classList.contains("hidden")) return;
  const tag = e.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  const v = $("video");
  const keys = [" ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "f", "F"];
  if (!keys.includes(e.key)) return;
  e.preventDefault();
  switch (e.key) {
    case " ":
      v.paused ? v.play().catch(() => {}) : v.pause();
      break;
    case "ArrowLeft": v.currentTime = Math.max(0, v.currentTime - 10); break;
    case "ArrowRight": v.currentTime += 10; break;
    case "ArrowUp": v.volume = Math.min(1, v.volume + 0.1); break;
    case "ArrowDown": v.volume = Math.max(0, v.volume - 0.1); break;
    case "f": case "F": toggleFullscreen(); break;
  }
});
$("video").addEventListener("ended", () => {
  saveProgress(true);
  toast("已看完，进度已记录", true);
  // Bangumi 云同步：标记「看过」（未登录时后端拒绝，静默忽略）
  const subjectId = state.subject?.id?.id ?? state.subject?.id;
  if (subjectId && state.currentEp != null) {
    const epInfo = state.episodes.find((e) => Math.abs(e.ep - state.currentEp) < 0.01);
    if (epInfo) {
      invoke("bangumi_mark_watched", { subjectId, episodeId: epInfo.id.id ?? epInfo.id })
        .then(() => toast("已同步到 Bangumi：标记看过", true))
        .catch(() => {});
    }
  }
});

// 倍速切换
$("player-rate").onclick = () => {
  const v = $("video");
  const idx = (RATES.indexOf(v.playbackRate) + 1) % RATES.length;
  v.playbackRate = RATES[idx];
  $("player-rate").textContent = `倍速 ${RATES[idx]}x`;
  localStorage.setItem("ani_rate", String(RATES[idx]));
};
