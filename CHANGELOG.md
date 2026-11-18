# Changelog

All notable changes to **剧本对应语系工作台 (Script Language Matcher)** will be documented in this file.

## [0.1.0] - 2026-11-18

### Added
- 初始化独立跨平台工程（Tauri v2 + TypeScript 模块化架构，支持 Windows `.exe` 与 macOS `.dmg`/`.app` 构建及本地免 Rust 秒开桥接运行）。
- 支持在界面内加载 Google OAuth 2.0 客户端 `.json` 文件并通过浏览器完成账号授权，Windows 采用 DPAPI、macOS 采用 Keychain 本机加密保存凭据。
- 实现 Google Sheets（支持 `#gid` 精准锁定子表、新建/覆盖各语种独立 Sheet、底色高亮与 `【工具提示】` 列写入）与 Google Docs 单篇正文读取。
- 实现 8 类剧本内容自动分类、匹配与逐行切分引擎：
  - 固定引导词（`全能神说` 等）与双排摘自格式（字幕带版 / 视频特效括号版，兼容韩语等单排语种）；
  - 神话单篇长短段落检索与逐行时间轴语义切分（支持 `有省略` 与 `涉及截取` 处理）；
  - 教会诗歌与神话语诗歌歌词及标题提取；
  - 单一圣经库精确检索（严格隔离不自动回退天主教圣经库）与经文出处标点格式化；
  - 新俗语表 / 撒但毒素、定稿主祷文、报道人名/教会名/国家名库（最新期号优先）匹配；
  - `Note` 列 `XX` 占位符替换与独立标题行双填。
- 内置多语种剧本专用引号与句末标点规范库（支持从云端资源总表自动同步规则并在界面查看与微调）。
- 支持 Gemini API 密钥池（`gemini-3.8-flash` / `gemini-3.5-flash-lite` / `gemini-3.1-flash-lite`）均衡轮换与无密钥确定性分句兜底。
- 支持本地 CSV 源稿直接导入预览与 `.xlsx` 多 Sheet 本地备份导出。
- 配置 GitHub Actions 双平台（Windows + macOS）自动化测试与打包发布工作流。
