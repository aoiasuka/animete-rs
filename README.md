# ani-rs —— 用 Rust 复刻 Ani（Animeko）

一个 Windows 端追番客户端：**找番 → 聚合搜源 → 自动选源 → BT 下载 / 在线播放 / 离线缓存 → 弹幕 → 进度云同步**，用 Rust + Tauri 2 实现 [Ani（Animeko）](https://github.com/open-ani/animeko)的核心体验。

项目基于两份本地分析文档施工（不入库）：Ani 6.0.0 的行为级深度拆解（模块/类/端点地图），以及据此编写的《Rust 构建蓝图》（选型/子系统设计/工程规范/里程碑）。本仓库是蓝图的施工实现。当前进度：**M0 骨架、M1 数据源、M3 GUI 壳、M4 弹幕与同步完成；M2 边下边播已落地应用内形态（anibt:// 流式协议，mpv 为兜底）**。

---

## 功能

- **首页**：本周新番时间表（Bangumi `/calendar`）+ 继续观看（断点百分比进度卡片，单项移除/一键续播）+ 我的追番（本地收藏与管理、**并发检查追更状态、动态呈现「更新至第 X 集」更新徽标**）+ 最近搜索（单项删除/清空/SQLite 持久化，跨重启）+ **搜索框聚焦智能下拉建议（最近历史快捷直选/单项删除 + 我的追番快速检索标签）**
- **找番与剧集打卡**：搜索 Bangumi 条目（输入框交互式清空与 Esc 快捷清除）→ 条目详情（**封面提取色调 Ambient 动态流光背景** / 一键「♥ 追番」收藏 / **角色与声优展台（Ani 6.0 特性，主角配角徽标 + CV 详情）**）→ 剧集列表（**多类型分栏 Tab 过滤（正片 / SP特别篇 / OP&ED / 其他）、正序倒序（1→N / N→1）智能切换、剧集实时模糊搜索**、实时打卡进度统计 `已看 X / Y 集 (Z%)`、全标已看/清空已看、`Alt+点击` 区间打卡、已看「✓」绿色徽标、右键或 `Shift+点击` 手动切换、看完自动标记）
- **聚合选源**：向所有启用源并发检索 → 自动选源引擎评分排序（字幕组偏好 / 期望分辨率 / 大小合理性 / 剧集号匹配），支持「仅看可用」开关与字幕组/分辨率即时筛选、条件冲突时一键重置筛选
- **BT 下载**：磁力/.torrent 一键下载，顶栏常驻「下载」入口与未完成任务动态角标，右下角浮窗多任务管理（聚合上下行实时速率 / 进度 / 速度 / 暂停 / 移除 / 一键清理完成 / 复制文件绝对路径 / 完成后直接播放）
- **在线播放**：
  - HTTP/HLS 直链（Jellyfin 条目、直链粘贴）——内置 hls.js 播放器，多码率画质切换
  - BT 边下边播（应用内播放器）——按集号自动选种子内视频文件，头部缓冲就绪即在应用内起播：`anibt://` 自定义协议把 librqbit 文件流以 HTTP Range 形式喂给播放器，读到未下载区间阻塞等 piece、读位置（seek）即下载优先级；弹幕 / 断点续播 / 倍速对 BT 源全部生效，容器不受 WebView 原生支持（如 MKV）时智能分流至外部 mpv/PotPlayer/VLC 等系统播放器（Win32 原生调用无控制台黑框）
- **播放器与字幕体验**：**外挂字幕系统（支持拖拽 .srt / .vtt 至播放器挂载、内置纯前端 SRT 转 WebVTT、字幕延迟微调快捷键 `Z` / `X`、字号小/中/大切换、原生全屏高质感渲染）**、全屏沉浸 OSD 浮层（快进快退/音量/静音/倍速/连播倒计时/弹幕调谐/字幕微调全量视觉反馈）、**播放信息统计面板（Stats for Nerds，快捷键 `I` 调出，实时显示协议/分辨率/视口尺寸/丢帧率/缓冲比例/弹幕状态）**、播放器内嵌磨砂缓冲旋转 Spinner、沉浸播放鼠标停滞 2.5s 自动休眠（隐藏光标）、断点续播、连播下一集（顶栏「下一集 ⏭」按钮 / `N` 快捷键 / 播毕 3 秒倒计时自动切集）、倍速/音量记忆、全套桌面快捷键（`/` 聚焦搜索、`Escape` 退出返回、`Space` / `←→` 或 `JL` / `↑↓` / `M` 静音 / `0`~`9` 进度跳转 / `<` `>` 倍速 / `F` / `N` / `I` / `[` `]` / `Z` `X`）、点击暂停、双击全屏、HLS 出错自动恢复
- **弹幕与精细调谐**（dandanplay 开放 API）：在设置页填入免费申请的 AppId/AppSecret 后，播放时按「番名 + 集号」自动匹配弹幕池；结果缓存 3 天（SQLite，网络失败时回落过期缓存），后端完成去重 + 关键词/用户/类型屏蔽，前端 Canvas 渲染（全屏图层跟随与精准视口重定位、滚动/顶部/底部三轨道、轨道满自动限流、seek 重定位），支持多级不透明度循环（100% -> 70% -> 40% -> 关）与时间微调（`[` / `]` 按秒校准）
- **下载任务**：librqbit fastresume 恢复的历史任务自动登记进面板（后台全周期持续追踪进度与完成事件，角标与浮窗增量渲染，不重建 DOM）
- **偏好学习**（M5 起步）：手动点「下载 / 在线播放」时自动把该候选的字幕组/分辨率记为偏好，参与后续自动选源
- **离线缓存（M5 HTTP 引擎）**：候选列表点「⤓ 缓存」把 Jellyfin/HLS/直链视频下载到本地（**6 并发高速分段下载通道，5~10x 提速**；**启发式过滤净化 HLS 广告/贴片切片**；m3u8 自动选最高码率、本地重写 playlist），经 `anicache://` 自定义协议回放（支持 Range 拖动 seek）；设置 → 缓存 里管理（**一键打开缓存根目录、一键清空全部缓存与记录**、播放/定位/删除）；暂不支持加密流（AES-128）与 BYTERANGE 分段
- **数据管理与备份**：设置页支持一键**导出全部追番与播放历史为 JSON 备份文件**，并支持导入合并，实现跨机器无损迁移
- **版本更新检查**：设置 → 关于与更新 中提供「检查更新」，通过 GitHub Releases API 实时检测新版本并呈现更新日志与下载链接
- **选源过滤**：候选列表按字幕组/分辨率一键筛选与仅可用快速收缩
- **Bangumi 账号（收藏/进度同步）**：设置页填入 bgm.tv 开发者平台的 ClientID/Secret（免费创建应用）→ 浏览器授权 → 粘贴授权码登录；之后**看完一集自动标记「看过」**，条目未收藏时自动加入「在看」；token 临近过期自动刷新；**支持离线挂起队列（`playback_pending_op`，弱网断网先记账，网络或授权恢复后自动回放打卡）**
- **托盘**：关闭窗口 = 最小化到托盘（下载/做种继续）；托盘左键唤起主窗口，右键「退出」时有未完成任务会挽留确认；单实例互斥（二次启动唤起已有窗口）
- **设置**（改动即存，JSON 原子写）：选源偏好（字幕组/分辨率/黑名单）、数据源（启停/优先级覆盖/连通性测试/Jellyfin 配置与连接测试）、BT 下载（目录/做种/端口/流式缓冲与超时/mpv 检测）、弹幕（dandanplay 凭据 + 屏蔽规则）、备份与数据、关于与更新

前端是 `bin/ani/ui/` 下的纯静态 HTML/JS（无 npm 依赖），经 `window.__TAURI__` 调用后端 command。

## 快速开始

### GUI（推荐）

```bash
cargo build --release -p ani   # 产物 target/release/ani.exe（约 24 MB，免安装）
./target/release/ani.exe       # 需要 Windows 10/11（WebView2 系统自带）
```

流程：首页点条目看剧集 → 点某集自动多源聚合选源 → 「下载」/「复制磁力」/「▶ 在线播放」。

### CLI（调试/验收入口）

```bash
cargo run -p ani-cli -- search 葬送的芙莉莲   # Bangumi 搜条目
cargo run -p ani-cli -- episodes 400602      # 列剧集
cargo run -p ani-cli -- fetch 400602 1       # 多源聚合 + 自动选源，列出候选
cargo run -p ani-cli -- best 400602 1        # 最佳候选（JSON）
cargo run -p ani-cli -- db                   # 初始化/检查本地 SQLite
cargo run -p ani-cli -- torrent              # BT 会话烟雾测试
```

## 架构

### crate 分层（依赖纪律与蓝图 1.1 一致）

```
bin/ani              Tauri 2 GUI 入口薄壳（command 层保持薄，业务全在 crates）
bin/ani-cli          CLI 入口薄壳
crates/ani-core      骨架：Media / MediaSource trait / Registry（对应 datasource:api）
crates/ani-domain    自动选源评分引擎（纯函数，无网络无 GUI，100% 可测；对应 domain/media/selector）
crates/ani-danmaku   弹幕：dandanplay 协议客户端（签名/匹配/拉取）+ 引擎（去重/屏蔽/时间轴分桶，对应 danmaku:*）
crates/ani-torrent   librqbit 封装：会话 / 元数据 / 文件列表（对应 torrent:api + anitorrent）
crates/ani-db        SQLite 持久层：迁移 / 播放进度 / 搜索历史（对应 app-data 的 Room）
crates/ds-bangumi    bangumi.tv v0 REST（条目/剧集/时间表/封面升级）+ OAuth 账号链路（收藏/进度打卡）
crates/ds-dmhy       动漫花园 HTML 解析源（scraper + 双镜像轮询）
crates/ds-mikan      蜜柑计划 RSS 源
crates/ds-acgrip     acg.rip RSS 源
crates/ds-nyaa       nyaa.si RSS 源（日文原名检索）
crates/ds-jellyfin   Jellyfin/Emby 媒体服务器源（HLS 直链，在线播放）
```

与 Ani 的模块对应关系（完整映射表见蓝图 1.2）：

| Ani（Kotlin） | 本项目 | 差异说明 |
|---|---|---|
| `:datasource:api` | `ani-core` | Media / MediaSource / MediaSourceTier 原样保留 |
| `domain/media/selector` | `ani-domain` | "偏好 + 可解释排除"设计照搬：`Candidate::Available{score}` / `Excluded{reason}` |
| `:torrent:anitorrent`（libtorrent C++ FFI） | `ani-torrent` | 换 **librqbit**（纯 Rust、tokio 原生），省掉整个 FFI 层 |
| `app-data`（Room + domain） | `ani-db` + `ani-domain` | sqlx migrations；表结构沿用拆解文档 10.4 的子集 |
| `:danmaku:*` | `ani-danmaku` | 协议层（dandanplay）在 M4 接入，引擎层已就绪 |
| `:app:desktop`（Compose Multiplatform） | `bin/ani` | Tauri 2 + 系统 WebView2；自绘标题栏、无边框窗口 |
| 依赖注入 Koin | `AppContext` 显式装配 | Rust 惯例：一个 struct + `Arc<T>`，对应 `DesktopModulesKt` 的职责 |

### 数据流走读

```
搜索框 ──▶ ds-bangumi（/v0/search/subjects，filter type=2 只搜动画）
点条目 ──▶ ds-bangumi（/v0/episodes）
点某集 ──▶ registry.fetch_all()：dmhy(HTML)/mikan·acgrip·nyaa(RSS)/jellyfin(REST) 并发
       ──▶ ani-domain::select_auto（评分 + 可解释排除，黑名单/偏好来自设置）
       ──▶ 候选列表（Available 按分排序 + Excluded 带原因）
下载   ──▶ ani-torrent（librqbit 会话，fastresume 持久化）→ 800ms ticker 广播 downloads-progress
在线播放 ─▶ BT：等元数据 → 按集号选文件 → 头部 8MB 就绪 → 应用内播放器经 anibt:// 协议
         │  读 librqbit FileStream（未下载区间阻塞等 piece、seek 即改下载优先级），206 分块响应
         └▶ HTTP/HLS：hls.js 直播（应用内 BT 播放失败时回落外部 mpv/系统播放器）
看完/退出 ─▶ ani-db playback_history（断点续播；媒体 key = URL 哈希）
```

### 数据源现状

| 源 | 方式 | 状态 |
|---|---|---|
| dmhy 动漫花园 | 列表页 HTML 解析 + 磁力 | ✅ 主力源 |
| acg.rip | RSS（enclosure 直链 + media:content 大小） | ✅ |
| nyaa.si | RSS（`<link>` 即 .torrent 直链，日文原名检索） | ✅ 需代理可达 |
| mikan 蜜柑计划 | RSS | ⚠️ 匿名 `/RSS/Search` 已停用（需登录），当前静默无结果 |
| Bangumi | v0 REST | ✅ 元数据/时间表/剧集（非片源） |
| Jellyfin/Emby | REST + HLS 直链 | ✅ 设置页配置后作为高分源参与选源 |

每个解析器都有真实页面/Feed 结构的 fixture 单测（`#[cfg(test)]`），站点改版时测试先红——这是蓝图第 9 章的纪律。

## 关键实现要点

- **自动选源**（`ani-domain`）：源分级打底（High/Medium/Low → 3/2/1 ×10）+ 字幕语言偏好打分（简中/繁中/生肉 +6.0 匹配加权与背离惩罚）+ 字幕组偏好（完全 +8 / 模糊 +4）+ 分辨率接近度 + 大小合理性（<100MiB 惩罚预告、>20GiB 惩罚合集）；剧集号解析绕开 `1080p`/`x265`/`S01`/`第2季`/`Season 2`/年份/日期区间等全部假阳性，`S01E05` 取 E 后集号
- **沉浸播放与快速选集**：全屏/窗口模式下支持一键滑出「快速选集抽屉」（快捷键 `E` / `Esc`，磨砂质感悬浮、分类 Tab、播放中高亮、已看徽标，原地无缝换集）；支持外挂字幕微调（`Z`/`X`）与原生渲染；支持 HLS 6 并发分段下载与广告切片启发式过滤净化
- **多主题与个性化强调色**：内置「深邃夜空」、「极夜 OLED」（纯黑极致省电）与「晨曦雅白」（日间清雅护眼）3 种主题模式，以及「紫罗兰」、「蔚蓝」、「翡翠」、「落樱」、「琥珀」5 组高定强调色调色盘，设置页即选即换并支持启动零闪烁持久化
- **BT 渐进播放**：磁力 `add` 内部会阻塞等元数据（librqbit 行为），命令层包超时；文件显式 `output_folder` 使落盘路径与播放路径恒一致；piece 区间换算（`pieces_for_range`）是 seek 的核心一跳
- **anibt:// 协议**（`bin/ani/src/btstream.rs`）：Tauri 的协议 responder 只收缓冲响应体，所以按 4MiB 封顶回 206（Content-Range 收敛区间），WebView 按消费进度续发 Range 请求，等价于滚动窗口的渐进读取；无 Range 头的请求按 `bytes=0-` 处理（防止整部几 GiB 文件读进内存）；读块 60s 超时防死种挂起。Range 解析/路径校验是纯函数带单测（多区间取第一个、`bytes=-N` 后缀、非法 spec 忽略、越界 416）
- **弹幕索引**：1 秒分桶 + 桶内按权重降序，`window(from, to)` 供渲染层 O(1) 取窗口；脏数据（负值/超 24h `time_ms`）构建时丢弃；多源去重按时间窗回看，O(n·w)
- **设置**：单文件 JSON + `version` 链式迁移预留 + 临时文件 rename 原子写；损坏时留档 `.json.bad` 防止静默覆盖
- **错误模型**：`UserError` 两级（network / source_blocked / captcha_required / internal），command 边界统一收敛，前端按 kind 出文案

## 数据存储

全部位于 `%APPDATA%\ani-rs\`：

```
%APPDATA%\ani-rs\
├── settings.json        # 设置（原子写）
├── ani.db               # SQLite（WAL）：播放进度 / 搜索历史 / 弹幕缓存 / 离线缓存清单
├── downloads\           # BT 下载目录（默认，可改）
└── cache\               # 离线缓存（HLS/直链），经 anicache:// 协议回放
```

BT 会话的断点/做种状态由 librqbit 自己持久化（`persistence: json`），重启自动恢复；SQLite 只存业务数据——单一真相源原则（蓝图 3.3）。

## 开发

```bash
cargo check --workspace --all-targets
cargo test --workspace          # 35 个单测（解析器 fixture + 纯函数 + dandanplay/Bangumi/HLS 协议）
cargo clippy --workspace --all-targets   # 0 警告基线（CI 以 -D warnings 强制）
cargo fmt --all --check         # CI 同样强制
```

约定：凡是改解析器的提交必须带 fixture 变更；`ani-core`/`ani-domain` 保持无网络、无 GUI 可测；错误跨 crate 边界统一收敛为 `UserError`；提交信息走 Conventional Commits（`fix(ds-dmhy): …`）。

## 路线图

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 骨架 | workspace + ani-core + Bangumi CLI | ✅ |
| M1 数据源 | dmhy/mikan/acgrip/nyaa + 聚合选源 | ✅ |
| M3 GUI 壳 | Tauri 2 窗口 + 首页/搜索/选源/设置/播放器 | ✅ |
| M2 边下边播 | StreamingReader + mpv stream-cb 随机读、piece 级优先级、分段进度条 | 🔶 **应用内形态已落地**：librqbit FileStream（AsyncRead+AsyncSeek，流位置即 piece 优先级）经 anibt:// 协议接入应用内播放器（弹幕/续播可用），mpv 为兜底；未做 mpv stream-cb 直读 |
| M4 弹幕与同步 | dandanplay 弹幕接入 + Canvas 渲染层 + Bangumi 收藏/进度云同步 | ✅ 弹幕（需自配 AppId）+ Bangumi 看完自动打卡均已打通 |
| M5 选源与缓存 | 偏好学习持久化 + 双缓存引擎（BT/HTTP） | 🔶 偏好学习 + HTTP/HLS 离线缓存（含管理页）已就绪；BT 引擎即下载目录本身 |
| M6 打磨 | 托盘 / 单实例 / 更新器 / 打包 CI / i18n | ✅ 托盘 + 单实例 + 自动更新检查（GitHub Releases API）+ Windows CI 流水线已全部就绪 |

### 已知限制

- **mikan**：匿名搜索接口被官方停用且 ID 空间独立（非 bangumi.tv ID），恢复需登录态接入；当前该源静默无结果，不影响其它源
- **弹幕**：dandanplay 开放 API 需要在[弹弹play 开放平台](https://github.com/kaedei/dandanplay-libraryindex)免费申请 AppId/AppSecret 并填入设置（Ani 官方是内置自家凭据，本项目按合规考虑让用户自配）；未配置时弹幕静默关闭，不影响其它功能
- **Bangumi 账号**：OAuth 需要在 [bgm.tv 开发者平台](https://bgm.tv/dev/app)免费创建应用获取 ClientID/Secret 并填入设置（授权采用「打开授权页 → 复制授权码」流程，应用无需注册回调地址）；未登录时看完打卡静默跳过，不影响本地进度
- BT 边下边播默认走应用内播放器（需视频容器被 WebView2 支持：mp4/webm/ts 无碍，mkv 走 Edge 媒体栈多数可播）；失败自动回落外部 mpv（设置里可配路径，自动探测 PATH/常见位置），再找不到回退系统默认播放器
- 仅在 Windows 10/11 上验证（Tauri 2 理论上可跨平台，未测）

## 合规说明

本项目为 clean-room 实现：只依据行为级拆解文档与接口签名重新设计，未复制 Ani 的源码（Ani 为 AGPL-3.0）。BT 功能仅供学习研究，请尊重内容版权；做种默认开启，可在设置中关闭。

---

*本项目是《Ani 深度拆解 + Rust 构建蓝图》的施工实现；crate 职责与对应 Ani 模块的映射见上文架构一节。*
