/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const enum LayoutPriority {
	Low = 0,
	Normal = 1,
	High = 2
}

export interface IGridView {
	readonly element: HTMLElement;
	readonly minimumWidth: number;
	readonly minimumHeight: number;
	readonly priority: LayoutPriority;
	layout(width: number, height: number, top: number, left: number): void;
}

export interface IWorkbenchGridParts {
	readonly titlebar: IGridView;
	readonly sidebar: IGridView;
	readonly sessions: IGridView;
	readonly editor: IGridView;
	readonly auxiliaryBar: IGridView;
	readonly panel: IGridView;
}

export interface IWorkbenchGridVisibility {
	readonly sidebar: boolean;
	readonly sessions: boolean;
	readonly editor: boolean;
	readonly auxiliaryBar: boolean;
	readonly panel: boolean;
}

export interface IWorkbenchGridDimensions {
	readonly titlebarHeight: number;
	readonly sidebarWidth: number;
	readonly auxiliaryBarWidth: number;
	readonly editorWidth: number;
	readonly panelHeight: number;
}

type HorizontalViewName = 'sessions' | 'editor' | 'auxiliaryBar';

interface IHorizontalEntry {
	readonly name: HorizontalViewName;
	readonly view: IGridView;
	readonly preferredWidth: number;
}

const defaultDimensions: IWorkbenchGridDimensions = {
	titlebarHeight: 35,
	sidebarWidth: 300,
	auxiliaryBarWidth: 340,
	editorWidth: 360,
	panelHeight: 300
};

export class WorkbenchGrid {
	private visibility: IWorkbenchGridVisibility;
	private readonly dimensions: IWorkbenchGridDimensions;

	constructor(
		private readonly parts: IWorkbenchGridParts,
		initialVisibility: IWorkbenchGridVisibility,
		dimensions: Partial<IWorkbenchGridDimensions> = {}
	) {
		this.visibility = initialVisibility;
		this.dimensions = { ...defaultDimensions, ...dimensions };
	}

	setPartVisible(part: keyof IWorkbenchGridVisibility, visible: boolean): void {
		this.visibility = { ...this.visibility, [part]: visible };
	}

	isPartVisible(part: keyof IWorkbenchGridVisibility): boolean {
		return this.visibility[part];
	}

	layout(width: number, height: number): void {
		const safeWidth = Math.max(0, width);
		const safeHeight = Math.max(0, height);

		this.parts.titlebar.layout(safeWidth, this.dimensions.titlebarHeight, 0, 0);

		const contentTop = this.dimensions.titlebarHeight;
		const contentHeight = Math.max(0, safeHeight - this.dimensions.titlebarHeight);
		const panelHeight = this.visibility.panel ? Math.min(contentHeight, Math.max(this.parts.panel.minimumHeight, this.dimensions.panelHeight)) : 0;
		const topRowHeight = Math.max(0, contentHeight - panelHeight);
		const sidebarWidth = this.visibility.sidebar ? Math.min(safeWidth, Math.max(this.parts.sidebar.minimumWidth, this.dimensions.sidebarWidth)) : 0;
		const rightLeft = sidebarWidth;
		const rightWidth = Math.max(0, safeWidth - sidebarWidth);

		layoutOrHide(this.parts.sidebar, this.visibility.sidebar, sidebarWidth, contentHeight, contentTop, 0);
		layoutOrHide(this.parts.panel, this.visibility.panel, rightWidth, panelHeight, contentTop + topRowHeight, rightLeft);
		this.parts.sessions.element.style.display = 'none';
		this.parts.editor.element.style.display = 'none';
		this.parts.auxiliaryBar.element.style.display = 'none';

		const topRowEntries = this.collectTopRowEntries();
		layoutHorizontalViews(topRowEntries, rightWidth, topRowHeight, contentTop, rightLeft);
	}

	private collectTopRowEntries(): readonly IHorizontalEntry[] {
		const entries: IHorizontalEntry[] = [];

		if (this.visibility.sessions) {
			entries.push({
				name: 'sessions',
				view: this.parts.sessions,
				preferredWidth: this.parts.sessions.minimumWidth
			});
		}

		if (this.visibility.editor) {
			entries.push({
				name: 'editor',
				view: this.parts.editor,
				preferredWidth: Math.max(this.parts.editor.minimumWidth, this.dimensions.editorWidth)
			});
		}

		if (this.visibility.auxiliaryBar) {
			entries.push({
				name: 'auxiliaryBar',
				view: this.parts.auxiliaryBar,
				preferredWidth: Math.max(this.parts.auxiliaryBar.minimumWidth, this.dimensions.auxiliaryBarWidth)
			});
		}

		return entries;
	}
}

function layoutHorizontalViews(
	entries: readonly IHorizontalEntry[],
	availableWidth: number,
	height: number,
	top: number,
	left: number
): void {
	const widths = computeHorizontalWidths(entries, availableWidth);
	let offset = left;

	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		const width = widths[index];
		if (!entry || width === undefined) {
			continue;
		}

		entry.view.element.style.display = '';
		entry.view.layout(width, height, top, offset);
		offset += width;
	}
}

function computeHorizontalWidths(entries: readonly IHorizontalEntry[], availableWidth: number): number[] {
	if (entries.length === 0) {
		return [];
	}

	const widths = entries.map(entry => {
		if (entry.view.priority === LayoutPriority.High) {
			return entry.view.minimumWidth;
		}

		return Math.max(entry.view.minimumWidth, entry.preferredWidth);
	});

	const totalWidth = widths.reduce((sum, value) => sum + value, 0);
	const delta = availableWidth - totalWidth;

	if (delta > 0) {
		const highPriorityEntries = entries
			.map((entry, index) => ({ entry, index }))
			.filter(candidate => candidate.entry.view.priority === LayoutPriority.High);

		if (highPriorityEntries.length > 0) {
			const target = highPriorityEntries[0];
			if (target) {
				widths[target.index] = (widths[target.index] ?? 0) + delta;
			}
		} else {
			const lastIndex = widths.length - 1;
			widths[lastIndex] = (widths[lastIndex] ?? 0) + delta;
		}
	} else if (delta < 0) {
		shrinkWidths(entries, widths, -delta);
	}

	return widths.map(value => Math.max(0, value));
}

function shrinkWidths(entries: readonly IHorizontalEntry[], widths: number[], overflow: number): void {
	let remaining = overflow;
	const priorities = [LayoutPriority.Low, LayoutPriority.Normal, LayoutPriority.High];

	for (const priority of priorities) {
		for (let index = 0; index < entries.length && remaining > 0; index++) {
			const entry = entries[index];
			const currentWidth = widths[index];
			if (!entry || currentWidth === undefined || entry.view.priority !== priority) {
				continue;
			}

			const minimum = entry.view.minimumWidth;
			const reducible = Math.max(0, currentWidth - minimum);
			const reduction = Math.min(reducible, remaining);
			widths[index] = currentWidth - reduction;
			remaining -= reduction;
		}
	}

	if (remaining > 0) {
		const widthPerEntry = Math.floor(remaining / entries.length);
		const remainder = remaining % entries.length;

		for (let index = widths.length - 1; index >= 0; index--) {
			const currentWidth = widths[index];
			if (currentWidth === undefined) {
				continue;
			}

			widths[index] = Math.max(0, currentWidth - widthPerEntry - (index >= widths.length - remainder ? 1 : 0));
		}
	}
}

function layoutOrHide(view: IGridView, visible: boolean, width: number, height: number, top: number, left: number): void {
	if (!visible) {
		view.element.style.display = 'none';
		return;
	}

	view.element.style.display = '';
	view.layout(width, height, top, left);
}
