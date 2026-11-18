---
version: 1
slug: "index-html"
primary_target: "index.html"
related_targets: ["src/ui/app.ts"]
---

# 剧本对应语系工作台（Workbench Surface Brief）

- **Scope**: 主工作台单页（`index.html` + `src/ui/`）
- **Mode**: Operate（高频任务执行与逐行对照复查界面）

## Direction contract

- **THESIS**: 把原本需要在七八张外语 Google 表格和翻译软件之间来回盲找的手工摘录流程，收敛成“左侧配置连接与语种、右侧实时预览并核对逐行摘录结果”的一屏双栏制播台，拒绝零散弹窗堆砌与花哨营销横幅。
- **OWN-WORLD**: 冷调石板纸面底色（浅色 `#F5F7F9` / 深色 `#0F1419`）配高对比白/深灰工作表层，唯一主操作色采用沉稳青钴蓝（`#0E5A6D` / `#4CC3D9`），搭配三色语义复查高亮（翠绿已匹配、暖琥珀需核对截取、柔珊瑚红未找到），全界面采用自托管 Geist Sans 与 JetBrains Mono 等宽数字时间轴字体及统一 1.75px 描边矢量图标。
- **STORY**: 同工打开工作台即可看清 Google OAuth 2.0 授权、API 连接与 GitHub 版本状态，填入源剧本与专用输出表链接（或导入本地 CSV 试跑），勾选目标语种执行摘录，右侧实时按语种切换查看每一行的外文切分、标点转换与工具提示，点击微调确认无误后直接将审校结果写回云端分 Sheet 交付。
- **FIRST VIEWPORT**: 顶部单行紧凑工具栏（应用名+GitHub版本入口、Google OAuth 授权状态按钮、Gemini 密钥池按钮、语种标点规则库按钮、明暗主题分段开关）；下方直入左右分栏主体：左侧 360px 任务配置栏（源稿/资源总表/输出表链接、目标语种多选网格、底部吸底主执行与写回区），右侧自适应全高数据检视台（状态筛选标签栏 + 含等宽时间轴与源/译分界线的冻结表头逐行对照表）。
- **FORM**: 双栏制播检视工作台（Split Inspector Workbench），候选结构第 4 项（dealt lead），`seed:c20fde7448aad05e`。
- **FINISH**: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
