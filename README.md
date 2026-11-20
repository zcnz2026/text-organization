# 文字整理工具

多语种文稿自动摘录对齐与多语种字幕自动断行工具。基于 **Tauri v2 + TypeScript** 构建，支持 **Windows** 与 **macOS** 双系统运行。

## 核心工作模块

- **剧本摘录整理**：从云端多语种资料库自动检索定稿段落与词条，按时间轴逐行语义切分、套用 35+ 语种标点与引号规范，预览核对后批量写入 Google 表格。
- **字幕断行（单表精修 & 总表批量）**：
  - 内置 34+ 语种字符数与 12pt 视觉尺子规格，支持在界面直接**新增自定义语系、修改各语种断行参数与追加自然语言断行规则**（支持 `.json` 团队导入导出）；
  - 结合 **Gemini 密钥池语义意群切分 + 本地硬规则校验闭环**，支持同屏双行 `@` 断行、超长意群分屏、绿底免断与出处行同屏规则；
  - 支持多语种**总表批量队列**（自动识别智能芯片链接、多 Sheet 弹窗人工确认、API 额度耗尽自动保存断点续跑、`L` 列输出核对备注）；
  - 原样预览表格支持首列冻结、列宽自由拖拽、任意列显示/隐藏切换，坚持**先人工核对预览、确认后再写回 `{原Sheet名}_已断行`**，100% 保留原表颜色、粗体、公式与条件格式。
- **统一设置中心**：右上角「设置」集中管理 Google OAuth 2.0 授权、Gemini API 密钥池、资源与列配置清单、语种标点规则库、字幕断行语种与规则库及界面外观。

## 快速启动

### 方式一：正式安装包（免环境，适合日常分发给 Windows / Mac 使用）
推送版本标签（如 `v0.3.0`）到 GitHub 后，GitHub Actions 会自动在 Releases 页面生成：
- **Windows**：`.exe` / `.msi` 安装包（双击即用）
- **macOS**：`.dmg`（通用架构，同时兼容 Apple Silicon M 系列芯片与 Intel Mac）
  > macOS 首次打开未签名应用如遇拦截，可在终端运行：`xattr -cr "/Applications/文字整理工具.app"`

### 方式二：本机免 Rust 秒开模式（开发调试 / 本机有 Node.js）
- **Windows**：双击 `启动工作台-Windows.bat`（或运行 `npm start`）
- **macOS**：双击 `启动工作台-macOS.command`（或运行 `npm start`）

---

## Google OAuth 2.0 授权配置说明

1. 在 Google Cloud Console 中启用 **Google Sheets API**、**Google Docs API** 与 **Google Drive API**。
2. 在「凭据 (Credentials)」中创建 **OAuth 客户端 ID**，应用类型选择 **桌面应用 (Desktop app)**，下载 `.json` 文件。
3. 打开软件右上角 **「设置 → Google OAuth 授权」**，选择该 `.json` 文件并点击「打开浏览器登录 Google 账号」即可。

---

## 目录结构（模块化架构）

```text
src/
├── types/          # 领域模型、全表列映射配置与全局状态类型定义
├── platform/       # 宿主通信桥接层（自动适配 Tauri IPC 与本地 Node 桥接）与版本更新检测
├── google/         # Google URL/gid 解析、Sheets v4 读写着色、Docs v1 与 Drive .docx 三列表提取
├── catalog/        # 35+ 语种标点预设、云端配置模板生成/解析与资料库加载器
├── engine/         # 剧本行分类器、文本匹配、LRC 聚合、逐行切分、标点规范化与 XLSX 导出
├── linebreak/      # 34+ 语种字幕断行规格与自定义规则库、视觉尺子测量、AI+本地校验闭环、总表批量与原样写回
├── ai/             # Gemini API 密钥池轮换与结构化输出客户端
└── ui/             # 双标签工作台界面、统一设置弹窗、断行检视台与明暗自适应样式
server/             # 本地免 Rust 秒开桥接服务（OAuth 回环监听 + DPAPI/Keychain 加密存储）
src-tauri/          # Tauri v2 原生桌面壳（Rust）
tests/              # 核心解析器、标点引擎与多语种字幕断行自动化单元测试
```

## 开发与测试命令

```bash
npm test          # 运行全套自动化单元测试
npm run typecheck # TypeScript 严格类型检查
npm run build     # 构建前端生产产物
npm run dev       # 启动热更新开发工作台
```
