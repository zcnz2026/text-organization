---
name: 剧本对应语系工作台
description: 多语种报道剧本自动摘录、逐行对齐与复查制播工作台视觉规范
colors:
  primary-teal: "#0e5a6d"
  primary-teal-hover: "#0a4655"
  primary-tint: "#e3f1f5"
  canvas-slate: "#f5f7f9"
  surface-paper: "#ffffff"
  surface-subtle: "#eaf0f4"
  ink-primary: "#101822"
  ink-secondary: "#415060"
  ink-muted: "#566677"
  border-subtle: "#d5dfe7"
  border-strong: "#b6c5d3"
  status-matched-bg: "#e8f7ef"
  status-matched-fg: "#0b633c"
  status-warning-bg: "#fef5e3"
  status-warning-fg: "#8f4f05"
  status-missing-bg: "#fdecec"
  status-missing-fg: "#a61e24"
typography:
  title:
    fontFamily: "\"Geist Sans\", \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei UI\", sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "-0.02em"
  heading:
    fontFamily: "\"Geist Sans\", \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei UI\", sans-serif"
    fontSize: "1rem"
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  body:
    fontFamily: "\"Geist Sans\", \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei UI\", sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "\"JetBrains Mono\", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.4
rounded:
  xs: "6px"
  sm: "8px"
  md: "12px"
  pill: "99px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "20px"
components:
  button-primary:
    backgroundColor: "{colors.primary-teal}"
    textColor: "{colors.surface-paper}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.primary-teal-hover}"
  button-secondary:
    backgroundColor: "{colors.surface-paper}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.sm}"
    padding: "8px 14px"
  input-field:
    backgroundColor: "{colors.surface-paper}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.sm}"
    padding: "8px 11px"
  panel-surface:
    backgroundColor: "{colors.surface-paper}"
    rounded: "{rounded.md}"
    padding: "18px"
---

# Design System: 剧本对应语系工作台

## Overview

**Creative North Star: "The Editorial Control Desk"**

剧本对应语系工作台服务于高时效、多语种并行的文稿整理与复查场景。整体视觉以克制、清晰的编辑审校台为核心：浅冷石板画布承托纯净白工作表层，避免任何装饰性渐变、悬浮徽章或卡片嵌套，让同工的视线始终聚焦在行号、中英底稿、外文切分结果与三色复查状态上。

系统原生支持明暗双色方案（`light-dark()` 与系统外观同步及手动切换），所有西里尔文、希腊文、天城文、拉丁文及中文标点在同一无衬线字族下保持清晰可辨。

**Key Characteristics:**
- 单一青钴蓝主操作色统领全局主按钮、激活标签下划线与已勾选语种项。
- 单元格语义底色与写入 Google Sheets 的浅绿（已匹配）、浅琥珀（需核对截取/人名）、浅珊瑚红（未找到）严格一致。
- 平面边框分层取代弥散卡片阴影，仅原生顶层 `<dialog>` 模态框保留定向投影。
- 全套统一 `1.75px` 描边内联矢量图标与等宽表格数字（`tabular-nums`）。

## Colors

以冷调中性纸面为主体，仅保留一个功能主色与三组审校语义色。

### Primary
- **Deep Editorial Teal** (`#0e5a6d` 浅色 / `#4cc3d9` 深色): 用于唯一主执行按钮、当前激活标签 `3px` 底边指示条、焦点环及选中语种高亮边框。
- **Teal Wash Tint** (`#e3f1f5` 浅色 / `#13313b` 深色): 用于已勾选目标语种芯片与顶部状态横幅底色。

### Neutral
- **Cool Slate Canvas** (`#f5f7f9` 浅色 / `#0f1419` 深色): 全局底层背景，拉开左右工作面板边界。
- **Crisp Sheet Surface** (`#ffffff` 浅色 / `#161e27` 深色): 左侧配置栏、顶部工具栏与右侧数据检视表底面。
- **Subtle Header Wash** (`#eaf0f4` 浅色 / `#1f2a36` 深色): 冻结表头、工具条与分段切换器底槽。
- **Deep Slate Ink** (`#101822` 浅色 / `#edf2f7` 深色): 正文与多语种译文主文字色。

### Named Rules
**The Single Action Accent Rule.** 青钴蓝仅出现在主操作按钮与激活态指示器上，绝不用于纯装饰边框或静态标签。

**The Sheet Parity Rule.** 界面预览表中的绿、琥珀、红三种单元格底色必须与写入 Google Sheets 的复查底色保持一致，确保同工在工作台与云端表格间切换零认知偏差。

## Typography

**Display Font:** `"Geist Sans"`（离线自托管 WOFF2，搭配 `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI"` 中文族）
**Body Font:** `"Geist Sans"`（搭配 `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI"`）
**Label/Mono Font:** `"JetBrains Mono"`（离线自托管 WOFF2，覆盖拉丁、西里尔与希腊字符集）

**Character:** 自托管现代编辑无衬线字族承载中英外多语种正文，配合广播级等宽字体呈现时间轴、行号、版本号与引号规则样例。

### Hierarchy
- **Title** (`700`, `1.1875rem`, `1.35`): 顶部应用主标题与空状态引导标题。
- **Heading** (`650`, `1rem`, `1.4`): 左侧分区标题与模态框标题。
- **Body** (`400` / `550`, `0.875rem`, `1.5`): 表单控件、按钮文案及多语种剧本正文单元格。
- **Label** (`600`, `0.8125rem`, `1.4`): 等宽时间轴、行号、冻结表头列名与复查提示文字。

### Named Rules
**The Tabular Timecode Rule.** 所有行号、时间轴（`In Time / Out Time`）、版本号与引号标本一律使用 `"JetBrains Mono"` 与 `font-variant-numeric: tabular-nums`。

## Layout

桌面端采用顶栏（单行紧凑工具条）加双栏主体（左侧固定 `360px` 任务配置栏 + 右侧自适应 `minmax(0, 1fr)` 剧本检视台，栏距 `16px`），左侧任务栏底部配置吸底操作区确保主执行按钮在首屏始终完整可见。宽度低于 `980px` 时自动切换为单列纵向堆叠并在顶部提供结果表快捷跳转条；数据表容器宽度低于 `640px` 时通过 `@container` 容器查询自动转为纵向卡片并注入列名标签。

## Elevation & Depth

工作台在静止态完全采用平面 `1px` 结构边框与浅色阶分层（Canvas → Surface → Subtle Wash），不使用卡片阴影。仅在打开 `<dialog>` 原生顶层弹窗时使用无描边的纯定向阴影（`box-shadow: 0 20px 48px rgb(0 0 0 / 0.26)`）将其从半透明遮罩上托起，并配合 `210ms` 指数缓出（`cubic-bezier(0.16, 1, 0.3, 1)`）入场过渡。

### Shadow Vocabulary
- **Modal Dialog Lift** (`box-shadow: 0 20px 48px rgb(0 0 0 / 0.26)`): 仅用于无外描边的 `<dialog>` 模态窗口。

### Named Rules
**The One Elevation Signal Rule.** 同一容器只选边框或阴影其中一种表达层级，严禁在带阴影的卡片外叠加宽晕边框。

## Shapes

面板与弹窗统一采用 `12px` 圆角（`--radius-md`），所有输入框、按钮、语种复选项与分段切换器统一采用 `8px` 圆角（`--radius-sm`），形成严谨紧凑的工具秩序。

## Components

### Buttons
- **Shape:** 紧凑圆角矩形（`8px`）。
- **Primary:** 青钴蓝实底配纯白字（`#0e5a6d`），内边距 `0.68rem 0.9rem`，仅用于每块核心提交动作。
- **Hover / Focus:** 背景加深至 `#0a4655`，键盘聚焦显示 `2px` 偏移轮廓环。
- **Secondary:** 纯白/深灰表层配 `1px` 强边框（`#b6c5d3`），悬停切换浅灰底（`#eaf0f4`）。

### Cards / Containers
- **Corner Style:** `12px` 圆角。
- **Background:** `#ffffff`（深色模式 `#151c24`）。
- **Shadow Strategy:** 无阴影，使用 `1px solid #d5dfe7` 描边与画布分层。
- **Internal Padding:** `18px`（窄屏收敛至 `14px`）。

### Inputs / Fields
- **Style:** `1px solid #b6c5d3` 描边、`8px` 圆角、表层实底。
- **Focus:** `2px solid #0e5a6d` 外轮廓环，悬停边框过渡至主色。

### Navigation
- **Top Bar & Filter Tabs:** 顶栏右侧排列授权、密钥池、标点库与外观分段开关；检视台顶部采用单行横向滚动标签栏，选中态通过 `aria-selected="true"` 驱动 `3px` 底部实线边框，不改变字重或内边距以防跳动。

## Do's and Don'ts

### Do:
- **Do** 始终从 `<h1>` 或 `<h2>` 直接开始分区标题，靠字号与留白建立层级。
- **Do** 对模态弹窗一律使用原生 `<dialog>` + `showModal()`，并配置 `overscroll-behavior: contain`。
- **Do** 为所有可交互过渡显式指定属性（`background-color`、`border-color`、`color`），时长控制在 `140ms–180ms`。

### Don't:
- **Don't** 在标题上方放置任何眉标（eyebrow/kicker）或装饰性序号（`01 / 02`）。
- **Don't** 使用 Emoji 充当功能图标，一律使用统一 `1.75px` 描边 SVG。
- **Don't** 在面板内部再套带边框的子卡片，分组统一使用留白与 `1px` 分割线。
