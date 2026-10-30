/**
 * Every numeric layout/sizing knob the picker uses, pulled out of the render
 * methods so callers can retune the picker (terminal real estate, preview
 * verbosity, truncation lengths, …) without editing the view or view-model.
 * Construct with `{ ...defaultPickerConfig, ...overrides }`.
 */
export interface PickerConfig {
	/** Floor on visible list rows, even in a very short terminal. */
	minListRows: number;
	/** Terminal rows reserved for chrome when computing the fallback row budget (before the first render). */
	initialHeightReserve: number;
	/** Floor on how many rows the list keeps once the preview pane is open and splitting the remainder. */
	minListBudgetWithPreview: number;
	/** Fraction of the remaining rows given to the list (vs. the preview pane) once the preview is open. */
	listPreviewSplitRatio: number;
	/** Terminal rows reserved for the preview box's own border/hint chrome. */
	previewChromeRows: number;
	/** Floor on the preview box's content width. */
	minPreviewContentWidth: number;
	/** Columns reserved for the preview box's border/scrollbar chrome, subtracted from box width to get content width. */
	previewBoxChromeCols: number;
	/** Floor on the preview title's available width. */
	minPreviewTitleWidth: number;
	/** Columns reserved when truncating the preview title so it never crowds out the border. */
	previewTitleReserveCols: number;
	/** Columns scrolled per horizontal-scroll keypress in the preview pane. */
	previewHScrollStep: number;
	/** Max content lines shown before "… N more lines" in the compact preview. */
	compactContentLineLimit: number;
	/** Max content lines shown before "… N more lines" in the detailed/compressed preview. */
	detailedContentLineLimit: number;
	/** Max characters per rendered content line before truncation. */
	contentLineMaxWidth: number;
	/** Max characters for a summarized tool-call argument string. */
	toolArgsMaxWidth: number;
	/** Max characters for a tool-call result summary line (detailed preview). */
	toolResultMaxWidth: number;
	/** Width of the "───" section rules drawn inside the preview pane. */
	sectionRuleWidth: number;
	/** Floor on the processing view's progress bar width. */
	progressBarMinWidth: number;
	/** Ceiling on the processing view's progress bar width. */
	progressBarMaxWidth: number;
	/** Columns reserved around the progress bar, subtracted from terminal width. */
	progressBarWidthReserve: number;
	/** Floor on how many log rows the processing view shows. */
	minProcessingLogRows: number;
	/** Terminal rows reserved for chrome in the processing view, subtracted from rows to get the log row budget. */
	processingChromeRows: number;
	/** Max characters for a unit-preview string in the processing log. */
	logPreviewMaxWidth: number;
	/** Floor on a list row's usable width. */
	minRowWidth: number;
	/** Floor on the space reserved for a list row's label before the token count. */
	minRowLeftBudget: number;
	/** Columns reserved between a list row's label and its token count. */
	rowTokenGap: number;
	/** Floor on the preview box's total width. */
	minPreviewBoxWidth: number;
	/** Indent width used when pretty-printing tool-call arguments in the detailed preview. */
	toolArgsJsonIndent: number;
}

export const defaultPickerConfig: PickerConfig = {
	minListRows: 5,
	initialHeightReserve: 8,
	minListBudgetWithPreview: 3,
	listPreviewSplitRatio: 0.45,
	previewChromeRows: 6,
	minPreviewContentWidth: 4,
	previewBoxChromeCols: 5,
	minPreviewTitleWidth: 10,
	previewTitleReserveCols: 16,
	previewHScrollStep: 4,
	compactContentLineLimit: 15,
	detailedContentLineLimit: 20,
	contentLineMaxWidth: 160,
	toolArgsMaxWidth: 100,
	toolResultMaxWidth: 200,
	sectionRuleWidth: 40,
	progressBarMinWidth: 10,
	progressBarMaxWidth: 40,
	progressBarWidthReserve: 10,
	minProcessingLogRows: 3,
	processingChromeRows: 8,
	logPreviewMaxWidth: 120,
	minRowWidth: 40,
	minRowLeftBudget: 4,
	rowTokenGap: 2,
	minPreviewBoxWidth: 60,
	toolArgsJsonIndent: 2,
};
