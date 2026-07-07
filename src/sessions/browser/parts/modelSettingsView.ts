/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, clearNode } from '../../base/browser/dom.js';
import { Disposable } from '../../base/common/lifecycle.js';
import type { IModelsService } from '../../services/models/browser/modelsService.js';
import type { IModelEntryInput, IModelEntryView, IProviderInput, IProviderView } from '../../services/models/common/models.js';
import { CUSTOM_PRESET_ID, deriveProviderType, findPreset, PROVIDER_PRESETS, type IProviderPreset } from '../../services/models/common/providerPresets.js';
import { settingsToggle } from './settingsControls.js';

interface IProviderFormState {
	readonly editing: IProviderView | undefined;
	readonly preset: IProviderPreset | undefined;
}

/**
 * Provider-centric model manager. A provider is one endpoint (name + base URL +
 * key); the wire format is derived, never chosen. Adding a provider starts from
 * the built-in preset catalog (or Custom). Models carry an `enabled` flag and an
 * order (priority) — there is no default model.
 */
export class ModelSettingsView extends Disposable {
	readonly element: HTMLElement;

	private selectedProviderId: string | undefined;
	private mode: 'detail' | 'preset-picker' | 'provider-form' = 'detail';
	private providerForm: IProviderFormState | undefined;
	private expandedModel: { readonly providerId: string; readonly editing: IModelEntryView | undefined } | undefined;
	private formError: string | undefined;

	constructor(private readonly service: IModelsService) {
		super();
		this.element = document.createElement('div');
		this.element.className = 'sessions-models';
		this._register(this.service.registry.subscribe(() => this.render()));
		this.render();
	}

	private render(): void {
		clearNode(this.element);
		const providers = this.service.registry.get().providers;

		if (this.selectedProviderId && !providers.some(provider => provider.id === this.selectedProviderId)) {
			this.selectedProviderId = undefined;
		}
		if (!this.selectedProviderId && this.mode === 'detail') {
			this.selectedProviderId = providers[0]?.id;
		}

		this.renderProviderColumn(providers);
		this.renderDetailColumn(providers);
	}

	private renderProviderColumn(providers: readonly IProviderView[]): void {
		const column = append(this.element, document.createElement('div'));
		column.className = 'sessions-models-providers';

		const title = append(column, document.createElement('div'));
		title.className = 'sessions-models-column-title';
		title.textContent = 'Providers';

		for (const provider of providers) {
			const row = append(column, document.createElement('button')) as HTMLButtonElement;
			row.className = 'sessions-models-provider';
			row.type = 'button';
			row.dataset.providerId = provider.id;
			if (provider.id === this.selectedProviderId && this.mode === 'detail') {
				row.classList.add('active');
			}
			const name = append(row, document.createElement('span'));
			name.className = 'sessions-models-provider-row-name';
			name.textContent = provider.name;
			const dot = append(row, document.createElement('span'));
			dot.className = provider.hasApiKey ? 'sessions-models-provider-dot on' : 'sessions-models-provider-dot';
			dot.setAttribute('aria-hidden', 'true');
			row.addEventListener('click', () => {
				this.selectedProviderId = provider.id;
				this.mode = 'detail';
				this.providerForm = undefined;
				this.expandedModel = undefined;
				this.render();
			});
		}

		const add = append(column, document.createElement('button')) as HTMLButtonElement;
		add.className = 'sessions-models-add-provider';
		add.type = 'button';
		add.innerHTML = '<span class="codicon codicon-add" aria-hidden="true"></span><span>Add provider</span>';
		add.addEventListener('click', () => this.openPresetPicker());
	}

	private renderDetailColumn(providers: readonly IProviderView[]): void {
		const detail = append(this.element, document.createElement('div'));
		detail.className = 'sessions-models-detail';

		if (this.mode === 'preset-picker') {
			this.renderPresetPicker(detail);
			return;
		}
		if (this.mode === 'provider-form') {
			detail.appendChild(this.renderProviderForm());
			return;
		}

		const provider = providers.find(candidate => candidate.id === this.selectedProviderId);
		if (!provider) {
			const empty = append(detail, document.createElement('div'));
			empty.className = 'sessions-models-empty';
			const icon = append(empty, document.createElement('span'));
			icon.className = 'codicon codicon-server-environment sessions-models-empty-icon';
			icon.setAttribute('aria-hidden', 'true');
			const text = append(empty, document.createElement('p'));
			text.textContent = 'Add a provider to configure models for chatting.';
			return;
		}

		this.renderProviderDetail(detail, provider);
	}

	private renderPresetPicker(detail: HTMLElement): void {
		const title = append(detail, document.createElement('h2'));
		title.className = 'sessions-models-provider-name';
		title.textContent = 'Add a provider';
		const subtitle = append(detail, document.createElement('div'));
		subtitle.className = 'sessions-models-detail-meta';
		subtitle.textContent = 'Pick a built-in provider, or configure a custom endpoint.';

		const grid = append(detail, document.createElement('div'));
		grid.className = 'sessions-models-preset-grid';
		for (const preset of PROVIDER_PRESETS) {
			grid.appendChild(this.renderPresetCard(preset.name, preset.description ?? preset.baseURL, () => this.openProviderForm(undefined, preset)));
		}
		grid.appendChild(this.renderPresetCard('Custom provider', 'Any OpenAI- or Anthropic-compatible endpoint', () => this.openProviderForm(undefined, undefined)));

		const cancel = append(detail, document.createElement('button')) as HTMLButtonElement;
		cancel.className = 'sessions-models-cancel';
		cancel.type = 'button';
		cancel.textContent = 'Cancel';
		cancel.addEventListener('click', () => this.closeForms());
	}

	private renderPresetCard(name: string, description: string, onPick: () => void): HTMLElement {
		const card = document.createElement('button');
		card.className = 'sessions-models-preset-card';
		card.type = 'button';
		const title = append(card, document.createElement('div'));
		title.className = 'sessions-models-preset-name';
		title.textContent = name;
		const desc = append(card, document.createElement('div'));
		desc.className = 'sessions-models-preset-desc';
		desc.textContent = description;
		card.addEventListener('click', onPick);
		return card;
	}

	private renderProviderDetail(detail: HTMLElement, provider: IProviderView): void {
		const header = append(detail, document.createElement('div'));
		header.className = 'sessions-models-detail-header';
		const name = append(header, document.createElement('h2'));
		name.className = 'sessions-models-provider-name';
		name.textContent = provider.name;

		const actions = append(header, document.createElement('div'));
		actions.className = 'sessions-models-detail-actions';
		const edit = append(actions, document.createElement('button')) as HTMLButtonElement;
		edit.className = 'sessions-models-edit-provider';
		edit.type = 'button';
		edit.textContent = 'Edit';
		edit.addEventListener('click', () => this.openProviderForm(provider, findPreset(provider.presetId)));
		const remove = append(actions, document.createElement('button')) as HTMLButtonElement;
		remove.className = 'sessions-models-delete-provider';
		remove.type = 'button';
		remove.textContent = 'Remove';
		remove.addEventListener('click', () => void this.service.removeProvider(provider.id));

		const meta = append(detail, document.createElement('div'));
		meta.className = 'sessions-models-detail-meta';
		const typeLabel = provider.type === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible';
		meta.textContent = `${typeLabel} · ${provider.baseURL || 'no base URL'} · ${provider.hasApiKey ? 'key set' : 'no key'}`;

		const listTitle = append(detail, document.createElement('div'));
		listTitle.className = 'sessions-models-section-title';
		listTitle.textContent = 'Model list';

		const list = append(detail, document.createElement('div'));
		list.className = 'sessions-models-model-list';
		if (provider.models.length === 0 && !(this.expandedModel && this.expandedModel.providerId === provider.id && !this.expandedModel.editing)) {
			const empty = append(list, document.createElement('div'));
			empty.className = 'sessions-models-model-empty';
			empty.textContent = 'No models yet.';
		}
		provider.models.forEach((model, index) => {
			list.appendChild(this.renderModelRow(provider.id, model, index, provider.models.length));
			if (this.expandedModel && this.expandedModel.editing?.id === model.id) {
				list.appendChild(this.renderModelForm(provider.id, model));
			}
		});
		if (this.expandedModel && this.expandedModel.providerId === provider.id && !this.expandedModel.editing) {
			list.appendChild(this.renderModelForm(provider.id, undefined));
		}

		if (!(this.expandedModel && this.expandedModel.providerId === provider.id && !this.expandedModel.editing)) {
			const add = append(detail, document.createElement('button')) as HTMLButtonElement;
			add.className = 'sessions-models-add-model';
			add.type = 'button';
			add.innerHTML = '<span class="codicon codicon-add" aria-hidden="true"></span><span>Add model</span>';
			add.addEventListener('click', () => this.openModelForm(provider.id, undefined));
		}
	}

	private renderModelRow(providerId: string, model: IModelEntryView, index: number, total: number): HTMLElement {
		const row = document.createElement('div');
		row.className = 'sessions-models-model-row';
		row.dataset.modelId = model.id;

		const label = append(row, document.createElement('div'));
		label.className = 'sessions-models-model-label';
		label.textContent = model.label;

		const right = append(row, document.createElement('div'));
		right.className = 'sessions-models-model-right';

		const context = formatContext(model.contextLength);
		if (context) {
			const badge = append(right, document.createElement('span'));
			badge.className = 'sessions-models-model-badge';
			badge.textContent = context;
		}

		const actions = append(right, document.createElement('div'));
		actions.className = 'sessions-models-model-actions';
		const up = append(actions, document.createElement('button')) as HTMLButtonElement;
		up.className = 'sessions-models-move-up';
		up.type = 'button';
		up.title = 'Move up';
		up.disabled = index === 0;
		up.innerHTML = '<span class="codicon codicon-chevron-up" aria-hidden="true"></span>';
		up.addEventListener('click', () => void this.service.moveModel(model.id, 'up'));
		const down = append(actions, document.createElement('button')) as HTMLButtonElement;
		down.className = 'sessions-models-move-down';
		down.type = 'button';
		down.title = 'Move down';
		down.disabled = index === total - 1;
		down.innerHTML = '<span class="codicon codicon-chevron-down" aria-hidden="true"></span>';
		down.addEventListener('click', () => void this.service.moveModel(model.id, 'down'));
		const edit = append(actions, document.createElement('button')) as HTMLButtonElement;
		edit.className = 'sessions-models-edit-model';
		edit.type = 'button';
		edit.textContent = 'Edit';
		edit.addEventListener('click', () => this.toggleModelForm(providerId, model));
		const remove = append(actions, document.createElement('button')) as HTMLButtonElement;
		remove.className = 'sessions-models-delete-model';
		remove.type = 'button';
		remove.textContent = 'Delete';
		remove.addEventListener('click', () => void this.service.removeModel(model.id));

		// Enabled toggle: whether the model is offered in the composer's picker.
		settingsToggle(right, model.enabled, value => void this.service.setModelEnabled(model.id, value));

		return row;
	}

	private renderModelForm(providerId: string, editing: IModelEntryView | undefined): HTMLElement {
		const form = document.createElement('form');
		form.className = 'sessions-models-form sessions-models-model-form';

		const modelInput = this.field(form, 'Model', 'sessions-models-field-model', editing?.model ?? '', 'glm-4.6');
		const labelInput = this.field(form, 'Display name (optional)', 'sessions-models-field-modellabel', editing?.label ?? '', 'GLM-4.6');
		const contextInput = this.field(form, 'Context length (optional)', 'sessions-models-field-context', editing?.contextLength ? String(editing.contextLength) : '', '200000');
		contextInput.inputMode = 'numeric';

		this.appendFormError(form);
		this.appendFormActions(form, editing ? 'Save' : 'Add', 'sessions-models-model-save', 'sessions-models-model-cancel');

		form.addEventListener('submit', event => {
			event.preventDefault();
			const contextLength = Number.parseInt(contextInput.value, 10);
			const input: IModelEntryInput = {
				...(editing ? { id: editing.id } : {}),
				model: modelInput.value.trim(),
				...(labelInput.value.trim().length > 0 ? { label: labelInput.value.trim() } : {}),
				...(Number.isFinite(contextLength) && contextLength > 0 ? { contextLength } : {}),
			};
			void this.submitModel(providerId, input);
		});

		return form;
	}

	private renderProviderForm(): HTMLElement {
		const editing = this.providerForm?.editing;
		const preset = this.providerForm?.preset;
		const form = document.createElement('form');
		form.className = 'sessions-models-form sessions-models-provider-form';

		const title = append(form, document.createElement('div'));
		title.className = 'sessions-models-form-title';
		title.textContent = editing ? 'Edit provider' : preset ? `Add ${preset.name}` : 'Add custom provider';
		const subtitle = append(form, document.createElement('div'));
		subtitle.className = 'sessions-models-detail-meta';
		subtitle.textContent = editing ? 'Update the endpoint or rotate the key.' : 'Configure the API endpoint and key.';

		const nameInput = this.field(form, 'Name', 'sessions-models-field-name', editing?.name ?? preset?.name ?? '', 'DeepSeek');
		const baseUrlInput = this.field(form, 'Base URL', 'sessions-models-field-baseurl', editing?.baseURL ?? preset?.baseURL ?? '', 'https://api.example.com/v1');

		const keyRow = append(form, document.createElement('label'));
		keyRow.className = 'sessions-models-field';
		append(keyRow, document.createElement('span')).textContent = 'API key';
		const apiKeyInput = append(keyRow, document.createElement('input')) as HTMLInputElement;
		apiKeyInput.className = 'sessions-models-field-apikey';
		apiKeyInput.type = 'password';
		apiKeyInput.placeholder = editing?.hasApiKey ? '•••••••• (leave blank to keep)' : 'Enter API key';

		this.appendFormError(form);
		this.appendFormActions(form, editing ? 'Save' : 'Add provider', 'sessions-models-provider-save', 'sessions-models-provider-cancel');

		form.addEventListener('submit', event => {
			event.preventDefault();
			const baseURL = baseUrlInput.value.trim();
			const type = preset ? preset.type : deriveProviderType(baseURL);
			const input: IProviderInput = {
				...(editing ? { id: editing.id } : {}),
				name: nameInput.value.trim(),
				type,
				baseURL,
				...(preset ? { presetId: preset.id } : {}),
				...(apiKeyInput.value.length > 0 ? { apiKey: apiKeyInput.value } : {}),
				...(!editing && preset
					? { models: preset.models.map(model => ({ model: model.model, label: model.label, ...(model.contextLength ? { contextLength: model.contextLength } : {}) })) }
					: {}),
			};
			void this.submitProvider(input, editing === undefined);
		});

		return form;
	}

	private appendFormError(form: HTMLElement): void {
		if (!this.formError) {
			return;
		}
		const error = append(form, document.createElement('div'));
		error.className = 'sessions-models-error';
		error.setAttribute('role', 'alert');
		error.textContent = this.formError;
	}

	private appendFormActions(form: HTMLElement, saveLabel: string, saveClass: string, cancelClass: string): void {
		const actions = append(form, document.createElement('div'));
		actions.className = 'sessions-models-form-actions';
		const save = append(actions, document.createElement('button')) as HTMLButtonElement;
		save.className = saveClass;
		save.type = 'submit';
		save.textContent = saveLabel;
		const cancel = append(actions, document.createElement('button')) as HTMLButtonElement;
		cancel.className = cancelClass;
		cancel.type = 'button';
		cancel.textContent = 'Cancel';
		cancel.addEventListener('click', () => this.closeForms());
	}

	private field(form: HTMLElement, label: string, className: string, value: string, placeholder?: string): HTMLInputElement {
		const row = append(form, document.createElement('label'));
		row.className = 'sessions-models-field';
		append(row, document.createElement('span')).textContent = label;
		const input = append(row, document.createElement('input')) as HTMLInputElement;
		input.className = className;
		input.type = 'text';
		input.value = value;
		if (placeholder) {
			input.placeholder = placeholder;
		}

		return input;
	}

	private openPresetPicker(): void {
		this.mode = 'preset-picker';
		this.providerForm = undefined;
		this.expandedModel = undefined;
		this.formError = undefined;
		this.render();
	}

	private openProviderForm(provider: IProviderView | undefined, preset: IProviderPreset | undefined): void {
		this.mode = 'provider-form';
		this.providerForm = { editing: provider, preset: preset?.id === CUSTOM_PRESET_ID ? undefined : preset };
		this.expandedModel = undefined;
		this.formError = undefined;
		if (provider) {
			this.selectedProviderId = provider.id;
		}
		this.render();
	}

	private openModelForm(providerId: string, model: IModelEntryView | undefined): void {
		this.expandedModel = { providerId, editing: model };
		this.formError = undefined;
		this.render();
	}

	private toggleModelForm(providerId: string, model: IModelEntryView): void {
		if (this.expandedModel && this.expandedModel.editing?.id === model.id) {
			this.expandedModel = undefined;
		} else {
			this.expandedModel = { providerId, editing: model };
		}
		this.formError = undefined;
		this.render();
	}

	private closeForms(): void {
		this.mode = 'detail';
		this.providerForm = undefined;
		this.expandedModel = undefined;
		this.formError = undefined;
		this.render();
	}

	private async submitProvider(input: IProviderInput, isAdd: boolean): Promise<void> {
		if (!input.name || !input.baseURL) {
			this.formError = 'Name and base URL are required.';
			this.render();
			return;
		}

		try {
			await this.service.upsertProvider(input);
		} catch (error) {
			this.formError = error instanceof Error ? error.message : String(error);
			this.render();
			return;
		}

		if (isAdd) {
			const providers = this.service.registry.get().providers;
			this.selectedProviderId = providers[providers.length - 1]?.id;
		}
		this.closeForms();
	}

	private async submitModel(providerId: string, input: IModelEntryInput): Promise<void> {
		if (!input.model) {
			this.formError = 'Model is required.';
			this.render();
			return;
		}

		try {
			await this.service.upsertModel(providerId, input);
		} catch (error) {
			this.formError = error instanceof Error ? error.message : String(error);
			this.render();
			return;
		}

		this.expandedModel = undefined;
		this.formError = undefined;
		this.render();
	}
}

/** 1_000_000 -> "1M", 200_000 -> "200K". */
function formatContext(tokens: number | undefined): string {
	if (!tokens || tokens <= 0) {
		return '';
	}
	if (tokens >= 1_000_000) {
		const millions = tokens / 1_000_000;
		return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
	}
	if (tokens >= 1000) {
		return `${Math.round(tokens / 1000)}K`;
	}

	return String(tokens);
}
