/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, clearNode } from '../../base/browser/dom.js';
import { Disposable } from '../../base/common/lifecycle.js';
import type { IModelsService } from '../../services/models/browser/modelsService.js';
import type { IModelEntryInput, IModelEntryView, IProviderInput, IProviderView, ModelProvider } from '../../services/models/common/models.js';

const PROVIDER_TYPE_LABELS: Readonly<Record<ModelProvider, string>> = {
	'openai-compatible': 'OpenAI-compatible',
	anthropic: 'Anthropic',
};

interface IProviderFormState {
	readonly editing: IProviderView | undefined;
}

interface IModelFormState {
	readonly providerId: string;
	readonly editing: IModelEntryView | undefined;
}

/**
 * The provider-centric model manager mounted inside the settings dialog: a left
 * column of providers and a right detail pane listing that provider's models.
 */
export class ModelSettingsView extends Disposable {
	readonly element: HTMLElement;

	private selectedProviderId: string | undefined;
	private providerForm: IProviderFormState | undefined;
	private modelForm: IModelFormState | undefined;
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
		if (!this.selectedProviderId) {
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
			if (provider.id === this.selectedProviderId && !this.providerForm) {
				row.classList.add('active');
			}
			const name = append(row, document.createElement('span'));
			name.className = 'sessions-models-provider-row-name';
			name.textContent = provider.name;
			const dot = append(row, document.createElement('span'));
			dot.className = provider.enabled ? 'sessions-models-provider-dot on' : 'sessions-models-provider-dot';
			dot.setAttribute('aria-hidden', 'true');
			row.addEventListener('click', () => {
				this.selectedProviderId = provider.id;
				this.providerForm = undefined;
				this.modelForm = undefined;
				this.render();
			});
		}

		const add = append(column, document.createElement('button')) as HTMLButtonElement;
		add.className = 'sessions-models-add-provider';
		add.type = 'button';
		add.innerHTML = '<span class="codicon codicon-add" aria-hidden="true"></span><span>Add provider</span>';
		add.addEventListener('click', () => this.openProviderForm(undefined));
	}

	private renderDetailColumn(providers: readonly IProviderView[]): void {
		const detail = append(this.element, document.createElement('div'));
		detail.className = 'sessions-models-detail';

		if (this.providerForm) {
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

	private renderProviderDetail(detail: HTMLElement, provider: IProviderView): void {
		const defaultModelId = this.service.registry.get().defaultModelId;

		const header = append(detail, document.createElement('div'));
		header.className = 'sessions-models-detail-header';
		const name = append(header, document.createElement('h2'));
		name.className = 'sessions-models-provider-name';
		name.textContent = provider.name;
		const badge = append(header, document.createElement('span'));
		badge.className = provider.enabled ? 'sessions-models-enabled-badge on' : 'sessions-models-enabled-badge';
		badge.textContent = provider.enabled ? 'Enabled' : 'Disabled';

		const actions = append(header, document.createElement('div'));
		actions.className = 'sessions-models-detail-actions';
		const edit = append(actions, document.createElement('button')) as HTMLButtonElement;
		edit.className = 'sessions-models-edit-provider';
		edit.type = 'button';
		edit.textContent = 'Edit';
		edit.addEventListener('click', () => this.openProviderForm(provider));
		const remove = append(actions, document.createElement('button')) as HTMLButtonElement;
		remove.className = 'sessions-models-delete-provider';
		remove.type = 'button';
		remove.textContent = 'Remove';
		remove.addEventListener('click', () => void this.service.removeProvider(provider.id));

		const meta = append(detail, document.createElement('div'));
		meta.className = 'sessions-models-detail-meta';
		meta.textContent = `${PROVIDER_TYPE_LABELS[provider.type]} · ${provider.baseURL || 'no base URL'} · ${provider.hasApiKey ? 'key set' : 'no key'}`;

		const listTitle = append(detail, document.createElement('div'));
		listTitle.className = 'sessions-models-section-title';
		listTitle.textContent = 'Model list';

		const list = append(detail, document.createElement('div'));
		list.className = 'sessions-models-model-list';
		if (provider.models.length === 0) {
			const empty = append(list, document.createElement('div'));
			empty.className = 'sessions-models-model-empty';
			empty.textContent = 'No models yet.';
		} else {
			for (const model of provider.models) {
				list.appendChild(this.renderModelRow(provider.id, model, model.id === defaultModelId));
			}
		}

		if (this.modelForm && this.modelForm.providerId === provider.id) {
			detail.appendChild(this.renderModelForm(provider.id));
		} else {
			const add = append(detail, document.createElement('button')) as HTMLButtonElement;
			add.className = 'sessions-models-add-model';
			add.type = 'button';
			add.innerHTML = '<span class="codicon codicon-add" aria-hidden="true"></span><span>Add model</span>';
			add.addEventListener('click', () => this.openModelForm(provider.id, undefined));
		}
	}

	private renderModelRow(providerId: string, model: IModelEntryView, isDefault: boolean): HTMLElement {
		const row = document.createElement('div');
		row.className = 'sessions-models-model-row';
		row.dataset.modelId = model.id;

		const label = append(row, document.createElement('div'));
		label.className = 'sessions-models-model-label';
		label.textContent = model.label;
		if (isDefault) {
			const defaultBadge = append(label, document.createElement('span'));
			defaultBadge.className = 'sessions-models-default-badge';
			defaultBadge.textContent = 'Default';
		}

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
		if (!isDefault) {
			const setDefault = append(actions, document.createElement('button')) as HTMLButtonElement;
			setDefault.className = 'sessions-models-set-default';
			setDefault.type = 'button';
			setDefault.textContent = 'Set default';
			setDefault.addEventListener('click', () => void this.service.setDefaultModel(model.id));
		}
		const edit = append(actions, document.createElement('button')) as HTMLButtonElement;
		edit.className = 'sessions-models-edit-model';
		edit.type = 'button';
		edit.textContent = 'Edit';
		edit.addEventListener('click', () => this.openModelForm(providerId, model));
		const remove = append(actions, document.createElement('button')) as HTMLButtonElement;
		remove.className = 'sessions-models-delete-model';
		remove.type = 'button';
		remove.textContent = 'Delete';
		remove.addEventListener('click', () => void this.service.removeModel(model.id));

		return row;
	}

	private renderProviderForm(): HTMLElement {
		const editing = this.providerForm?.editing;
		const form = document.createElement('form');
		form.className = 'sessions-models-form sessions-models-provider-form';

		const title = append(form, document.createElement('div'));
		title.className = 'sessions-models-form-title';
		title.textContent = editing ? 'Edit provider' : 'Add provider';

		const nameInput = this.field(form, 'Name', 'sessions-models-field-name', editing?.name ?? '', 'Z.ai');

		const typeRow = append(form, document.createElement('label'));
		typeRow.className = 'sessions-models-field';
		append(typeRow, document.createElement('span')).textContent = 'Provider';
		const typeWrap = append(typeRow, document.createElement('div'));
		typeWrap.className = 'sessions-models-select';
		const typeSelect = append(typeWrap, document.createElement('select')) as HTMLSelectElement;
		typeSelect.className = 'sessions-models-field-provider';
		for (const type of ['openai-compatible', 'anthropic'] as const) {
			const option = append(typeSelect, document.createElement('option')) as HTMLOptionElement;
			option.value = type;
			option.textContent = type === 'openai-compatible' ? 'OpenAI-compatible (Kimi / GLM / DeepSeek / …)' : 'Anthropic (Claude)';
		}
		typeSelect.value = editing?.type ?? 'openai-compatible';
		const chevron = append(typeWrap, document.createElement('span'));
		chevron.className = 'codicon codicon-chevron-down sessions-models-select-chevron';
		chevron.setAttribute('aria-hidden', 'true');

		const baseUrlInput = this.field(form, 'Base URL', 'sessions-models-field-baseurl', editing?.baseURL ?? '', 'https://api.moonshot.cn/v1');

		const keyRow = append(form, document.createElement('label'));
		keyRow.className = 'sessions-models-field';
		append(keyRow, document.createElement('span')).textContent = 'API key';
		const apiKeyInput = append(keyRow, document.createElement('input')) as HTMLInputElement;
		apiKeyInput.className = 'sessions-models-field-apikey';
		apiKeyInput.type = 'password';
		apiKeyInput.placeholder = editing?.hasApiKey ? '•••••••• (leave blank to keep)' : 'sk-…';

		this.appendFormError(form);
		this.appendFormActions(form, editing ? 'Save' : 'Add', 'sessions-models-provider-save', 'sessions-models-provider-cancel');

		form.addEventListener('submit', event => {
			event.preventDefault();
			const input: IProviderInput = {
				...(editing ? { id: editing.id } : {}),
				name: nameInput.value.trim(),
				type: typeSelect.value as ModelProvider,
				baseURL: baseUrlInput.value.trim(),
				...(apiKeyInput.value.length > 0 ? { apiKey: apiKeyInput.value } : {}),
			};
			void this.submitProvider(input, editing === undefined);
		});

		return form;
	}

	private renderModelForm(providerId: string): HTMLElement {
		const editing = this.modelForm?.editing;
		const form = document.createElement('form');
		form.className = 'sessions-models-form sessions-models-model-form';

		const title = append(form, document.createElement('div'));
		title.className = 'sessions-models-form-title';
		title.textContent = editing ? 'Edit model' : 'Add model';

		const modelInput = this.field(form, 'Model', 'sessions-models-field-model', editing?.model ?? '', 'glm-4.6');
		const labelInput = this.field(form, 'Display name (optional)', 'sessions-models-field-modellabel', editing?.label ?? '', 'GLM-4.6');
		const contextInput = this.field(form, 'Context length (optional)', 'sessions-models-field-context', editing?.contextLength ? String(editing.contextLength) : '', '200000');
		contextInput.inputMode = 'numeric';

		const thinkingRow = append(form, document.createElement('label'));
		thinkingRow.className = 'sessions-models-field sessions-models-field-inline';
		const thinkingInput = append(thinkingRow, document.createElement('input')) as HTMLInputElement;
		thinkingInput.className = 'sessions-models-field-thinking';
		thinkingInput.type = 'checkbox';
		thinkingInput.checked = editing?.params?.thinking ?? false;
		append(thinkingRow, document.createElement('span')).textContent = 'Enable thinking';

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
				...(thinkingInput.checked ? { params: { thinking: true } } : {}),
			};
			void this.submitModel(providerId, input);
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

	private openProviderForm(provider: IProviderView | undefined): void {
		this.providerForm = { editing: provider };
		this.modelForm = undefined;
		this.formError = undefined;
		if (provider) {
			this.selectedProviderId = provider.id;
		}
		this.render();
	}

	private openModelForm(providerId: string, model: IModelEntryView | undefined): void {
		this.modelForm = { providerId, editing: model };
		this.providerForm = undefined;
		this.formError = undefined;
		this.render();
	}

	private closeForms(): void {
		this.providerForm = undefined;
		this.modelForm = undefined;
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

		this.closeForms();
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
