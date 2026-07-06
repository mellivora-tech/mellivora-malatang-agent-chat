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
	titlebarHeight: 52,
	sidebarWidth: 270,
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

		const sidebarWidth = this.visibility.sidebar
			? Math.min(safeWidth, Math.max(this.parts.sidebar.minimumWidth, this.dimensions.sidebarWidth))
			: 0;
		const rightWidth = Math.max(0, safeWidth - sidebarWidth);

		const panelHeight = this.visibility.panel
			? Math.min(safeHeight, Math.max(this.parts.panel.minimumHeight, this.dimensions.panelHeight))
			: 0;
		const contentHeight = Math.max(0, safeHeight - panelHeight);

		layoutOrHide(this.parts.sidebar, this.visibility.sidebar, sidebarWidth, safeHeight, 0, 0);

		const entries = this.collectTopRowEntries();
		const included = new Set(entries.map(entry => entry.name));
		for (const name of ['sessions', 'editor', 'auxiliaryBar'] as const) {
			if (!included.has(name)) {
				this.parts[name].element.style.display = 'none';
			}
		}

		const widths = computeHorizontalWidths(entries, rightWidth);
		layoutTopRow(entries, widths, contentHeight, 0, sidebarWidth);

		layoutOrHide(this.parts.panel, this.visibility.panel, rightWidth, panelHeight, contentHeight, sidebarWidth);
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

function layoutTopRow(
	entries: readonly IHorizontalEntry[],
	widths: readonly number[],
	height: number,
	top: number,
	left: number
): void {
	let offset = left;

	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		const width = widths[index];
		if (!entry || width === undefined) {
			continue;
		}

		if (width === 0) {
			entry.view.element.style.display = 'none';
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
		const shrunkTotal = widths.reduce((sum, value) => sum + value, 0);
		if (shrunkTotal > availableWidth) {
			if (entries.length > 1) {
				return dropLowestPriorityEntry(entries, availableWidth);
			}

			widths[0] = Math.min(widths[0] ?? 0, availableWidth);
		}
	}

	return widths.map(value => Math.max(0, value));
}

function dropLowestPriorityEntry(entries: readonly IHorizontalEntry[], availableWidth: number): number[] {
	let dropIndex = 0;
	let dropPriority = Number.POSITIVE_INFINITY;

	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry && entry.view.priority <= dropPriority) {
			dropPriority = entry.view.priority;
			dropIndex = index;
		}
	}

	const kept = entries.filter((_, index) => index !== dropIndex);
	const keptWidths = computeHorizontalWidths(kept, availableWidth);
	const widths: number[] = [];
	let keptCursor = 0;

	for (let index = 0; index < entries.length; index++) {
		widths.push(index === dropIndex ? 0 : keptWidths[keptCursor++] ?? 0);
	}

	return widths;
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
}

function layoutOrHide(view: IGridView, visible: boolean, width: number, height: number, top: number, left: number): void {
	if (!visible) {
		view.element.style.display = 'none';
		return;
	}

	view.element.style.display = '';
	view.layout(width, height, top, left);
}
