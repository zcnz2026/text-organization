# 剧本对应语系工作台 (Script Language Matcher)

多语种报道剧本自动摘录、逐行时间轴对齐、剧本专用标点转换与 Google 表格分语种写入工具。基于 **Tauri v2 + TypeScript** 构建，支持 **Windows** 与 **macOS** 双系统运行。

## 功能概览

- **界面内加载 Google OAuth 2.0 凭据**：直接拖入或选择从 Google Cloud 下载的桌面客户端 `.json` 文件，点击浏览器一键登录已授权邮箱；令牌在 Windows 通过 **DPAPI**、在 macOS 通过 **系统钥匙串（Keychain）** 本机加密持久保存。
- **全云端实时读取 + `#gid` 子表精准锁定**：自动识别各语种不同命名的圣经库、俗语表、单篇目录与诗歌表子表，杜绝离线副本漏更新。
- **8 类内容自动提取与逐行对齐**：
  1. 固定引导词（`全能神说：` 等）；
  2. 大段神话单篇检索与逐行时间轴语义切分（自动识别 `有省略` 与 `涉及截取`）；
  3. 双排摘自格式匹配（区分 `字幕带版` 与 `视频特效括号版`，自动兼容韩语等单排通用语种）；
  4. 教会诗歌与神话语诗歌歌词及出处；
  5. 单一圣经库检索（严格隔离版本，查不到直接标红提示，**绝不自动混查天主教圣经库**）；
  6. 新俗语表 / 撒但毒素匹配（兼容 `/` 多写法词条与漏标兜底）；
  7. 各语种定稿主祷文逐行填入；
  8. `Note` 列 `XX` 占位符预填、独立标题行双填，以及报道人名/教会名/国家名库（最新期号优先）预填。
- **多语种批量写入专用输出 Google 表格**：每个语种独立生成一个工作表（Sheet），已匹配标浅绿、需核对标浅琥珀、未找到标浅珊瑚红，并在最右侧附加 `【工具提示】` 列；同时支持一键导出本地 `.xlsx` 备份。

---

## 快速启动

### 方式一：正式安装包（免环境，适合日常分发给 Windows / Mac 同工）
推送版本标签（如 `v0.1.0`）到 GitHub 后，GitHub Actions 会自动在 Releases 页面生成：
- **Windows**：`.exe` / `.msi` 安装包（双击即用）
- **macOS**：`.dmg`（通用架构，同时兼容 Apple Silicon M 系列芯片与 Intel Mac）
  > macOS 首次打开未签名应用如遇拦截，可在终端运行：`xattr -cr "/Applications/剧本对应语系工作台.app"`

### 方式二：本机免 Rust 秒开模式（开发调试 / 本机有 Node.js）
- **Windows**：双击 `启动工作台-Windows.bat`（或运行 `npm start`）
- **macOS**：双击 `启动工作台-macOS.command`（或运行 `npm start`）

---

## Google OAuth 2.0 授权配置说明

1. 在 Google Cloud Console 中启用 **Google Sheets API** 与 **Google Docs API**。
2. 在「凭据 (Credentials)」中创建 **OAuth 客户端 ID**，应用类型选择 **桌面应用 (Desktop app)**，下载 `.json` 文件。
3. 打开软件顶部 **「Google OAuth 授权」**，选择该 `.json` 文件并点击「打开浏览器登录 Google 账号」，登录已有源稿/资料库查看权限及专用输出表编辑权限的邮箱即可。

---

## 目录结构（模块化架构）

```text
src/
├── types/          # 领域模型与全局配置类型定义
├── platform/       # 宿主通信桥接层（自动适配 Tauri IPC 与本地 Node 桥接）
├── google/         # Google URL/gid 解析、Sheets v4 读写着色、Docs v1 正文提取
├── catalog/        # 多语种标点预设、资源总配置表与各类资料库解析加载
├── engine/         # 剧本行分类器、文本匹配、逐行切分、标点规范化、主流水线与 XLSX 导出
├── ai/             # Gemini API 密钥池轮换与结构化输出客户端
└── ui/             # 简体中文双栏工作台组件与明暗自适应样式
server/             # 本地免 Rust 秒开桥接服务（OAuth 回环监听 + DPAPI/Keychain 加密存储）
src-tauri/          # Tauri v2 原生桌面壳（Rust）
tests/              # 核心模块与真实 39 期剧本端到端自动化测试
```

## 开发与测试命令

```bash
npm test          # 运行单元测试与端到端剧本流水线测试
npm run typecheck # TypeScript 严格类型检查
npm run build     # 构建前端生产产物
npm run dev       # 启动热更新开发工作台
```
