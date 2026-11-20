import { resolveLineBreakSpec } from "../linebreak/presets";
import type { ProcessedSubtitleRow } from "../linebreak/types";
import {
  colIndexToLetters,
  resolveTemplateColumnPlan,
} from "../linebreak/xlsx-writer";
import { icons } from "./icons";
import {
  type LineBreakRowFilter,
  notifyStateChanged,
  saveLineBreakColPrefs,
  store,
  type TableFontSize,
} from "./state";

function esc(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSubtitleWithHighlightedAt(text: string): string {
  return esc(text).replace(/@/g, '<span class="lb-at-mark">@</span>');
}

export interface LineBreakStageActions {
  onEditScreenText: (sourceRowIdx: number, screenIdx: number, newText: string) => void;
  onSplitScreen: (sourceRowIdx: number, screenIdx: number) => void;
  onMergeScreen: (sourceRowIdx: number, screenIdx: number) => void;
  onResumeSingle?: () => void;
  onOpenGeminiSettings?: () => void;
}

function matchesFilter(row: ProcessedSubtitleRow, filter: LineBreakRowFilter): boolean {
  if (filter === "all") return true;
  if (filter === "changed") {
    return (
      row.status === "broken_same_screen" ||
      row.status === "split_multi_screen" ||
      row.status === "citation_broken" ||
      row.status === "compact_kept_double"
    );
  }
  if (filter === "review") {
    return (
      Boolean(row.reviewNote) ||
      row.status === "review_warning" ||
      row.status === "soft_kept_single" ||
      row.status === "compact_kept_double"
    );
  }
  if (filter === "special") {
    return row.status === "skip_green" || row.category === "citation_same_screen";
  }
  return true;
}

function evalFormulaDisplay(
  subText: string,
  singleMax: number,
  doubleMax: number,
): Array<{ val: string; cfBg: string | null }> {
  const len = subText.length;
  const atIdx = subText.indexOf("@");

  const cfColorForNum = (n: number): string | null => {
    if (n > doubleMax) return "#FF00FF";
    if (n > singleMax) return "#FFFF00";
    return null;
  };

  const hCell = { val: String(len), cfBg: cfColorForNum(len) };
  if (len <= singleMax) {
    return [hCell, { val: "L", cfBg: null }, { val: "L", cfBg: null }];
  }
  if (atIdx >= 0) {
    const leftLen = atIdx;
    const rightLen = len - atIdx - 1;
    return [
      hCell,
      { val: String(leftLen), cfBg: cfColorForNum(leftLen) },
      { val: String(rightLen), cfBg: cfColorForNum(rightLen) },
    ];
  }
  return [hCell, { val: "#VALUE!", cfBg: null }, { val: "#VALUE!", cfBg: null }];
}

function defaultColPixelWidth(excelWidth: number | null, outCol: number, targetCol: number): number {
  if (excelWidth !== null && excelWidth > 0) {
    return Math.max(48, Math.round(excelWidth * 8.2));
  }
  if (outCol === targetCol) return 260;
  return 96;
}

export function renderLineBreakStage(
  container: HTMLElement,
  actions: LineBreakStageActions,
): void {
  const wasPopoverOpen = Boolean(
    container.querySelector("#lb-col-vis-popover:popover-open"),
  );

  const lb = store.lineBreak;
  const wb = lb.workbook;
  const activeSheet = wb ? wb.sheets[wb.activeSheetName] : null;
  const run = lb.run;

  const noticeHtml = store.notice
    ? `
      <div class="notice-bar ${store.notice.type === "error" ? "notice-error" : "notice-info"}" role="status">
        <span>${esc(store.notice.message)}</span>
        <button type="button" id="btn-dismiss-lb-notice" class="seg-option">关闭</button>
      </div>`
    : "";

  if (!activeSheet) {
    container.innerHTML = `
      <main class="inspector-stage" id="linebreak-inspector">
        ${noticeHtml}
        <div class="empty-guide">
          <h2>多语种字幕自动断行工作台</h2>
          <p>支持单表精修与总表批量（均采用<strong>「先生成断行预览核对 → 确认无误后再写入 Google 表格」</strong>两步确认流），原表颜色、粗体、字体与公式条件格式 100% 保留。</p>
          <ol>
            <li>在左侧选择「单表精修」或「总表批量」读取 Google 表格（多 Sheet 自动提醒人工确认）；</li>
            <li>运行自动断行后，在右侧冻结首列、可调列宽、可隐藏无关列的原样表中核对（红字加粗 <code>@</code> 为同屏双行，浅蓝底色为跨屏分屏，<code>L</code> 列为核对备注）；</li>
            <li>核对无误后点击「确认写入 Google 表格」或「导出 Excel (.xlsx)」。</li>
          </ol>
        </div>
      </main>
    `;
    container
      .querySelector("#btn-dismiss-lb-notice")
      ?.addEventListener("click", () => {
        store.notice = null;
        notifyStateChanged();
      });
    return;
  }

  const spec = run?.langSpec ?? resolveLineBreakSpec(lb.langCode);
  const includeCharFormulas =
    spec.mode === "char" || activeSheet.detectedFormulaCols.length >= 3;
  const plan = resolveTemplateColumnPlan(activeSheet, includeCharFormulas);
  const formulaCols = plan.formulaCols;
  const formulaPosMap = new Map<number, 0 | 1 | 2>();
  if (formulaCols) {
    formulaPosMap.set(formulaCols[0], 0);
    formulaPosMap.set(formulaCols[1], 1);
    formulaPosMap.set(formulaCols[2], 2);
  }

  const headerRows =
    activeSheet.headerRows.length > 0
      ? activeSheet.headerRows
      : [
          Array(plan.totalOutCols).fill(""),
          ["Line", "In Time", "Out Time", "Character", "Chinese", "English（标you）", "Target Language"],
        ];
  const mainHeaderRow = headerRows[headerRows.length - 1] ?? [];

  const describeColLabel = (outCol: number): string => {
    const letStr = colIndexToLetters(outCol);
    const fPos = formulaPosMap.get(outCol);
    if (fPos === 0) return `${letStr} · 总字符数`;
    if (fPos === 1) return `${letStr} · @前字数`;
    if (fPos === 2) return `${letStr} · @后字数`;
    if (outCol === plan.outReviewCol) return `${letStr} · 核对备注`;
    const srcCol = plan.outToSrcCol[outCol];
    const hText = srcCol >= 0 ? (mainHeaderRow[srcCol] ?? "").trim() : "";
    return hText ? `${letStr} · ${hText}` : `${letStr} · 空白列`;
  };

  const userHiddenSet = new Set(lb.userHiddenCols);
  // Ensure Col A (frozen Line col, index 0) and Col G (Target Language) stay visible
  const isLockedVisibleCol = (outCol: number) => outCol === 0 || outCol === plan.outTargetCol;

  const visibleOutCols: number[] = [];
  for (let c = 0; c < plan.totalOutCols; c += 1) {
    const letStr = colIndexToLetters(c);
    if (isLockedVisibleCol(c)) {
      visibleOutCols.push(c);
      continue;
    }
    if (plan.colHidden[c] && !lb.showHiddenCols) continue;
    if (userHiddenSet.has(letStr)) continue;
    visibleOutCols.push(c);
  }

  const colMap = activeSheet.columnMap;
  const allRows = activeSheet.rows;
  const isRtl = spec.dir === "rtl";

  const countAll = allRows.length;
  const countChanged = run
    ? run.results.filter((r) => matchesFilter(r, "changed")).length
    : 0;
  const countReview = run
    ? run.results.filter((r) => matchesFilter(r, "review")).length
    : 0;
  const countSpecial = run
    ? run.results.filter((r) => matchesFilter(r, "special")).length
    : allRows.filter((r) => r.isGreenHighlight).length;

  const isCenteredSrcCol = (srcCol: number): boolean =>
    srcCol === colMap.lineCol ||
    srcCol === colMap.inTimeCol ||
    srcCol === colMap.outTimeCol ||
    srcCol === colMap.characterCol;

  // Build frozen header rows (Row 1 + Row 2) with sticky Column 1 (visIdx === 0) & drag resizers!
  const frozenHeaderTrs: string[] = [];
  headerRows.forEach((hRow, hIdx) => {
    const sheetRowNum = hIdx + 1;
    const isLastFrozen = hIdx === headerRows.length - 1;
    const hFills = activeSheet.headerFillRgb[hIdx] ?? [];
    const hFonts = activeSheet.headerFontRgb?.[hIdx] ?? [];
    const hBolds = activeSheet.headerBold[hIdx] ?? [];
    const targetHeaderVal = hRow[colMap.targetCol] ?? "";
    const fDisplays = formulaCols
      ? evalFormulaDisplay(targetHeaderVal, spec.singleMax, spec.doubleMax)
      : [];

    const tds = visibleOutCols.map((outCol, visIdx) => {
      const colLet = colIndexToLetters(outCol);
      const stickyFirstCls = visIdx === 0 ? "gs-sticky-col-first" : "";
      const resizerHtml = isLastFrozen
        ? `<span class="col-resizer" data-lb-resize-col="${colLet}" data-lb-vis-idx="${visIdx}" title="按住左右拖动调整 ${colLet} 列宽度"></span>`
        : "";

      const fPos = formulaPosMap.get(outCol);
      if (fPos !== undefined) {
        const fd = fDisplays[fPos];
        const bgStyle = fd.cfBg ? `background-color:${fd.cfBg};color:#101822;` : "";
        const fillCls = fd.cfBg ? "gs-has-fill" : "";
        return `<th scope="col" class="gs-frozen-cell gs-cell-center ${stickyFirstCls} ${fillCls} ${isLastFrozen ? "gs-freeze-bottom" : ""}" style="${bgStyle}font-weight:400">${esc(fd.val)}${resizerHtml}</th>`;
      }
      const srcCol = plan.outToSrcCol[outCol];
      const isReviewCol = outCol === plan.outReviewCol;
      const val = isReviewCol
        ? isLastFrozen
          ? (srcCol >= 0 && (hRow[srcCol] ?? "").trim() ? hRow[srcCol] : "核对备注")
          : ""
        : srcCol >= 0
          ? (hRow[srcCol] ?? "")
          : "";
      const fillHex = srcCol >= 0 ? hFills[srcCol] : null;
      const fontHex = srcCol >= 0 ? hFonts[srcCol] : null;
      const bold = srcCol >= 0 ? (hBolds[srcCol] ?? isLastFrozen) : isLastFrozen;
      const styles: string[] = [];
      if (fillHex) {
        styles.push(`background-color:#${fillHex}`, `color:#101822`);
      }
      if (fontHex && !fillHex) {
        styles.push(`color:#${fontHex}`);
      }
      styles.push(`font-weight:${bold ? "700" : "400"}`);
      const fillCls = fillHex ? "gs-has-fill" : "";
      return `<th scope="col" class="gs-frozen-cell gs-cell-center ${stickyFirstCls} ${fillCls} ${isLastFrozen ? "gs-freeze-bottom" : ""}" style="${styles.join(";")}">${esc(val)}${resizerHtml}</th>`;
    });

    frozenHeaderTrs.push(`
      <tr class="gs-frozen-row ${isLastFrozen ? "gs-frozen-row-main" : `gs-frozen-row-${hIdx}`}">
        <th scope="row" class="gs-row-num gs-frozen-rownum ${isLastFrozen ? "gs-freeze-bottom" : ""}">${sheetRowNum}</th>
        ${tds.join("")}
      </tr>
    `);
  });

  // Build data rows (Row 3 .. N) with sticky Column 1 (visIdx === 0)
  const q = lb.searchQuery.trim().toLowerCase();
  const bodyTrs: string[] = [];
  let currentExcelRow = headerRows.length + 1;

  for (const srcRow of allRows) {
    const proc = run?.results[srcRow.rowIndex];
    const screens = proc?.screens.length
      ? proc.screens
      : [{ text: srcRow.rawCells[colMap.targetCol] ?? "" }];

    const rowVisibleByFilter = !proc || matchesFilter(proc, lb.filter);
    const matchesSearch =
      !q ||
      `${srcRow.rawCells.join(" ")} ${screens.map((s) => s.text).join(" ")}`
        .toLowerCase()
        .includes(q);

    const targetBold = Boolean(srcRow.cellBold[colMap.targetCol]);
    const targetFontHex = srcRow.cellFontRgb?.[colMap.targetCol] ?? null;

    screens.forEach((sc, sIdx) => {
      const displayRowNum = currentExcelRow;
      currentExcelRow += 1;

      if (!rowVisibleByFilter || !matchesSearch) return;

      const isSplitInserted = sIdx > 0;
      const isMultiScreenGroup = !srcRow.isGreenHighlight && screens.length > 1;
      const subText = sc.text;
      const fDisplays = formulaCols
        ? evalFormulaDisplay(subText, spec.singleMax, spec.doubleMax)
        : [];

      const cellsHtml = visibleOutCols.map((outCol, visIdx) => {
        const colLet = colIndexToLetters(outCol);
        const stickyFirstCls = visIdx === 0 ? "gs-sticky-col-first" : "";
        const fPos = formulaPosMap.get(outCol);
        if (fPos !== undefined) {
          const fd = fDisplays[fPos];
          const bgStyle = fd.cfBg ? `background-color:${fd.cfBg};color:#101822;` : "";
          const fillCls = fd.cfBg ? "gs-has-fill" : "";
          return `<td data-col="${colLet}" class="gs-cell gs-cell-center gs-cell-formula ${stickyFirstCls} ${fillCls}" style="${bgStyle}">${esc(fd.val)}</td>`;
        }

        const srcCol = plan.outToSrcCol[outCol];
        const isTarget = outCol === plan.outTargetCol;

        if (isTarget) {
          const fillHex = !isSplitInserted && srcCol >= 0 ? srcRow.cellFillRgb[srcCol] : null;
          const styles: string[] = [];
          if (fillHex) {
            styles.push(`background-color:#${fillHex}`, `color:#101822`);
          } else if (targetFontHex) {
            styles.push(`color:#${targetFontHex}`);
          }
          if (targetBold) styles.push("font-weight:700");

          const canAdjust = Boolean(run) && !srcRow.isGreenHighlight;
          const hoverControls = canAdjust
            ? `<span class="gs-hover-tools">
                <button type="button" class="gs-micro-btn" data-split-row="${srcRow.rowIndex}" data-split-sc="${sIdx}" title="在下方插入新行拆分为两屏">+分屏</button>
                ${
                  isSplitInserted
                    ? `<button type="button" class="gs-micro-btn" data-merge-row="${srcRow.rowIndex}" data-merge-sc="${sIdx}" title="合并回上一屏">↑合屏</button>`
                    : ""
                }
              </span>`
            : "";

          const fillCls = fillHex ? "gs-has-fill" : "";
          return `
            <td data-col="${colLet}" class="gs-cell gs-target-td ${stickyFirstCls} ${fillCls}" style="${styles.join(";")}" ${isRtl ? 'dir="rtl"' : ""}>
              <div
                class="editable-cell cell-pre lb-subtitle-edit"
                contenteditable="${run ? "true" : "false"}"
                spellcheck="false"
                data-src-row="${srcRow.rowIndex}"
                data-screen-idx="${sIdx}"
              >${renderSubtitleWithHighlightedAt(subText)}</div>
              ${hoverControls}
            </td>`;
        }

        if (outCol === plan.outReviewCol) {
          const noteVal = !isSplitInserted ? (proc?.reviewNote ?? "") : "";
          const fillHex = !isSplitInserted && srcRow.isGreenHighlight ? "00FF00" : null;
          const styles: string[] = [];
          if (fillHex) {
            styles.push(`background-color:#${fillHex}`, `color:#101822`);
          } else if (noteVal) {
            styles.push("color:#b42318", "font-weight:500");
          }
          const fillCls = fillHex ? "gs-has-fill" : "";
          return `<td data-col="${colLet}" class="gs-cell ${stickyFirstCls} ${fillCls}" style="${styles.join(";")}"><div class="cell-pre">${esc(noteVal)}</div></td>`;
        }

        const rawVal = !isSplitInserted && srcCol >= 0 ? (srcRow.rawCells[srcCol] ?? "") : "";
        const displayVal =
          srcCol === colMap.lineCol ? rawVal.replace(/\.0$/, "") : rawVal;
        const fillHex = !isSplitInserted && srcCol >= 0 ? srcRow.cellFillRgb[srcCol] : null;
        const fontHex = !isSplitInserted && srcCol >= 0 ? (srcRow.cellFontRgb?.[srcCol] ?? null) : null;
        const bold = !isSplitInserted && srcCol >= 0 ? Boolean(srcRow.cellBold[srcCol]) : false;

        const styles: string[] = [];
        if (fillHex) {
          styles.push(`background-color:#${fillHex}`, `color:#101822`);
        } else if (fontHex) {
          styles.push(`color:#${fontHex}`);
        }
        if (bold) styles.push("font-weight:700");

        const centerCls = isCenteredSrcCol(srcCol) ? "gs-cell-center" : "";
        const fillCls = fillHex ? "gs-has-fill" : "";
        return `<td data-col="${colLet}" class="gs-cell ${stickyFirstCls} ${centerCls} ${fillCls}" style="${styles.join(";")}"><div class="cell-pre">${esc(displayVal)}</div></td>`;
      });

      const splitRowCls = isMultiScreenGroup
        ? isSplitInserted
          ? "gs-split-row gs-split-cont"
          : "gs-split-row gs-split-first"
        : "";

      bodyTrs.push(`
        <tr class="${splitRowCls}">
          <th scope="row" class="gs-row-num">${displayRowNum}</th>
          ${cellsHtml.join("")}
        </tr>
      `);
    });
  }

  const colWidthsPx = visibleOutCols.map((outCol) => {
    const colLet = colIndexToLetters(outCol);
    return (
      lb.customColWidths[colLet] ??
      defaultColPixelWidth(plan.colWidths[outCol], outCol, plan.outTargetCol)
    );
  });
  const totalTablePx = 46 + colWidthsPx.reduce((a, b) => a + b, 0);
  const hasCustomWidths = Object.keys(lb.customColWidths).length > 0;

  // Build column checklist items inside Popover
  const standardColsList: number[] = [];
  const origHiddenColsList: number[] = [];
  for (let c = 0; c < plan.totalOutCols; c += 1) {
    if (isLockedVisibleCol(c)) continue;
    if (plan.colHidden[c]) origHiddenColsList.push(c);
    else standardColsList.push(c);
  }

  const colCheckboxesHtml = standardColsList
    .map((c) => {
      const colLet = colIndexToLetters(c);
      const checked = !userHiddenSet.has(colLet);
      return `
        <label class="col-vis-check-item">
          <input type="checkbox" data-toggle-col-let="${colLet}" ${checked ? "checked" : ""} />
          <span>${esc(describeColLabel(c))}</span>
        </label>`;
    })
    .join("");

  const pausedBannerHtml =
    lb.singlePausedProgress && !store.busy
      ? `<div class="notice-bar notice-error" role="region" aria-label="单表断点续跑提示">
          <span>当前表格已安全保存中途断点（已完成 <strong>${lb.singlePausedProgress.done}/${lb.singlePausedProgress.total}</strong> 条待断行字幕）。更换/添加可用 Key 后点击右侧即可从断点接续处理！</span>
          <div style="display:flex;gap:0.4rem;flex-shrink:0">
            <button type="button" id="btn-single-open-keys" class="btn btn-compact">${icons.key}<span>更换/添加 Key</span></button>
            <button type="button" id="btn-single-resume-now" class="btn btn-compact btn-primary">${icons.play}<span>继续接续处理</span></button>
          </div>
        </div>`
      : "";

  const backToBatchBtn = lb.batchInspectingItemId
    ? `<button type="button" id="btn-back-to-batch-queue" class="btn btn-compact" style="margin-inline-end:0.4rem">← 返回批量列表</button>`
    : "";

  container.innerHTML = `
    <main class="inspector-stage" id="linebreak-inspector">
      ${noticeHtml}
      ${pausedBannerHtml}
      <div class="inspector-header">
        <div style="display:flex;align-items:center;gap:0.4rem;min-inline-size:0;flex:1">
          ${backToBatchBtn}
          <div class="tablist-scroller" role="tablist" aria-label="断行结果筛选">
            <button type="button" role="tab" class="tab-btn" data-lb-filter="all" aria-selected="${lb.filter === "all"}">全部 (${countAll})</button>
            <button type="button" role="tab" class="tab-btn" data-lb-filter="changed" aria-selected="${lb.filter === "changed"}">已断行/分屏 (${countChanged})</button>
            <button type="button" role="tab" class="tab-btn" data-lb-filter="review" aria-selected="${lb.filter === "review"}">L列待核对 (${countReview})</button>
            <button type="button" role="tab" class="tab-btn" data-lb-filter="special" aria-selected="${lb.filter === "special"}">绿底免断/出处 (${countSpecial})</button>
          </div>
        </div>
        ${
          run
            ? `<div class="lb-summary-strip">
                <span class="col-chip">总行 ${headerRows.length + run.totalOutputScreens}</span>
                <span class="col-chip">同屏 @ ${run.sameScreenAtCount}</span>
                <span class="col-chip">分屏插行 +${run.insertedScreenRowsCount}</span>
              </div>`
            : ""
        }
      </div>

      <div class="inspector-toolbar">
        <div style="display:flex;align-items:center;gap:0.5rem;flex:1;min-inline-size:170px;max-inline-size:290px">
          <input
            type="search"
            id="inp-lb-search"
            class="text-input"
            placeholder="搜索 Line、Chinese 或 Target Language..."
            value="${esc(lb.searchQuery)}"
          />
        </div>
        <div style="display:flex;align-items:center;gap:0.45rem;flex-wrap:wrap">
          <button
            type="button"
            id="btn-lb-col-popover"
            popovertarget="lb-col-vis-popover"
            class="btn btn-compact"
            title="隐藏不常看的列（如时间轴、角色、空白列）以便一屏核对字幕，不影响导出和写回"
          >
            ${icons.tableGrid}
            <span>显示/隐藏列 (${visibleOutCols.length}/${plan.totalOutCols})</span>
          </button>

          <div id="lb-col-vis-popover" popover="auto" class="col-vis-popover">
            <div class="col-vis-popover-head">
              <strong>视图列显示控制（仅影响预览，不改原表）</strong>
              <div class="col-vis-presets">
                <button type="button" id="btn-col-preset-focus" class="seg-option">精简核对视图</button>
                <button type="button" id="btn-col-preset-std" class="seg-option">标准列 (A~L)</button>
                ${
                  origHiddenColsList.length > 0
                    ? `<button type="button" id="btn-col-preset-all" class="seg-option">${lb.showHiddenCols ? "收起M~P备注" : "展开M~P备注"}</button>`
                    : ""
                }
              </div>
            </div>
            <div class="col-vis-grid">
              <label class="col-vis-check-item is-locked">
                <input type="checkbox" checked disabled />
                <span>A · Line（首列已冻结）</span>
              </label>
              ${colCheckboxesHtml}
              <label class="col-vis-check-item is-locked">
                <input type="checkbox" checked disabled />
                <span>${colIndexToLetters(plan.outTargetCol)} · Target Language（核心列）</span>
              </label>
            </div>
          </div>

          ${
            hasCustomWidths
              ? `<button type="button" id="btn-lb-reset-widths" class="btn btn-compact" title="恢复模板默认列宽">重置列宽</button>`
              : ""
          }

          <div class="segmented-group" role="group" aria-label="字号大小">
            <button type="button" class="seg-option" data-lb-font="sm" aria-pressed="${store.tableFontSize === "sm"}">紧凑</button>
            <button type="button" class="seg-option" data-lb-font="md" aria-pressed="${store.tableFontSize === "md"}">标准</button>
            <button type="button" class="seg-option" data-lb-font="lg" aria-pressed="${store.tableFontSize === "lg"}">放大</button>
          </div>
        </div>
      </div>

      <div tabindex="0" role="region" aria-labelledby="lb-table-caption" class="table-wrapper gs-sheet-wrapper">
        <table class="gs-sheet-table font-${store.tableFontSize}" style="inline-size:${totalTablePx}px">
          <caption id="lb-table-caption">${esc(activeSheet.sheetName)} 原模板预览表</caption>
          <colgroup>
            <col style="inline-size:46px" />
            ${colWidthsPx.map((px, visIdx) => `<col data-lb-vis-idx="${visIdx}" style="inline-size:${px}px" />`).join("")}
          </colgroup>
          <thead>
            <tr class="gs-col-letter-row">
              <th scope="col" class="gs-corner-th"></th>
              ${visibleOutCols
                .map((c, visIdx) => {
                  const letStr = colIndexToLetters(c);
                  const stickyFirstCls = visIdx === 0 ? "gs-sticky-col-first" : "";
                  const canHide = !isLockedVisibleCol(c);
                  return `<th scope="col" class="gs-col-letter-th ${stickyFirstCls}">
                    <span>${letStr}${visIdx === 0 ? " · 冻结" : ""}</span>
                    ${canHide ? `<button type="button" class="gs-col-hide-btn" data-quick-hide-col="${letStr}" aria-label="隐藏 ${letStr} 列" title="隐藏 ${letStr} 列（可在上方『显示/隐藏列』恢复）">×</button>` : ""}
                    <span class="col-resizer" data-lb-resize-col="${letStr}" data-lb-vis-idx="${visIdx}" title="按住左右拖动调整 ${letStr} 列宽度"></span>
                  </th>`;
                })
                .join("")}
            </tr>
            ${frozenHeaderTrs.join("")}
          </thead>
          <tbody>
            ${
              bodyTrs.length > 0
                ? bodyTrs.join("")
                : `<tr><td colspan="${visibleOutCols.length + 1}" style="padding:2rem;text-align:center;color:var(--text-muted)">当前筛选条件下暂无匹配行</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </main>
  `;

  // Position Popover cleanly anchored to trigger button (explicit anchor + source + rect safety net)
  const popBtn = container.querySelector<HTMLButtonElement>("#btn-lb-col-popover");
  const popEl = container.querySelector<HTMLElement>("#lb-col-vis-popover");
  if (popBtn && popEl) {
    const placePopoverByRect = () => {
      const t = popBtn.getBoundingClientRect();
      const m = popEl.getBoundingClientRect();
      const w = m.width || 340;
      const h = m.height || 260;
      const below = t.bottom + h + 8 <= window.innerHeight;
      popEl.style.position = "fixed";
      popEl.style.inset = "auto";
      popEl.style.margin = "0";
      popEl.style.top = `${Math.max(8, below ? t.bottom + 4 : t.top - h - 4)}px`;
      popEl.style.left = `${Math.max(8, Math.min(t.right - w, window.innerWidth - w - 8))}px`;
    };

    popEl.addEventListener("toggle", (ev) => {
      const te = ev as ToggleEvent;
      if (te.newState !== "open") return;
      const hasNativeExplicitAnchor =
        CSS.supports("position-area", "block-end") &&
        CSS.supports("anchor-name", "--lb-col-vis-anchor");
      if (!hasNativeExplicitAnchor) {
        placePopoverByRect();
        return;
      }
      // Safety net in case programmatic reopen in older Chromium builds lost anchor resolution
      const rect = popEl.getBoundingClientRect();
      const btnRect = popBtn.getBoundingClientRect();
      if (rect.top <= 6 && rect.left <= 6 && btnRect.left > 40) {
        placePopoverByRect();
      }
    });

    if (wasPopoverOpen && typeof popEl.showPopover === "function") {
      try {
        (popEl as HTMLElement & { showPopover: (opts?: { source?: HTMLElement }) => void }).showPopover({
          source: popBtn,
        });
      } catch {
        try {
          popEl.showPopover();
        } catch {
          // ignore if detached
        }
      }
    }
  }

  // Column visibility preset & checkbox handlers
  container.querySelector("#btn-col-preset-focus")?.addEventListener("click", () => {
    // Hide In Time, Out Time, Character, and blank K so Line + Chinese + English + Target + H/I/J + L fit comfortably!
    const toHide = new Set<string>();
    for (let c = 0; c < plan.totalOutCols; c += 1) {
      if (isLockedVisibleCol(c) || plan.colHidden[c]) continue;
      const srcCol = plan.outToSrcCol[c];
      if (
        srcCol === colMap.inTimeCol ||
        srcCol === colMap.outTimeCol ||
        srcCol === colMap.characterCol ||
        (srcCol < 0 && c !== plan.outReviewCol && !formulaPosMap.has(c)) ||
        (srcCol >= 0 && !(mainHeaderRow[srcCol] ?? "").trim() && !formulaPosMap.has(c))
      ) {
        toHide.add(colIndexToLetters(c));
      }
    }
    lb.userHiddenCols = [...toHide];
    lb.showHiddenCols = false;
    saveLineBreakColPrefs();
    notifyStateChanged();
  });

  container.querySelector("#btn-col-preset-std")?.addEventListener("click", () => {
    lb.userHiddenCols = [];
    lb.showHiddenCols = false;
    saveLineBreakColPrefs();
    notifyStateChanged();
  });

  container.querySelector("#btn-col-preset-all")?.addEventListener("click", () => {
    lb.showHiddenCols = !lb.showHiddenCols;
    saveLineBreakColPrefs();
    notifyStateChanged();
  });

  container.querySelectorAll<HTMLInputElement>("[data-toggle-col-let]").forEach((chk) => {
    chk.addEventListener("change", () => {
      const colLet = chk.dataset.toggleColLet!;
      const next = new Set(lb.userHiddenCols);
      if (chk.checked) next.delete(colLet);
      else next.add(colLet);
      lb.userHiddenCols = [...next];
      saveLineBreakColPrefs();
      notifyStateChanged();
    });
  });

  container.querySelectorAll<HTMLButtonElement>("[data-quick-hide-col]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const colLet = btn.dataset.quickHideCol!;
      if (!lb.userHiddenCols.includes(colLet)) {
        lb.userHiddenCols = [...lb.userHiddenCols, colLet];
        saveLineBreakColPrefs();
        notifyStateChanged();
      }
    });
  });

  container.querySelector("#btn-lb-reset-widths")?.addEventListener("click", () => {
    lb.customColWidths = {};
    saveLineBreakColPrefs();
    notifyStateChanged();
  });

  // Drag-to-resize column handles (60fps live DOM width update + persist on pointerup)
  container.querySelectorAll<HTMLElement>("[data-lb-resize-col]").forEach((handle) => {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const colLet = handle.dataset.lbResizeCol!;
      const visIdx = Number(handle.dataset.lbVisIdx);
      const startX = e.clientX;
      const startW = colWidthsPx[visIdx] ?? 100;
      const colEl = container.querySelector<HTMLElement>(`col[data-lb-vis-idx="${visIdx}"]`);
      const tableEl = container.querySelector<HTMLElement>(".gs-sheet-table");
      handle.classList.add("is-dragging");

      const onMove = (ev: PointerEvent) => {
        const nextW = Math.max(42, Math.min(820, Math.round(startW + (ev.clientX - startX))));
        colWidthsPx[visIdx] = nextW;
        lb.customColWidths[colLet] = nextW;
        if (colEl) colEl.style.inlineSize = `${nextW}px`;
        if (tableEl) {
          tableEl.style.inlineSize = `${46 + colWidthsPx.reduce((a, b) => a + b, 0)}px`;
        }
      };

      const onUp = () => {
        handle.classList.remove("is-dragging");
        saveLineBreakColPrefs();
        notifyStateChanged();
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  });

  container
    .querySelector("#btn-dismiss-lb-notice")
    ?.addEventListener("click", () => {
      store.notice = null;
      notifyStateChanged();
    });

  container.querySelector("#btn-back-to-batch-queue")?.addEventListener("click", () => {
    store.lineBreak.batchInspectingItemId = null;
    notifyStateChanged();
  });

  container.querySelector("#btn-single-open-keys")?.addEventListener("click", () => {
    actions.onOpenGeminiSettings?.();
  });

  container.querySelector("#btn-single-resume-now")?.addEventListener("click", () => {
    actions.onResumeSingle?.();
  });

  container.querySelectorAll<HTMLButtonElement>("[data-lb-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      store.lineBreak.filter = btn.dataset.lbFilter as LineBreakRowFilter;
      notifyStateChanged();
    });
  });

  container.querySelectorAll<HTMLButtonElement>("[data-lb-font]").forEach((btn) => {
    btn.addEventListener("click", () => {
      store.tableFontSize = btn.dataset.lbFont as TableFontSize;
      notifyStateChanged();
    });
  });

  const searchInp = container.querySelector<HTMLInputElement>("#inp-lb-search");
  searchInp?.addEventListener("input", () => {
    store.lineBreak.searchQuery = searchInp.value;
    notifyStateChanged();
    const nextInp = container.querySelector<HTMLInputElement>("#inp-lb-search");
    if (nextInp) {
      nextInp.focus();
      nextInp.setSelectionRange(nextInp.value.length, nextInp.value.length);
    }
  });

  container.querySelectorAll<HTMLElement>(".lb-subtitle-edit").forEach((cell) => {
    cell.addEventListener("blur", () => {
      const rIdx = parseInt(cell.dataset.srcRow ?? "-1", 10);
      const sIdx = parseInt(cell.dataset.screenIdx ?? "0", 10);
      if (rIdx >= 0) {
        const nextVal = cell.textContent ?? "";
        const existing = store.lineBreak.run?.results[rIdx]?.screens[sIdx]?.text ?? "";
        if (nextVal.trim() !== existing.trim()) {
          actions.onEditScreenText(rIdx, sIdx, nextVal);
        }
      }
    });
  });

  container.querySelectorAll<HTMLButtonElement>("[data-split-row]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const rIdx = parseInt(btn.dataset.splitRow ?? "-1", 10);
      const sIdx = parseInt(btn.dataset.splitSc ?? "0", 10);
      if (rIdx >= 0) actions.onSplitScreen(rIdx, sIdx);
    });
  });

  container.querySelectorAll<HTMLButtonElement>("[data-merge-row]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const rIdx = parseInt(btn.dataset.mergeRow ?? "-1", 10);
      const sIdx = parseInt(btn.dataset.mergeSc ?? "0", 10);
      if (rIdx >= 0) actions.onMergeScreen(rIdx, sIdx);
    });
  });
}
