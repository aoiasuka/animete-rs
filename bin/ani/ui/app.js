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
  currentEp: null,
  currentEpId: null,
  watchedEps: new Set(),
  collectionUpdates: {},
};

const epViewState = {
  currentTab: "main",
  order: "asc",
  filterText: "",
};

// 提取封面主色调（Ani 6.0 动态环境背光）
function extractDominantColor(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return resolve(null);
        canvas.width = 32;
        canvas.height = 32;
        ctx.drawImage(img, 0, 0, 32, 32);
        const data = ctx.getImageData(0, 0, 32, 32).data;
        let r = 0, g = 0, b = 0, total = 0;
        for (let i = 0; i < data.length; i += 16) {
          const cr = data[i], cg = data[i + 1], cb = data[i + 2], ca = data[i + 3];
          if (ca < 128) continue;
          const brightness = 0.299 * cr + 0.587 * cg + 0.114 * cb;
          if (brightness > 30 && brightness < 225) {
            const max = Math.max(cr, cg, cb);
            const min = Math.min(cr, cg, cb);
            const sat = max === 0 ? 0 : (max - min) / max;
            const weight = 1 + sat * 3;
            r += cr * weight;
            g += cg * weight;
            b += cb * weight;
            total += weight;
          }
        }
        if (total > 0) {
          resolve(`rgb(${Math.round(r / total)}, ${Math.round(g / total)}, ${Math.round(b / total)})`);
        } else {
          resolve(null);
        }
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// ---------- 通用 ----------

function setStatus(text) {
  const el = $("status");
  if (!el) return;
  if (text) {
    el.innerHTML = `<span class="status-dot"></span><span>${escapeHtml(text)}</span>`;
  } else {
    el.innerHTML = "";
  }
}

let toastTimer = null;
function toast(msg, ok = false) {
  const el = $("toast");
  const icon = ok ? "✓ " : "⚠ ";
  el.textContent = icon + msg;
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
  // 最近搜索、继续观看与我的追番刷新
  refreshHistory();
  loadContinueWatching();
  loadCollections();

  // 离线打卡挂起队列自动重试同步
  invoke("sync_pending_playback_ops")
    .then((res) => {
      if (res && res.succeeded > 0) {
        toast(`已自动同步 ${res.succeeded} 条离线打卡记录到 Bangumi`, true);
      }
    })
    .catch(() => {});

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

async function loadContinueWatching() {
  const sec = $("continue-section");
  const grid = $("continue-grid");
  if (!sec || !grid) return;
  try {
    const list = await invoke("list_playback_history", { limit: 8 });
    if (!list || !list.length) {
      sec.classList.add("hidden");
      grid.innerHTML = "";
      return;
    }
    sec.classList.remove("hidden");
    grid.innerHTML = "";
    for (const it of list) {
      const card = document.createElement("div");
      card.className = "continue-card";
      const dur = it.duration_seconds || 0;
      const pct = dur > 0 ? Math.min(100, Math.round((it.position_seconds / dur) * 100)) : 0;
      const coverImg = it.cover_url
        ? `<img src="${escapeAttr(it.cover_url)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.opacity='0.15'" />`
        : `<div style="display:grid;place-items:center;height:100%;color:var(--text-dim);font-size:28px">🎬</div>`;

      const timeStr = dur > 0 ? `${fmtTime(it.position_seconds)} / ${fmtTime(dur)} (${pct}%)` : fmtTime(it.position_seconds);
      const subTitle = it.title ? `${escapeHtml(it.title)} · ${timeStr}` : timeStr;

      card.innerHTML = `
        <div class="continue-cover">
          ${coverImg}
          <div class="continue-play-hint">
            <div class="continue-play-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            </div>
          </div>
          <button class="continue-del" title="从历史中移除">✕</button>
          <div class="continue-progress-bar">
            <div class="continue-progress-fill" style="width: ${pct}%"></div>
          </div>
        </div>
        <div class="continue-body">
          <div class="continue-title" title="${escapeAttr(it.subject_name || it.title)}">${escapeHtml(it.subject_name || it.title || "继续播放")}</div>
          <div class="continue-sub">
            <span>${subTitle}</span>
          </div>
        </div>`;

      const delBtn = card.querySelector(".continue-del");
      if (delBtn) {
        delBtn.onclick = async (e) => {
          e.stopPropagation();
          try {
            await invoke("remove_playback_history", { key: it.episode_id });
            toast("已从继续观看中移除", true);
            loadContinueWatching();
          } catch (err) {
            toast("移除失败：" + err);
          }
        };
      }

      card.onclick = () => {
        if (it.media_url) {
          openPlayer(it.media_url, it.title || it.subject_name);
        } else {
          toast("请从条目详情选择剧集播放");
        }
      };
      grid.appendChild(card);
    }
  } catch {
    sec.classList.add("hidden");
  }
}

let colFilterState = { text: "", status: "all" };
let cachedCollections = [];

function renderCollectionsList() {
  const grid = $("collection-grid");
  const countEl = $("collection-count");
  if (!grid) return;
  const kw = colFilterState.text.toLowerCase().trim();
  const status = colFilterState.status;

  const filtered = cachedCollections.filter((item) => {
    if (kw) {
      const t1 = (item.display_title || item.name_cn || "").toLowerCase();
      const t2 = (item.original_title || item.name || "").toLowerCase();
      if (!t1.includes(kw) && !t2.includes(kw)) return false;
    }
    if (status !== "all") {
      const subjectId = Number(item.id?.id ?? item.id);
      const update = state.collectionUpdates?.[subjectId];
      if (status === "pending") {
        if (!update || !update.has_unwatched) return false;
      } else if (status === "caught_up") {
        if (update && update.has_unwatched) return false;
      }
    }
    return true;
  });

  if (countEl) {
    if (cachedCollections.length === filtered.length) {
      countEl.textContent = `${cachedCollections.length} 部追番`;
    } else {
      countEl.textContent = `显示 ${filtered.length} / ${cachedCollections.length} 部`;
    }
  }

  grid.innerHTML = "";
  if (!filtered.length) {
    grid.innerHTML = `<div class="empty" style="grid-column: 1 / -1; padding: 24px; text-align: center; color: var(--text-muted);">没有符合条件的追番条目</div>`;
    return;
  }
  for (const item of filtered) {
    grid.appendChild(subjectCard(item));
  }
}

async function loadCollections() {
  const sec = $("collection-section");
  const grid = $("collection-grid");
  const countEl = $("collection-count");
  const refreshBtn = $("btn-refresh-collections");
  const filterInput = $("collection-filter-input");
  const statusTabs = $("collection-status-tabs");
  if (!sec || !grid) return;

  if (filterInput && !filterInput.__bound) {
    filterInput.__bound = true;
    filterInput.oninput = () => {
      colFilterState.text = filterInput.value;
      renderCollectionsList();
    };
  }

  if (statusTabs && !statusTabs.__bound) {
    statusTabs.__bound = true;
    statusTabs.querySelectorAll(".col-tab").forEach((tab) => {
      tab.onclick = () => {
        statusTabs.querySelectorAll(".col-tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        colFilterState.status = tab.getAttribute("data-status") || "all";
        renderCollectionsList();
      };
    });
  }

  if (refreshBtn && !refreshBtn.__bound) {
    refreshBtn.__bound = true;
    refreshBtn.onclick = async () => {
      try {
        refreshBtn.disabled = true;
        refreshBtn.textContent = "检查中…";
        const updates = await invoke("check_collection_updates");
        state.collectionUpdates = updates || {};
        await loadCollections();
        const list = Object.values(state.collectionUpdates || {});
        const unwatched = list.filter((u) => u.has_unwatched).length;
        if (unwatched > 0) {
          toast(`追更状态已更新：共 ${list.length} 部追番，其中 ${unwatched} 部有新集待看！`, true);
        } else {
          toast(`追更状态已更新：共 ${list.length} 部追番，全部均已追平 ✓`, true);
        }
      } catch (err) {
        toast("检查追更失败：" + err);
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "检查追更 🔄";
      }
    };
  }

  try {
    const list = await invoke("list_subject_collections");
    if (!list || !list.length) {
      sec.classList.add("hidden");
      grid.innerHTML = "";
      cachedCollections = [];
      return;
    }
    cachedCollections = list;
    sec.classList.remove("hidden");
    renderCollectionsList();
  } catch {
    sec.classList.add("hidden");
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
      chip.innerHTML = `<span>${escapeHtml(kw)}</span><span class="hist-chip-del" title="删除该记录">✕</span>`;
      chip.onclick = (e) => {
        if (e.target.classList.contains("hist-chip-del")) return;
        $("search-input").value = kw;
        const clr = $("search-clear");
        if (clr) clr.classList.remove("hidden");
        doSearch();
      };
      const del = chip.querySelector(".hist-chip-del");
      if (del) {
        del.onclick = async (e) => {
          e.stopPropagation();
          try {
            await invoke("remove_search_history", { keyword: kw });
            refreshHistory();
          } catch (err) {
            toast("删除历史失败：" + err);
          }
        };
      }
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
    const isToday = day.weekday.id === homeState.today;
    const tab = document.createElement("div");
    tab.className = "wd-tab" + (day.weekday.id === selected ? " active" : "");
    tab.innerHTML = `
      ${isToday ? '<span class="today-badge" title="今天"></span>' : ""}
      <span>${escapeHtml(day.weekday.cn)}</span>
      <span class="cnt">${day.items.length}</span>`;
    tab.onclick = () => {
      homeState.selected = day.weekday.id;
      renderCalendar();
    };
    tabs.appendChild(tab);
  }
  const current = days.find((d) => d.weekday.id === selected) ?? days[0];
  const isCurrentDayToday = current && current.weekday.id === homeState.today;
  grid.innerHTML = "";
  if (!current || !current.items.length) {
    grid.innerHTML = `<div class="empty">这一天没有放送条目</div>`;
    return;
  }
  for (const s of current.items) {
    grid.appendChild(subjectCard(s, isCurrentDayToday));
  }
}

function exportAnimeCalendar() {
  if (!homeState.calendar || !homeState.calendar.length) {
    toast("新番时间表尚未加载完成，请稍候");
    return;
  }
  const bydayMap = { 1: "MO", 2: "TU", 3: "WE", 4: "TH", 5: "FR", 6: "SA", 7: "SU" };
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const dtStamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

  let ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ani-rs//Anime Calendar 1.0//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:ani-rs 本周新番放送时间表",
    "X-WR-TIMEZONE:Asia/Shanghai",
  ];

  let eventCount = 0;
  for (const day of homeState.calendar) {
    const wId = day.weekday?.id || 1;
    const byday = bydayMap[wId] || "MO";
    const weekdayCn = day.weekday?.cn || `星期${wId}`;

    const todayW = now.getDay() === 0 ? 7 : now.getDay();
    let diffDays = (wId - todayW + 7) % 7;
    const eventDate = new Date(now.getTime() + diffDays * 86400000);
    const yyyymmdd = `${eventDate.getFullYear()}${pad(eventDate.getMonth() + 1)}${pad(eventDate.getDate())}`;
    const dtStart = `${yyyymmdd}T200000`; // 默认晚上黄金档 20:00

    for (const item of day.items || []) {
      const subId = Number(item.id ? (item.id.id ?? item.id) : (item.bangumi_id ?? item.id));
      const title = item.display_title || item.original_title || "未知新番";
      const orig = item.original_title && item.original_title !== title ? `\\n日文原名: ${item.original_title}` : "";
      const bgmUrl = `https://bgm.tv/subject/${subId}`;
      const desc = `放送时间: 每${weekdayCn} 20:00\\nBangumi ID: ${subId}${orig}\\n条目详情: ${bgmUrl}\\n由 ani-rs 追番客户端导出`;

      ics.push("BEGIN:VEVENT");
      ics.push(`UID:bangumi-sub-${subId}@ani-rs`);
      ics.push(`DTSTAMP:${dtStamp}`);
      ics.push(`DTSTART;TZID=Asia/Shanghai:${dtStart}`);
      ics.push(`SUMMARY:[新番] ${title.replace(/[,;\\]/g, " ")}`);
      ics.push(`DESCRIPTION:${desc}`);
      ics.push(`URL:${bgmUrl}`);
      ics.push(`RRULE:FREQ=WEEKLY;BYDAY=${byday}`);
      ics.push("END:VEVENT");
      eventCount++;
    }
  }

  ics.push("END:VCALENDAR");
  const icsContent = ics.join("\r\n");

  const blob = new Blob([icsContent], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "anime_broadcast_schedule.ics";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  navigator.clipboard.writeText(icsContent).catch(() => {});
  toast(`已导出 ${eventCount} 部新番日程并已复制到剪贴板，可直接导入 Windows 日历 / Outlook / Apple / Google Calendar！`, true);
}

const calExportBtn = $("calendar-export-btn");
if (calExportBtn) {
  calExportBtn.onclick = () => exportAnimeCalendar();
}

function subjectCard(s, isTodayAiring = false) {
  const card = document.createElement("div");
  card.className = "card" + (isTodayAiring ? " today-airing" : "");
  const displayTitle = s.display_title || s.name_cn || s.name || "动画";
  const originalTitle = s.original_title || s.name || "";
  const bangumiId = Number(s.id ? (s.id.id ?? s.id) : (s.bangumi_id ?? s.id));
  const coverImg = s.cover_url
    ? `<img src="${escapeAttr(s.cover_url)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.opacity='0.15'" />`
    : `<div style="display:grid;place-items:center;height:100%;color:var(--text-dim);font-size:32px">🎬</div>`;
  const airDate = s.air_date ? escapeHtml(s.air_date) : "放送中";
  const updateInfo = state.collectionUpdates ? state.collectionUpdates[bangumiId] : null;
  let updateBadge = "";
  if (updateInfo) {
    if (updateInfo.has_unwatched) {
      updateBadge = `<div class="card-update-badge unwatched" title="更新至第 ${updateInfo.latest_ep} 集，尚有未看剧集">待看 · 第 ${updateInfo.latest_ep} 集</div>`;
    } else {
      updateBadge = `<div class="card-update-badge caught-up" title="已全部观看完成">已追平 · 共 ${updateInfo.latest_ep} 集 ✓</div>`;
    }
  }
  card.innerHTML = `
    <div class="card-cover">
      ${coverImg}
      ${updateBadge}
      <div class="card-play-hint">
        <div class="card-play-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </div>
      </div>
    </div>
    <div class="card-body">
      <div class="t" title="${escapeAttr(displayTitle)}">${escapeHtml(displayTitle)}</div>
      <div class="m"><span>${airDate}</span></div>
    </div>`;
  card.onclick = () => openSubject({
    id: { id: bangumiId },
    display_title: displayTitle,
    original_title: originalTitle,
    name_cn: s.name_cn || displayTitle,
    name: originalTitle,
    cover_url: s.cover_url,
    air_date: s.air_date,
  });
  return card;
}

function showHomeSection() {
  $("home-section").classList.remove("hidden");
  $("search-section").classList.add("hidden");
  state.subView = "home";
  loadHome(); // 回首页时刷新最近搜索、继续观看与追番
}

function showSearchSection() {
  $("home-section").classList.add("hidden");
  $("search-section").classList.remove("hidden");
  state.subView = "results";
}

// ---------- 第一步：搜索条目 ----------

// 请求令牌：慢返回的旧请求不得覆盖新数据
let searchSeq = 0, subjectSeq = 0, fetchSeq = 0;
// 候选列表过滤（字幕组/分辨率/仅看可用），配合选源页的筛选下拉
const candFilter = { group: "", res: "", onlyAvail: true };
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
  const availEl = $("cand-filter-avail");
  if (availEl) availEl.checked = candFilter.onlyAvail;
}

$("cand-filter-group").onchange = (e) => {
  candFilter.group = e.target.value;
  if (lastSelection) renderSelection(lastSelection);
};
$("cand-filter-res").onchange = (e) => {
  candFilter.res = e.target.value;
  if (lastSelection) renderSelection(lastSelection);
};
const candAvailEl = $("cand-filter-avail");
if (candAvailEl) {
  candAvailEl.onchange = (e) => {
    candFilter.onlyAvail = e.target.checked;
    if (lastSelection) renderSelection(lastSelection);
  };
}

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

let searchFilterType = "all";
let searchSortOrder = "default";
let rawSearchResults = [];
let currentSearchKeyword = "";

function applySearchFilterAndSort() {
  if (!rawSearchResults || !rawSearchResults.length) return;
  let list = [...rawSearchResults];

  if (searchFilterType !== "all") {
    list = list.filter((s) => {
      const title = (s.display_title || s.name_cn || s.name || "").toLowerCase();
      const orig = (s.original_title || s.name || "").toLowerCase();
      const combined = title + " " + orig;
      if (searchFilterType === "movie") {
        return combined.includes("剧场版") || combined.includes("movie") || combined.includes("电影");
      }
      if (searchFilterType === "ova") {
        return (
          combined.includes("ova") ||
          combined.includes("oad") ||
          combined.includes("sp") ||
          combined.includes("特别篇")
        );
      }
      if (searchFilterType === "tv") {
        return (
          !combined.includes("剧场版") &&
          !combined.includes("movie") &&
          !combined.includes("ova") &&
          !combined.includes("oad")
        );
      }
      return true;
    });
  }

  if (searchSortOrder === "air_desc") {
    list.sort((a, b) => (b.air_date || "").localeCompare(a.air_date || ""));
  } else if (searchSortOrder === "air_asc") {
    list.sort((a, b) => (a.air_date || "9999").localeCompare(b.air_date || "9999"));
  } else if (searchSortOrder === "title") {
    list.sort((a, b) =>
      (a.display_title || a.name_cn || "").localeCompare(b.display_title || b.name_cn || "", "zh-CN")
    );
  }

  const wrap = $("subjects");
  wrap.innerHTML = "";
  const countEl = $("search-results-count");
  if (countEl) {
    countEl.textContent = `（${rawSearchResults.length} 部番剧${searchFilterType !== "all" ? ` · 过滤后 ${list.length} 部` : ""}）`;
  }

  if (!list.length) {
    wrap.innerHTML = `<div class="empty">当前分类下没有匹配条目，可尝试切换「全部」</div>`;
    return;
  }
  for (const s of list) {
    wrap.appendChild(subjectCard(s));
  }
}

function renderSubjects(subjects, q) {
  rawSearchResults = subjects || [];
  currentSearchKeyword = q;
  $("subjects-title").textContent = subjects.length ? `“${q}” 的搜索结果` : "没有结果，换个关键词试试";
  if (!subjects.length) {
    $("subjects").innerHTML = `<div class="empty">换个关键词，或返回首页从时间表挑一部</div>`;
    if ($("search-results-count")) $("search-results-count").textContent = "";
    return;
  }
  applySearchFilterAndSort();
}

// 热门题材点击与搜索分类切换绑定
document.querySelectorAll(".hot-tag-pill").forEach((pill) => {
  pill.onclick = () => {
    const kw = pill.getAttribute("data-keyword");
    if (!kw) return;
    const input = $("search-input");
    if (input) {
      input.value = kw;
      doSearch();
    }
  };
});

document.querySelectorAll(".search-tab").forEach((tab) => {
  tab.onclick = () => {
    searchFilterType = tab.getAttribute("data-type") || "all";
    document.querySelectorAll(".search-tab").forEach((t) => t.classList.toggle("active", t === tab));
    applySearchFilterAndSort();
  };
});

const searchSortSelect = $("search-sort-select");
if (searchSortSelect) {
  searchSortSelect.onchange = () => {
    searchSortOrder = searchSortSelect.value;
    applySearchFilterAndSort();
  };
}

// ---------- 第二步：条目详情 + 剧集 ----------

let isCurrentSubjectCollected = false;

async function updateCollectBtn(bangumiId, s) {
  const btn = $("subject-collect-btn");
  if (!btn) return;
  try {
    isCurrentSubjectCollected = await invoke("is_subject_collected", { bangumiId: Number(bangumiId) });
  } catch {
    isCurrentSubjectCollected = false;
  }
  setCollectBtnUI(isCurrentSubjectCollected);

  btn.onclick = async () => {
    try {
      const res = await invoke("toggle_subject_collection", {
        bangumiId: Number(bangumiId),
        nameCn: s.name_cn || s.display_title || "",
        name: s.original_title || s.name || "",
        coverUrl: s.cover_url || null,
        airDate: s.air_date || null,
      });
      const isNow = typeof res === "boolean" ? res : res.collected;
      const synced = res?.bangumi_synced;
      isCurrentSubjectCollected = isNow;
      setCollectBtnUI(isNow);
      if (isNow) {
        toast(synced ? "已加入追番（已同步至 Bangumi 在看 ✓）" : "已加入我的追番", true);
      } else {
        toast("已取消追番", true);
      }
      loadCollections();
    } catch (e) {
      toast("追番操作失败：" + e);
    }
  };
}

function setCollectBtnUI(collected) {
  const btn = $("subject-collect-btn");
  if (!btn) return;
  btn.classList.toggle("collected", collected);
  const txt = btn.querySelector(".collect-text");
  if (txt) txt.textContent = collected ? "已追番" : "追番";
  const icon = btn.querySelector(".collect-icon");
  if (icon) icon.textContent = collected ? "♥" : "♡";
}

async function openSubject(s) {
  const my = ++subjectSeq;
  const displayTitle = s.display_title || s.name_cn || s.name || "动画";
  const originalTitle = s.original_title || s.name || "";
  s.display_title = displayTitle;
  s.original_title = originalTitle;
  state.subject = s;
  state.currentEp = null;
  state.currentEpId = null;
  $("subject-name").textContent = displayTitle;
  $("subject-meta").textContent = [originalTitle, s.air_date].filter(Boolean).join(" · ");
  const bangumiId = Number(s.id ? (s.id.id ?? s.id) : (s.bangumi_id ?? s.id));
  updateCollectBtn(bangumiId, s);
  const coverWrap = $("subject-cover-wrap");
  const coverImg = $("subject-cover");
  if (coverWrap && coverImg) {
    if (s.cover_url) {
      coverImg.src = s.cover_url;
      coverWrap.classList.remove("hidden");
      extractDominantColor(s.cover_url).then((color) => {
        if (color && state.subject === s) {
          document.documentElement.style.setProperty("--subject-accent", color);
          document.documentElement.style.setProperty(
            "--subject-accent-glow",
            color.replace("rgb", "rgba").replace(")", ", 0.28)")
          );
        }
      });
    } else {
      coverWrap.classList.add("hidden");
      document.documentElement.style.removeProperty("--subject-accent");
      document.documentElement.style.removeProperty("--subject-accent-glow");
    }
  }
  const filterInput = $("ep-filter-input");
  if (filterInput) filterInput.value = "";
  epViewState.filterText = "";
  $("candidates").innerHTML = `<div class="empty">从下方剧集列表选择一集开始找资源</div>`;
  $("cand-count").textContent = "";
  $("source-errors").classList.add("hidden");
  $("episodes").innerHTML = `<div class="empty">加载中…</div>`;
  showView("detail");
  loadFullSubjectDetail(bangumiId, my);
  loadCharacters(bangumiId, my);
  loadRelatedSubjects(bangumiId, my);
  loadSubjectComments(bangumiId, my);
  try {
    const [eps, watchedList] = await Promise.all([
      invoke("episode_list", { subjectId: bangumiId }),
      invoke("get_watched_episodes", { subjectId: bangumiId }).catch(() => []),
    ]);
    if (my !== subjectSeq) return; // 用户已切换到其它条目
    state.episodes = eps;
    state.watchedEps = new Set((watchedList || []).map(Number));
    renderEpisodes(eps);
  } catch (e) {
    if (my !== subjectSeq) return;
    $("episodes").innerHTML = "";
    toast("加载剧集失败：" + e);
  }
}

const subjectDetailCache = new Map();
const subjectCharactersCache = new Map();
const subjectRelatedCache = new Map();

async function loadCharacters(subjectId, seq) {
  const wrap = $("characters-wrap");
  const listEl = $("characters-list");
  const countEl = $("characters-count");
  if (!wrap || !listEl) return;
  wrap.classList.add("hidden");
  listEl.innerHTML = "";
  if (countEl) countEl.textContent = "";

  const renderChars = (chars) => {
    if (!chars || !chars.length) {
      wrap.classList.add("hidden");
      return;
    }
    if (countEl) countEl.textContent = `${chars.length} 位角色`;
    listEl.innerHTML = chars
      .map((c) => {
        const avatarHtml = c.image_url
          ? `<img class="character-avatar" src="${escapeHtml(c.image_url)}" alt="${escapeHtml(c.name)}" referrerpolicy="no-referrer" loading="lazy" />`
          : `<div class="character-avatar" style="display:flex;align-items:center;justify-content:center;font-size:24px;background:rgba(255,255,255,0.06)">🎭</div>`;

        let badgeClass = "character-role-badge";
        if (c.relation === "主角") badgeClass += " main";
        else if (c.relation === "配角") badgeClass += " sub";

        let actorHtml = "";
        if (c.actors && c.actors.length > 0) {
          const a = c.actors[0];
          const aImg = a.image_url
            ? `<img class="actor-avatar" src="${escapeHtml(a.image_url)}" referrerpolicy="no-referrer" />`
            : "";
          actorHtml = `<div class="character-actor-line" title="声优: ${escapeHtml(a.name)}">${aImg}<span class="actor-name">CV: ${escapeHtml(a.name)}</span></div>`;
        }

        return `
          <div class="character-card">
            <div class="character-avatar-wrap">${avatarHtml}</div>
            <div class="character-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</div>
            <div class="${badgeClass}">${escapeHtml(c.relation || "角色")}</div>
            ${actorHtml}
          </div>
        `;
      })
      .join("");
    wrap.classList.remove("hidden");
  };

  if (subjectCharactersCache.has(subjectId)) {
    renderChars(subjectCharactersCache.get(subjectId));
    return;
  }

  try {
    const chars = await invoke("get_subject_characters", { subjectId });
    if (seq !== subjectSeq) return;
    subjectCharactersCache.set(subjectId, chars || []);
    renderChars(chars);
  } catch (e) {
    if (seq !== subjectSeq) return;
    wrap.classList.add("hidden");
  }
}

async function loadRelatedSubjects(subjectId, seq) {
  const wrap = $("detail-related-wrap");
  const listEl = $("related-list");
  const countEl = $("related-count");
  if (!wrap || !listEl) return;
  wrap.classList.add("hidden");
  listEl.innerHTML = "";
  if (countEl) countEl.textContent = "";

  const renderRelated = (list) => {
    if (!list || !list.length) {
      wrap.classList.add("hidden");
      return;
    }
    if (countEl) countEl.textContent = `${list.length} 部关联`;
    listEl.innerHTML = list
      .map((item) => {
        let badgeClass = "related-badge";
        if (item.relation === "续集") badgeClass += " sequel";
        else if (item.relation === "前传") badgeClass += " prequel";
        else if (item.relation.includes("剧场版") || item.relation === "总集篇") badgeClass += " movie";
        else badgeClass += " other";

        const title = item.name_cn || item.name;
        const subTitle = item.name_cn ? item.name : "";
        const coverHtml = item.cover_url
          ? `<img class="related-cover" src="${escapeHtml(item.cover_url)}" alt="${escapeHtml(title)}" referrerpolicy="no-referrer" loading="lazy" />`
          : `<div class="related-cover" style="display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.06);font-size:24px">🎬</div>`;

        return `
          <div class="related-card" data-subject-id="${item.id}" title="${escapeHtml(title)}${subTitle ? " (" + escapeHtml(subTitle) + ")" : ""}">
            <div class="related-cover-wrap">
              ${coverHtml}
              <span class="${badgeClass}">${escapeHtml(item.relation)}</span>
            </div>
            <div class="related-title">${escapeHtml(title)}</div>
            ${subTitle ? `<div class="related-sub-title">${escapeHtml(subTitle)}</div>` : ""}
          </div>
        `;
      })
      .join("");

    listEl.querySelectorAll(".related-card").forEach((card) => {
      card.onclick = () => {
        const id = parseInt(card.dataset.subjectId, 10);
        if (id) loadSubject(id);
      };
    });

    wrap.classList.remove("hidden");
  };

  if (subjectRelatedCache.has(subjectId)) {
    renderRelated(subjectRelatedCache.get(subjectId));
    return;
  }

  try {
    const list = await invoke("get_related_subjects", { subjectId });
    if (seq !== subjectSeq) return;
    subjectRelatedCache.set(subjectId, list || []);
    renderRelated(list);
  } catch (e) {
    if (seq !== subjectSeq) return;
    wrap.classList.add("hidden");
  }
}

let commentsState = {
  subjectId: null,
  offset: 0,
  limit: 15,
  total: 0,
  loading: false,
};

async function loadSubjectComments(subjectId, seq, append = false) {
  const listEl = $("comments-list");
  const statsEl = $("comments-stats");
  const moreRow = $("comments-more-row");
  const moreBtn = $("comments-more-btn");
  if (!listEl) return;

  if (!append) {
    commentsState.subjectId = subjectId;
    commentsState.offset = 0;
    commentsState.total = 0;
    listEl.innerHTML = `<div class="meta empty-tip">正在加载社区短评…</div>`;
    if (statsEl) statsEl.textContent = "";
    if (moreRow) moreRow.classList.add("hidden");
  }

  if (commentsState.loading) return;
  commentsState.loading = true;
  if (moreBtn) moreBtn.textContent = "加载中…";

  try {
    const res = await invoke("get_subject_comments", {
      subjectId,
      offset: commentsState.offset,
      limit: commentsState.limit,
    });
    if (seq !== subjectSeq) return;

    commentsState.total = res.total || 0;
    const items = res.data || [];

    if (!append) {
      listEl.innerHTML = "";
    }

    if (statsEl) {
      statsEl.textContent = commentsState.total > 0 ? `共 ${commentsState.total} 条短评` : "";
    }

    if (!append && (!items || !items.length)) {
      listEl.innerHTML = `<div class="meta empty-tip">暂无社区短评，快去 Bangumi 抢沙发吧！</div>`;
      if (moreRow) moreRow.classList.add("hidden");
      return;
    }

    for (const c of items) {
      const card = document.createElement("div");
      card.className = "comment-card";

      const avatarHtml = c.user?.avatar_url
        ? `<img class="comment-avatar" src="${escapeHtml(c.user.avatar_url)}" alt="${escapeHtml(c.user.nickname)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()" />`
        : "";
      const initial = (c.user?.nickname || c.user?.username || "?").slice(0, 1).toUpperCase();

      let rateHtml = "";
      if (c.rate) {
        let rateClass = "comment-rate-badge";
        if (c.rate >= 8) rateClass += " high";
        else if (c.rate >= 6) rateClass += " mid";
        rateHtml = `<span class="${rateClass}" title="评分: ${c.rate} / 10"><span style="color:#f59e0b">★</span> ${c.rate}</span>`;
      }

      const dateStr = c.updated_at ? c.updated_at.split("T")[0] : "";

      card.innerHTML = `
        <div class="comment-avatar-wrap">
          ${avatarHtml || initial}
        </div>
        <div class="comment-content-wrap">
          <div class="comment-meta-row">
            <span class="comment-user-name">${escapeHtml(c.user?.nickname || c.user?.username || "漫友")}</span>
            ${rateHtml}
            <span class="comment-time">${escapeHtml(dateStr)}</span>
          </div>
          <p class="comment-text">${escapeHtml(c.comment)}</p>
        </div>
      `;
      listEl.appendChild(card);
    }

    commentsState.offset += items.length;
    if (moreRow && moreBtn) {
      const hasMore = commentsState.offset < commentsState.total;
      moreRow.classList.toggle("hidden", !hasMore);
      moreBtn.textContent = "加载更多短评 ▾";
    }
  } catch (e) {
    if (seq !== subjectSeq) return;
    if (!append) {
      listEl.innerHTML = `<div class="meta empty-tip">暂未获取到短评 (${escapeHtml(String(e))})</div>`;
    }
  } finally {
    commentsState.loading = false;
    if (moreBtn && moreBtn.textContent === "加载中…") {
      moreBtn.textContent = "加载更多短评 ▾";
    }
  }
}

const commentsMoreBtn = $("comments-more-btn");
if (commentsMoreBtn) {
  commentsMoreBtn.onclick = () => {
    if (commentsState.subjectId) {
      loadSubjectComments(commentsState.subjectId, subjectSeq, true);
    }
  };
}

async function loadFullSubjectDetail(subjectId, seq) {
  const badgesEl = $("subject-badges");
  const tagsEl = $("subject-tags");
  const synopsisWrap = $("subject-synopsis-wrap");
  const synopsisEl = $("subject-synopsis");
  const synopsisToggle = $("subject-synopsis-toggle");

  if (badgesEl) { badgesEl.innerHTML = ""; badgesEl.classList.add("hidden"); }
  if (tagsEl) { tagsEl.innerHTML = ""; tagsEl.classList.add("hidden"); }
  if (synopsisWrap) synopsisWrap.classList.add("hidden");
  if (synopsisEl) { synopsisEl.textContent = ""; synopsisEl.classList.add("collapsed"); }
  if (synopsisToggle) synopsisToggle.textContent = "展开简介 ▾";

  const renderDetail = (detail) => {
    if (!detail) return;
    // 徽标栏：黄金评分、排名、媒介、总集数
    if (badgesEl) {
      const parts = [];
      if (typeof detail.score === "number" && detail.score > 0) {
        const totalStr = detail.rating_total
          ? `<span class="score-total">(${detail.rating_total > 10000 ? (detail.rating_total / 10000).toFixed(1) + "w" : detail.rating_total}人评)</span>`
          : "";
        parts.push(`<span class="subject-badge score" title="Bangumi 评分"><span class="score-star">★</span> ${detail.score.toFixed(1)} ${totalStr}</span>`);
      }
      if (detail.rank) {
        parts.push(`<span class="subject-badge rank" title="Bangumi 全站综合排名">Rank #${detail.rank}</span>`);
      }
      if (detail.platform) {
        parts.push(`<span class="subject-badge platform">${escapeHtml(detail.platform)}</span>`);
      }
      if (detail.total_episodes) {
        parts.push(`<span class="subject-badge eps">全 ${detail.total_episodes} 话</span>`);
      }
      if (parts.length > 0) {
        badgesEl.innerHTML = parts.join("");
        badgesEl.classList.remove("hidden");
      }
    }

    // 热门标签胶囊群
    if (tagsEl && detail.tags && detail.tags.length > 0) {
      tagsEl.innerHTML = detail.tags
        .map((t) => `<span class="subject-tag-chip" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</span>`)
        .join("");
      tagsEl.classList.remove("hidden");
      tagsEl.querySelectorAll(".subject-tag-chip").forEach((chip) => {
        chip.onclick = () => {
          const kw = chip.getAttribute("data-tag");
          if (kw) {
            $("search-input").value = kw;
            const clr = $("search-clear");
            if (clr) clr.classList.remove("hidden");
            doSearch();
          }
        };
      });
    }

    // 剧情简介
    if (synopsisWrap && synopsisEl && detail.summary) {
      synopsisEl.textContent = detail.summary;
      synopsisWrap.classList.remove("hidden");
      if (synopsisToggle) {
        synopsisToggle.onclick = () => {
          const isCollapsed = synopsisEl.classList.toggle("collapsed");
          synopsisToggle.textContent = isCollapsed ? "展开简介 ▾" : "收起 ▴";
        };
      }
    }
  };

  if (subjectDetailCache.has(subjectId)) {
    renderDetail(subjectDetailCache.get(subjectId));
    return;
  }

  try {
    const detail = await invoke("get_subject_detail", { subjectId });
    if (seq !== subjectSeq) return;
    if (detail) {
      subjectDetailCache.set(subjectId, detail);
      renderDetail(detail);
    }
  } catch (e) {
    console.warn("loadFullSubjectDetail error:", e);
  }
}

function updateEpisodeStats(list) {
  const statsEl = $("episodes-stats");
  if (!statsEl || !list || !list.length) return;
  const watchedCount = list.filter((e) => state.watchedEps.has(Number(e.id?.id ?? e.id))).length;
  const pct = Math.round((watchedCount / list.length) * 100);
  statsEl.textContent = `已看 ${watchedCount} / ${list.length} 集 (${pct}%)`;
}

async function markEpisodesUpTo(targetEp, list, eps) {
  const subjectId = Number(state.subject?.id?.id ?? state.subject?.id ?? state.subject?.bangumi_id);
  const toMark = list.filter((x) => x.ep <= targetEp && !state.watchedEps.has(Number(x.id?.id ?? x.id)));
  if (!toMark.length) {
    toast(`第 1 至 ${targetEp} 集均已处于已看状态`, true);
    return;
  }
  for (const item of toMark) {
    const epId = Number(item.id?.id ?? item.id);
    await invoke("mark_episode_watched", {
      episodeId: epId,
      subjectId,
      ep: Number(item.ep),
      watched: true,
    }).catch(() => {});
    state.watchedEps.add(epId);
  }
  renderEpisodes(eps);
  toast(`已将第 1 至 ${targetEp} 集标记为已看`, true);
}

async function toggleEpisodeWatched(e, chip, list) {
  const epId = Number(e.id?.id ?? e.id);
  const subjectId = Number(state.subject?.id?.id ?? state.subject?.id ?? state.subject?.bangumi_id);
  const isWatched = state.watchedEps.has(epId);
  const nextState = !isWatched;
  try {
    await invoke("mark_episode_watched", {
      episodeId: epId,
      subjectId,
      ep: Number(e.ep),
      watched: nextState,
    });
    if (nextState) {
      state.watchedEps.add(epId);
      chip.classList.add("watched");
      if (!chip.querySelector(".ep-check")) {
        const check = document.createElement("span");
        check.className = "ep-check";
        check.textContent = "✓";
        chip.appendChild(check);
      }
      toast(`第 ${e.ep} 集已标记为已看`, true);
    } else {
      state.watchedEps.delete(epId);
      chip.classList.remove("watched");
      chip.querySelector(".ep-check")?.remove();
      toast(`第 ${e.ep} 集已取消已看标记`, true);
    }
    if (list) updateEpisodeStats(list);
  } catch (err) {
    toast("更新剧集已看状态失败：" + err);
  }
}

function renderEpisodes(eps) {
  const wrap = $("episodes");
  const tabsEl = $("ep-type-tabs");
  const sortBtn = $("ep-sort-btn");
  const filterInput = $("ep-filter-input");
  wrap.innerHTML = "";

  if (!eps || !eps.length) {
    if (tabsEl) tabsEl.classList.add("hidden");
    wrap.innerHTML = `<div class="empty">该条目没有剧集数据（可能是漫画/画集等非动画条目，换动画条目即可找资源）</div>`;
    $("candidates").innerHTML = "";
    if ($("episodes-stats")) $("episodes-stats").textContent = "";
    return;
  }

  // 剧集按类型分组（正片 / SP特别篇 / OP&ED / 其他）
  const groups = {
    all: { label: "全部", items: [] },
    main: { label: "正片", items: [] },
    special: { label: "SP特别篇", items: [] },
    op_ed: { label: "OP/ED", items: [] },
    other: { label: "其他", items: [] },
  };

  for (const e of eps) {
    groups.all.items.push(e);
    if (e.kind === "main") {
      groups.main.items.push(e);
    } else if (e.kind === "special") {
      groups.special.items.push(e);
    } else if (e.kind === "opening" || e.kind === "ending") {
      groups.op_ed.items.push(e);
    } else {
      groups.other.items.push(e);
    }
  }

  const availableKeys = ["main", "special", "op_ed", "other"].filter(
    (k) => groups[k].items.length > 0
  );

  // 仅在存在多种类型时展示分类切换 Tab
  if (tabsEl) {
    if (availableKeys.length > 1) {
      tabsEl.classList.remove("hidden");
      const displayKeys = ["all", ...availableKeys];
      if (!displayKeys.includes(epViewState.currentTab)) {
        epViewState.currentTab = groups.main.items.length ? "main" : availableKeys[0];
      }
      tabsEl.innerHTML = displayKeys
        .map((k) => {
          const g = groups[k];
          const activeClass = k === epViewState.currentTab ? " active" : "";
          return `<div class="wd-tab${activeClass}" data-tab="${k}"><span>${g.label}</span><span class="cnt">${g.items.length}</span></div>`;
        })
        .join("");

      tabsEl.querySelectorAll(".wd-tab").forEach((tab) => {
        tab.onclick = () => {
          epViewState.currentTab = tab.dataset.tab;
          renderEpisodes(eps);
        };
      });
    } else {
      tabsEl.classList.add("hidden");
      if (groups.main.items.length) {
        epViewState.currentTab = "main";
      } else if (availableKeys.length > 0) {
        epViewState.currentTab = availableKeys[0];
      } else {
        epViewState.currentTab = "all";
      }
    }
  }

  // 当前分类剧集列表
  let list = [...(groups[epViewState.currentTab]?.items || groups.all.items)];

  // 关键字筛选（集号或标题模糊匹配）
  if (epViewState.filterText) {
    const q = epViewState.filterText.toLowerCase();
    list = list.filter(
      (e) =>
        String(e.ep).includes(q) ||
        (e.display_title && e.display_title.toLowerCase().includes(q))
    );
  }

  // 排序：正序 1→N / 倒序 N→1
  list.sort((a, b) => {
    const diff = (a.ep || 0) - (b.ep || 0);
    return epViewState.order === "asc" ? diff : -diff;
  });

  if (sortBtn && !sortBtn.__bound) {
    sortBtn.__bound = true;
    sortBtn.onclick = () => {
      epViewState.order = epViewState.order === "asc" ? "desc" : "asc";
      sortBtn.textContent = epViewState.order === "asc" ? "正序 1→N" : "倒序 N→1";
      renderEpisodes(eps);
    };
  }
  if (sortBtn) {
    sortBtn.textContent = epViewState.order === "asc" ? "正序 1→N" : "倒序 N→1";
  }

  if (filterInput && !filterInput.__bound) {
    filterInput.__bound = true;
    filterInput.oninput = (ev) => {
      epViewState.filterText = ev.target.value.trim();
      renderEpisodes(eps);
    };
  }

  updateEpisodeStats(list);

  const markAllBtn = $("ep-mark-all");
  if (markAllBtn) {
    markAllBtn.onclick = async () => {
      const subjectId = Number(state.subject?.id?.id ?? state.subject?.id ?? state.subject?.bangumi_id);
      const toMark = list.filter((e) => !state.watchedEps.has(Number(e.id?.id ?? e.id)));
      if (!toMark.length) {
        toast("当前剧集均已处于已看状态", true);
        return;
      }
      for (const e of toMark) {
        const epId = Number(e.id?.id ?? e.id);
        await invoke("mark_episode_watched", {
          episodeId: epId,
          subjectId,
          ep: Number(e.ep),
          watched: true,
        }).catch(() => {});
        state.watchedEps.add(epId);
      }
      renderEpisodes(eps);
      toast(`已将当前分类全部 ${list.length} 集标记为已看`, true);
    };
  }

  const clearAllBtn = $("ep-clear-all");
  if (clearAllBtn) {
    clearAllBtn.onclick = async () => {
      const subjectId = Number(state.subject?.id?.id ?? state.subject?.id ?? state.subject?.bangumi_id);
      const toClear = list.filter((e) => state.watchedEps.has(Number(e.id?.id ?? e.id)));
      if (!toClear.length) return;
      for (const e of toClear) {
        const epId = Number(e.id?.id ?? e.id);
        await invoke("mark_episode_watched", {
          episodeId: epId,
          subjectId,
          ep: Number(e.ep),
          watched: false,
        }).catch(() => {});
        state.watchedEps.delete(epId);
      }
      renderEpisodes(eps);
      toast("已清空当前分类已看标记", true);
    };
  }

  if (!list.length) {
    wrap.innerHTML = `<div class="empty" style="padding:16px 0">未找到符合条件的剧集</div>`;
    return;
  }

  for (const e of list) {
    const epId = Number(e.id?.id ?? e.id);
    const isWatched = state.watchedEps.has(epId);
    const isActive = state.currentEp != null && Math.abs(e.ep - state.currentEp) < 0.01;
    const chip = document.createElement("div");
    chip.className = "ep" + (isWatched ? " watched" : "") + (isActive ? " active" : "");
    chip.innerHTML = `<span class="epno">${e.ep}</span>${escapeHtml(e.display_title)}${isWatched ? '<span class="ep-check">✓</span>' : ""}`;
    chip.title = `${e.display_title} (右键/Shift+点击: 切换已看 | Alt+点击: 标记到此集)`;
    chip.oncontextmenu = (evt) => {
      evt.preventDefault();
      toggleEpisodeWatched(e, chip, list);
    };
    chip.onclick = (evt) => {
      if (evt.shiftKey) {
        evt.preventDefault();
        toggleEpisodeWatched(e, chip, list);
        return;
      }
      if (evt.altKey) {
        evt.preventDefault();
        markEpisodesUpTo(e.ep, list, eps);
        return;
      }
      document.querySelectorAll(".ep.active").forEach((n) => n.classList.remove("active"));
      chip.classList.add("active");
      state.currentEp = e.ep;
      state.currentEpId = epId;
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
      (!candFilter.onlyAvail || c.type === "available") &&
      (!candFilter.group || c.media.properties.subtitle_group === candFilter.group) &&
      (!candFilter.res ||
        (c.media.properties.resolution &&
          String(c.media.properties.resolution.height) === candFilter.res)),
  );
  const filterParts = [];
  if (candFilter.onlyAvail) filterParts.push("仅可用");
  if (candFilter.group) filterParts.push(candFilter.group);
  if (candFilter.res) filterParts.push(candFilter.res + "p");
  const filterNote = filterParts.length ? `（${filterParts.join(" · ")} 筛选后 ${filtered.length} 条）` : "";
  const clipped = filtered.length > 40 ? `（显示前 40 条）` : "";
  $("cand-count").textContent = `${avail.length} 可用 · ${excluded.length} 已排除${filterNote}${clipped}`;

  const wrap = $("candidates");
  wrap.innerHTML = "";
  if (!sel.candidates.length) {
    wrap.innerHTML = `<div class="empty">没有候选结果（网络或站点问题，稍后重试）</div>`;
    return;
  }
  if (!filtered.length) {
    wrap.innerHTML = `<div class="empty">没有符合筛选条件的候选 <button id="reset-cand-filter" class="btn small secondary" style="margin-left:10px">重置筛选</button></div>`;
    const resetBtn = $("reset-cand-filter");
    if (resetBtn) {
      resetBtn.onclick = () => {
        candFilter.group = "";
        candFilter.res = "";
        candFilter.onlyAvail = false;
        $("cand-filter-group").value = "";
        $("cand-filter-res").value = "";
        const availEl = $("cand-filter-avail");
        if (availEl) availEl.checked = false;
        renderSelection(sel);
      };
    }
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
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        toast("磁力链接已复制", true);
      } catch (e) {
        toast("复制失败：" + e);
      }
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
    mkBtn("复制路径", async () => {
      try {
        const path = await invoke("download_video_path", { id: t.id });
        if (!path) return toast("未找到视频文件");
        await navigator.clipboard.writeText(path);
        toast("文件路径已复制", true);
      } catch (e) { toast("复制失败：" + e); }
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
  const activeCount = tasks.filter((t) => !t.finished && !t.paused).length;
  const finishedTasks = tasks.filter((t) => t.finished);
  const badge = $("dl-badge");
  if (badge) {
    if (activeCount > 0) {
      badge.textContent = String(activeCount);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  // 聚合总上传/下载速度
  const totalDl = tasks.reduce((s, t) => s + (t.download_speed_bps || 0), 0);
  const totalUl = tasks.reduce((s, t) => s + (t.upload_speed_bps || 0), 0);
  const speedEl = $("dl-total-speed");
  if (speedEl) {
    if (totalDl > 0 || totalUl > 0) {
      speedEl.textContent = `↓ ${fmtSpeed(totalDl)} · ↑ ${fmtSpeed(totalUl)}`;
      speedEl.classList.remove("hidden");
    } else {
      speedEl.classList.add("hidden");
    }
  }

  // 清空已完成任务按钮
  const clearBtn = $("dl-clear-finished");
  if (clearBtn) {
    clearBtn.classList.toggle("hidden", finishedTasks.length === 0);
    clearBtn.onclick = async () => {
      for (const t of finishedTasks) {
        await invoke("remove_download", { id: t.id }).catch(() => {});
        dlTasks.delete(t.id);
      }
      renderDownloads();
      toast("已清理已完成任务记录", true);
    };
  }

  // 全部暂停 / 全部继续 按钮
  const toggleAllBtn = $("dl-toggle-all-btn");
  const unfinishedTasks = tasks.filter((t) => !t.finished);
  if (toggleAllBtn) {
    toggleAllBtn.classList.toggle("hidden", unfinishedTasks.length === 0);
    const anyRunning = unfinishedTasks.some((t) => !t.paused);
    toggleAllBtn.textContent = anyRunning ? "全部暂停 ⏸" : "全部继续 ▶";
    toggleAllBtn.onclick = async () => {
      try {
        const nextPaused = anyRunning;
        await invoke("set_all_downloads_paused", { paused: nextPaused });
        for (const t of unfinishedTasks) {
          t.paused = nextPaused;
          const node = dlNodes.get(t.id);
          if (node) updateDlNode(node, t);
        }
        toast(nextPaused ? "已暂停所有下载任务" : "已恢复所有下载任务", true);
        renderDownloads();
      } catch (e) {
        toast("批量操作失败：" + e);
      }
    };
  }

  // 打开下载目录按钮
  const openDirBtn = $("dl-open-dir-btn");
  if (openDirBtn) {
    openDirBtn.onclick = async () => {
      try {
        await invoke("open_download_dir");
        toast("已在资源管理器中打开下载目录", true);
      } catch (e) {
        toast("打开下载目录失败：" + e);
      }
    };
  }

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
  for (const t of ev.payload) {
    dlTasks.set(t.id, t);
    if (t.finished && !finishedToasted.has(t.id)) {
      finishedToasted.add(t.id);
      toast("下载完成：" + (t.title || t.id), true);
    }
  }
  // 即使面板隐藏，也保持角标与后台完成通知生效
  const activeCount = [...dlTasks.values()].filter((t) => !t.finished && !t.paused).length;
  const badge = $("dl-badge");
  if (badge) {
    if (activeCount > 0) {
      badge.textContent = String(activeCount);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }
  if (dlVisible) {
    renderDownloads();
  }
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

// ---------- 剧集批量下载调度台 ----------
let isBatchDownloading = false;

function openBatchDownloadModal() {
  const modal = $("batch-dl-modal");
  if (!modal) return;
  const subjectTitle = state.subject?.display_title || state.subject?.name_cn || state.subject?.name || "当前动画";
  const titleEl = $("batch-dl-subject-title");
  if (titleEl) titleEl.textContent = `《${subjectTitle}》`;

  const grid = $("batch-ep-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const eps = state.episodes || [];
  if (!eps.length) {
    grid.innerHTML = `<div class="meta" style="grid-column: 1 / -1; padding: 20px; text-align: center;">暂无剧集数据</div>`;
    modal.classList.remove("hidden");
    return;
  }

  eps.forEach((e) => {
    const epId = Number(e.id?.id ?? e.id);
    const isWatched = state.watchedEps.has(epId);
    const isMain = e.ep_type === 0 || e.kind === "main" || !e.kind;
    const epTitle = e.display_title || (e.name_cn ? `${e.ep}. ${e.name_cn}` : `第 ${e.ep} 集`);

    const item = document.createElement("label");
    item.className = "batch-ep-item";
    item.dataset.epId = String(epId);
    item.dataset.ep = String(e.ep);
    item.dataset.isMain = isMain ? "1" : "0";
    item.dataset.isWatched = isWatched ? "1" : "0";

    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.className = "batch-ep-chk";
    chk.value = String(e.ep);
    // 默认勾选未看的正片
    chk.checked = isMain && !isWatched;

    if (chk.checked) item.classList.add("selected");

    chk.onchange = () => {
      item.classList.toggle("selected", chk.checked);
      updateBatchSelectedCount();
    };

    const span = document.createElement("span");
    span.className = "batch-ep-label";
    span.textContent = epTitle;
    span.title = epTitle;

    item.appendChild(chk);
    item.appendChild(span);
    grid.appendChild(item);
  });

  updateBatchSelectedCount();
  $("batch-dl-progress-box")?.classList.add("hidden");
  modal.classList.remove("hidden");
}

function updateBatchSelectedCount() {
  const chks = document.querySelectorAll(".batch-ep-chk:checked");
  const cntEl = $("batch-sel-count");
  if (cntEl) cntEl.textContent = `已选 ${chks.length} 集`;
}

function closeBatchDownloadModal() {
  if (isBatchDownloading) {
    if (!confirm("批量下载任务正在调度中，确定中断吗？")) return;
    isBatchDownloading = false;
  }
  $("batch-dl-modal")?.classList.add("hidden");
}

const batchDlBtn = $("ep-batch-dl-btn");
if (batchDlBtn) batchDlBtn.onclick = openBatchDownloadModal;

const batchDlClose = $("batch-dl-close");
if (batchDlClose) batchDlClose.onclick = closeBatchDownloadModal;

const batchDlCancel = $("batch-dl-cancel-btn");
if (batchDlCancel) batchDlCancel.onclick = closeBatchDownloadModal;

const batchModalEl = $("batch-dl-modal");
if (batchModalEl) {
  batchModalEl.onclick = (e) => {
    if (e.target === batchModalEl) closeBatchDownloadModal();
  };
}

// 快捷选择按钮
const batchSelMain = $("batch-sel-main");
if (batchSelMain) {
  batchSelMain.onclick = () => {
    document.querySelectorAll(".batch-ep-item").forEach((item) => {
      const chk = item.querySelector(".batch-ep-chk");
      if (chk) {
        chk.checked = item.dataset.isMain === "1";
        item.classList.toggle("selected", chk.checked);
      }
    });
    updateBatchSelectedCount();
  };
}

const batchSelUnwatched = $("batch-sel-unwatched");
if (batchSelUnwatched) {
  batchSelUnwatched.onclick = () => {
    document.querySelectorAll(".batch-ep-item").forEach((item) => {
      const chk = item.querySelector(".batch-ep-chk");
      if (chk) {
        chk.checked = item.dataset.isWatched !== "1";
        item.classList.toggle("selected", chk.checked);
      }
    });
    updateBatchSelectedCount();
  };
}

const batchSelInvert = $("batch-sel-invert");
if (batchSelInvert) {
  batchSelInvert.onclick = () => {
    document.querySelectorAll(".batch-ep-item").forEach((item) => {
      const chk = item.querySelector(".batch-ep-chk");
      if (chk) {
        chk.checked = !chk.checked;
        item.classList.toggle("selected", chk.checked);
      }
    });
    updateBatchSelectedCount();
  };
}

const batchSelClear = $("batch-sel-clear");
if (batchSelClear) {
  batchSelClear.onclick = () => {
    document.querySelectorAll(".batch-ep-item").forEach((item) => {
      const chk = item.querySelector(".batch-ep-chk");
      if (chk) {
        chk.checked = false;
        item.classList.remove("selected");
      }
    });
    updateBatchSelectedCount();
  };
}

// 开始批量下载
const batchStartBtn = $("batch-dl-start-btn");
if (batchStartBtn) {
  batchStartBtn.onclick = async () => {
    if (isBatchDownloading) return;
    const selectedChks = [...document.querySelectorAll(".batch-ep-chk:checked")];
    if (!selectedChks.length) {
      toast("请先勾选至少一集要下载的剧集");
      return;
    }
    const subjectId = Number(state.subject?.id?.id ?? state.subject?.id ?? state.subject?.bangumi_id);
    if (!subjectId) {
      toast("未找到番剧上下文");
      return;
    }

    const prefRes = $("batch-pref-res")?.value || "";
    const prefGroup = ($("batch-pref-group")?.value || "").trim().toLowerCase();

    isBatchDownloading = true;
    batchStartBtn.disabled = true;
    batchStartBtn.textContent = "调度中…";

    const progBox = $("batch-dl-progress-box");
    const progBar = $("batch-prog-bar");
    const progStatus = $("batch-prog-status");
    const progPct = $("batch-prog-pct");
    const progLog = $("batch-prog-log");

    if (progBox) progBox.classList.remove("hidden");
    if (progLog) progLog.innerHTML = "";

    const addLog = (msg) => {
      if (!progLog) return;
      const row = document.createElement("div");
      row.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
      progLog.appendChild(row);
      progLog.scrollTop = progLog.scrollHeight;
    };

    let successCount = 0;
    let failCount = 0;

    addLog(`开始批量调度：共 ${selectedChks.length} 集，首选清晰度: ${prefRes ? prefRes + "p" : "自动最优"}`);

    for (let idx = 0; idx < selectedChks.length; idx++) {
      if (!isBatchDownloading) {
        addLog("批量下载已被用户取消");
        break;
      }
      const chk = selectedChks[idx];
      const epNum = parseFloat(chk.value);
      const pct = Math.round((idx / selectedChks.length) * 100);

      if (progBar) progBar.style.width = `${pct}%`;
      if (progPct) progPct.textContent = `${pct}%`;
      if (progStatus) progStatus.textContent = `正在解析第 ${epNum} 集资源 (${idx + 1}/${selectedChks.length})…`;

      try {
        const sel = await invoke("fetch_medias", { subjectId, ep: epNum });
        const all = sel.candidates || [];
        let avail = all.filter((c) => c.type === "available");
        if (!avail.length && all.length) avail = all;

        if (!avail.length) {
          addLog(`第 ${epNum} 集：未找到有效资源候选，跳过`);
          failCount++;
          continue;
        }

        // 匹配偏好分辨率
        let matched = avail;
        if (prefRes) {
          const resFiltered = matched.filter((c) => c.media?.properties?.resolution?.height === Number(prefRes));
          if (resFiltered.length > 0) matched = resFiltered;
        }
        // 匹配偏好字幕组
        if (prefGroup) {
          const groupFiltered = matched.filter((c) =>
            c.media?.properties?.subtitle_group?.toLowerCase().includes(prefGroup)
          );
          if (groupFiltered.length > 0) matched = groupFiltered;
        }

        const best = matched[0] || avail[0];
        const m = best.media;
        const magnet = m.download?.type === "torrent" ? m.download.uri : null;
        const httpUrl = m.download?.type === "http" ? m.download.url : null;

        if (magnet) {
          await invoke("start_torrent", { uri: magnet, title: m.title || null });
          learnPreference({ group: m.properties?.subtitle_group, res: m.properties?.resolution?.height });
          successCount++;
          addLog(`第 ${epNum} 集：已加入 BT 下载队列 (${m.title})`);
        } else if (httpUrl) {
          await invoke("cache_start", { url: httpUrl, title: m.title || "离线视频" });
          successCount++;
          addLog(`第 ${epNum} 集：已加入离线缓存队列 (${m.title})`);
        } else {
          addLog(`第 ${epNum} 集：无下载地址，跳过`);
          failCount++;
        }
      } catch (err) {
        addLog(`第 ${epNum} 集解析失败：${err}`);
        failCount++;
      }

      // 平滑节流，防并发限流
      await new Promise((resolve) => setTimeout(resolve, 350));
    }

    if (progBar) progBar.style.width = "100%";
    if (progPct) progPct.textContent = "100%";
    if (progStatus) progStatus.textContent = `批量调度完毕：成功添加 ${successCount} 集${failCount > 0 ? `，跳过/失败 ${failCount} 集` : ""}`;
    addLog(`调度任务结束：成功 ${successCount} 集，失败 ${failCount} 集`);

    isBatchDownloading = false;
    batchStartBtn.disabled = false;
    batchStartBtn.textContent = "开始批量下载";

    toast(`批量调度完成！已添加 ${successCount} 集至下载面板`, true);
    openDlPanel();
  };
}

// ---------- 追番与历史 Markdown 导出器 ----------
function exportCollectionsToMarkdown() {
  const cols = cachedCollections || [];
  if (!cols.length) {
    toast("当前暂无追番数据可供导出");
    return;
  }
  let md = `# 我的追番清单 (共 ${cols.length} 部)\n\n`;
  md += `> 导出时间：${new Date().toLocaleString()} · 由 [ani-rs](https://github.com/ani-rs/ani-rs) 追番客户端生成\n\n`;
  md += `| 封面 | 番剧名称 | 评分 | 观看进度 | 更新状态 | 放送星期 |\n`;
  md += `| :---: | :--- | :---: | :---: | :---: | :---: |\n`;

  const WEEKDAYS = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

  for (const c of cols) {
    const title = c.subject_name_cn ? `${c.subject_name_cn} (${c.subject_name})` : c.subject_name;
    const cover = c.cover_url ? `![封面](${c.cover_url})` : "无封面";
    const score = c.score ? `⭐ ${c.score.toFixed(1)}` : "暂无评分";
    const progress = c.last_watched_ep ? `看到第 ${c.last_watched_ep} 集` : "尚未开始";
    const status = c.air_status === "caught_up" ? "✅ 已追平" : (c.air_status === "pending" ? "⏳ 待看" : "追番中");
    const weekday = c.air_weekday ? (WEEKDAYS[c.air_weekday] || `周${c.air_weekday}`) : "已完结/未知";

    md += `| ${cover} | **${title.replace(/\|/g, "/")}** | ${score} | ${progress} | ${status} | ${weekday} |\n`;
  }

  navigator.clipboard.writeText(md).then(() => {
    toast(`已成功复制 ${cols.length} 部追番清单为 Markdown 表格！`, true);
  }).catch((e) => {
    toast("复制到剪贴板失败：" + e);
  });
}

async function exportHistoryToMarkdown() {
  try {
    const history = await invoke("list_full_playback_history", { limit: 300 });
    if (!history || !history.length) {
      toast("当前暂无观影历史可供导出");
      return;
    }
    let md = `# 我的观影足迹与历史 (共 ${history.length} 条)\n\n`;
    md += `> 导出时间：${new Date().toLocaleString()} · 由 [ani-rs](https://github.com/ani-rs/ani-rs) 追番客户端生成\n\n`;
    md += `| 番剧名称 | 剧集 | 进度 | 播放时长 | 状态 | 最后观看时间 |\n`;
    md += `| :--- | :---: | :---: | :---: | :---: | :---: |\n`;

    for (const h of history) {
      const title = h.subject_name || "未知动画";
      const ep = h.ep ? `第 ${h.ep} 集` : (h.title || "正片");
      const pct = h.duration_seconds > 0 ? Math.min(100, Math.round((h.position_seconds / h.duration_seconds) * 100)) : 0;
      const progress = `${pct}%`;
      const posStr = `${fmtTime(h.position_seconds)} / ${fmtTime(h.duration_seconds)}`;
      const status = h.finished ? "已看完" : "未播完";
      const dateStr = h.updated_at_ms ? new Date(h.updated_at_ms).toLocaleString() : "-";

      md += `| **${title.replace(/\|/g, "/")}** | ${ep} | ${progress} | ${posStr} | ${status} | ${dateStr} |\n`;
    }

    await navigator.clipboard.writeText(md);
    toast(`已成功复制 ${history.length} 条观影历史为 Markdown 表格！`, true);
  } catch (e) {
    toast("导出观影历史失败：" + e);
  }
}

const colExportBtn = $("col-export-btn");
if (colExportBtn) colExportBtn.onclick = exportCollectionsToMarkdown;

const historyExportBtn = $("history-export-btn");
if (historyExportBtn) historyExportBtn.onclick = exportHistoryToMarkdown;

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

$("search-btn").onclick = () => {
  hideSearchDropdown();
  doSearch();
};
const searchInput = $("search-input");
const searchClear = $("search-clear");
let searchDropdownActiveIdx = -1;

async function renderSearchDropdown(query = "") {
  const dd = $("search-dropdown");
  if (!dd) return;
  const q = query.trim().toLowerCase();

  let hist = [];
  try {
    hist = await invoke("list_search_history");
  } catch {}

  let matchedHist = hist;
  if (q) {
    matchedHist = hist.filter((k) => k.toLowerCase().includes(q));
  }

  let cols = [];
  try {
    cols = await invoke("list_subject_collections");
  } catch {}

  let html = "";
  let itemCount = 0;

  if (matchedHist && matchedHist.length > 0) {
    html += `
      <div class="search-dropdown-group">
        <div class="search-dropdown-title">
          <span>搜索历史</span>
          <span class="meta" style="font-size:10px">最近 ${matchedHist.length} 条</span>
        </div>`;
    for (const h of matchedHist.slice(0, 6)) {
      html += `
        <div class="search-dropdown-item" data-idx="${itemCount}" data-keyword="${escapeAttr(h)}">
          <div class="search-dropdown-item-left">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <span>${escapeHtml(h)}</span>
          </div>
          <button class="search-dropdown-del-btn" title="删除记录">✕</button>
        </div>`;
      itemCount++;
    }
    html += `</div>`;
  }

  if (cols && cols.length > 0) {
    html += `
      <div class="search-dropdown-group">
        <div class="search-dropdown-title">
          <span>我的追番快捷检索</span>
        </div>
        <div class="search-tag-chips">`;
    for (const c of cols.slice(0, 8)) {
      const name = c.name_cn || c.name || "动画";
      html += `<span class="search-tag-chip" data-keyword="${escapeAttr(name)}">${escapeHtml(name)}</span>`;
    }
    html += `</div></div>`;
  }

  if (!html) {
    html = `<div class="meta" style="padding:12px;text-align:center">输入番剧或动画名称并回车搜索</div>`;
  }

  dd.innerHTML = html;
  searchDropdownActiveIdx = -1;

  dd.querySelectorAll(".search-dropdown-item").forEach((item) => {
    item.onclick = (e) => {
      if (e.target.classList.contains("search-dropdown-del-btn")) return;
      const kw = item.dataset.keyword;
      searchInput.value = kw;
      if (searchClear) searchClear.classList.remove("hidden");
      hideSearchDropdown();
      doSearch();
    };
    const delBtn = item.querySelector(".search-dropdown-del-btn");
    if (delBtn) {
      delBtn.onclick = async (e) => {
        e.stopPropagation();
        const kw = item.dataset.keyword;
        try {
          await invoke("remove_search_history", { keyword: kw });
          refreshHistory();
          renderSearchDropdown(searchInput.value);
        } catch {}
      };
    }
  });

  dd.querySelectorAll(".search-tag-chip").forEach((chip) => {
    chip.onclick = () => {
      const kw = chip.dataset.keyword;
      searchInput.value = kw;
      if (searchClear) searchClear.classList.remove("hidden");
      hideSearchDropdown();
      doSearch();
    };
  });
}

function showSearchDropdown() {
  const dd = $("search-dropdown");
  if (!dd) return;
  renderSearchDropdown(searchInput.value);
  dd.classList.remove("hidden");
}

function hideSearchDropdown() {
  const dd = $("search-dropdown");
  if (dd) dd.classList.add("hidden");
  searchDropdownActiveIdx = -1;
}

if (searchInput && searchClear) {
  searchInput.addEventListener("focus", () => showSearchDropdown());
  searchInput.addEventListener("input", () => {
    searchClear.classList.toggle("hidden", !searchInput.value);
    showSearchDropdown();
  });
  searchClear.onclick = () => {
    searchInput.value = "";
    searchClear.classList.add("hidden");
    searchInput.focus();
    renderSearchDropdown("");
  };
  searchInput.addEventListener("keydown", (e) => {
    const dd = $("search-dropdown");
    if (!dd || dd.classList.contains("hidden")) {
      if (e.key === "Enter") {
        hideSearchDropdown();
        doSearch();
      }
      return;
    }
    const items = dd.querySelectorAll(".search-dropdown-item");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length > 0) {
        searchDropdownActiveIdx = (searchDropdownActiveIdx + 1) % items.length;
        items.forEach((it, idx) => it.classList.toggle("active", idx === searchDropdownActiveIdx));
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length > 0) {
        searchDropdownActiveIdx = (searchDropdownActiveIdx - 1 + items.length) % items.length;
        items.forEach((it, idx) => it.classList.toggle("active", idx === searchDropdownActiveIdx));
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (searchDropdownActiveIdx >= 0 && items[searchDropdownActiveIdx]) {
        searchInput.value = items[searchDropdownActiveIdx].dataset.keyword;
      }
      hideSearchDropdown();
      doSearch();
    } else if (e.key === "Escape") {
      hideSearchDropdown();
    }
  });
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-input-wrapper")) {
    hideSearchDropdown();
  }
});
const brandEl = document.querySelector(".brand");
if (brandEl) {
  brandEl.onclick = () => {
    state.subject = null;
    showView("subjects");
    showHomeSection();
  };
}
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
const dlBtn = $("dl-btn");
if (dlBtn) {
  dlBtn.onclick = () => {
    if (dlVisible) {
      dlVisible = false;
      $("download-panel").classList.add("hidden");
    } else {
      openDlPanel();
    }
  };
}
const clearContinueBtn = $("clear-continue");
if (clearContinueBtn) {
  clearContinueBtn.onclick = async () => {
    try {
      await invoke("clear_playback_history");
      toast("播放历史已清空", true);
      loadContinueWatching();
    } catch (e) {
      toast("清空历史失败：" + e);
    }
  };
}

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

// 启动：进入首页 + 预查下载任务更新角标
showHomeSection();
invoke("list_downloads")
  .then((tasks) => {
    dlTasks.clear();
    tasks.forEach((t) => dlTasks.set(t.id, t));
    renderDownloads();
  })
  .catch(() => {});

// ---------- 设置界面 ----------

const settingsState = { loaded: false, data: null, sources: [], paths: {} };

function showView(name) {
  // 离开播放器视图时必须销毁媒体（display:none 不会暂停，音频会在后台继续播），
  // 销毁前保存一次进度（v.load() 之后 duration 就没了）
  if (name !== "player" && !$("view-player").classList.contains("hidden")) {
    saveProgress(false);
    destroyPlayer();
  }
  if (name !== "detail") {
    document.documentElement.style.removeProperty("--subject-accent");
    document.documentElement.style.removeProperty("--subject-accent-glow");
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
  if ($("set-sub-lang")) {
    $("set-sub-lang").value = d.selector.subtitle_lang ?? "any";
    $("set-sub-lang").onchange = () => {
      d.selector.subtitle_lang = $("set-sub-lang").value;
      scheduleSave();
    };
  }
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

  // --- 备份与恢复 ---
  const exportBtn = $("btn-export-backup");
  if (exportBtn) {
    exportBtn.onclick = async () => {
      try {
        exportBtn.disabled = true;
        exportBtn.textContent = "导出中…";
        const backup = await invoke("export_user_data");
        const jsonStr = JSON.stringify(backup, null, 2);
        const blob = new Blob([jsonStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const nowStr = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = `ani-rs-backup-${nowStr}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast("追番与播放历史备份已导出！", true);
      } catch (err) {
        toast("导出备份失败：" + err);
      } finally {
        exportBtn.disabled = false;
        exportBtn.textContent = "⤓ 导出数据备份 (JSON)";
      }
    };
  }

  const importBtn = $("btn-import-backup");
  const fileInput = $("backup-file-input");
  if (importBtn && fileInput) {
    importBtn.onclick = () => fileInput.click();
    fileInput.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const backup = JSON.parse(text);
        if (!backup.collections && !backup.playback_history) {
          throw new Error("无效的备份文件格式（缺少 collections/playback_history）");
        }
        const stats = await invoke("import_user_data", { backup });
        toast(`导入成功：${stats.collections_imported} 条追番，${stats.playback_imported} 条播放历史已合并！`, true);
        const statusEl = $("backup-status");
        if (statusEl) {
          statusEl.textContent = `最近导入：${file.name}（${stats.collections_imported} 追番 / ${stats.playback_imported} 历史）`;
        }
        loadCollections();
        loadContinueWatching();
      } catch (err) {
        toast("导入备份失败：" + err);
      } finally {
        fileInput.value = "";
      }
    };
  }

  // --- 检查更新 ---
  const checkBtn = $("btn-check-update");
  if (checkBtn) {
    checkBtn.onclick = async () => {
      const statusEl = $("update-status");
      const banner = $("update-banner");
      const titleEl = $("update-title");
      const msgEl = $("update-msg");
      const openRelBtn = $("btn-open-release");
      if (statusEl) statusEl.textContent = "检查中…";
      checkBtn.disabled = true;
      try {
        const info = await invoke("check_update");
        if (info.has_update) {
          if (statusEl) statusEl.textContent = "";
          if (banner) banner.classList.remove("hidden");
          if (titleEl) titleEl.textContent = `发现新版本 v${info.latest_version}（当前 v${info.current_version}）`;
          if (msgEl) msgEl.textContent = info.release_notes || "新版本已发布，点击下方按钮前往下载。";
          if (openRelBtn) {
            openRelBtn.onclick = () => invoke("open_url", { url: info.release_url });
          }
          toast(`发现新版本 v${info.latest_version}！`, true);
        } else {
          if (statusEl) statusEl.textContent = `已是最新版本 (v${info.current_version}) ✓`;
          if (banner) banner.classList.add("hidden");
          toast("当前已是最新版本", true);
        }
      } catch (err) {
        if (statusEl) statusEl.textContent = "检查失败";
        toast("检查更新失败：" + err);
      } finally {
        checkBtn.disabled = false;
      }
    };
  }

  // --- 关于 ---
  $("path-settings").textContent = settingsState.paths.settings ?? "";
  $("path-db").textContent = settingsState.paths.db ?? "";
  $("path-downloads").textContent = settingsState.paths.downloads ?? "";
  document.querySelectorAll("[data-reveal]").forEach((b) => {
    b.onclick = () => invoke("reveal_path", { path: settingsState.paths[b.dataset.reveal] })
      .catch((e) => toast("打开失败：" + e));
  });

  // --- 外观与主题 ---
  bindAppearanceSettings();
}

async function refreshBangumiStatus() {
  try {
    const st = await invoke("bangumi_status");
    $("bg-status").textContent = st.logged_in ? `✓ 已登录：${st.nickname}` : "";
    $("set-bg-logout").classList.toggle("hidden", !st.logged_in);
  } catch (e) { /* 状态获取失败不阻塞设置页 */ }
}

// ---------- 外观与主题系统 (Theme & Accent Palettes) ----------

function applyTheme(theme, save = true) {
  document.documentElement.setAttribute("data-theme", theme);
  if (save) {
    localStorage.setItem("ani_theme_mode", theme);
  }
  document.querySelectorAll(".theme-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.theme === theme);
  });
}

function applyAccent(accent, save = true) {
  document.documentElement.setAttribute("data-accent", accent);
  if (save) {
    localStorage.setItem("ani_accent_color", accent);
  }
  document.querySelectorAll(".accent-pill").forEach((pill) => {
    pill.classList.toggle("active", pill.dataset.accent === accent);
  });
}

function bindAppearanceSettings() {
  const currentTheme = localStorage.getItem("ani_theme_mode") || "dark";
  const currentAccent = localStorage.getItem("ani_accent_color") || "violet";

  document.querySelectorAll(".theme-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.theme === currentTheme);
    card.onclick = () => {
      applyTheme(card.dataset.theme);
      toast(`已切换主题：${card.querySelector(".theme-name")?.textContent || card.dataset.theme}`, true);
    };
  });

  document.querySelectorAll(".accent-pill").forEach((pill) => {
    pill.classList.toggle("active", pill.dataset.accent === currentAccent);
    pill.onclick = () => {
      applyAccent(pill.dataset.accent);
      toast(`强调色已设为：${pill.querySelector(".accent-name")?.textContent || pill.dataset.accent}`, true);
    };
  });
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
  const openCacheRootBtn = $("btn-open-cache-root");
  if (openCacheRootBtn && !openCacheRootBtn.__bound) {
    openCacheRootBtn.__bound = true;
    openCacheRootBtn.onclick = async () => {
      try {
        const rootPath = await invoke("cache_root_path");
        await invoke("reveal_path", { path: rootPath });
      } catch (err) {
        toast("打开缓存目录失败：" + err);
      }
    };
  }

  const clearAllCachesBtn = $("btn-clear-all-caches");
  if (clearAllCachesBtn && !clearAllCachesBtn.__bound) {
    clearAllCachesBtn.__bound = true;
    clearAllCachesBtn.onclick = async () => {
      if (!confirm("确定要清空全部离线缓存文件和记录吗？此操作不可恢复。")) return;
      try {
        clearAllCachesBtn.disabled = true;
        clearAllCachesBtn.textContent = "清空中…";
        await invoke("cache_clear_all");
        cacheDownloading.clear();
        await refreshCacheList();
        toast("已清空全部离线缓存", true);
      } catch (err) {
        toast("清空缓存失败：" + err);
      } finally {
        clearAllCachesBtn.disabled = false;
        clearAllCachesBtn.textContent = "🗑 清空全部缓存";
      }
    };
  }

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


function getUserDanmakuKey() {
  const bgmId = state.subject?.id?.id ?? state.subject?.bangumi_id ?? "gen";
  const ep = state.currentEp != null ? state.currentEp : "all";
  return `ani_user_dm_${bgmId}_${ep}`;
}

function loadStoredUserDanmaku() {
  try {
    const raw = localStorage.getItem(getUserDanmakuKey());
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveUserDanmaku(evt) {
  try {
    const list = loadStoredUserDanmaku();
    list.push(evt);
    localStorage.setItem(getUserDanmakuKey(), JSON.stringify(list));
  } catch {}
}

function renderDanmakuHeatmap(events, duration) {
  const wrap = $("danmaku-heatmap-wrap");
  const canvas = $("danmaku-heatmap-canvas");
  if (!wrap || !canvas || !events || !events.length || !duration || !isFinite(duration) || duration <= 0) {
    if (wrap) wrap.classList.add("hidden");
    return;
  }

  const NUM_BINS = 100;
  const binSec = duration / NUM_BINS;
  const bins = new Array(NUM_BINS).fill(0);

  for (const e of events) {
    const sec = (e.time_ms || 0) / 1000;
    if (sec >= 0 && sec <= duration) {
      const idx = Math.min(NUM_BINS - 1, Math.floor(sec / binSec));
      bins[idx]++;
    }
  }

  const maxCount = Math.max(...bins);
  if (maxCount === 0) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 600;
  const h = canvas.clientHeight || 32;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(dpr, dpr);

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(244, 63, 94, 0.75)");
  grad.addColorStop(0.4, "rgba(139, 92, 246, 0.55)");
  grad.addColorStop(1, "rgba(56, 189, 248, 0.12)");

  ctx.beginPath();
  ctx.moveTo(0, h);

  const stepX = w / (NUM_BINS - 1);
  for (let i = 0; i < NUM_BINS; i++) {
    const norm = bins[i] / maxCount;
    const scaled = Math.pow(norm, 0.7);
    const x = i * stepX;
    const y = h - scaled * (h - 4);
    if (i === 0) {
      ctx.lineTo(x, y);
    } else {
      const prevX = (i - 1) * stepX;
      const prevNorm = bins[i - 1] / maxCount;
      const prevY = h - Math.pow(prevNorm, 0.7) * (h - 4);
      const cx = (prevX + x) / 2;
      ctx.bezierCurveTo(cx, prevY, cx, y, x, y);
    }
  }

  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
  ctx.beginPath();
  for (let i = 0; i < NUM_BINS; i++) {
    const norm = bins[i] / maxCount;
    const scaled = Math.pow(norm, 0.7);
    const x = i * stepX;
    const y = h - scaled * (h - 4);
    if (i === 0) ctx.moveTo(x, y);
    else {
      const prevX = (i - 1) * stepX;
      const prevNorm = bins[i - 1] / maxCount;
      const prevY = h - Math.pow(prevNorm, 0.7) * (h - 4);
      const cx = (prevX + x) / 2;
      ctx.bezierCurveTo(cx, prevY, cx, y, x, y);
    }
  }
  ctx.stroke();
  ctx.restore();

  const peaksContainer = $("heatmap-peaks");
  if (peaksContainer) {
    peaksContainer.innerHTML = "";
    const peakIndices = [];
    const threshold = maxCount * 0.4;
    for (let i = 1; i < NUM_BINS - 1; i++) {
      if (bins[i] >= threshold && bins[i] >= bins[i - 1] && bins[i] >= bins[i + 1]) {
        peakIndices.push(i);
      }
    }
    peakIndices.sort((a, b) => bins[b] - bins[a]);

    const selected = [];
    for (const idx of peakIndices) {
      if (!selected.some((s) => Math.abs(s - idx) < 8)) {
        selected.push(idx);
        if (selected.length >= 3) break;
      }
    }
    selected.sort((a, b) => a - b);

    for (const idx of selected) {
      const peakTime = Math.round(idx * binSec);
      const count = bins[idx];
      const btn = document.createElement("button");
      btn.className = "peak-badge";
      btn.innerHTML = `🔥 ${fmtTime(peakTime)} <span style="opacity:0.8;font-size:9.5px">(${count}条)</span>`;
      btn.title = `点击直达名场面高能时刻（${fmtTime(peakTime)}，本段约 ${count} 条弹幕）`;
      btn.onclick = (e) => {
        e.stopPropagation();
        const v = $("video");
        if (v) {
          v.currentTime = Math.max(0, peakTime - 2);
          showPlayerOsd(`🔥 已直达高能时刻：${fmtTime(peakTime)}`);
        }
      };
      peaksContainer.appendChild(btn);
    }
  }

  const track = $("heatmap-track");
  const hoverTip = $("heatmap-hover-tip");
  if (track) {
    track.onmousemove = (e) => {
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const hoverSec = ratio * duration;
      const binIdx = Math.min(NUM_BINS - 1, Math.floor(hoverSec / binSec));
      const count = bins[binIdx] || 0;
      if (hoverTip) {
        hoverTip.classList.remove("hidden");
        hoverTip.style.left = `${ratio * 100}%`;
        hoverTip.textContent = `${fmtTime(hoverSec)} · ${count} 条弹幕`;
      }
    };
    track.onmouseleave = () => {
      if (hoverTip) hoverTip.classList.add("hidden");
    };
    track.onclick = (e) => {
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const targetSec = ratio * duration;
      const v = $("video");
      if (v) {
        v.currentTime = targetSec;
        DanmakuOverlay.seekTo(targetSec);
        showPlayerOsd(`跳转至 ${fmtTime(targetSec)}`);
      }
    };
  }
}

// ---------- 弹幕渲染层（Canvas 覆盖层；过滤已在后端完成，这里只管画） ----------
const DanmakuOverlay = (() => {
  let scrollMs = parseInt(localStorage.getItem("ani_dm_speed") || "6000", 10);
  let staticMs = 4000;
  const MAX_ITEMS = 100;
  let events = [];   // 按时间升序
  let cursor = 0;    // 下一条待上屏的下标
  let items = [];    // 活动中的弹幕 {text,color,mode,lane,born,width}
  let scrollLanes = [], staticLanes = [];  // 各轨道的占用截止时刻（video 时间秒）
  let raf = null, lastT = 0, W = 0, H = 0, fontPx = 24;
  let timeOffsetSec = 0;
  let opacity = 0.5;
  let areaRatio = parseFloat(localStorage.getItem("ani_dm_area") || "0.5");
  let fontScale = localStorage.getItem("ani_dm_size") || "md";

  const cv = () => $("danmaku-canvas");
  const vid = () => $("video");

  let dpr = 1;

  function resize() {
    const c = cv(), v = vid();
    if (!c || !v) return;
    const isFs = !!document.fullscreenElement;
    dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = v.getBoundingClientRect();
    if (isFs && rect.width > 0 && rect.height > 0) {
      W = rect.width;
      H = rect.height;
      c.style.left = `${rect.left}px`;
      c.style.top = `${rect.top}px`;
      c.style.width = `${rect.width}px`;
      c.style.height = `${rect.height}px`;
    } else {
      W = v.clientWidth || window.innerWidth;
      H = v.clientHeight || window.innerHeight;
      c.style.left = "0";
      c.style.top = "0";
      c.style.width = "100%";
      c.style.height = "100%";
    }
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    const mult = fontScale === "sm" ? 0.75 : fontScale === "lg" ? 1.3 : 1.0;
    fontPx = Math.round(Math.max(16, Math.min(36, Math.round(H / 22))) * mult);
  }

  function resetLanes() {
    const scrollLaneCount = Math.max(2, Math.floor((H * areaRatio) / (fontPx + 4)));
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
      ? takeLane(scrollLanes, now, scrollMs / 1000)
      : takeLane(staticLanes, now, staticMs / 1000);
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
    while (cursor < events.length && (events[cursor].time_ms / 1000 + timeOffsetSec) <= now) {
      const t = events[cursor].time_ms / 1000 + timeOffsetSec;
      if (t > lastT) spawn(events[cursor], now);
      cursor++;
    }
    lastT = now;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.save();
    ctx.scale(dpr, dpr);
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
        x = W - (age / scrollMs) * (W + w);
        y = it.lane * (fontPx + 4) + 2;
        if (x < -w) continue;
      } else {
        if (age > staticMs) continue;
        alpha = age > staticMs - 600 ? (staticMs - age) / 600 : 1;
        y = it.mode === "top" ? it.lane * (fontPx + 4) + 2 : H - (it.lane + 1) * (fontPx + 4) - 6;
        x = (W - w) / 2;
      }
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha * opacity));
      ctx.strokeText(it.text, x, y);
      ctx.fillStyle = "#" + (it.color || 0xffffff).toString(16).padStart(6, "0");
      ctx.fillText(it.text, x, y);
      next.push(it);
    }
    ctx.restore();
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
      timeOffsetSec = 0;
      const delayEl = $("dm-delay-val");
      if (delayEl) delayEl.textContent = "0.0s";
      const userList = loadStoredUserDanmaku();
      const merged = [...(list || []), ...userList];
      events = merged.sort((a, b) => a.time_ms - b.time_ms);
      danmakuTimeline = events;
      this.setEnabled(this.enabled);
      const v = vid();
      if (v && v.duration && isFinite(v.duration) && v.duration > 0) {
        renderDanmakuHeatmap(events, v.duration);
      }
    },
    clear() {
      events = []; cursor = 0; items = []; lastT = 0;
      const c = cv();
      if (c) c.getContext("2d").clearRect(0, 0, c.width, c.height);
      const wrap = $("danmaku-heatmap-wrap");
      if (wrap) wrap.classList.add("hidden");
    },
    /** seek 后重定位游标并清空已上屏内容 */
    seekTo(sec) {
      lastT = sec;
      items = [];
      let lo = 0, hi = events.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        (events[mid].time_ms / 1000 + timeOffsetSec) <= sec ? lo = mid + 1 : hi = mid;
      }
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
    adjustOffset(deltaSec) {
      timeOffsetSec = Math.round((timeOffsetSec + deltaSec) * 10) / 10;
      this.seekTo(vid().currentTime);
      const sign = timeOffsetSec > 0 ? "+" : "";
      const delayEl = $("dm-delay-val");
      if (delayEl) delayEl.textContent = `${sign}${timeOffsetSec.toFixed(1)}s`;
      showPlayerOsd(`弹幕时间微调：${sign}${timeOffsetSec.toFixed(1)}s`);
    },
    resetOffset() {
      timeOffsetSec = 0.0;
      this.seekTo(vid().currentTime);
      const delayEl = $("dm-delay-val");
      if (delayEl) delayEl.textContent = "0.0s";
      showPlayerOsd("弹幕时间已重置为 0.0s");
    },
    setOpacity(val) {
      opacity = val;
    },
    setAreaRatio(ratio) {
      areaRatio = ratio;
      resetLanes();
    },
    setFontScale(scale) {
      fontScale = scale;
      resize();
      resetLanes();
    },
    setSpeedMs(ms) {
      scrollMs = ms;
    },
    /** 即时添加单条弹幕并实时上屏 */
    addEvent(event) {
      if (!event || typeof event.time_ms !== "number") return;
      let lo = 0, hi = events.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        events[mid].time_ms <= event.time_ms ? (lo = mid + 1) : (hi = mid);
      }
      events.splice(lo, 0, event);
      if (lo <= cursor) {
        cursor++;
      }
      const v = vid();
      if (v && this.enabled) {
        const now = v.currentTime;
        spawn(event, now);
        ensureRunning();
      }
    },
    /** 获取当前所有弹幕事件 */
    getEvents() {
      return events;
    },
    enabled: false,
    resize,
  };
})();

let playerOsdTimer = null;
function showPlayerOsd(msg) {
  const osd = $("player-osd");
  if (osd) {
    osd.textContent = msg;
    osd.classList.remove("hidden");
    clearTimeout(playerOsdTimer);
    playerOsdTimer = setTimeout(() => osd.classList.add("hidden"), 1800);
  } else {
    toast(msg, true);
  }
}

let statsOsdVisible = false;

function toggleStatsOsd(force) {
  const osd = $("player-stats-osd");
  if (!osd) return;
  statsOsdVisible = typeof force === "boolean" ? force : !statsOsdVisible;
  osd.classList.toggle("hidden", !statsOsdVisible);
  if (statsOsdVisible) {
    updateStatsOsd();
  }
}

function updateStatsOsd() {
  if (!statsOsdVisible) return;
  const grid = $("stats-osd-grid");
  const v = $("video");
  if (!grid || !v) return;

  const res = v.videoWidth ? `${v.videoWidth} × ${v.videoHeight}` : "检测中…";
  const vp = `${v.clientWidth} × ${v.clientHeight}`;
  const cur = fmtTime(v.currentTime);
  const dur = fmtTime(v.duration);
  const rate = `${v.playbackRate}x`;
  const vol = `${Math.round(v.volume * 100)}%${v.muted ? " (静音)" : ""}`;

  let proto = "直链播放 (HTTP)";
  const src = v.currentSrc || v.src || currentMediaUrl || "";
  if (src.includes("anibt.localhost")) proto = "BT 边下边播 (anibt://)";
  else if (src.includes("anicache.localhost")) proto = "离线缓存 (anicache://)";
  else if (src.startsWith("blob:") || src.includes(".m3u8")) proto = "HLS 流式分段 (hls.js)";

  let bufferedPct = "0%";
  if (v.duration > 0 && v.buffered.length > 0) {
    let totalBuf = 0;
    for (let i = 0; i < v.buffered.length; i++) {
      totalBuf += v.buffered.end(i) - v.buffered.start(i);
    }
    bufferedPct = `${Math.min(100, Math.round((totalBuf / v.duration) * 100))}%`;
  }

  let dropInfo = "—";
  if (typeof v.getVideoPlaybackQuality === "function") {
    const q = v.getVideoPlaybackQuality();
    const dropped = q.droppedVideoFrames || 0;
    const total = q.totalVideoFrames || 0;
    dropInfo = total > 0 ? `${dropped} / ${total} (${((dropped / total) * 100).toFixed(1)}%)` : "0";
  }

  const dmCount = typeof danmakuTimeline !== "undefined" && danmakuTimeline ? danmakuTimeline.length : 0;

  grid.innerHTML = `
    <div class="stats-row"><span class="stats-label">媒体协议</span><span class="stats-val">${escapeHtml(proto)}</span></div>
    <div class="stats-row"><span class="stats-label">视频分辨率</span><span class="stats-val">${res}</span></div>
    <div class="stats-row"><span class="stats-label">视口尺寸</span><span class="stats-val">${vp}</span></div>
    <div class="stats-row"><span class="stats-label">播放进度</span><span class="stats-val">${cur} / ${dur}</span></div>
    <div class="stats-row"><span class="stats-label">缓冲进度</span><span class="stats-val">${bufferedPct}</span></div>
    <div class="stats-row"><span class="stats-label">丢帧统计</span><span class="stats-val">${dropInfo}</span></div>
    <div class="stats-row"><span class="stats-label">当前倍速</span><span class="stats-val">${rate}</span></div>
    <div class="stats-row"><span class="stats-label">音频音量</span><span class="stats-val">${vol}</span></div>
    <div class="stats-row"><span class="stats-label">弹幕池数量</span><span class="stats-val">${dmCount > 0 ? dmCount + " 条" : "未加载"}</span></div>
  `;
}

let hls = null;
let playerPrev = "subjects";
let currentMediaKey = null;
let currentMediaUrl = "";
let resumeListener = null;
let lastSavedSec = -10;
// 应用内 BT 播放（anibt://）失败时回落外部播放器用的本地路径
let btFallbackPath = null;
let btErrorListener = null;
const RATES = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];

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

let autoPlayTimer = null;
let isSwitchingEp = false;

function getNextEpisode() {
  if (!state.episodes || !state.episodes.length || state.currentEp == null) return null;
  const mains = state.episodes.filter((e) => e.kind === "main");
  const list = mains.length ? mains : state.episodes;
  const sorted = [...list].sort((a, b) => a.ep - b.ep);
  return sorted.find((e) => e.ep > state.currentEp) || null;
}

function updatePlayerNextBtn() {
  const btn = $("player-next-ep");
  if (!btn) return;
  const nextEp = getNextEpisode();
  if (nextEp) {
    btn.classList.remove("hidden");
    btn.textContent = `下一集 ${nextEp.ep} ⏭`;
    btn.title = `播放第 ${nextEp.ep} 集 (${nextEp.display_title || ""}) (快捷键 N)`;
  } else {
    btn.classList.add("hidden");
  }
}

async function playNextEpisode() {
  const nextEp = getNextEpisode();
  if (!nextEp) {
    toast("已经是最后一集了");
    showPlayerOsd("已经是最后一集了");
    return;
  }
  if (isSwitchingEp) return;
  isSwitchingEp = true;
  clearTimeout(autoPlayTimer);
  autoPlayTimer = null;
  const epNo = nextEp.ep;
  const epId = Number(nextEp.id?.id ?? nextEp.id);
  const subjectId = Number(state.subject?.id?.id ?? state.subject?.id ?? state.subject?.bangumi_id);
  state.currentEp = epNo;
  state.currentEpId = epId;

  const chips = $("episodes")?.querySelectorAll(".ep");
  if (chips) {
    chips.forEach((c) => {
      const noEl = c.querySelector(".epno");
      if (noEl && parseFloat(noEl.textContent) === epNo) {
        c.classList.add("active");
      } else {
        c.classList.remove("active");
      }
    });
  }

  updatePlayerNextBtn();
  showPlayerOsd(`准备第 ${epNo} 集：${nextEp.display_title}…`);
  toast(`正在准备第 ${epNo} 集：${nextEp.display_title}…`);
  try {
    const sel = await invoke("fetch_medias", { subjectId, ep: epNo });
    state.candidates = sel.candidates;
    const best = sel.candidates.find((c) => c.type === "available") || sel.candidates[0];
    if (!best) {
      toast(`第 ${epNo} 集暂无可用资源`);
      return;
    }
    const m = best.media;
    const magnet = m.download?.type === "torrent" ? m.download.uri : null;
    const httpUrl = m.download?.type === "http" ? m.download.url : null;
    if (httpUrl) {
      openPlayer(httpUrl, m.title);
    } else if (magnet) {
      startStream(magnet, m.title);
    } else {
      toast(`第 ${epNo} 集未找到可播放链接`);
    }
  } catch (err) {
    toast(`加载第 ${epNo} 集失败：` + err);
  } finally {
    isSwitchingEp = false;
  }
}

function getPreviousEpisode() {
  if (!state.episodes || !state.episodes.length || state.currentEp == null) return null;
  const mains = state.episodes.filter((e) => e.kind === "main");
  const list = mains.length ? mains : state.episodes;
  const sorted = [...list].sort((a, b) => b.ep - a.ep);
  return sorted.find((e) => e.ep < state.currentEp) || null;
}

async function playPreviousEpisode() {
  const prevEp = getPreviousEpisode();
  if (!prevEp) {
    toast("已经是第一集了");
    showPlayerOsd("已经是第一集了");
    return;
  }
  if (isSwitchingEp) return;
  isSwitchingEp = true;
  clearTimeout(autoPlayTimer);
  autoPlayTimer = null;
  const epNo = prevEp.ep;
  const epId = Number(prevEp.id?.id ?? prevEp.id);
  const subjectId = Number(state.subject?.id?.id ?? state.subject?.id ?? state.subject?.bangumi_id);
  state.currentEp = epNo;
  state.currentEpId = epId;

  const chips = $("episodes")?.querySelectorAll(".ep");
  if (chips) {
    chips.forEach((c) => {
      const noEl = c.querySelector(".epno");
      if (noEl && parseFloat(noEl.textContent) === epNo) {
        c.classList.add("active");
      } else {
        c.classList.remove("active");
      }
    });
  }

  updatePlayerNextBtn();
  showPlayerOsd(`准备第 ${epNo} 集：${prevEp.display_title}…`);
  toast(`正在准备第 ${epNo} 集：${prevEp.display_title}…`);
  try {
    const sel = await invoke("fetch_medias", { subjectId, ep: epNo });
    state.candidates = sel.candidates;
    const best = sel.candidates.find((c) => c.type === "available") || sel.candidates[0];
    if (!best) {
      toast(`第 ${epNo} 集暂无可用资源`);
      return;
    }
    const m = best.media;
    const magnet = m.download?.type === "torrent" ? m.download.uri : null;
    const httpUrl = m.download?.type === "http" ? m.download.url : null;
    if (httpUrl) {
      openPlayer(httpUrl, m.title);
    } else if (magnet) {
      startStream(magnet, m.title);
    } else {
      toast(`第 ${epNo} 集未找到可播放链接`);
    }
  } catch (err) {
    toast(`加载第 ${epNo} 集失败：` + err);
  } finally {
    isSwitchingEp = false;
  }
}

function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const sTitle = state.subject?.display_title || state.subject?.name_cn || state.subject?.name || "动漫播放";
  const epTitle = state.currentEp != null ? `第 ${state.currentEp} 集` : "";
  const artist = "ani-rs 追番";
  const artwork = [];
  const cover = state.subject?.cover_url || state.subject?.images?.large || state.subject?.images?.common;
  if (cover) {
    artwork.push({
      src: cover,
      sizes: "512x512",
      type: "image/jpeg",
    });
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: epTitle ? `${sTitle} - ${epTitle}` : sTitle,
    artist,
    album: sTitle,
    artwork,
  });

  try {
    navigator.mediaSession.setActionHandler("play", () => {
      $("video")?.play().catch(() => {});
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      $("video")?.pause();
    });
    navigator.mediaSession.setActionHandler("seekbackward", (details) => {
      const v = $("video");
      if (v) v.currentTime = Math.max(0, v.currentTime - (details.seekOffset || 10));
    });
    navigator.mediaSession.setActionHandler("seekforward", (details) => {
      const v = $("video");
      if (v) v.currentTime = Math.min(v.duration || Infinity, v.currentTime + (details.seekOffset || 10));
    });
    navigator.mediaSession.setActionHandler("previoustrack", () => {
      playPreviousEpisode();
    });
    navigator.mediaSession.setActionHandler("nexttrack", () => {
      playNextEpisode();
    });
  } catch (_) {}
}

// ---------- 播放器快速选集抽屉 (Player Episode Drawer) ----------

let epDrawerKind = "all";

function toggleEpDrawer(show) {
  const drawer = $("player-ep-drawer");
  if (!drawer) return;
  const isHidden = drawer.classList.contains("hidden");
  const targetShow = show !== undefined ? show : isHidden;

  if (targetShow) {
    drawer.classList.remove("hidden");
    renderEpDrawer();
  } else {
    drawer.classList.add("hidden");
  }
}

function renderEpDrawer() {
  const listEl = $("ep-drawer-list");
  const countEl = $("ep-drawer-count");
  if (!listEl) return;

  const episodes = state.episodes || [];
  if (!episodes.length) {
    listEl.innerHTML = `<div class="ep-drawer-empty">当前播放未关联番剧剧集列表</div>`;
    if (countEl) countEl.textContent = "";
    return;
  }

  // 过滤剧集类型
  let filtered = episodes;
  if (epDrawerKind === "main") {
    filtered = episodes.filter((e) => e.kind === "main");
  } else if (epDrawerKind === "sp") {
    filtered = episodes.filter((e) => e.kind !== "main");
  }
  // 按集数排序
  const sorted = [...filtered].sort((a, b) => a.ep - b.ep);

  if (countEl) countEl.textContent = `(${sorted.length}/${episodes.length})`;

  listEl.innerHTML = "";
  if (!sorted.length) {
    listEl.innerHTML = `<div class="ep-drawer-empty">该分类下暂无剧集</div>`;
    return;
  }

  sorted.forEach((ep) => {
    const epNo = ep.ep;
    const epId = Number(ep.id?.id ?? ep.id);
    const isPlaying = state.currentEp != null && Math.abs(state.currentEp - epNo) < 0.01;
    const isWatched = state.watchedEps && state.watchedEps.has(epId);

    const item = document.createElement("div");
    item.className = `ep-drawer-item${isPlaying ? " playing" : ""}`;
    item.innerHTML = `
      <div class="ep-drawer-item-left">
        <span class="ep-drawer-item-no">${ep.kind === "main" ? epNo : `SP${epNo}`}</span>
        <span class="ep-drawer-item-title" title="${escapeAttr(ep.display_title || `第 ${epNo} 集`)}">${escapeHtml(ep.display_title || `第 ${epNo} 集`)}</span>
      </div>
      ${isPlaying
        ? `<span class="ep-drawer-item-badge now-playing">播放中</span>`
        : isWatched
        ? `<span class="ep-drawer-item-badge watched-check" title="已看完">✓</span>`
        : ""
      }
    `;

    item.onclick = () => {
      if (isPlaying) {
        toast(`正在播放第 ${epNo} 集`, true);
        return;
      }
      playDrawerEpisode(ep);
    };

    listEl.appendChild(item);
  });

  // 自动滚动到当前播放集的位置
  const activeEl = listEl.querySelector(".ep-drawer-item.playing");
  if (activeEl) {
    setTimeout(() => {
      activeEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 50);
  }
}

async function playDrawerEpisode(ep) {
  if (isSwitchingEp) return;
  isSwitchingEp = true;
  clearTimeout(autoPlayTimer);
  autoPlayTimer = null;

  const epNo = ep.ep;
  const epId = Number(ep.id?.id ?? ep.id);
  const subjectId = Number(state.subject?.id?.id ?? state.subject?.id ?? state.subject?.bangumi_id);
  state.currentEp = epNo;
  state.currentEpId = epId;

  // 同步详情页芯片高亮
  const chips = $("episodes")?.querySelectorAll(".ep");
  if (chips) {
    chips.forEach((c) => {
      const noEl = c.querySelector(".epno");
      if (noEl && parseFloat(noEl.textContent) === epNo) {
        c.classList.add("active");
      } else {
        c.classList.remove("active");
      }
    });
  }

  updatePlayerNextBtn();
  renderEpDrawer();
  showPlayerOsd(`换集：第 ${epNo} 集 ${ep.display_title || ""}…`);
  toast(`正在加载第 ${epNo} 集：${ep.display_title || ""}…`);

  try {
    const sel = await invoke("fetch_medias", { subjectId, ep: epNo });
    state.candidates = sel.candidates;
    const best = sel.candidates.find((c) => c.type === "available") || sel.candidates[0];
    if (!best) {
      toast(`第 ${epNo} 集暂无可用资源`);
      return;
    }
    const m = best.media;
    const magnet = m.download?.type === "torrent" ? m.download.uri : null;
    const httpUrl = m.download?.type === "http" ? m.download.url : null;
    if (httpUrl) {
      openPlayer(httpUrl, m.title);
    } else if (magnet) {
      startStream(magnet, m.title);
    } else {
      toast(`第 ${epNo} 集未找到可播放链接`);
    }
  } catch (err) {
    toast(`加载第 ${epNo} 集失败：` + err);
  } finally {
    isSwitchingEp = false;
  }
}

function saveProgress(finished = false) {
  if (!currentMediaKey) return;
  const v = $("video");
  if (!v.duration || !isFinite(v.duration)) return;
  const title = $("player-title")?.textContent || "";
  const subjectName = state.subject?.display_title || state.subject?.name_cn || "";
  const coverUrl = state.subject?.cover_url || null;
  invoke("save_progress", {
    payload: {
      key: currentMediaKey,
      positionSeconds: v.currentTime,
      durationSeconds: v.duration,
      finished,
      title,
      subjectName,
      coverUrl,
      mediaUrl: currentMediaUrl || "",
    },
  }).catch(() => {});

  if (finished && state.subject) {
    let epId = state.currentEpId;
    let epNo = state.currentEp;
    if (!epId && state.episodes && epNo != null) {
      const found = state.episodes.find((e) => Math.abs(e.ep - epNo) < 0.01);
      if (found) epId = Number(found.id?.id ?? found.id);
    }
    if (epId) {
      const subjectId = Number(state.subject?.id?.id ?? state.subject?.id ?? state.subject?.bangumi_id);
      invoke("mark_episode_watched", {
        episodeId: Number(epId),
        subjectId,
        ep: Number(epNo ?? 0),
        watched: true,
      }).then(() => {
        state.watchedEps.add(Number(epId));
        const activeChip = $("episodes")?.querySelector(".ep.active");
        if (activeChip) {
          activeChip.classList.add("watched");
          if (!activeChip.querySelector(".ep-check")) {
            const check = document.createElement("span");
            check.className = "ep-check";
            check.textContent = "✓";
            activeChip.appendChild(check);
          }
        }
      }).catch(() => {});
    }
  }
}

// ---------- 播放器视效调谐、动漫滤镜、跳过片头与 A-B 循环 ----------
const visualState = {
  aspect: localStorage.getItem("ani_visual_aspect") || "default",
  mirror: false,
  rotateDeg: 0,
  filter: localStorage.getItem("ani_visual_filter") || "none",
  autoSkipOp: localStorage.getItem("ani_auto_skip_op") === "1",
  autoSkipEd: parseInt(localStorage.getItem("ani_auto_skip_ed") || "0", 10),
  abLoop: { a: null, b: null, active: false },
};

let opAutoSkipped = false;
let edAutoSkipped = false;

const ASPECT_LABELS = {
  default: "自适应",
  "16-9": "16:9",
  "4-3": "4:3",
  "21-9": "21:9",
  fill: "拉伸铺满",
  cover: "去黑边裁剪",
};

const FILTER_LABELS = {
  none: "原画",
  vivid: "动漫鲜艳",
  warm: "护眼柔和",
  contrast: "明亮锐利",
};

function applyVisualEffects(notify = false) {
  const v = $("video");
  if (!v) return;

  // 1. 比例与填充
  let fit = "contain";
  let aspect = "auto";

  switch (visualState.aspect) {
    case "16-9":
      fit = "fill";
      aspect = "16 / 9";
      break;
    case "4-3":
      fit = "fill";
      aspect = "4 / 3";
      break;
    case "21-9":
      fit = "fill";
      aspect = "21 / 9";
      break;
    case "fill":
      fit = "fill";
      aspect = "auto";
      break;
    case "cover":
      fit = "cover";
      aspect = "auto";
      break;
    case "default":
    default:
      fit = "contain";
      aspect = "auto";
      break;
  }

  v.style.setProperty("--video-fit", fit);
  v.style.setProperty("--video-aspect", aspect);
  if (visualState.aspect === "fill" || visualState.aspect === "cover") {
    v.style.setProperty("--video-width", "100%");
    v.style.setProperty("--video-height", "100%");
  } else {
    v.style.removeProperty("--video-width");
    v.style.removeProperty("--video-height");
  }

  // 2. 变换（镜像翻转与旋转）
  const transforms = [];
  if (visualState.mirror) transforms.push("scaleX(-1)");
  if (visualState.rotateDeg) transforms.push(`rotate(${visualState.rotateDeg}deg)`);
  v.style.setProperty("--video-transform", transforms.length > 0 ? transforms.join(" ") : "none");

  // 3. 动漫硬件加速色彩滤镜
  const FILTERS = {
    none: "none",
    vivid: "saturate(1.25) contrast(1.08) brightness(1.02)",
    warm: "sepia(0.18) saturate(0.9) brightness(0.96) hue-rotate(-5deg)",
    contrast: "contrast(1.2) brightness(1.06) saturate(1.1)",
  };
  v.style.setProperty("--video-filter", FILTERS[visualState.filter] || "none");

  // 同步 UI 状态
  document.querySelectorAll(".visual-aspect-opt").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-aspect") === visualState.aspect);
  });
  document.querySelectorAll(".visual-filter-opt").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-filter") === visualState.filter);
  });
  const mirrorBtn = $("btn-mirror");
  if (mirrorBtn) mirrorBtn.classList.toggle("active", visualState.mirror);
  const rotateBtn = $("btn-rotate");
  if (rotateBtn) {
    rotateBtn.textContent = visualState.rotateDeg ? `旋转 ${visualState.rotateDeg}°` : "旋转 90°";
    rotateBtn.classList.toggle("active", visualState.rotateDeg > 0);
  }
  const autoSkipBtn = $("btn-auto-skip-op");
  if (autoSkipBtn) {
    autoSkipBtn.textContent = `自动跳过 OP: ${visualState.autoSkipOp ? "开" : "关"}`;
    autoSkipBtn.classList.toggle("active", visualState.autoSkipOp);
  }
  const autoSkipEdBtn = $("btn-auto-skip-ed");
  if (autoSkipEdBtn) {
    autoSkipEdBtn.textContent = visualState.autoSkipEd > 0 ? `跳过片尾: ${visualState.autoSkipEd}s` : "跳过片尾: 关";
    autoSkipEdBtn.classList.toggle("active", visualState.autoSkipEd > 0);
  }

  if (notify) {
    showPlayerOsd(`画面比例: ${ASPECT_LABELS[visualState.aspect] || visualState.aspect}`);
  }
}

const ASPECT_CYCLE = ["default", "16-9", "4-3", "21-9", "fill", "cover"];
function cycleAspectRatio() {
  const curIdx = ASPECT_CYCLE.indexOf(visualState.aspect);
  const nextIdx = (curIdx + 1) % ASPECT_CYCLE.length;
  visualState.aspect = ASPECT_CYCLE[nextIdx];
  localStorage.setItem("ani_visual_aspect", visualState.aspect);
  applyVisualEffects(true);
}

function skipOp(seconds = 90) {
  const v = $("video");
  if (!v) return;
  const dur = v.duration && isFinite(v.duration) ? v.duration : Infinity;
  const target = Math.min(dur, v.currentTime + seconds);
  v.currentTime = target;
  showPlayerOsd(`⏭ 已跳过片头 (+${seconds}s) · ${fmtTime(target)}`);
  toast(`已跳过片头 ${seconds} 秒`, true);
  const capsule = $("player-skip-capsule");
  if (capsule) capsule.classList.add("hidden");
}

function setAbPointA() {
  const v = $("video");
  if (!v) return;
  const now = v.currentTime;
  visualState.abLoop.a = now;
  visualState.abLoop.active = false;
  const btnA = $("btn-ab-a");
  if (btnA) {
    btnA.textContent = `A: ${fmtTime(now)}`;
    btnA.classList.add("active");
  }
  const btnB = $("btn-ab-b");
  if (btnB) {
    btnB.textContent = "设 B 点";
    btnB.classList.remove("active");
  }
  showPlayerOsd(`🔁 A-B 循环：起点 A = ${fmtTime(now)}`);
  toast(`已标记 A 点：${fmtTime(now)}（请在终点按 ] 设 B 点）`, true);
}

function setAbPointB() {
  const v = $("video");
  if (!v) return;
  const now = v.currentTime;
  if (visualState.abLoop.a === null) {
    visualState.abLoop.a = 0;
    const btnA = $("btn-ab-a");
    if (btnA) {
      btnA.textContent = `A: 00:00`;
      btnA.classList.add("active");
    }
  }
  if (now <= visualState.abLoop.a) {
    toast("B 点时间必须大于 A 点");
    return;
  }
  visualState.abLoop.b = now;
  visualState.abLoop.active = true;
  const btnB = $("btn-ab-b");
  if (btnB) {
    btnB.textContent = `B: ${fmtTime(now)}`;
    btnB.classList.add("active");
  }
  v.currentTime = visualState.abLoop.a;
  showPlayerOsd(`🔁 A-B 循环中：${fmtTime(visualState.abLoop.a)} ➔ ${fmtTime(now)}`);
  toast(`A-B 循环已激活：${fmtTime(visualState.abLoop.a)} ~ ${fmtTime(now)}`, true);
}

function clearAbLoop(notify = true) {
  visualState.abLoop = { a: null, b: null, active: false };
  const btnA = $("btn-ab-a");
  if (btnA) {
    btnA.textContent = "设 A 点";
    btnA.classList.remove("active");
  }
  const btnB = $("btn-ab-b");
  if (btnB) {
    btnB.textContent = "设 B 点";
    btnB.classList.remove("active");
  }
  if (notify) {
    showPlayerOsd("🔁 A-B 循环已清除");
    toast("A-B 循环已清除", true);
  }
}

// ---------- Web Audio 音量超频增益与音频均衡器系统 ----------
const audioBoostState = {
  level: parseFloat(localStorage.getItem("ani_audio_boost")) || 1.0,
  eqMode: localStorage.getItem("ani_audio_eq") || "flat",
  ctx: null,
  sourceNode: null,
  gainNode: null,
  lowFilter: null,
  midFilter: null,
  highFilter: null,
};

const BOOST_LEVELS = [1.0, 1.5, 2.0, 3.0];

const EQ_PRESETS = {
  flat: { name: "原声", low: 0, mid: 0, high: 0 },
  vocal: { name: "人声清晰", low: -2.5, mid: 4.5, high: 1.0 },
  bass: { name: "影院重低音", low: 6.0, mid: 0, high: -1.0 },
  bright: { name: "明亮高音", low: -1.0, mid: 1.5, high: 4.5 },
};

function initAudioBoost() {
  const v = $("video");
  if (!v) return;
  if (!audioBoostState.ctx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    try {
      audioBoostState.ctx = new AudioContext();
      audioBoostState.sourceNode = audioBoostState.ctx.createMediaElementSource(v);

      // 三段均衡滤波节点（低架 / 参量峰值 / 高架）
      audioBoostState.lowFilter = audioBoostState.ctx.createBiquadFilter();
      audioBoostState.lowFilter.type = "lowshelf";
      audioBoostState.lowFilter.frequency.value = 100;

      audioBoostState.midFilter = audioBoostState.ctx.createBiquadFilter();
      audioBoostState.midFilter.type = "peaking";
      audioBoostState.midFilter.frequency.value = 2200;
      audioBoostState.midFilter.Q.value = 1.1;

      audioBoostState.highFilter = audioBoostState.ctx.createBiquadFilter();
      audioBoostState.highFilter.type = "highshelf";
      audioBoostState.highFilter.frequency.value = 6000;

      audioBoostState.gainNode = audioBoostState.ctx.createGain();
      audioBoostState.gainNode.gain.value = audioBoostState.level;

      // 串联拓扑：source -> lowFilter -> midFilter -> highFilter -> gainNode -> destination
      audioBoostState.sourceNode.connect(audioBoostState.lowFilter);
      audioBoostState.lowFilter.connect(audioBoostState.midFilter);
      audioBoostState.midFilter.connect(audioBoostState.highFilter);
      audioBoostState.highFilter.connect(audioBoostState.gainNode);
      audioBoostState.gainNode.connect(audioBoostState.ctx.destination);

      applyAudioEq(audioBoostState.eqMode);
    } catch {
      // 避免重复创建 MediaElementSource 错误
    }
  }
  if (audioBoostState.ctx && audioBoostState.ctx.state === "suspended") {
    audioBoostState.ctx.resume().catch(() => {});
  }
}

function applyAudioEq(mode) {
  const preset = EQ_PRESETS[mode] || EQ_PRESETS.flat;
  if (audioBoostState.lowFilter) audioBoostState.lowFilter.gain.value = preset.low;
  if (audioBoostState.midFilter) audioBoostState.midFilter.gain.value = preset.mid;
  if (audioBoostState.highFilter) audioBoostState.highFilter.gain.value = preset.high;
}

function setAudioEq(mode, notify = false) {
  audioBoostState.eqMode = mode;
  localStorage.setItem("ani_audio_eq", mode);
  initAudioBoost();
  applyAudioEq(mode);
  document.querySelectorAll(".visual-eq-opt").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.eq === mode);
  });
  if (notify) {
    const preset = EQ_PRESETS[mode] || EQ_PRESETS.flat;
    showPlayerOsd(`🎧 均衡器: ${preset.name}`);
    toast(`已切换音频均衡器模式：${preset.name}`, true);
  }
}

function setAudioBoost(level, notify = false) {
  audioBoostState.level = level;
  localStorage.setItem("ani_audio_boost", String(level));
  initAudioBoost();
  if (audioBoostState.gainNode) {
    audioBoostState.gainNode.gain.value = level;
  }
  document.querySelectorAll(".visual-boost-opt").forEach((btn) => {
    btn.classList.toggle("active", Math.abs(parseFloat(btn.dataset.boost) - level) < 0.05);
  });
  if (notify) {
    const pct = Math.round(level * 100);
    const tag = level > 1.0 ? (level >= 3.0 ? " (极限超频)" : " (增强)") : " (原音)";
    showPlayerOsd(`🔊 音量增益: ${pct}%${tag}`);
    toast(`音效增益已调整为 ${pct}%${tag}`, true);
  }
}

function adjustAudioBoost(step = 0.5) {
  const curIdx = BOOST_LEVELS.findIndex((l) => Math.abs(l - audioBoostState.level) < 0.05);
  let nextIdx = curIdx >= 0 ? curIdx + (step > 0 ? 1 : -1) : 0;
  nextIdx = Math.max(0, Math.min(BOOST_LEVELS.length - 1, nextIdx));
  setAudioBoost(BOOST_LEVELS[nextIdx], true);
}

// ---------- 名场面无损截帧与系统剪贴板分享 ----------
let isCapturingFrame = false;
async function captureVideoFrame() {
  const v = $("video");
  if (!v || isCapturingFrame || !v.videoWidth || !v.videoHeight) {
    toast("暂无视频画面可供截取");
    return;
  }
  isCapturingFrame = true;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext("2d");

    // 若用户应用了色彩滤镜或镜像/旋转变换，同步应用到导出画面
    if (visualState.filter !== "none") {
      ctx.filter = getComputedStyle(v).filter;
    }
    if (visualState.mirror || visualState.rotateDeg) {
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      if (visualState.mirror) ctx.scale(-1, 1);
      if (visualState.rotateDeg) ctx.rotate((visualState.rotateDeg * Math.PI) / 180);
      ctx.drawImage(v, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
      ctx.restore();
    } else {
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    }

    // 触发快门白闪动效
    const flash = $("player-shutter-flash");
    if (flash) {
      flash.classList.remove("hidden");
      setTimeout(() => flash.classList.add("hidden"), 350);
    }

    const subjectName = (state.subject?.name_cn || state.subject?.name || state.subject?.display_title || "anime")
      .replace(/[\\/:*?"<>|]/g, "_")
      .trim();
    const epNum = state.currentEp != null ? `_EP${String(state.currentEp).padStart(2, "0")}` : "";
    const curSec = Math.floor(v.currentTime);
    const m = Math.floor(curSec / 60);
    const s = curSec % 60;
    const timeStr = `${String(m).padStart(2, "0")}m${String(s).padStart(2, "0")}s`;
    const filename = `[${subjectName}]${epNum}_${timeStr}.png`;

    canvas.toBlob(async (blob) => {
      if (!blob) {
        toast("截图生成失败");
        isCapturingFrame = false;
        return;
      }

      // 1. 尝试复制到系统剪贴板（支持在聊天工具直接 Ctrl+V）
      let clipboardCopied = false;
      if (navigator.clipboard && window.ClipboardItem) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          clipboardCopied = true;
        } catch {
          clipboardCopied = false;
        }
      }

      // 2. 触发浏览器/系统原生下载文件保存
      const a = document.createElement("a");
      a.download = filename;
      const blobUrl = URL.createObjectURL(blob);
      a.href = blobUrl;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      }, 1000);

      const msg = clipboardCopied
        ? "📸 名场面截图已保存并复制到剪贴板！"
        : "📸 名场面截图已保存至本地！";
      showPlayerOsd(msg);
      toast(`${msg}（${canvas.width}×${canvas.height}）`, true);
      isCapturingFrame = false;
    }, "image/png");
  } catch (e) {
    isCapturingFrame = false;
    toast("截屏失败：" + e);
  }
}

// ---------- 画中画悬浮窗功能 ----------
async function togglePiP() {
  const v = $("video");
  if (!v) return;
  if (!document.pictureInPictureEnabled) {
    toast("当前系统环境不支持画中画功能");
    return;
  }
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      showPlayerOsd("🗗 退出画中画");
    } else {
      await v.requestPictureInPicture();
      showPlayerOsd("🗗 已进入画中画悬浮窗");
      toast("已开启画中画悬浮窗（切至桌面或其他页面可持续悬浮观看）", true);
    }
  } catch (e) {
    toast("画中画操作失败：" + e);
  }
}

function destroyPlayer() {
  const v = $("video");
  v.pause();
  DanmakuOverlay.clear();
  clearTimeout(autoPlayTimer);
  autoPlayTimer = null;
  const nextBtn = $("player-next-ep");
  if (nextBtn) nextBtn.classList.add("hidden");
  const osd = $("player-osd");
  if (osd) osd.classList.add("hidden");
  toggleStatsOsd(false);
  toggleEpDrawer(false);
  const sp = $("player-spinner");
  if (sp) sp.classList.add("hidden");
  clearTimeout(stageIdleTimer);
  stageIdleTimer = null;
  const stage = document.querySelector(".player-stage");
  if (stage) stage.classList.remove("idle");
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
  unloadSubtitle(true);
  const subWrap = $("sub-detected-wrap");
  if (subWrap) subWrap.classList.add("hidden");
  const subList = $("sub-detected-list");
  if (subList) subList.innerHTML = "";
  const subMenu = $("sub-menu");
  if (subMenu) subMenu.classList.add("hidden");
  const visualMenu = $("visual-menu");
  if (visualMenu) visualMenu.classList.add("hidden");
  const skipCapsule = $("player-skip-capsule");
  if (skipCapsule) skipCapsule.classList.add("hidden");
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
  }
  const pipBtn = $("player-pip");
  if (pipBtn) pipBtn.classList.remove("active");
  clearAbLoop(false);
  opAutoSkipped = false;
  edAutoSkipped = false;
  v.removeAttribute("src");
  v.load();
}

function openPlayer(url, title, extra = {}) {
  playerPrev = $("view-detail").classList.contains("hidden")
    ? (state.subView === "results" ? "results" : "subjects")
    : "detail";
  showPlayer(url, title, extra);
}

function showPlayerEmpty() {
  playerPrev = "subjects";
  showPlayer("", "在线播放");
}

function showPlayer(url, title, extra = {}) {
  destroyPlayer();
  currentMediaUrl = url || "";
  $("player-title").textContent = title || "在线播放";
  showView("player");
  updatePlayerNextBtn();
  const v = $("video");
  applyVisualEffects();
  if (audioBoostState.level !== 1.0) {
    setAudioBoost(audioBoostState.level);
  }
  if (!url) return;

  autoDetectAndMountSubtitles(extra?.localPath || btFallbackPath, extra?.subtitles);

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
      if (pos && pos > 10) resumeAt = pos;
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
        const fallback = btFallbackPath;
        destroyPlayer();
        showView(playerPrev);
        invoke("spawn_player", { path: fallback })
          .then((via) => toast("已在" + via + "中播放（边下边播，请勿关闭下载面板）", true))
          .catch((e) => toast("启动播放器失败：" + e));
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
  updateMediaSession();

  // 弹幕：有番剧上下文时按 番名+集号 从 dandanplay 拉取（未配置时后端静默返回未匹配）
  syncDanmakuToggle();
  DanmakuOverlay.clear();
  const subjectName = state.subject?.display_title || state.subject?.name_cn || state.subject?.name;
  if (subjectName && state.currentEp != null) {
    invoke("danmaku_fetch", { subjectName, ep: state.currentEp })
      .then((r) => {
        if (r.matched) {
          DanmakuOverlay.load(r.comments);
          if (r.comments.length) toast(`弹幕已加载：${r.comments.length} 条（${r.title}）`, true);
        } else {
          DanmakuOverlay.load([]);
        }
      })
      .catch(() => {
        DanmakuOverlay.load([]);
      });
  } else {
    DanmakuOverlay.load([]);
  }
}

$("player-btn").onclick = showPlayerEmpty;

async function startStream(uri, title) {
  openDlPanel();
  setStatus("在线播放准备中…");
  toast("BT 边下边播：先缓冲视频头部数据…");
  try {
    const handle = await invoke("start_torrent_stream", { magnet: uri });
    currentStreamHandle = handle;
    toast("种子元数据已解析，正在缓冲视频片段…", true);
  } catch (e) {
    setStatus("在线播放启动失败：" + e);
    toast("在线播放失败：" + e);
  }
}

// 视频点击播放/暂停；防抖避免双击全屏时误触发暂停/播放
let videoClickTimer = null;
$("video").addEventListener("click", (e) => {
  const v = $("video");
  const rect = v.getBoundingClientRect();
  if (e.clientY - rect.top > rect.height - 60) return;
  if (videoClickTimer) {
    clearTimeout(videoClickTimer);
    videoClickTimer = null;
    return;
  }
  videoClickTimer = setTimeout(() => {
    videoClickTimer = null;
    if (v.paused) {
      v.play().catch(() => {});
      showPlayerOsd("▶ 播放");
    } else {
      v.pause();
      showPlayerOsd("⏸ 暂停");
    }
  }, 220);
});
$("video").addEventListener("dblclick", () => {
  if (videoClickTimer) {
    clearTimeout(videoClickTimer);
    videoClickTimer = null;
  }
  toggleFullscreen();
});
$("video").addEventListener("play", () => {
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
});
$("video").addEventListener("pause", () => {
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
});

function toggleFullscreen() {
  const stage = document.querySelector(".player-stage") || $("video");
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    stage.requestFullscreen?.().catch(() => {
      $("video").requestFullscreen?.().catch(() => {});
    });
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
  const { url, path, title, subtitles } = ev.payload;
  setStatus("");
  if (url) {
    // 应用内边下边播（anibt:// 协议）：弹幕/断点续播/倍速全可用
    btFallbackPath = path || null;
    openPlayer(url, title, { localPath: path, subtitles });
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
  if (statsOsdVisible) updateStatsOsd();
  if (v.currentTime - lastSavedSec >= 5) {
    lastSavedSec = v.currentTime;
    saveProgress(false);
  }

  // A-B 片段循环播放
  if (visualState.abLoop.active && visualState.abLoop.b !== null && v.currentTime >= visualState.abLoop.b) {
    v.currentTime = visualState.abLoop.a ?? 0;
  }

  // 弹幕热力图进度游标跟随
  const playhead = $("heatmap-playhead");
  if (playhead && v.duration > 0) {
    playhead.style.left = `${(v.currentTime / v.duration) * 100}%`;
  }

  // 自动跳过片头（连播时仅在开播 0.5s~5s 自动触发一次）
  if (visualState.autoSkipOp && !opAutoSkipped && v.currentTime >= 0.5 && v.currentTime < 5) {
    opAutoSkipped = true;
    skipOp(getOpSkipSeconds());
  }

  // 自动跳过片尾（若开启，在离结尾还有 autoSkipEd 秒时自动跳过并连播）
  const edSkip = getEdSkipSeconds();
  if (
    visualState.autoSkipEd > 0 &&
    !edAutoSkipped &&
    v.duration > 180 &&
    v.currentTime >= (v.duration - edSkip) &&
    !v.paused
  ) {
    edAutoSkipped = true;
    showPlayerOsd(`⏭ 已自动跳过片尾 (-${edSkip}s)`);
    toast("已跳过片尾，自动连播下一集…", true);
    v.currentTime = v.duration;
  }

  // 开播 0.5s ~ 15s 展示悬浮跳过片头胶囊（自动跳过开启时不展示）
  const capsule = $("player-skip-capsule");
  if (capsule) {
    const showCapsule = !visualState.autoSkipOp && v.currentTime >= 0.5 && v.currentTime <= 15;
    capsule.classList.toggle("hidden", !showCapsule);
  }
});
$("video").addEventListener("volumechange", () => {
  localStorage.setItem("ani_vol", String($("video").volume));
});
const setPlayerSpinner = (show) => {
  const sp = $("player-spinner");
  if (sp) sp.classList.toggle("hidden", !show);
};

let stageIdleTimer = null;
const stageEl = document.querySelector(".player-stage");
if (stageEl) {
  stageEl.addEventListener("mousemove", () => {
    stageEl.classList.remove("idle");
    clearTimeout(stageIdleTimer);
    const v = $("video");
    if (v && !v.paused) {
      stageIdleTimer = setTimeout(() => {
        if (v && !v.paused) stageEl.classList.add("idle");
      }, 2500);
    }
  });
  stageEl.addEventListener("mouseleave", () => {
    clearTimeout(stageIdleTimer);
    stageEl.classList.remove("idle");
  });
}

$("video").addEventListener("waiting", () => {
  setStatus("缓冲中…");
  setPlayerSpinner(true);
});
$("video").addEventListener("playing", () => {
  setStatus("");
  setPlayerSpinner(false);
});
$("video").addEventListener("canplay", () => setPlayerSpinner(false));
$("video").addEventListener("loadedmetadata", () => {
  const v = $("video");
  if (v && v.duration && isFinite(v.duration) && v.duration > 0) {
    if (DanmakuOverlay.getEvents().length) {
      renderDanmakuHeatmap(DanmakuOverlay.getEvents(), v.duration);
    }
  }
});
$("video").addEventListener("pause", () => {
  if (stageEl) stageEl.classList.remove("idle");
  clearTimeout(stageIdleTimer);
});
$("player-fs").onclick = toggleFullscreen;
$("player-next-ep").onclick = () => playNextEpisode();

const epDrawerBtn = $("player-ep-drawer-btn");
if (epDrawerBtn) epDrawerBtn.onclick = () => toggleEpDrawer();
const epDrawerClose = $("ep-drawer-close");
if (epDrawerClose) epDrawerClose.onclick = () => toggleEpDrawer(false);

document.querySelectorAll(".ep-drawer-tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".ep-drawer-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    epDrawerKind = tab.dataset.kind;
    renderEpDrawer();
  };
});

// ---------- 弹幕开关、不透明度循环与联动 ----------

const DM_OPACITIES = [1.0, 0.7, 0.4, 0];

function danmakuOpacity() {
  if (settingsState.data?.danmaku_source) {
    if (!settingsState.data.danmaku_source.enabled) return 0;
    const saved = localStorage.getItem("ani_dm_opacity");
    const val = saved !== null ? parseFloat(saved) : 1.0;
    return val > 0 ? val : 1.0;
  }
  const saved = localStorage.getItem("ani_dm_opacity");
  if (saved !== null) return parseFloat(saved);
  return localStorage.getItem("ani_dm") === "0" ? 0 : 1.0;
}

function syncDanmakuToggle() {
  const op = danmakuOpacity();
  const on = op > 0;
  const btn = $("player-danmaku");
  if (btn) {
    btn.textContent = on ? `弹幕 ${Math.round(op * 100)}%` : "弹幕 关";
    btn.classList.toggle("active", on);
  }
  DanmakuOverlay.setOpacity(op);
  DanmakuOverlay.setEnabled(on);
  syncDanmakuMenuUI();
}

function syncDanmakuMenuUI() {
  const op = danmakuOpacity();
  const curArea = parseFloat(localStorage.getItem("ani_dm_area") || "0.5");
  const curSize = localStorage.getItem("ani_dm_size") || "md";
  const curSpeed = parseInt(localStorage.getItem("ani_dm_speed") || "6000", 10);

  document.querySelectorAll(".dm-opacity-opt").forEach((btn) => {
    btn.classList.toggle("active", Math.abs(parseFloat(btn.dataset.opacity) - op) < 0.05);
  });
  document.querySelectorAll(".dm-area-opt").forEach((btn) => {
    btn.classList.toggle("active", Math.abs(parseFloat(btn.dataset.area) - curArea) < 0.05);
  });
  document.querySelectorAll(".dm-size-opt").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.size === curSize);
  });
  document.querySelectorAll(".dm-speed-opt").forEach((btn) => {
    btn.classList.toggle("active", parseInt(btn.dataset.speed, 10) === curSpeed);
  });
}

function setDanmakuOpacity(op, notify = true) {
  localStorage.setItem("ani_dm_opacity", String(op));
  localStorage.setItem("ani_dm", op > 0 ? "1" : "0");
  if (settingsState.data?.danmaku_source) {
    settingsState.data.danmaku_source.enabled = op > 0;
    scheduleSave();
  }
  syncDanmakuToggle();
  if (notify) {
    if (op > 0) {
      toast(`弹幕不透明度：${Math.round(op * 100)}%`, true);
      showPlayerOsd(`弹幕不透明度: ${Math.round(op * 100)}%`);
    } else {
      toast("弹幕已关闭", true);
      showPlayerOsd("弹幕已关闭");
    }
  }
}

function setDanmakuArea(area) {
  localStorage.setItem("ani_dm_area", String(area));
  DanmakuOverlay.setAreaRatio(area);
  syncDanmakuMenuUI();
  const names = { "0.25": "1/4 顶", "0.5": "半屏", "1": "满屏", "1.0": "满屏" };
  showPlayerOsd(`弹幕显示区域: ${names[String(area)] || area}`);
}

function setDanmakuSize(size) {
  localStorage.setItem("ani_dm_size", size);
  DanmakuOverlay.setFontScale(size);
  syncDanmakuMenuUI();
  const names = { sm: "小", md: "中", lg: "大" };
  showPlayerOsd(`弹幕字号: ${names[size] || size}`);
}

function setDanmakuSpeed(speedMs) {
  localStorage.setItem("ani_dm_speed", String(speedMs));
  DanmakuOverlay.setSpeedMs(speedMs);
  syncDanmakuMenuUI();
  const names = { 8000: "慢速", 6000: "正常", 4000: "快速" };
  showPlayerOsd(`弹幕飘字速度: ${names[speedMs] || (speedMs + "ms")}`);
}

const dmBtn = $("player-danmaku");
const dmMenu = $("danmaku-menu");
if (dmBtn && dmMenu) {
  dmBtn.onclick = (e) => {
    e.stopPropagation();
    dmMenu.classList.toggle("hidden");
    syncDanmakuMenuUI();
  };
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".player-danmaku-wrap")) {
      dmMenu.classList.add("hidden");
    }
  });
}

document.querySelectorAll(".dm-opacity-opt").forEach((btn) => {
  btn.onclick = () => setDanmakuOpacity(parseFloat(btn.dataset.opacity));
});
document.querySelectorAll(".dm-area-opt").forEach((btn) => {
  btn.onclick = () => setDanmakuArea(parseFloat(btn.dataset.area));
});
document.querySelectorAll(".dm-size-opt").forEach((btn) => {
  btn.onclick = () => setDanmakuSize(btn.dataset.size);
});
document.querySelectorAll(".dm-speed-opt").forEach((btn) => {
  btn.onclick = () => setDanmakuSpeed(parseInt(btn.dataset.speed, 10));
});

const dmDelayMinus = $("dm-delay-minus");
if (dmDelayMinus) dmDelayMinus.onclick = () => DanmakuOverlay.adjustOffset(-0.5);
const dmDelayPlus = $("dm-delay-plus");
if (dmDelayPlus) dmDelayPlus.onclick = () => DanmakuOverlay.adjustOffset(0.5);
const dmDelayReset = $("dm-delay-reset");
if (dmDelayReset) dmDelayReset.onclick = () => DanmakuOverlay.resetOffset();

function parseLocalDanmaku(content) {
  const comments = [];
  const trimmed = content.trim();
  if (trimmed.startsWith("<") || trimmed.includes("<d p=")) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(content, "text/xml");
      const dEls = doc.querySelectorAll("d");
      dEls.forEach((el) => {
        const p = el.getAttribute("p");
        const text = el.textContent?.trim();
        if (!p || !text) return;
        const parts = p.split(",");
        const timeSec = parseFloat(parts[0]);
        if (isNaN(timeSec) || timeSec < 0) return;
        const modeNum = parseInt(parts[1], 10);
        let mode = "scroll";
        if (modeNum === 4) mode = "bottom";
        else if (modeNum === 5) mode = "top";
        const color = parseInt(parts[3], 10) || 0xffffff;
        comments.push({
          time_ms: Math.round(timeSec * 1000),
          mode,
          color,
          text,
        });
      });
    } catch (e) {
      console.warn("parse danmaku xml failed", e);
    }
  } else if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const obj = JSON.parse(content);
      const list = Array.isArray(obj) ? obj : (obj.comments || obj.danmaku || []);
      list.forEach((item) => {
        const t = item.time_ms ?? (item.time != null ? Math.round(item.time * 1000) : null);
        const text = (item.text ?? item.comment ?? item.m ?? "").trim();
        if (t == null || !text) return;
        let mode = item.mode;
        if (mode === 1 || mode === 2 || mode === 3) mode = "scroll";
        else if (mode === 4) mode = "bottom";
        else if (mode === 5) mode = "top";
        else if (!["scroll", "top", "bottom"].includes(mode)) mode = "scroll";
        const color = typeof item.color === "number" ? item.color : (parseInt(item.color, 16) || 0xffffff);
        comments.push({ time_ms: t, mode, color, text });
      });
    } catch (e) {
      console.warn("parse danmaku json failed", e);
    }
  }
  return comments;
}

function loadDanmakuFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const content = e.target.result;
    const comments = parseLocalDanmaku(content);
    if (!comments || !comments.length) {
      toast("未在文件中解析到有效弹幕内容", true);
      return;
    }
    danmakuTimeline = comments;
    DanmakuOverlay.load(comments);
    DanmakuOverlay.setEnabled(true);
    setDanmakuOpacity(0.5, false);
    syncDanmakuToggle();
    $("dm-clear-btn")?.classList.remove("hidden");
    toast(`已加载本地弹幕：${file.name} (共 ${comments.length} 条)`, true);
    showPlayerOsd(`已加载本地弹幕 (${comments.length} 条)`);
  };
  reader.readAsText(file, "utf-8");
}

function unloadDanmaku() {
  danmakuTimeline = [];
  DanmakuOverlay.clear();
  DanmakuOverlay.setEnabled(false);
  $("dm-clear-btn")?.classList.add("hidden");
  syncDanmakuToggle();
  toast("已卸载当前弹幕", true);
  showPlayerOsd("已清空弹幕");
}

const dmLoadBtn = $("dm-load-file-btn");
const dmFileInput = $("dm-file-input");
const dmClearBtn = $("dm-clear-btn");
if (dmLoadBtn && dmFileInput) {
  dmLoadBtn.onclick = () => dmFileInput.click();
  dmFileInput.onchange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      loadDanmakuFile(file);
      $("danmaku-menu")?.classList.add("hidden");
    }
    dmFileInput.value = "";
  };
}
if (dmClearBtn) {
  dmClearBtn.onclick = () => {
    unloadDanmaku();
    $("danmaku-menu")?.classList.add("hidden");
  };
}

// ---------- 弹幕手动搜索与跨集匹配系统 ----------
const dmManualMatchBtn = $("dm-manual-match-btn");
const dmMatchModal = $("dm-match-modal");
const dmMatchClose = $("dm-match-close");
const dmMatchInput = $("dm-match-input");
const dmMatchSearchBtn = $("dm-match-search-btn");
const dmMatchResults = $("dm-match-results");

function openDmMatchModal() {
  $("danmaku-menu")?.classList.add("hidden");
  if (!dmMatchModal) return;
  dmMatchModal.classList.remove("hidden");
  const curTitle = state.subject?.display_title || state.subject?.name_cn || state.subject?.name || "";
  if (dmMatchInput) {
    if (curTitle && !dmMatchInput.value.trim()) {
      dmMatchInput.value = curTitle;
    }
    dmMatchInput.focus();
    if (dmMatchInput.value.trim()) {
      performDmSearch(dmMatchInput.value.trim());
    }
  }
}

function closeDmMatchModal() {
  if (dmMatchModal) dmMatchModal.classList.add("hidden");
}

if (dmManualMatchBtn) {
  dmManualMatchBtn.onclick = openDmMatchModal;
}
if (dmMatchClose) {
  dmMatchClose.onclick = closeDmMatchModal;
}
if (dmMatchModal) {
  dmMatchModal.onclick = (e) => {
    if (e.target === dmMatchModal) closeDmMatchModal();
  };
}

async function performDmSearch(keyword) {
  if (!dmMatchResults) return;
  if (!keyword || !keyword.trim()) {
    dmMatchResults.innerHTML = `<div class="meta empty-tip">请输入有效的番剧名称</div>`;
    return;
  }
  dmMatchResults.innerHTML = `<div class="meta empty-tip">正在向弹弹play检索「${escapeHtml(keyword)}」剧集库…</div>`;
  try {
    const list = await invoke("danmaku_search_episodes", { anime: keyword.trim() });
    if (!list || !list.length) {
      dmMatchResults.innerHTML = `<div class="meta empty-tip">未找到匹配的剧集条目，请尝试换用别名或日文原名</div>`;
      return;
    }
    dmMatchResults.innerHTML = "";
    list.forEach((ep) => {
      const el = document.createElement("div");
      el.className = "dm-match-item";
      const fullTitle = ep.episode_title ? `${ep.anime_title} - ${ep.episode_title}` : ep.anime_title;
      el.innerHTML = `
        <div class="dm-match-info">
          <div class="dm-match-title">${escapeHtml(fullTitle)}</div>
          <div class="dm-match-meta">ID: ${ep.episode_id} · 番名: ${escapeHtml(ep.anime_title)}</div>
        </div>
        <button class="button small dm-match-action-btn">载入弹幕</button>
      `;
      el.onclick = async () => {
        try {
          toast(`正在拉取「${fullTitle}」弹幕库…`);
          const r = await invoke("danmaku_fetch_by_episode_id", {
            episodeId: ep.episode_id,
            title: fullTitle,
          });
          if (r && r.matched) {
            DanmakuOverlay.load(r.comments);
            DanmakuOverlay.setEnabled(true);
            setDanmakuOpacity(0.5, false);
            syncDanmakuToggle();
            renderDanmakuHeatmap(r.comments);
            closeDmMatchModal();
            toast(`已成功载入 ${r.comments.length} 条弹幕（${r.title}）`, true);
            showPlayerOsd(`弹幕已匹配: ${r.comments.length} 条`);
          } else {
            toast("该集弹幕库为空或拉取失败");
          }
        } catch (e) {
          toast("载入弹幕失败：" + e);
        }
      };
      dmMatchResults.appendChild(el);
    });
  } catch (e) {
    dmMatchResults.innerHTML = `<div class="meta empty-tip">搜索失败：${escapeHtml(String(e))}</div>`;
  }
}

if (dmMatchSearchBtn) {
  dmMatchSearchBtn.onclick = () => {
    if (dmMatchInput) performDmSearch(dmMatchInput.value.trim());
  };
}
if (dmMatchInput) {
  dmMatchInput.onkeydown = (e) => {
    if (e.key === "Enter") {
      performDmSearch(dmMatchInput.value.trim());
    }
  };
}

syncDanmakuMenuUI();

// seek 后重定位弹幕游标；窗口尺寸变化时重排画布
$("video").addEventListener("seeked", () => DanmakuOverlay.seekTo($("video").currentTime));
window.addEventListener("resize", () => DanmakuOverlay.resize());
document.addEventListener("fullscreenchange", () => setTimeout(() => DanmakuOverlay.resize(), 60));

// 画质切换
$("player-quality").onchange = (e) => {
  if (hls) hls.currentLevel = +e.target.value;
};

// ---------- 外挂字幕系统（WebVTT / SRT / ASS） ----------

const subState = {
  loaded: false,
  filename: "",
  rawVtt: "",
  cues: [],
  offsetSec: 0.0,
  size: localStorage.getItem("ani_sub_size") || "md",
  color: localStorage.getItem("ani_sub_color") || "white",
  bg: localStorage.getItem("ani_sub_bg") || "dim",
  position: localStorage.getItem("ani_sub_pos") || "bottom",
  trackEl: null,
  blobUrl: null,
};

const SUB_COLORS = {
  white: "#ffffff",
  yellow: "#fde047",
  cyan: "#38bdf8",
  green: "#4ade80",
};

const SUB_BGS = {
  dim: "rgba(10, 13, 20, 0.78)",
  none: "transparent",
  solid: "#000000",
};

const SUB_SHADOWS = {
  dim: "0 1px 3px rgba(0, 0, 0, 0.95), 0 0 2px rgba(0, 0, 0, 0.9)",
  none: "0 0 4px #000, 0 0 2px #000, 1px 1px 2px #000, -1px -1px 2px #000",
  solid: "none",
};

function srtToVtt(srtText) {
  let vtt = "WEBVTT\n\n";
  const clean = srtText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\uFEFF/, "");
  vtt += clean.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return vtt;
}

function assToVtt(assText) {
  let vtt = "WEBVTT\n\n";
  const clean = assText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\uFEFF/, "");
  const lines = clean.split("\n");
  let inEvents = false;
  let startIdx = 1, endIdx = 2, textIdx = 9;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.toLowerCase() === "[events]") {
      inEvents = true;
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;

    if (line.toLowerCase().startsWith("format:")) {
      const cols = line.substring(7).split(",").map((s) => s.trim().toLowerCase());
      startIdx = cols.indexOf("start");
      endIdx = cols.indexOf("end");
      textIdx = cols.indexOf("text");
      if (startIdx === -1) startIdx = 1;
      if (endIdx === -1) endIdx = 2;
      if (textIdx === -1) textIdx = cols.length - 1;
      continue;
    }

    if (line.toLowerCase().startsWith("dialogue:")) {
      const content = line.substring(9);
      const colCount = Math.max(startIdx, endIdx, textIdx) + 1;
      const fields = [];
      let lastPos = 0;
      for (let f = 0; f < colCount - 1; f++) {
        const nextComma = content.indexOf(",", lastPos);
        if (nextComma === -1) break;
        fields.push(content.substring(lastPos, nextComma).trim());
        lastPos = nextComma + 1;
      }
      fields.push(content.substring(lastPos));

      const startStr = fields[startIdx];
      const endStr = fields[endIdx];
      const textRaw = fields[textIdx];
      if (!startStr || !endStr || !textRaw) continue;

      const parseAssTime = (t) => {
        const p = t.trim().split(":");
        if (p.length < 2) return null;
        let h = 0, m = 0, s = 0;
        if (p.length === 3) {
          h = parseInt(p[0], 10) || 0;
          m = parseInt(p[1], 10) || 0;
          s = parseFloat(p[2]) || 0;
        } else {
          m = parseInt(p[0], 10) || 0;
          s = parseFloat(p[1]) || 0;
        }
        const totalSec = h * 3600 + m * 60 + s;
        const sInt = Math.floor(totalSec);
        const ms = Math.round((totalSec - sInt) * 1000);
        const hh = String(Math.floor(sInt / 3600)).padStart(2, "0");
        const mm = String(Math.floor((sInt % 3600) / 60)).padStart(2, "0");
        const ss = String(sInt % 60).padStart(2, "0");
        const mmm = String(ms).padStart(3, "0");
        return `${hh}:${mm}:${ss}.${mmm}`;
      };

      const vttStart = parseAssTime(startStr);
      const vttEnd = parseAssTime(endStr);
      if (!vttStart || !vttEnd) continue;

      let cleanText = textRaw
        .replace(/\{[^\}]*\}/g, "")
        .replace(/\\N/gi, "\n")
        .replace(/\\n/gi, "\n")
        .replace(/\\h/gi, " ")
        .trim();

      if (!cleanText) continue;
      vtt += `${vttStart} --> ${vttEnd}\n${cleanText}\n\n`;
    }
  }
  return vtt;
}

function parseVttCues(vttText) {
  const cues = [];
  const lines = vttText.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const match = line.match(/(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})/);
    if (match) {
      const parseSec = (h, m, s, ms) => (parseInt(h || "0", 10) * 3600) + (parseInt(m, 10) * 60) + parseInt(s, 10) + (parseInt(ms, 10) / 1000);
      const start = parseSec(match[1], match[2], match[3], match[4]);
      const end = parseSec(match[5], match[6], match[7], match[8]);
      let text = "";
      i++;
      while (i < lines.length && lines[i].trim() !== "") {
        text += (text ? "\n" : "") + lines[i];
        i++;
      }
      cues.push({ start, end, text });
    } else {
      i++;
    }
  }
  return cues;
}

function buildShiftedVtt(cues, offsetSec, position = subState.position) {
  let out = "WEBVTT\n\n";
  const fmtVttTime = (sec) => {
    sec = Math.max(0, sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  };
  const lineSetting = position === "top" ? " line:10%" : " line:90%";
  for (const cue of cues) {
    const s = cue.start + offsetSec;
    const e = cue.end + offsetSec;
    if (e > 0) {
      out += `${fmtVttTime(s)} --> ${fmtVttTime(e)}${lineSetting}\n${cue.text}\n\n`;
    }
  }
  return out;
}

function applySubtitleTrack(vttContent) {
  const v = $("video");
  if (!v) return;
  if (subState.blobUrl) {
    URL.revokeObjectURL(subState.blobUrl);
    subState.blobUrl = null;
  }
  if (subState.trackEl) {
    subState.trackEl.remove();
    subState.trackEl = null;
  }
  const blob = new Blob([vttContent], { type: "text/vtt;charset=utf-8" });
  subState.blobUrl = URL.createObjectURL(blob);
  const track = document.createElement("track");
  track.kind = "subtitles";
  track.label = subState.filename || "外挂字幕";
  track.srclang = "zh";
  track.src = subState.blobUrl;
  track.default = true;
  v.appendChild(track);
  subState.trackEl = track;

  if (v.textTracks && v.textTracks.length > 0) {
    for (let i = 0; i < v.textTracks.length; i++) {
      v.textTracks[i].mode = "showing";
    }
  }
}

function updateSubUI() {
  const btn = $("player-sub-btn");
  const clearBtn = $("sub-clear-btn");
  const valEl = $("sub-delay-val");
  if (btn) {
    btn.textContent = subState.loaded ? "字幕 开" : "字幕 关";
    btn.classList.toggle("active", subState.loaded);
  }
  if (clearBtn) {
    clearBtn.classList.toggle("hidden", !subState.loaded);
  }
  if (valEl) {
    const sign = subState.offsetSec > 0 ? "+" : "";
    valEl.textContent = `${sign}${subState.offsetSec.toFixed(1)}s`;
  }
}

function loadSubtitleFromText(rawText, filename) {
  let content = rawText;
  const n = (filename || "").toLowerCase();
  if (n.endsWith(".srt")) {
    content = srtToVtt(content);
  } else if (n.endsWith(".ass") || n.endsWith(".ssa") || content.includes("[Events]")) {
    content = assToVtt(content);
  }
  subState.cues = parseVttCues(content);
  subState.rawVtt = content;
  subState.filename = filename || "外挂字幕";
  subState.loaded = true;
  subState.offsetSec = 0.0;
  const shifted = buildShiftedVtt(subState.cues, 0.0, subState.position);
  applySubtitleTrack(shifted);
  applySubtitleStyles();
  updateSubUI();
  toast("已加载字幕：" + subState.filename, true);
  showPlayerOsd("已加载字幕: " + subState.filename);
}

function loadSubtitleFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    loadSubtitleFromText(e.target.result, file.name);
  };
  reader.readAsText(file, "utf-8");
}

async function autoDetectAndMountSubtitles(videoPath, initialSubs = []) {
  const wrap = $("sub-detected-wrap");
  const listEl = $("sub-detected-list");
  if (!wrap || !listEl) return;
  wrap.classList.add("hidden");
  listEl.innerHTML = "";

  let subs = Array.isArray(initialSubs) ? [...initialSubs] : [];
  if ((!subs || !subs.length) && videoPath) {
    try {
      const found = await invoke("find_sibling_subtitles", { videoPath });
      if (found && found.length) subs = found;
    } catch (e) {
      console.warn("find_sibling_subtitles error:", e);
    }
  }

  if (!subs || !subs.length) return;

  wrap.classList.remove("hidden");

  // 字幕语言偏好，默认优先简中
  const prefLang = settingsData?.prefs?.subtitle_lang || "chi";
  let matchedSub = null;

  for (const s of subs) {
    const item = document.createElement("button");
    item.className = "sub-detected-item";
    const name = s.name.split(/[/\\]/).pop();
    const isChs = /[\.\[_\-](sc|chs|gb|zh-hans|cn)[\.\]_\-]/i.test(s.name) || s.name.includes("简") || s.name.includes("GB");
    const isCht = /[\.\[_\-](tc|cht|big5|zh-hant)[\.\]_\-]/i.test(s.name) || s.name.includes("繁") || s.name.includes("BIG5");
    const tag = isChs ? "简中" : (isCht ? "繁中" : "外挂");

    item.innerHTML = `
      <span class="sub-detected-item-name" title="${escapeAttr(name)}">${escapeHtml(name)}</span>
      <span class="sub-detected-item-tag">${tag}</span>
    `;

    item.onclick = async () => {
      try {
        const text = await invoke("read_local_text_file", { path: s.path });
        loadSubtitleFromText(text, name);
        listEl.querySelectorAll(".sub-detected-item").forEach((el) => el.classList.remove("active"));
        item.classList.add("active");
      } catch (err) {
        toast("加载字幕失败：" + err);
      }
    };

    listEl.appendChild(item);

    if (!matchedSub) {
      if (prefLang === "chi_trad" && isCht) matchedSub = { sub: s, btn: item };
      else if (prefLang !== "chi_trad" && isChs) matchedSub = { sub: s, btn: item };
    }
  }

  // 自动挂载匹配偏好的字幕或唯一字幕
  if (!subState.loaded) {
    const toMount = matchedSub || (subs.length === 1 ? { sub: subs[0], btn: listEl.children[0] } : null);
    if (toMount) {
      try {
        const text = await invoke("read_local_text_file", { path: toMount.sub.path });
        const name = toMount.sub.name.split(/[/\\]/).pop();
        loadSubtitleFromText(text, name);
        toMount.btn?.classList.add("active");
        showPlayerOsd(`已自动挂载片源字幕: ${name}`);
      } catch (e) {
        console.warn("auto-mount subtitle failed:", e);
      }
    }
  }
}

function unloadSubtitle(silent = false) {
  if (subState.blobUrl) {
    URL.revokeObjectURL(subState.blobUrl);
    subState.blobUrl = null;
  }
  if (subState.trackEl) {
    subState.trackEl.remove();
    subState.trackEl = null;
  }
  subState.loaded = false;
  subState.filename = "";
  subState.cues = [];
  subState.offsetSec = 0.0;
  updateSubUI();
  const detectedList = $("sub-detected-list");
  if (detectedList) {
    detectedList.querySelectorAll(".sub-detected-item").forEach((el) => el.classList.remove("active"));
  }
  const subMenu = $("sub-menu");
  if (subMenu) subMenu.classList.add("hidden");
  if (!silent) {
    toast("已卸载外挂字幕", true);
    showPlayerOsd("已关闭外挂字幕");
  }
}

function adjustSubOffset(delta) {
  if (!subState.loaded || subState.cues.length === 0) {
    toast("当前未加载外挂字幕");
    return;
  }
  subState.offsetSec = Math.round((subState.offsetSec + delta) * 10) / 10;
  const shifted = buildShiftedVtt(subState.cues, subState.offsetSec, subState.position);
  applySubtitleTrack(shifted);
  updateSubUI();
  const sign = subState.offsetSec > 0 ? "+" : "";
  showPlayerOsd(`字幕延迟: ${sign}${subState.offsetSec.toFixed(1)}s`);
}

function applySubtitleStyles() {
  const sizes = { sm: "17px", md: "21px", lg: "26px" };
  document.documentElement.style.setProperty("--sub-font-size", sizes[subState.size] || "21px");
  document.documentElement.style.setProperty("--sub-color", SUB_COLORS[subState.color] || "#ffffff");
  document.documentElement.style.setProperty("--sub-bg", SUB_BGS[subState.bg] || "rgba(10, 13, 20, 0.78)");
  document.documentElement.style.setProperty("--sub-shadow", SUB_SHADOWS[subState.bg] || "0 1px 3px rgba(0, 0, 0, 0.95), 0 0 2px rgba(0, 0, 0, 0.9)");

  document.querySelectorAll(".sub-size-opt").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-size") === subState.size);
  });
  document.querySelectorAll(".sub-color-opt").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-color") === subState.color);
  });
  document.querySelectorAll(".sub-bg-opt").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-bg") === subState.bg);
  });
  document.querySelectorAll(".sub-pos-opt").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-pos") === subState.position);
  });
}

function setSubSize(size) {
  subState.size = size;
  localStorage.setItem("ani_sub_size", size);
  applySubtitleStyles();
  showPlayerOsd(`字幕字号: ${size === "sm" ? "小" : size === "lg" ? "大" : "中"}`);
}

function setSubColor(color) {
  subState.color = color;
  localStorage.setItem("ani_sub_color", color);
  applySubtitleStyles();
  const names = { white: "纯白", yellow: "明黄", cyan: "天蓝", green: "翡翠" };
  showPlayerOsd(`字幕色彩: ${names[color] || color}`);
}

function setSubBg(bg) {
  subState.bg = bg;
  localStorage.setItem("ani_sub_bg", bg);
  applySubtitleStyles();
  const names = { dim: "半透明", none: "纯描边", solid: "纯黑" };
  showPlayerOsd(`底框样式: ${names[bg] || bg}`);
}

function setSubPosition(pos) {
  subState.position = pos;
  localStorage.setItem("ani_sub_pos", pos);
  applySubtitleStyles();
  if (subState.loaded && subState.cues.length > 0) {
    const shifted = buildShiftedVtt(subState.cues, subState.offsetSec, subState.position);
    applySubtitleTrack(shifted);
  }
  showPlayerOsd(`字幕位置: ${pos === "top" ? "顶部" : "底部"}`);
}

const subBtn = $("player-sub-btn");
const subMenu = $("sub-menu");
if (subBtn && subMenu) {
  subBtn.onclick = (e) => {
    e.stopPropagation();
    subMenu.classList.toggle("hidden");
  };
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".player-sub-wrap")) {
      subMenu.classList.add("hidden");
    }
  });
}

const subLoadBtn = $("sub-load-file-btn");
const subFileInput = $("sub-file-input");
if (subLoadBtn && subFileInput) {
  subLoadBtn.onclick = () => subFileInput.click();
  subFileInput.onchange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      loadSubtitleFile(file);
      subMenu?.classList.add("hidden");
    }
    subFileInput.value = "";
  };
}

const subClearBtn = $("sub-clear-btn");
if (subClearBtn) subClearBtn.onclick = () => unloadSubtitle();

const subDelayMinus = $("sub-delay-minus");
if (subDelayMinus) subDelayMinus.onclick = () => adjustSubOffset(-0.5);
const subDelayPlus = $("sub-delay-plus");
if (subDelayPlus) subDelayPlus.onclick = () => adjustSubOffset(0.5);

document.querySelectorAll(".sub-size-opt").forEach((btn) => {
  btn.onclick = () => setSubSize(btn.getAttribute("data-size"));
});
document.querySelectorAll(".sub-color-opt").forEach((btn) => {
  btn.onclick = () => setSubColor(btn.getAttribute("data-color"));
});
document.querySelectorAll(".sub-bg-opt").forEach((btn) => {
  btn.onclick = () => setSubBg(btn.getAttribute("data-bg"));
});
document.querySelectorAll(".sub-pos-opt").forEach((btn) => {
  btn.onclick = () => setSubPosition(btn.getAttribute("data-pos"));
});

applySubtitleStyles();

// 播放器区域支持直接拖拽挂载字幕文件
const pStage = document.querySelector(".player-stage");
if (pStage) {
  pStage.addEventListener("dragover", (e) => {
    e.preventDefault();
    pStage.classList.add("drag-over");
  });
  pStage.addEventListener("dragleave", () => {
    pStage.classList.remove("drag-over");
  });
  pStage.addEventListener("drop", (e) => {
    e.preventDefault();
    pStage.classList.remove("drag-over");
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    for (const file of files) {
      const n = file.name.toLowerCase();
      if (n.endsWith(".srt") || n.endsWith(".vtt") || n.endsWith(".ass") || n.endsWith(".ssa")) {
        loadSubtitleFile(file);
      } else if (n.endsWith(".xml") || n.endsWith(".json")) {
        loadDanmakuFile(file);
      } else {
        toast("仅支持拖入字幕文件 (.srt/.vtt/.ass) 或弹幕文件 (.xml/.json)");
      }
    }
  });
}

// 画面比例、视效菜单与跳过片头控制绑定
const visualBtn = $("player-visual-btn");
const visualMenu = $("visual-menu");
if (visualBtn && visualMenu) {
  visualBtn.onclick = (e) => {
    e.stopPropagation();
    visualMenu.classList.toggle("hidden");
    applyVisualEffects();
  };
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".player-visual-wrap")) {
      visualMenu.classList.add("hidden");
    }
  });
}

document.querySelectorAll(".visual-aspect-opt").forEach((btn) => {
  btn.onclick = () => {
    visualState.aspect = btn.getAttribute("data-aspect");
    localStorage.setItem("ani_visual_aspect", visualState.aspect);
    applyVisualEffects(true);
  };
});

document.querySelectorAll(".visual-filter-opt").forEach((btn) => {
  btn.onclick = () => {
    visualState.filter = btn.getAttribute("data-filter");
    localStorage.setItem("ani_visual_filter", visualState.filter);
    applyVisualEffects();
    showPlayerOsd(`色彩滤镜: ${FILTER_LABELS[visualState.filter] || visualState.filter}`);
  };
});

const btnMirror = $("btn-mirror");
if (btnMirror) {
  btnMirror.onclick = () => {
    visualState.mirror = !visualState.mirror;
    applyVisualEffects();
    showPlayerOsd(visualState.mirror ? "画面: 左右镜像开启" : "画面: 正常显示");
  };
}

const btnRotate = $("btn-rotate");
if (btnRotate) {
  btnRotate.onclick = () => {
    visualState.rotateDeg = (visualState.rotateDeg + 90) % 360;
    applyVisualEffects();
    showPlayerOsd(`画面顺时针旋转: ${visualState.rotateDeg}°`);
  };
}

const btnResetTransform = $("btn-reset-transform");
if (btnResetTransform) {
  btnResetTransform.onclick = () => {
    visualState.mirror = false;
    visualState.rotateDeg = 0;
    applyVisualEffects();
    showPlayerOsd("画面变换已重置");
  };
}

function getOpSkipSeconds() {
  return parseInt(localStorage.getItem("ani_op_skip_len") || "90", 10);
}

function getEdSkipSeconds() {
  return parseInt(localStorage.getItem("ani_ed_skip_len") || "90", 10);
}

const btnSkipOp = $("btn-skip-op");
if (btnSkipOp) {
  btnSkipOp.textContent = `+${getOpSkipSeconds()}s 跳过`;
  btnSkipOp.onclick = () => skipOp(getOpSkipSeconds());
}

document.querySelectorAll(".visual-op-len-opt").forEach((btn) => {
  const len = parseInt(btn.getAttribute("data-len"), 10);
  if (len === getOpSkipSeconds()) btn.classList.add("active");
  else btn.classList.remove("active");
  btn.onclick = () => {
    localStorage.setItem("ani_op_skip_len", String(len));
    document.querySelectorAll(".visual-op-len-opt").forEach((b) => b.classList.toggle("active", b === btn));
    if (btnSkipOp) btnSkipOp.textContent = `+${len}s 跳过`;
    showPlayerOsd(`片头跳过时长已设为 ${len} 秒`);
  };
});

document.querySelectorAll(".visual-ed-len-opt").forEach((btn) => {
  const len = parseInt(btn.getAttribute("data-len"), 10);
  if (len === getEdSkipSeconds()) btn.classList.add("active");
  else btn.classList.remove("active");
  btn.onclick = () => {
    localStorage.setItem("ani_ed_skip_len", String(len));
    document.querySelectorAll(".visual-ed-len-opt").forEach((b) => b.classList.toggle("active", b === btn));
    showPlayerOsd(`片尾跳过时长已设为 ${len} 秒`);
  };
});

const btnAutoSkipOp = $("btn-auto-skip-op");
if (btnAutoSkipOp) {
  btnAutoSkipOp.onclick = () => {
    visualState.autoSkipOp = !visualState.autoSkipOp;
    localStorage.setItem("ani_auto_skip_op", visualState.autoSkipOp ? "1" : "0");
    applyVisualEffects();
    showPlayerOsd(visualState.autoSkipOp ? "自动跳过 OP: 开启" : "自动跳过 OP: 关闭");
  };
}

const btnAutoSkipEd = $("btn-auto-skip-ed");
if (btnAutoSkipEd) {
  const ED_CYCLE = [0, 60, 90];
  btnAutoSkipEd.onclick = () => {
    const idx = ED_CYCLE.indexOf(visualState.autoSkipEd);
    const next = ED_CYCLE[(idx + 1) % ED_CYCLE.length];
    visualState.autoSkipEd = next;
    localStorage.setItem("ani_auto_skip_ed", String(next));
    applyVisualEffects();
    showPlayerOsd(next > 0 ? `跳过片尾: ${next}s` : "跳过片尾: 关闭");
  };
}

const btnAbA = $("btn-ab-a");
if (btnAbA) btnAbA.onclick = () => setAbPointA();
const btnAbB = $("btn-ab-b");
if (btnAbB) btnAbB.onclick = () => setAbPointB();
const btnAbClear = $("btn-ab-clear");
if (btnAbClear) btnAbClear.onclick = () => clearAbLoop();

const skipCapsule = $("player-skip-capsule");
if (skipCapsule) {
  skipCapsule.onclick = () => skipOp(getOpSkipSeconds());
}

const screenshotBtn = $("player-screenshot-btn");
if (screenshotBtn) {
  screenshotBtn.onclick = () => captureVideoFrame();
}

const pipBtn = $("player-pip");
if (pipBtn) {
  pipBtn.onclick = () => togglePiP();
}

document.querySelectorAll(".visual-boost-opt").forEach((btn) => {
  btn.onclick = () => {
    const level = parseFloat(btn.getAttribute("data-boost")) || 1.0;
    setAudioBoost(level, true);
  };
});

document.querySelectorAll(".visual-eq-opt").forEach((btn) => {
  btn.onclick = () => {
    const eq = btn.getAttribute("data-eq") || "flat";
    setAudioEq(eq, true);
  };
});

const sleepState = {
  mode: "off",
  timerId: null,
};

function setSleepTimer(mode, notify = true) {
  if (sleepState.timerId) {
    clearTimeout(sleepState.timerId);
    sleepState.timerId = null;
  }
  sleepState.mode = mode;

  document.querySelectorAll(".visual-sleep-opt").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-sleep") === mode);
  });

  if (mode === "off") {
    if (notify) showPlayerOsd("睡眠定时: 已关闭");
  } else if (mode === "ep") {
    if (notify) showPlayerOsd("睡眠定时: 播完本集自动暂停");
  } else {
    const mins = parseInt(mode, 10);
    sleepState.timerId = setTimeout(() => {
      triggerSleepTimer();
    }, mins * 60 * 1000);
    if (notify) showPlayerOsd(`睡眠定时: ${mins} 分钟后自动暂停`);
  }
}

function triggerSleepTimer() {
  const v = $("video");
  if (v && !v.paused) {
    v.pause();
  }
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
  setSleepTimer("off", false);
  showPlayerOsd("【睡眠定时器】设定时间已到，已自动为您暂停播放");
  toast("【睡眠定时器】设定时间已到，已自动暂停播放", true);
}

document.querySelectorAll(".visual-sleep-opt").forEach((btn) => {
  btn.onclick = () => {
    const mode = btn.getAttribute("data-sleep") || "off";
    setSleepTimer(mode);
  };
});

const vEl = $("video");
if (vEl) {
  vEl.addEventListener("enterpictureinpicture", () => {
    $("player-pip")?.classList.add("active");
  });
  vEl.addEventListener("leavepictureinpicture", () => {
    $("player-pip")?.classList.remove("active");
  });
}

// 键盘快捷键：空格暂停 / ←→ 或 JL 快退快进 10s / ↑↓ 音量 / Shift+↑↓ 音效超频 / C 截图 / P 画中画 / M 静音 / 0-9 进度跳转 / < > 倍速 / W 画面比例 / S 跳过片头 / [ ] \ A-B循环 / - = 弹幕微调 / Z X 字幕延迟微调
document.addEventListener("keydown", (e) => {
  if ($("view-player").classList.contains("hidden")) return;
  const tag = e.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const v = $("video");
  const isDigit = /^[0-9]$/.test(e.key);
  const keys = [
    " ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
    "f", "F", "n", "N", "m", "M", "j", "J", "l", "L",
    "w", "W", "s", "S", "c", "C", "p", "P", "d", "D", "[", "]", "\\", "-", "=", "_", "+",
    ",", "<", ".", ">", "i", "I", "e", "E", "z", "Z", "x", "X"
  ];
  if (!keys.includes(e.key) && !isDigit) return;
  e.preventDefault();

  if (isDigit) {
    if (v.duration && isFinite(v.duration)) {
      const pct = parseInt(e.key, 10) * 0.1;
      v.currentTime = v.duration * pct;
      showPlayerOsd(`⏩ 跳转至 ${Math.round(pct * 100)}% · ${fmtTime(v.currentTime)}`);
    }
    return;
  }

  switch (e.key) {
    case " ":
      if (v.paused) {
        v.play().catch(() => {});
        showPlayerOsd("▶ 播放");
      } else {
        v.pause();
        showPlayerOsd("⏸ 暂停");
      }
      break;
    case "ArrowLeft": case "j": case "J":
      v.currentTime = Math.max(0, v.currentTime - 10);
      showPlayerOsd("⏪ 快退 10s · " + fmtTime(v.currentTime));
      break;
    case "ArrowRight": case "l": case "L":
      v.currentTime += 10;
      showPlayerOsd("⏩ 快进 10s · " + fmtTime(v.currentTime));
      break;
    case "ArrowUp":
      if (e.shiftKey) {
        adjustAudioBoost(0.5);
      } else {
        v.muted = false;
        v.volume = Math.min(1, Math.round((v.volume + 0.1) * 10) / 10);
        showPlayerOsd("🔊 音量: " + Math.round(v.volume * 100) + "%");
      }
      break;
    case "ArrowDown":
      if (e.shiftKey) {
        adjustAudioBoost(-0.5);
      } else {
        v.volume = Math.max(0, Math.round((v.volume - 0.1) * 10) / 10);
        showPlayerOsd("🔉 音量: " + Math.round(v.volume * 100) + "%");
      }
      break;
    case "m": case "M":
      v.muted = !v.muted;
      showPlayerOsd(v.muted ? "🔇 静音" : `🔊 音量: ${Math.round(v.volume * 100)}%`);
      break;
    case "<": case ",": {
      const curIdx = RATES.indexOf(v.playbackRate);
      const prevIdx = (curIdx - 1 + RATES.length) % RATES.length;
      v.playbackRate = RATES[prevIdx];
      $("player-rate").textContent = `倍速 ${RATES[prevIdx]}x`;
      showPlayerOsd(`倍速: ${RATES[prevIdx]}x`);
      localStorage.setItem("ani_rate", String(RATES[prevIdx]));
      break;
    }
    case ">": case ".": {
      const curIdx = RATES.indexOf(v.playbackRate);
      const nextIdx = (curIdx + 1) % RATES.length;
      v.playbackRate = RATES[nextIdx];
      $("player-rate").textContent = `倍速 ${RATES[nextIdx]}x`;
      showPlayerOsd(`倍速: ${RATES[nextIdx]}x`);
      localStorage.setItem("ani_rate", String(RATES[nextIdx]));
      break;
    }
    case "w": case "W": cycleAspectRatio(); break;
    case "s": case "S": skipOp(90); break;
    case "c": case "C": captureVideoFrame(); break;
    case "p": case "P": togglePiP(); break;
    case "d": case "D": {
      const dmMenu = $("danmaku-menu");
      if (dmMenu) {
        dmMenu.classList.toggle("hidden");
        syncDanmakuMenuUI();
      }
      break;
    }
    case "[": setAbPointA(); break;
    case "]": setAbPointB(); break;
    case "\\": clearAbLoop(); break;
    case "-": case "_": DanmakuOverlay.adjustOffset(-0.5); break;
    case "=": case "+": DanmakuOverlay.adjustOffset(0.5); break;
    case "f": case "F": toggleFullscreen(); break;
    case "b": case "B": playPreviousEpisode(); break;
    case "n": case "N": playNextEpisode(); break;
    case "e": case "E": toggleEpDrawer(); break;
    case "i": case "I": toggleStatsOsd(); break;
    case "z": case "Z": adjustSubOffset(-0.5); break;
    case "x": case "X": adjustSubOffset(0.5); break;
  }
});

const statsBtn = $("player-stats-btn");
if (statsBtn) statsBtn.onclick = () => toggleStatsOsd();
const statsClose = $("stats-osd-close");
if (statsClose) statsClose.onclick = () => toggleStatsOsd(false);
$("video").addEventListener("ended", () => {
  saveProgress(true);
  toast("已看完，进度已记录", true);
  // Bangumi 云同步：标记「看过」（未登录时后端拒绝，静默忽略）
  const subjectId = state.subject?.id?.id ?? state.subject?.id;
  if (subjectId && state.currentEp != null && state.episodes) {
    const epInfo = state.episodes.find((e) => Math.abs(e.ep - state.currentEp) < 0.01);
    if (epInfo) {
      invoke("bangumi_mark_watched", { subjectId, episodeId: epInfo.id.id ?? epInfo.id })
        .then(() => toast("已同步到 Bangumi：标记看过", true))
        .catch(() => {});
    }
  }

  // 睡眠定时器检查：若是「播完本集」模式，则不连播下一集，直接退出全屏并休眠
  if (sleepState.mode === "ep") {
    clearTimeout(autoPlayTimer);
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    setSleepTimer("off", false);
    showPlayerOsd("【睡眠定时器】本集已播完，已停止连播");
    toast("【睡眠定时器】本集已播完，已停止连播", true);
    return;
  }

  // 自动连播下一集（3 秒倒计时）
  const nextEp = getNextEpisode();
  if (nextEp) {
    toast(`3 秒后自动播放下一集（第 ${nextEp.ep} 集）…`, true);
    showPlayerOsd(`3 秒后自动播放第 ${nextEp.ep} 集…`);
    clearTimeout(autoPlayTimer);
    autoPlayTimer = setTimeout(() => {
      if (!$("view-player").classList.contains("hidden")) {
        playNextEpisode();
      }
    }, 3000);
  }
});

// 倍速切换
$("player-rate").onclick = () => {
  const v = $("video");
  const idx = (RATES.indexOf(v.playbackRate) + 1) % RATES.length;
  v.playbackRate = RATES[idx];
  $("player-rate").textContent = `倍速 ${RATES[idx]}x`;
  showPlayerOsd(`倍速: ${RATES[idx]}x`);
  localStorage.setItem("ani_rate", String(RATES[idx]));
};

function toggleHelpModal(show) {
  const modal = $("help-modal");
  if (!modal) return;
  if (show === undefined) {
    modal.classList.toggle("hidden");
  } else if (show) {
    modal.classList.remove("hidden");
  } else {
    modal.classList.add("hidden");
  }
}

const helpBtn = $("help-btn");
if (helpBtn) helpBtn.onclick = () => toggleHelpModal();
const helpClose = $("help-close");
if (helpClose) helpClose.onclick = () => toggleHelpModal(false);
const helpModalEl = $("help-modal");
if (helpModalEl) {
  helpModalEl.onclick = (e) => {
    if (e.target === helpModalEl) toggleHelpModal(false);
  };
}

// ---------- 即时弹幕发射台 ----------
let dmSendMode = "scroll";
let dmSendColor = "#ffffff";

function initDanmakuSender() {
  const modeBtn = $("dm-send-mode-btn");
  const modeMenu = $("dm-send-mode-menu");
  const colorBtn = $("dm-send-color-btn");
  const colorMenu = $("dm-send-color-menu");
  const sendInput = $("dm-send-input");
  const sendBtn = $("dm-send-btn");

  if (modeBtn && modeMenu) {
    modeBtn.onclick = (e) => {
      e.stopPropagation();
      modeMenu.classList.toggle("hidden");
      colorMenu?.classList.add("hidden");
    };
    modeMenu.querySelectorAll(".dm-popup-item").forEach((item) => {
      item.onclick = (e) => {
        e.stopPropagation();
        dmSendMode = item.getAttribute("data-mode") || "scroll";
        modeMenu.querySelectorAll(".dm-popup-item").forEach((it) => it.classList.toggle("active", it === item));
        const labels = { scroll: "滚动 ➔", top: "顶端 ⤓", bottom: "底端 ⤒" };
        modeBtn.textContent = labels[dmSendMode] || "滚动 ➔";
        modeMenu.classList.add("hidden");
      };
    });
  }

  if (colorBtn && colorMenu) {
    colorBtn.onclick = (e) => {
      e.stopPropagation();
      colorMenu.classList.toggle("hidden");
      modeMenu?.classList.add("hidden");
    };
    colorMenu.querySelectorAll(".color-opt").forEach((opt) => {
      opt.onclick = (e) => {
        e.stopPropagation();
        dmSendColor = opt.getAttribute("data-color") || "#ffffff";
        colorMenu.querySelectorAll(".color-opt").forEach((it) => it.classList.toggle("active", it === opt));
        colorBtn.style.setProperty("--cur-color", dmSendColor);
        colorMenu.classList.add("hidden");
      };
    });
  }

  document.addEventListener("click", () => {
    modeMenu?.classList.add("hidden");
    colorMenu?.classList.add("hidden");
  });

  function doSend() {
    if (!sendInput) return;
    const text = sendInput.value.trim();
    if (!text) {
      toast("请输入弹幕内容", false);
      return;
    }
    const v = $("video");
    const sec = v && isFinite(v.currentTime) ? v.currentTime : 0;
    const colNum = parseInt(dmSendColor.replace("#", ""), 16) || 0xffffff;

    const evt = {
      time_ms: Math.round(sec * 1000),
      text,
      mode: dmSendMode,
      color: colNum,
      sender: "me",
      weight: 30,
    };

    DanmakuOverlay.addEvent(evt);
    saveUserDanmaku(evt);
    if (typeof danmakuTimeline !== "undefined" && danmakuTimeline) {
      danmakuTimeline.push(evt);
      if (v && v.duration > 0) {
        renderDanmakuHeatmap(danmakuTimeline, v.duration);
      }
    }

    sendInput.value = "";
    sendInput.blur();
    showPlayerOsd(`弹幕已发送 🚀（${text}）`);
    toast("弹幕发送成功！", true);
  }

  if (sendBtn) sendBtn.onclick = doSend;
  if (sendInput) {
    sendInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doSend();
      } else if (e.key === "Escape") {
        sendInput.blur();
      }
    };
  }
}

// ---------- 完整观影历史看板 ----------
let fullHistoryCache = [];
let historyFilterText = "";

function fmtRelativeTime(timestampMs) {
  if (!timestampMs) return "未知时间";
  const now = Date.now();
  const diffSec = Math.floor((now - timestampMs) / 1000);
  if (diffSec < 60) return "刚刚";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  if (diffSec < 86400 * 2) return "昨天";
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)} 天前`;
  const d = new Date(timestampMs);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function fmtDuration(sec) {
  if (!sec || isNaN(sec)) return "0:00";
  return fmtTime(sec);
}

async function loadFullHistory() {
  try {
    const list = await invoke("list_full_playback_history", { limit: 200 });
    fullHistoryCache = list || [];
    renderFullHistoryList();
  } catch (e) {
    toast("拉取观影历史失败：" + e);
  }
}

function renderFullHistoryList() {
  const container = $("history-list");
  const countEl = $("history-modal-count");
  if (!container) return;

  let items = fullHistoryCache;
  if (historyFilterText) {
    const kw = historyFilterText.toLowerCase();
    items = items.filter(
      (it) =>
        (it.subject_name && it.subject_name.toLowerCase().includes(kw)) ||
        (it.title && it.title.toLowerCase().includes(kw))
    );
  }

  if (countEl) {
    countEl.textContent = `共 ${fullHistoryCache.length} 条记录${historyFilterText ? `（过滤后 ${items.length} 条）` : ""}`;
  }

  if (!items.length) {
    container.innerHTML = `<div class="empty" style="text-align:center;padding:40px;color:var(--text-muted);">${historyFilterText ? "未检索到匹配的观影记录" : "还没有观影记录，快去挑一部番剧看看吧~"}</div>`;
    return;
  }

  container.innerHTML = "";
  for (const item of items) {
    const card = document.createElement("div");
    card.className = "history-item-card";

    const dur = item.duration_seconds || 0;
    const pos = item.position_seconds || 0;
    const pct = dur > 0 ? Math.min(100, Math.round((pos / dur) * 100)) : 0;
    const isFinished = item.finished || pct >= 95;

    const coverHtml = item.cover_url
      ? `<img src="${escapeAttr(item.cover_url)}" class="history-item-cover" referrerpolicy="no-referrer" onerror="this.style.opacity='0.2'" />`
      : `<div class="history-item-cover" style="display:grid;place-items:center;font-size:24px">🎬</div>`;

    const progDesc = isFinished
      ? `已观看完毕 ✓`
      : dur > 0
      ? `看到 ${fmtDuration(pos)} / ${fmtDuration(dur)} (${pct}%)`
      : `看到 ${fmtDuration(pos)}`;

    const relTime = fmtRelativeTime(item.updated_at);

    card.innerHTML = `
      ${coverHtml}
      <div class="history-item-info">
        <div class="history-item-title-row">
          <span class="history-item-subject" title="${escapeAttr(item.subject_name || "未知番剧")}">${escapeHtml(item.subject_name || "未知番剧")}</span>
          <span class="history-item-ep">${escapeHtml(item.title || "")}</span>
        </div>
        <div class="history-progress-bar-wrap">
          <div class="history-progress-bar-inner" style="width:${isFinished ? 100 : pct}%"></div>
        </div>
        <div class="history-item-meta-row">
          <span class="history-status-tag ${isFinished ? "finished" : "watching"}">${isFinished ? "已追完" : "观看中"}</span>
          <span>${progDesc}</span>
          <span class="meta">${relTime}</span>
        </div>
      </div>
      <div class="history-item-actions">
        <button class="button small btn-hist-play" title="继续播放">▶ 播放</button>
        <button class="ghost small btn-hist-del" title="删除本条记录">✕</button>
      </div>
    `;

    card.querySelector(".btn-hist-play").onclick = () => {
      toggleHistoryModal(false);
      if (item.media_url) {
        openPlayer(
          item.media_url,
          `${item.subject_name || ""} ${item.title || ""}`.trim()
        );
      } else {
        toast("该记录未关联媒体播放链接");
      }
    };

    card.querySelector(".btn-hist-del").onclick = async (e) => {
      e.stopPropagation();
      try {
        await invoke("remove_playback_history", { key: item.episode_id });
        fullHistoryCache = fullHistoryCache.filter((x) => x.episode_id !== item.episode_id);
        renderFullHistoryList();
        loadHome();
        toast("已删除播放记录", true);
      } catch (err) {
        toast("删除失败：" + err);
      }
    };

    container.appendChild(card);
  }
}

function toggleHistoryModal(show) {
  const modal = $("history-modal");
  if (!modal) return;
  const isHidden = modal.classList.contains("hidden");
  const next = show !== undefined ? show : isHidden;
  modal.classList.toggle("hidden", !next);
  if (next) {
    historyFilterText = "";
    const input = $("history-search-input");
    if (input) {
      input.value = "";
      input.focus();
    }
    loadFullHistory();
  }
}

function initHistoryModal() {
  const btn = $("history-btn");
  if (btn) btn.onclick = () => toggleHistoryModal();
  const closeBtn = $("history-close");
  if (closeBtn) closeBtn.onclick = () => toggleHistoryModal(false);
  const modal = $("history-modal");
  if (modal) {
    modal.onclick = (e) => {
      if (e.target === modal) toggleHistoryModal(false);
    };
  }

  const searchInput = $("history-search-input");
  if (searchInput) {
    searchInput.oninput = () => {
      historyFilterText = searchInput.value.trim();
      renderFullHistoryList();
    };
  }

  const clearBtn = $("history-clear-all");
  if (clearBtn) {
    clearBtn.onclick = async () => {
      if (!confirm("确定要清空全部观影历史记录吗？此操作不可恢复。")) return;
      try {
        await invoke("clear_playback_history");
        fullHistoryCache = [];
        renderFullHistoryList();
        loadHome();
        toast("已清空全部观影历史记录", true);
      } catch (err) {
        toast("清空失败：" + err);
      }
    };
  }
}

initDanmakuSender();
initHistoryModal();

function triggerBossKey() {
  const v = $("video");
  if (v) {
    if (!v.paused) v.pause();
    v.muted = true;
  }
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
  invoke("win_minimize").catch(() => {});
  showPlayerOsd("【老板键】已静音并最小化窗口");
}

// 全局桌面快捷键：/ 聚焦搜索框；H 打开历史；Enter 发射弹幕；? 打开帮助；Escape 退出/返回上一层；Alt+Q 老板键
document.addEventListener("keydown", (e) => {
  const tag = e.target?.tagName;
  const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

  if ((e.altKey && (e.key === "q" || e.key === "Q")) || (e.ctrlKey && e.altKey && (e.key === "h" || e.key === "H"))) {
    e.preventDefault();
    triggerBossKey();
    return;
  }

  if ((e.key === "h" || e.key === "H") && !isInput && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    toggleHistoryModal();
    return;
  }

  if (e.key === "Enter" && !isInput && !$("view-player").classList.contains("hidden")) {
    const dmInput = $("dm-send-input");
    if (dmInput) {
      e.preventDefault();
      dmInput.focus();
      dmInput.select();
      return;
    }
  }

  if (e.key === "/" && !isInput) {
    e.preventDefault();
    const sInput = $("search-input");
    if (sInput) {
      sInput.focus();
      sInput.select();
    }
    return;
  }

  if (e.key === "?" && !isInput) {
    e.preventDefault();
    toggleHelpModal();
    return;
  }

  if (e.key === "Escape") {
    const batchModal = $("batch-dl-modal");
    if (batchModal && !batchModal.classList.contains("hidden")) {
      closeBatchDownloadModal();
      return;
    }
    const dmModal = $("dm-match-modal");
    if (dmModal && !dmModal.classList.contains("hidden")) {
      closeDmMatchModal();
      return;
    }
    const histModal = $("history-modal");
    if (histModal && !histModal.classList.contains("hidden")) {
      toggleHistoryModal(false);
      return;
    }
    const helpModal = $("help-modal");
    if (helpModal && !helpModal.classList.contains("hidden")) {
      toggleHelpModal(false);
      return;
    }
    if (isInput) {
      if (e.target.id === "search-input" && e.target.value) {
        e.target.value = "";
        const clr = $("search-clear");
        if (clr) clr.classList.add("hidden");
      } else {
        e.target.blur();
      }
    } else if (dlVisible) {
      dlVisible = false;
      $("download-panel").classList.add("hidden");
    } else if (!$("view-player").classList.contains("hidden")) {
      const drawer = $("player-ep-drawer");
      if (drawer && !drawer.classList.contains("hidden")) {
        toggleEpDrawer(false);
        return;
      }
      if (!document.fullscreenElement) {
        $("player-back").click();
      }
    } else if (!$("view-settings").classList.contains("hidden")) {
      $("settings-back").click();
    } else if (!$("view-detail").classList.contains("hidden")) {
      $("back-btn").click();
    } else if (state.subView === "results") {
      showHomeSection();
    }
  }
});

