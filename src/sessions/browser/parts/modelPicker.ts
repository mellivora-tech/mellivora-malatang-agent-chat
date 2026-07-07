/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append } from '../../base/browser/dom.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import { listEnabledModels, type IModelsService } from '../../services/models/browser/modelsService.js';
import type { ModelEffort } from '../../services/models/common/models.js';

export interface IComposerPickerOptions {
	/** Positioned ancestor that hosts the dropdown (the composer clips overflow). */
	readonly host: HTMLElement;
	readonly trigger: HTMLButtonElement;
	readonly label: HTMLElement;
	readonly modelsService: IModelsService;
}

/**
 * Turn a composer's model button into a picker over the enabled models of all
 * configured providers. The selection lives on the models service, so every
 * composer shows and drives the same choice.
 */
export function installModelPicker(options: IComposerPickerOptions): IDisposable {
	const { trigger, label, modelsService } = options;
	const disposables = new DisposableStore();

	const updateLabel = (): void => {
		const selected = modelsService.selectedModel.get();
		label.textContent = selected?.label ?? 'No model';
		trigger.title = selected ? `Model: ${selected.label} (${selected.providerName})` : 'No models enabled — add one in Settings › Models';
	};
	disposables.add(modelsService.selectedModel.subscribe(updateLabel));
	updateLabel();

	disposables.add(
		installDropdown(options, menu => {
			const enabled = listEnabledModels(modelsService.registry.get());
			if (enabled.length === 0) {
				const empty = append(menu, document.createElement('div'));
				empty.className = 'sessions-model-menu-empty';
				empty.textContent = 'No models enabled — add one in Settings › Models.';
			}

			const selectedId = modelsService.selectedModel.get()?.id;
			return enabled.map(model => ({
				label: model.label,
				detail: model.providerName,
				checked: model.id === selectedId,
				pick: () => modelsService.setSelectedModel(model.id),
			}));
		}),
	);

	return disposables;
}

/**
 * The reasoning-effort picker next to the model button. Levels come from the
 * selected model's preset capability list; the button hides entirely for
 * models without an effort knob (e.g. Kimi's always-on thinking). "Auto"
 * clears the pick so nothing is sent and the provider default applies.
 */
export function installEffortPicker(options: IComposerPickerOptions): IDisposable {
	const { trigger, label, modelsService } = options;
	const disposables = new DisposableStore();

	const update = (): void => {
		const selected = modelsService.selectedModel.get();
		const efforts = selected?.efforts ?? [];
		trigger.hidden = efforts.length === 0;
		label.textContent = selected?.effort ?? 'Effort';
		trigger.title = selected?.effort ? `Reasoning effort: ${selected.effort}` : 'Reasoning effort (provider default)';
	};
	disposables.add(modelsService.selectedModel.subscribe(update));
	update();

	disposables.add(
		installDropdown(options, () => {
			const selected = modelsService.selectedModel.get();
			if (!selected) {
				return [];
			}
			const pick = (effort: ModelEffort | undefined) => () => void modelsService.setModelEffort(selected.id, effort);
			return [
				{ label: 'Auto', detail: 'provider default', checked: !selected.effort, pick: pick(undefined) },
				...(selected.efforts ?? []).map(effort => ({ label: effort, checked: selected.effort === effort, pick: pick(effort) })),
			];
		}),
	);

	return disposables;
}

interface IDropdownItem {
	readonly label: string;
	readonly detail?: string;
	readonly checked: boolean;
	pick(): void;
}

/**
 * Shared composer dropdown: anchored to the trigger, right-aligned, flipping
 * above it when the composer sits near the window bottom; closes on outside
 * click, Escape, or pick.
 */
function installDropdown(options: IComposerPickerOptions, buildItems: (menu: HTMLElement) => readonly IDropdownItem[]): IDisposable {
	const { host, trigger } = options;
	let menu: HTMLElement | undefined;

	const closeMenu = (): void => {
		menu?.remove();
		menu = undefined;
		document.removeEventListener('mousedown', onOutsideMouseDown, true);
		document.removeEventListener('keydown', onEscape, true);
	};

	const onOutsideMouseDown = (event: MouseEvent): void => {
		if (menu && event.target instanceof Node && !menu.contains(event.target) && !trigger.contains(event.target)) {
			closeMenu();
		}
	};

	const onEscape = (event: KeyboardEvent): void => {
		if (event.key === 'Escape') {
			closeMenu();
		}
	};

	const openMenu = (): void => {
		menu = append(host, document.createElement('div'));
		menu.className = 'sessions-model-menu';
		menu.setAttribute('role', 'menu');

		for (const entry of buildItems(menu)) {
			const item = append(menu, document.createElement('button')) as HTMLButtonElement;
			item.className = 'sessions-model-menu-item';
			item.type = 'button';
			item.setAttribute('role', 'menuitem');
			const check = append(item, document.createElement('span'));
			check.className = `codicon codicon-check${entry.checked ? '' : ' sessions-model-check-hidden'}`;
			check.setAttribute('aria-hidden', 'true');
			const name = append(item, document.createElement('span'));
			name.className = 'sessions-model-menu-label';
			name.textContent = entry.label;
			if (entry.detail) {
				const detail = append(item, document.createElement('span'));
				detail.className = 'sessions-model-menu-provider';
				detail.textContent = entry.detail;
			}
			item.addEventListener('click', () => {
				entry.pick();
				closeMenu();
			});
		}

		// Anchor to the trigger, right-aligned (the button sits at the
		// composer's right edge); sizes are known once appended. The
		// conversation composer hugs the window bottom, so flip the menu
		// above the trigger when it would be clipped below.
		const gap = 4;
		const margin = 8;
		const hostRect = host.getBoundingClientRect();
		const triggerRect = trigger.getBoundingClientRect();
		const spaceBelow = window.innerHeight - triggerRect.bottom - gap - margin;
		const openUp = spaceBelow < menu.offsetHeight && triggerRect.top > window.innerHeight - triggerRect.bottom;
		menu.style.top = openUp ? `${triggerRect.top - hostRect.top - menu.offsetHeight - gap}px` : `${triggerRect.bottom - hostRect.top + gap}px`;
		menu.style.left = `${Math.max(margin, triggerRect.right - hostRect.left - menu.offsetWidth)}px`;

		document.addEventListener('mousedown', onOutsideMouseDown, true);
		document.addEventListener('keydown', onEscape, true);
	};

	trigger.addEventListener('click', () => {
		if (menu) {
			closeMenu();
		} else {
			openMenu();
		}
	});

	return toDisposable(closeMenu);
}
