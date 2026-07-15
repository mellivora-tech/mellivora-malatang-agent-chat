/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { LayoutPriority, WorkbenchGrid, type IGridView } from '../../src/sessions/base/browser/grid.js';

interface ILayoutCall {
	readonly width: number;
	readonly height: number;
	readonly top: number;
	readonly left: number;
}

interface IFakeView {
	readonly view: IGridView;
	readonly calls: ILayoutCall[];
	readonly element: { readonly style: { display: string } };
	setMaximumWidth(value: number | undefined): void;
}

function createFakeView(minimumWidth: number, minimumHeight: number, priority: LayoutPriority): IFakeView {
	const calls: ILayoutCall[] = [];
	const element = { style: { display: '' } };
	let maximumWidth: number | undefined;
	const view: IGridView = {
		element: element as unknown as HTMLElement,
		minimumWidth,
		minimumHeight,
		get maximumWidth() {
			return maximumWidth;
		},
		priority,
		layout: (width, height, top, left) => {
			calls.push({ width, height, top, left });
		},
	};
	return { view, calls, element, setMaximumWidth: value => { maximumWidth = value; } };
}

function createGrid() {
	const titlebar = createFakeView(0, 52, LayoutPriority.Normal);
	const sidebar = createFakeView(170, 0, LayoutPriority.Low);
	const sessions = createFakeView(640, 0, LayoutPriority.High);
	const editor = createFakeView(320, 0, LayoutPriority.Normal);
	const auxiliaryBar = createFakeView(260, 0, LayoutPriority.Low);
	const panel = createFakeView(0, 120, LayoutPriority.Normal);
	const grid = new WorkbenchGrid(
		{
			titlebar: titlebar.view,
			sidebar: sidebar.view,
			sessions: sessions.view,
			editor: editor.view,
			auxiliaryBar: auxiliaryBar.view,
			panel: panel.view,
		},
		{ sidebar: true, sessions: true, editor: false, auxiliaryBar: true, panel: false },
		{ titlebarHeight: 52, sidebarWidth: 270, auxiliaryBarWidth: 340, editorWidth: 360, panelHeight: 300 },
	);
	return { grid, titlebar, sidebar, sessions, editor, auxiliaryBar, panel };
}

test('sessions part absorbs extra width as the high priority view', () => {
	const { grid, sessions, auxiliaryBar } = createGrid();

	grid.layout(1600, 900);

	assert.deepEqual(sessions.calls.at(-1), { width: 990, height: 900, top: 0, left: 270 });
	assert.deepEqual(auxiliaryBar.calls.at(-1), { width: 340, height: 900, top: 0, left: 1260 });
});

test('auxiliary bar is dropped before sessions falls below its minimum width', () => {
	const { grid, sessions, auxiliaryBar } = createGrid();

	grid.layout(960, 640);

	assert.equal(auxiliaryBar.element.style.display, 'none');
	assert.deepEqual(sessions.calls.at(-1), { width: 690, height: 640, top: 0, left: 270 });
});

test('setPartVisible(panel) lays out the panel below the content row', () => {
	const { grid, sessions, panel } = createGrid();

	grid.setPartVisible('panel', true);
	grid.layout(1600, 900);

	assert.equal(grid.isPartVisible('panel'), true);
	assert.notEqual(panel.element.style.display, 'none');
	assert.deepEqual(panel.calls.at(-1), { width: 1330, height: 300, top: 600, left: 270 });
	assert.equal(sessions.calls.at(-1)?.height, 600);
});

test('editor participates in the content row when visible', () => {
	const { grid, sessions, editor, auxiliaryBar } = createGrid();

	grid.setPartVisible('editor', true);
	grid.layout(1700, 900);

	assert.deepEqual(sessions.calls.at(-1), { width: 730, height: 900, top: 0, left: 270 });
	assert.deepEqual(editor.calls.at(-1), { width: 360, height: 900, top: 0, left: 1000 });
	assert.deepEqual(auxiliaryBar.calls.at(-1), { width: 340, height: 900, top: 0, left: 1360 });
});

test('capped sessions hands the surplus to the auxiliary bar (open tab, wide window)', () => {
	const { grid, sessions, auxiliaryBar } = createGrid();
	sessions.setMaximumWidth(986);

	grid.layout(1920, 900);

	// rightWidth 1650: sessions stops at its cap, the side pane takes the rest.
	assert.deepEqual(sessions.calls.at(-1), { width: 986, height: 900, top: 0, left: 270 });
	assert.deepEqual(auxiliaryBar.calls.at(-1), { width: 664, height: 900, top: 0, left: 1256 });
});

test('when every view is capped the high-priority one absorbs the leftover (empty side pane)', () => {
	const { grid, sessions, auxiliaryBar } = createGrid();
	sessions.setMaximumWidth(986);
	auxiliaryBar.setMaximumWidth(340);

	grid.layout(1920, 900);

	// The empty tab picker must not balloon — the chat column eats the surplus as gutters.
	assert.deepEqual(auxiliaryBar.calls.at(-1), { width: 340, height: 900, top: 0, left: 1580 });
	assert.deepEqual(sessions.calls.at(-1), { width: 1310, height: 900, top: 0, left: 270 });
});

test('a capped view alone in the row still fills it', () => {
	const { grid, sessions } = createGrid();
	sessions.setMaximumWidth(986);
	grid.setPartVisible('auxiliaryBar', false);

	grid.layout(1920, 900);

	assert.deepEqual(sessions.calls.at(-1), { width: 1650, height: 900, top: 0, left: 270 });
});

test('the cap is inert while the window is too narrow to reach it', () => {
	const { grid, sessions, auxiliaryBar } = createGrid();
	sessions.setMaximumWidth(986);

	grid.layout(1440, 900);

	// rightWidth 1170: sessions grows to 830 — under its cap — exactly as before.
	assert.deepEqual(sessions.calls.at(-1), { width: 830, height: 900, top: 0, left: 270 });
	assert.deepEqual(auxiliaryBar.calls.at(-1), { width: 340, height: 900, top: 0, left: 1100 });
});

test('hidden editor and panel stay hidden and receive no layout', () => {
	const { grid, editor, panel } = createGrid();

	grid.layout(1600, 900);

	assert.equal(editor.element.style.display, 'none');
	assert.equal(panel.element.style.display, 'none');
	assert.equal(editor.calls.length, 0);
	assert.equal(panel.calls.length, 0);
});
