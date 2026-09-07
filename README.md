# ani-rs —— 用 Rust 复刻 Ani（Animeko）

一个 Windows 端追番客户端：**找番 → 聚合搜源 → 自动选源 → BT 下载 / 在线播放 / 离线缓存 → 弹幕 → 进度云同步**，用 Rust + Tauri 2 实现 [Ani（Animeko）](https://github.com/open-ani/animeko)的核心体验。

项目基于两份本地分析文档施工（不入库）：Ani 6.0.0 的行为级深度拆解（模块/类/端点地图），以及据此编写的《Rust 构建蓝图》（选型/子系统设计/工程规范/里程碑）。本仓库是蓝图的施工实现。当前进度：**M0 骨架、M1 数据源、M3 GUI 壳、M4 弹幕与同步完成；M2 边下边播已落地应用内形态（anibt:// 流式协议，mpv 为兜底）**。

---

## 功能

- **首页与探索**：本周新番时间表（Bangumi `/calendar`，**今日放送呼吸光环与「今日更新」徽标**，**支持一键「导出日历 📅」生成标准 RFC 5545 .ics 订阅文件并写入剪贴板，无缝导入 Windows 日历 / Outlook / Apple / Google Calendar 每周开播提醒**）+ **今日追更新番智能感应流光横幅（首屏并发交叉比对用户追番与今日开播列表，动态展示封面缩略阵列与「今日更新 N 部」霓虹徽章，支持 1-Click 一键聚焦筛选今日追更番剧）** + 继续观看（断点百分比进度卡片，单项移除/一键续播）+ 我的追番（本地收藏与管理、**联动 Bangumi 日历高能感应「今日更新 🔥」呼吸霓虹微标与专属过滤 Tab、多维排序下拉（默认/评分最高/放送最新/待看优先/名称A-Z）**、**并发检查追更状态、智能感知本地已看打卡与「待看第 X 集 / 已追平 ✓」动态徽标、追番关键词即时检索与「全部 / 待看 / 已追平」状态过滤**）+ 最近搜索（单项删除/清空/SQLite 持久化，跨重启）+ **二次元热门题材探索胶囊（异世界/热血/日常/科幻/恋爱/奇幻/治愈等，点击即搜）** + **搜索框聚焦智能下拉建议（最近历史快捷直选/单项删除 + 我的追番快速检索标签）**
- **找番与剧集打卡**：搜索 Bangumi 条目（输入框交互式清空与 Esc 快捷清除）→ **搜索结果多维分类筛选（全部 / TV 动画 / 剧场版 / OVA&SP）与多重排序（默认匹配 / 放送日期最新与最旧 / 标题 A-Z）** → 条目详情（**封面提取色调 Ambient 动态流光背景** / 一键「♥ 追番」收藏 / **Bangumi 黄金评分徽标（★ 8.5 + 评价人数）与全站综合排名（Rank #）** / **放送媒介（TV/WEB/OVA）与总集数徽标** / **热门标签群（点击直达搜索）** / **剧情简介平滑折叠卡片（展开 ▾ / 收起 ▴）** / **角色与声优展台（Ani 6.0 特性，主角配角徽标 + CV 详情，点击卡片呼出「角色名鉴 / 主创演职员名鉴」专属深度展台，支持一键探查该声优参演的其他动画作品、角色全局检索以及在系统浏览器直达 Bangumi 官方百科主页）** / **关联作品矩阵（前传 / 续集 / 剧场版 / 外传，关系徽标 + 一键跳转补番）** / **社区吐槽与短评（Ani 6.0 特性，接通 Bangumi 官方评论流，展示漫友星级评分 ★、用户头像与短评气泡，支持无缝分页加载）**）→ 剧集列表（**多类型分栏 Tab 过滤（正片 / SP特别篇 / OP&ED / 其他）、正序倒序（1→N / N→1）智能切换、剧集实时模糊搜索**、**离线已缓存剧集感知（剧集 Chip 智能标注「⚡ 已缓存」绿色徽标，选源列表置顶呈现「⚡ 本地离线缓存」极速秒开卡片）**、实时打卡进度统计 `已看 X / Y 集 (Z%)`、**剧集批量下载调度台（一键全选正片/未看、自选清晰度与字幕组偏好、平滑并发队列化加入下载）**、全标已看/清空已看、`Alt+点击` 区间打卡、已看「✓」绿色徽标、右键或 `Shift+点击` 手动切换、看完自动标记）
- **完整观影历史看板与数据清单导出**：顶栏常驻「历史 🕒」快捷入口（快捷键 `H`），展示完整观影足迹（含已看完与正在观看）；支持按番名/剧集即时模糊检索、精确时间戳与已看百分比进度条、单项删除与一键清空全部历史，支持直接点击「▶ 播放」续播；**支持一键「导出清单 📋」将追番列表或历史足迹导出为格式化 Markdown 表格并写入剪贴板**
- **聚合选源与后台智能预拉取**：向所有启用源并发检索 → 自动选源引擎评分排序（字幕组偏好 / 期望分辨率 / 大小合理性 / 剧集号匹配），支持「仅看可用」开关与字幕组/分辨率即时筛选、条件冲突时一键重置筛选；**下一集片源后台智能预拉取池（Pre-fetching），单集播放后半程静默并发预拉取并评分下一集候选，点击下一集或跳过 ED 连播时 0 毫秒瞬间秒开起播**；候选列表支持磁力与 HTTP 直链一键复制
- **BT 下载与任务调度控制**：磁力/.torrent 一键下载，顶栏常驻「下载」入口与未完成任务动态角标，右下角浮窗多任务管理（**「全部暂停 ⏸ / 全部继续 ▶」一键全局切换**、**「打开目录 📁」直接在资源管理器中唤起下载根目录**、聚合上下行实时速率 / 进度 / 速度 / 单项暂停 / 移除 / 一键清理完成 / 复制文件绝对路径 / 完成后直接播放）
- **在线播放**：
  - HTTP/HLS 直链（Jellyfin 条目、直链粘贴，**输入框全格式智能兼容自动识别 magnet:?xt= 磁力链直接流播**）——内置 hls.js 播放器，多码率画质切换
  - BT 边下边播（应用内播放器）——按集号自动选种子内视频文件，头部缓冲就绪即在应用内起播：`anibt://` 自定义协议把 librqbit 文件流以 HTTP Range 形式喂给播放器，读到未下载区间阻塞等 piece、读位置（seek）即下载优先级；弹幕 / 断点续播 / 倍速对 BT 源全部生效，容器不受 WebView 原生支持（如 MKV）时智能分流至外部 mpv/PotPlayer/VLC 等系统播放器（Win32 原生调用无控制台黑框）
- **播放器与字幕视效体验**：
  - **影院级环境光模式（Cinema Ambient Glow Mode）**：控制栏「画面 📺」菜单支持关闭 / 柔和 / 鲜明多档环境光调谐；底层 10fps 低功耗采样当前画面主色调，利用 GPU 硬件加速弥散滤镜将柔和呼吸光晕投射至播放器画布背景，大幅消除暗色与全屏观影的黑边压抑感，打造 IMAX 级沉浸视听体验；
  - **名场面无损截帧与剪贴板秒发**：快捷键 `C` 或点击「截屏 📸」，自动抓取当前片源原生真实分辨率帧（`videoWidth x videoHeight`），同步合成滤镜视效与镜像旋转，触发相机快门闪光动画；自动下载保存为规范格式（`[番名][第X集]_[分]m[秒]s.png`），并同步写入系统剪贴板（微信/QQ/Discord 中直接 `Ctrl+V` 发送分享）；
  - **画中画悬浮小窗（PiP）**：原生支持 Picture-in-Picture，快捷键 `P` 或顶栏「画中画 🗗」，小窗悬浮在桌面最顶层播放，切换至主页搜索找番或后台工作时音画不间断；
  - **Web Audio 音画同步校准与蓝牙耳机延迟补偿**：在 `AudioContext` 链路集成 `DelayNode` 延迟拓扑，控制栏「画面 📺」菜单支持 -500ms ~ +1000ms 精细调谐与**一键「蓝牙 +200ms」常见耳机延迟补偿（快捷键 `Shift+[` 提前 / `Shift+]` 延后）**，彻底告别看番音画错位；
  - **Web Audio 音效超频增益与多预设音频均衡器（EQ）**：内置 `AudioContext` 与 `GainNode` 音频增益通道（高达 300% 极限增益）；**新增三段立体声硬件级音频均衡器（原声 Flat / 人声清晰 Clear Dialogue / 影院重低音 Cinema Bass / 明亮高音 Bright Treble）**，大幅改善动漫配乐轰头、人声台词偏弱或外放发闷问题；
  - **高能长按倍速快进与鼠标滚轮桌面手势**：鼠标在视频画面长按 350ms+ 或键盘长按 `→` 400ms+，临时飙升至 2.0x/3.0x 快进，顶部浮现毛玻璃 `2.0x ⚡ 快进中` 呼吸胶囊，松手平滑恢复原速；播放器区域滚动鼠标滚轮平滑微调音量（±5%），`Shift+滚轮` 5秒进度微调，`Ctrl+滚轮` 0.25x 倍速精调；
  - **画面比例与画质视效**：支持自适应、16:9、老番 4:3 比例修复、21:9 超宽屏、拉伸铺满 Fill、去黑边裁剪 Cover，支持左右镜像翻转与顺时针 90° 旋转，快捷键 `W` 一键循环切换；
  - **二次元动漫色彩滤镜**：内置硬件加速滤镜引擎（原画 / 动漫鲜艳 / 护眼柔和 / 明亮锐利），跨剧集持久化记忆；
  - **智能跳过片头/片尾与 A-B 循环**：开播 0.5s~15s 悬浮跳过胶囊提示、一键快进 OP（快捷键 `S`）、连播自动跳过 OP；**支持自定义片头/片尾跳过时长（60s / 80s / 85s / 90s / 100s / 120s 快速自选）**；**智能跳过片尾（Auto-Skip ED）尾声自动无缝切换下一集**；PotPlayer 风格 A-B 片段复读循环（`[` 设起点 A、`]` 设终点 B、`\` 一键清除）；
  - **睡眠定时器（Sleep Timer）**：控制栏「画面 📺」菜单内置睡眠定时（关闭 / 播完本集自动停止连播并退出全屏 / 30 / 60 / 90 分钟倒计时自动暂停）；
  - **快捷老板键（Boss Key）**：快捷键 `Alt+Q` 或 `Ctrl+Alt+H`，一键瞬时静音、暂停视频、退出全屏并最小化窗口；
  - **外挂字幕高级调谐、智能编码纠错与片源字幕嗅探**：支持拖拽 .srt / .vtt / .ass / .ssa 至播放器挂载、**Rust 后端深度集成 `encoding_rs` 纯纯防乱码引擎，智能探测并无损解码 UTF-8/GB18030/GBK/Big5/UTF-16LE/BE，老番字幕乱码彻底解决**、**内置纯前端 ASS/SSA 转 WebVTT 高性能解析引擎（智能清洗 `{\...}` 样式特效标签与换行符）**、**新增 BT 种子与本地同级目录外挂字幕自动嗅探与智能匹配，优先根据用户简繁中偏好自动挂载并在字幕菜单提供 1-Click 快捷切换**、字幕延迟微调快捷键 `Z` / `X`、字号小/中/大切换、**4 种精调色彩（纯白/明黄/天蓝/翡翠）、3 种底框样式（半透明/纯文字黑描边/纯黑）、垂直定位（顶部/底部）即时热重载**；
  - **系统级媒体控制（Windows SMTC）与双击防抖**：深度集成 `navigator.mediaSession`，在 Windows 锁屏/音量飞出浮层展示番名、集数与封面，全盘支持键盘多媒体键（播放/暂停/快进快退/切集）；视频点击与双击全屏智能防抖（彻底解决双击全屏时画面误暂停问题）；
  - **沉浸交互与统计**：全屏沉浸 OSD 浮层（快进快退/音量/增益/静音/倍速/画面比例/色彩滤镜/AB循环/截屏/画中画/连播倒计时/睡眠定时全量视觉反馈）、播放信息统计面板（Stats for Nerds，快捷键 `I` 调出，实时显示协议/分辨率/视口尺寸/丢帧率/缓冲比例/弹幕状态）、播放器内嵌磨砂缓冲旋转 Spinner、沉浸播放鼠标停滞 2.5s 自动休眠（隐藏光标）、断点续播、**上下集一键连播（快捷键 `B` 上一集 / `N` 下一集 / 顶栏按钮 / 播毕 3 秒倒计时自动切集）**、**全梯度倍速扩展（0.5x ~ 3.0x 共 9 档）**、全套桌面快捷键（`/` 聚焦搜索、`H` 观影历史、`Enter` 弹幕发射、`Escape` 退出返回、`Alt+Q` 老板键、`Space` / `←→` 或 `JL` / `↑↓` / `Shift+↑↓` 音效增益 / `M` 静音 / `0`~`9` 进度跳转 / `<` `>` 倍速 / `W` 画面比例 / `S` 跳过片头 / `D` 弹幕调谐 / `C` 截帧 / `P` 画中画 / `[` `]` `\` A-B循环 / `-` `=` 弹幕微调 / `Z` `X` 字幕微调 / `F` 全屏 / `B` 上一集 / `N` 下一集 / `E` 选集抽屉 / `I` 统计面板）、点击暂停、双击全屏、HLS 出错自动恢复
- **弹幕高能热力波形与即时发射台**：
  - **弹幕密度高能热力图与微缩悬停指示（Danmaku Density Heatmap & Scrubbing）**：基于全量弹幕时间戳自动计算密度直方图，以平滑渐变波形呈现；**智能识别前 3 大「🔥 名场面高能时刻」并生成快捷胶囊，点击直达名场面剧情高潮**；**鼠标在波形轨道滑动时实时呈现游标标尺、精准时间戳、百分比指示以及高能时刻专属火焰徽章，点击波形精准 Seek 跳转**；
  - **即时弹幕发射台**：播放器集成独立弹幕发射条，支持滚动/顶端/底端 3 种弹幕模式与 8 种高频二次元流行配色；快捷键 `Enter` 快速聚焦输入，发送后即时飞屏并持久化写入本地缓存，重播该集时自动合并复现；
  - **弹幕专业调谐与手动搜索匹配（Manual Match）**：在设置页填入免费申请的 AppId/AppSecret 后，播放时按「番名 + 集号」自动匹配弹幕池；**新增「🔍 手动搜索匹配弹幕源」浮窗，彻底解决番剧译名不一致、OVA/特别篇或多季动画无法自动匹配的痛点，支持输入任意关键词即时检索并一键绑定载入**；支持直接导入或拖拽挂载本地 .xml（Bilibili/弹弹play 标准格式）与 .json 弹幕文件；**支持 2K/4K/Retina 高清屏物理像素 DPR 自适应极清绘制，文字边缘锐利无锯齿**；结果缓存 3 天（SQLite，网络失败时回落过期缓存），后端完成去重 + 关键词/用户/类型屏蔽；**控制栏弹幕高级调谐菜单（快捷键 `D`），支持 3 档显示区域、3 档字号缩放、3 档飘字速度、不透明度快速切换与时间轴微调校准（`-` / `=`）**；全屏 Canvas 图层跟随，轨道满自动限流，seek 零延迟重定位
- **下载任务**：librqbit fastresume 恢复的历史任务自动登记进面板（后台全周期持续追踪进度与完成事件，角标与浮窗增量渲染，不重建 DOM）
- **偏好学习**（M5 起步）：手动点「下载 / 在线播放」时自动把该候选的字幕组/分辨率记为偏好，参与后续自动选源
- **离线缓存（M5 HTTP 引擎）**：候选列表点「⤓ 缓存」把 Jellyfin/HLS/直链视频下载到本地（**6 并发高速分段下载通道，5~10x 提速**；**启发式过滤净化 HLS 广告/贴片切片**；m3u8 自动选最高码率、本地重写 playlist），经 `anicache://` 自定义协议回放（支持 Range 拖动 seek）；设置 → 缓存 里管理（**一键打开缓存根目录、一键清空全部缓存与记录**、播放/定位/删除）；**详情页与选源联动（已离线剧集高亮「⚡ 已缓存」徽标，选源列表置顶直出「⚡ 本地离线缓存」秒开卡片）**；暂不支持加密流（AES-128）与 BYTERANGE 分段
- **数据管理与备份**：设置页支持一键**导出全部追番与播放历史为 JSON 备份文件**，并支持导入合并，实现跨机器无损迁移
- **版本更新检查**：设置 → 关于与更新 中提供「检查更新」，通过 GitHub Releases API 实时检测新版本并呈现更新日志与下载链接
- **选源过滤**：候选列表按字幕组/分辨率一键筛选与仅可用快速收缩
- **Bangumi 账号（收藏/进度双向同步）**：设置页填入 bgm.tv 开发者平台的 ClientID/Secret（免费创建应用）→ 浏览器授权 → 粘贴授权码登录；之后**点击「追番」自动同步为 Bangumi「在看」状态**，**看完一集自动标记「看过」**；token 临近过期自动刷新；**支持离线挂起队列（`playback_pending_op`，弱网断网先记账，网络或授权恢复后自动回放追番与打卡）**
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
