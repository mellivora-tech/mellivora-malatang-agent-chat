/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';

interface IFileTreeItem {
	readonly label: string;
	readonly kind: 'folder' | 'file';
	readonly children?: readonly IFileTreeItem[];
}

const mockTree: IFileTreeItem = {
	label: 'agent-chat',
	kind: 'folder',
	children: [
		{
			label: 'src',
			kind: 'folder',
			children: [
				{
					label: 'sessions',
					kind: 'folder',
					children: [
						{
							label: 'browser',
							kind: 'folder',
							children: [
								{
									label: 'services',
									kind: 'folder'
								}
							]
						}
					]
				}
			]
		},
		{
			label: 'package.json',
			kind: 'file'
		}
	]
};

export class FilesView extends Disposable {
	constructor(private readonly container: HTMLElement) {
		super();
		this.render();
	}

	private render(): void {
		this.container.textContent = '';

		const root = document.createElement('div');
		root.className = 'files-view';
		this.container.appendChild(root);

		const header = document.createElement('div');
		header.className = 'files-view-header';
		header.textContent = 'Files';
		root.appendChild(header);

		const tree = document.createElement('div');
		tree.className = 'files-tree';
		tree.setAttribute('role', 'tree');
		root.appendChild(tree);

		this.renderTreeItem(tree, mockTree, 0);
	}

	private renderTreeItem(container: HTMLElement, item: IFileTreeItem, depth: number): void {
		const row = document.createElement('div');
		row.className = `files-tree-row ${item.kind}`;
		row.setAttribute('role', 'treeitem');
		row.style.setProperty('--tree-depth', `${depth}`);

		const icon = document.createElement('span');
		icon.className = `codicon ${item.kind === 'folder' ? 'codicon-folder-opened' : 'codicon-json'}`;
		icon.setAttribute('aria-hidden', 'true');
		row.appendChild(icon);

		const label = document.createElement('span');
		label.className = 'files-tree-label';
		label.textContent = item.label;
		row.appendChild(label);

		container.appendChild(row);

		for (const child of item.children ?? []) {
			this.renderTreeItem(container, child, depth + 1);
		}
	}
}
