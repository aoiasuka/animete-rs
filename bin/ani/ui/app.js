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

async function loadCollections() {
  const sec = $("collection-section");
  const grid = $("collection-grid");
  const countEl = $("collection-count");
  const refreshBtn = $("btn-refresh-collections");
  if (!sec || !grid) return;

  if (refreshBtn && !refreshBtn.__bound) {
    refreshBtn.__bound = true;
    refreshBtn.onclick = async () => {
      try {
        refreshBtn.disabled = true;
        refreshBtn.textContent = "检查中…";
        const updates = await invoke("check_collection_updates");
        state.collectionUpdates = updates || {};
        await loadCollections();
        const count = Object.keys(state.collectionUpdates).length;
        toast(`追更状态已更新（共检查 ${count} 部动画）`, true);
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
      return;
    }
    sec.classList.remove("hidden");
    if (countEl) countEl.textContent = `${list.length} 部追番`;
    grid.innerHTML = "";
    for (const item of list) {
      grid.appendChild(subjectCard(item));
    }
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
  const displayTitle = s.display_title || s.name_cn || s.name || "动画";
  const originalTitle = s.original_title || s.name || "";
  const bangumiId = Number(s.id ? (s.id.id ?? s.id) : (s.bangumi_id ?? s.id));
  const coverImg = s.cover_url
    ? `<img src="${escapeAttr(s.cover_url)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.opacity='0.15'" />`
    : `<div style="display:grid;place-items:center;height:100%;color:var(--text-dim);font-size:32px">🎬</div>`;
  const airDate = s.air_date ? escapeHtml(s.air_date) : "放送中";
  const updateInfo = state.collectionUpdates ? state.collectionUpdates[bangumiId] : null;
  const updateBadge = updateInfo
    ? `<div class="card-update-badge">更新至第 ${updateInfo.latest_ep} 集</div>`
    : "";
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
      const isNow = await invoke("toggle_subject_collection", {
        bangumiId: Number(bangumiId),
        nameCn: s.name_cn || s.display_title || "",
        name: s.original_title || s.name || "",
        coverUrl: s.cover_url || null,
        airDate: s.air_date || null,
      });
      isCurrentSubjectCollected = isNow;
      setCollectBtnUI(isNow);
      toast(isNow ? "已加入我的追番" : "已取消追番", true);
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
  loadCharacters(bangumiId, my);
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

async function loadCharacters(subjectId, seq) {
  const wrap = $("characters-wrap");
  const listEl = $("characters-list");
  const countEl = $("characters-count");
  if (!wrap || !listEl) return;
  wrap.classList.add("hidden");
  listEl.innerHTML = "";
  if (countEl) countEl.textContent = "";

  try {
    const chars = await invoke("get_subject_characters", { subjectId });
    if (seq !== subjectSeq) return;
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
  } catch (e) {
    if (seq !== subjectSeq) return;
    wrap.classList.add("hidden");
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


// ---------- 在线播放器 ----------

// ---------- 弹幕渲染层（Canvas 覆盖层；过滤已在后端完成，这里只管画） ----------
const DanmakuOverlay = (() => {
  const SCROLL_MS = 9000, STATIC_MS = 5000, MAX_ITEMS = 80;
  let events = [];   // 按时间升序
  let cursor = 0;    // 下一条待上屏的下标
  let items = [];    // 活动中的弹幕 {text,color,mode,lane,born,width}
  let scrollLanes = [], staticLanes = [];  // 各轨道的占用截止时刻（video 时间秒）
  let raf = null, lastT = 0, W = 0, H = 0, fontPx = 24;
  let timeOffsetSec = 0;
  let opacity = 1.0;

  const cv = () => $("danmaku-canvas");
  const vid = () => $("video");

  function resize() {
    const c = cv(), v = vid();
    if (!c || !v) return;
    const isFs = !!document.fullscreenElement;
    W = c.width = v.clientWidth || window.innerWidth;
    H = c.height = v.clientHeight || window.innerHeight;
    const rect = v.getBoundingClientRect();
    if (isFs && rect.width > 0 && rect.height > 0) {
      W = c.width = rect.width;
      H = c.height = rect.height;
      c.style.left = `${rect.left}px`;
      c.style.top = `${rect.top}px`;
      c.style.width = `${rect.width}px`;
      c.style.height = `${rect.height}px`;
    } else {
      c.style.left = "0";
      c.style.top = "0";
      c.style.width = "100%";
      c.style.height = "100%";
    }
    fontPx = Math.max(16, Math.min(36, Math.round(H / 22)));
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
    while (cursor < events.length && (events[cursor].time_ms / 1000 + timeOffsetSec) <= now) {
      const t = events[cursor].time_ms / 1000 + timeOffsetSec;
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
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha * opacity));
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
      timeOffsetSec = 0;
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
      timeOffsetSec += deltaSec;
      this.seekTo(vid().currentTime);
      const sign = timeOffsetSec > 0 ? "+" : "";
      showPlayerOsd(`弹幕时间微调：${sign}${timeOffsetSec}s`);
    },
    setOpacity(val) {
      opacity = val;
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
  const subMenu = $("sub-menu");
  if (subMenu) subMenu.classList.add("hidden");
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
  currentMediaUrl = url || "";
  $("player-title").textContent = title || "在线播放";
  showView("player");
  updatePlayerNextBtn();
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
  if (statsOsdVisible) updateStatsOsd();
  if (v.currentTime - lastSavedSec >= 5) {
    lastSavedSec = v.currentTime;
    saveProgress(false);
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
$("video").addEventListener("pause", () => {
  if (stageEl) stageEl.classList.remove("idle");
  clearTimeout(stageIdleTimer);
});
$("video").addEventListener("click", (e) => {
  const v = $("video");
  // 原生控制条在 shadow DOM 里，click 会重定向到 video 元素本身；
  // 命中底部控制条区域时不翻转播放状态，否则"点暂停=没点"
  const rect = v.getBoundingClientRect();
  if (e.clientY - rect.top > rect.height - 60) return;
  if (v.paused) {
    v.play().catch(() => {});
    showPlayerOsd("▶ 播放");
  } else {
    v.pause();
    showPlayerOsd("⏸ 暂停");
  }
});
$("video").addEventListener("dblclick", () => toggleFullscreen());

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
  $("player-danmaku").textContent = on ? `弹幕 ${Math.round(op * 100)}%` : "弹幕 关";
  DanmakuOverlay.setOpacity(op);
  DanmakuOverlay.setEnabled(on);
}

$("player-danmaku").onclick = () => {
  const cur = danmakuOpacity();
  const idx = DM_OPACITIES.findIndex((o) => Math.abs(o - cur) < 0.05);
  const nextIdx = (idx + 1) % DM_OPACITIES.length;
  const next = DM_OPACITIES[nextIdx];
  localStorage.setItem("ani_dm_opacity", String(next));
  localStorage.setItem("ani_dm", next > 0 ? "1" : "0");
  if (settingsState.data?.danmaku_source) {
    settingsState.data.danmaku_source.enabled = next > 0;
    scheduleSave();
  }
  syncDanmakuToggle();
  if (next > 0) {
    toast(`弹幕不透明度：${Math.round(next * 100)}%`, true);
    showPlayerOsd(`弹幕不透明度: ${Math.round(next * 100)}%`);
  } else {
    toast("弹幕已关闭", true);
    showPlayerOsd("弹幕已关闭");
  }
};

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
  size: "md",
  trackEl: null,
  blobUrl: null,
};

function srtToVtt(srtText) {
  let vtt = "WEBVTT\n\n";
  const clean = srtText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\uFEFF/, "");
  vtt += clean.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
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

function buildShiftedVtt(cues, offsetSec) {
  let out = "WEBVTT\n\n";
  const fmtVttTime = (sec) => {
    sec = Math.max(0, sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  };
  for (const cue of cues) {
    const s = cue.start + offsetSec;
    const e = cue.end + offsetSec;
    if (e > 0) {
      out += `${fmtVttTime(s)} --> ${fmtVttTime(e)}\n${cue.text}\n\n`;
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

function loadSubtitleFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    let content = e.target.result;
    if (file.name.toLowerCase().endsWith(".srt")) {
      content = srtToVtt(content);
    }
    subState.cues = parseVttCues(content);
    subState.rawVtt = content;
    subState.filename = file.name;
    subState.loaded = true;
    subState.offsetSec = 0.0;
    applySubtitleTrack(content);
    updateSubUI();
    toast("已加载外挂字幕：" + file.name, true);
    showPlayerOsd("已加载字幕: " + file.name);
  };
  reader.readAsText(file, "utf-8");
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
  const shifted = buildShiftedVtt(subState.cues, subState.offsetSec);
  applySubtitleTrack(shifted);
  updateSubUI();
  const sign = subState.offsetSec > 0 ? "+" : "";
  showPlayerOsd(`字幕延迟: ${sign}${subState.offsetSec.toFixed(1)}s`);
}

function setSubSize(size) {
  subState.size = size;
  const sizes = { sm: "17px", md: "21px", lg: "26px" };
  document.documentElement.style.setProperty("--sub-font-size", sizes[size] || "21px");
  document.querySelectorAll(".sub-size-opt").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-size") === size);
  });
  showPlayerOsd(`字幕字号: ${size === "sm" ? "小" : size === "lg" ? "大" : "中"}`);
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
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      const n = file.name.toLowerCase();
      if (n.endsWith(".srt") || n.endsWith(".vtt") || n.endsWith(".ass")) {
        loadSubtitleFile(file);
      } else {
        toast("仅支持拖入 .srt 或 .vtt 外挂字幕文件");
      }
    }
  });
}

// 键盘快捷键：空格暂停 / ←→ 或 JL 快退快进 10s / ↑↓ 音量 / M 静音 / 0-9 进度跳转 / < > 倍速 / F 全屏 / N 下一集 / [ ] 弹幕时间微调 / Z X 字幕延迟微调
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
    "[", "]", ",", "<", ".", ">", "i", "I", "z", "Z", "x", "X"
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
      v.muted = false;
      v.volume = Math.min(1, Math.round((v.volume + 0.1) * 10) / 10);
      showPlayerOsd("🔊 音量: " + Math.round(v.volume * 100) + "%");
      break;
    case "ArrowDown":
      v.volume = Math.max(0, Math.round((v.volume - 0.1) * 10) / 10);
      showPlayerOsd("🔉 音量: " + Math.round(v.volume * 100) + "%");
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
    case "f": case "F": toggleFullscreen(); break;
    case "n": case "N": playNextEpisode(); break;
    case "e": case "E": toggleEpDrawer(); break;
    case "i": case "I": toggleStatsOsd(); break;
    case "[": DanmakuOverlay.adjustOffset(-1); break;
    case "]": DanmakuOverlay.adjustOffset(1); break;
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

// 全局桌面快捷键：/ 聚焦搜索框；? 打开帮助；Escape 退出/返回上一层
document.addEventListener("keydown", (e) => {
  const tag = e.target?.tagName;
  const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

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
