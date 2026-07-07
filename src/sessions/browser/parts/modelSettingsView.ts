/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, clearNode } from '../../base/browser/dom.js';
import { Disposable } from '../../base/common/lifecycle.js';
import type { IModelsService } from '../../services/models/browser/modelsService.js';
import type { IModelConfigInput, IModelConfigView, ModelProvider } from '../../services/models/common/models.js';

const PROVIDER_LABELS: Readonly<Record<ModelProvider, string>> = {
	'openai-compatible': 'OpenAI-compatible',
	anthropic: 'Anthropic',
};

/** The model-management panel mounted inside the settings dialog. */
export class ModelSettingsView extends Disposable {
	readonly element: HTMLElement;

	private formOpen = false;
	private editing: IModelConfigView | undefined;
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
		const registry = this.service.registry.get();

		const header = append(this.element, document.createElement('div'));
		header.className = 'sessions-models-header';
		const title = append(header, document.createElement('h2'));
		title.textContent = 'Models';
		if (!this.formOpen) {
			const addButton = append(header, document.createElement('button')) as HTMLButtonElement;
			addButton.className = 'sessions-models-add';
			addButton.type = 'button';
			addButton.textContent = 'Add model';
			addButton.addEventListener('click', () => this.openForm(undefined));
		}

		if (registry.models.length === 0 && !this.formOpen) {
			const empty = append(this.element, document.createElement('p'));
			empty.className = 'sessions-models-empty';
			empty.textContent = 'No models configured. Add one to start chatting.';
		} else {
			const list = append(this.element, document.createElement('div'));
			list.className = 'sessions-models-list';
			for (const model of registry.models) {
				list.appendChild(this.renderRow(model, model.id === registry.defaultModelId));
			}
		}

		if (this.formOpen) {
			this.element.appendChild(this.renderForm());
		}
	}

	private renderRow(model: IModelConfigView, isDefault: boolean): HTMLElement {
		const row = document.createElement('div');
		row.className = 'sessions-models-row';
		row.dataset.modelId = model.id;

		const main = append(row, document.createElement('div'));
		main.className = 'sessions-models-row-main';
		const name = append(main, document.createElement('div'));
		name.className = 'sessions-models-row-name';
		name.textContent = model.label;
		if (isDefault) {
			const badge = append(name, document.createElement('span'));
			badge.className = 'sessions-models-default-badge';
			badge.textContent = 'Default';
		}

		const meta = append(main, document.createElement('div'));
		meta.className = 'sessions-models-row-meta';
		meta.textContent = `${PROVIDER_LABELS[model.provider]} · ${model.model} · ${model.hasApiKey ? 'key set' : 'no key'}`;

		const actions = append(row, document.createElement('div'));
		actions.className = 'sessions-models-row-actions';
		if (!isDefault) {
			const setDefault = append(actions, document.createElement('button')) as HTMLButtonElement;
			setDefault.className = 'sessions-models-set-default';
			setDefault.type = 'button';
			setDefault.textContent = 'Set default';
			setDefault.addEventListener('click', () => void this.service.setDefault(model.id));
		}
		const edit = append(actions, document.createElement('button')) as HTMLButtonElement;
		edit.className = 'sessions-models-edit';
		edit.type = 'button';
		edit.textContent = 'Edit';
		edit.addEventListener('click', () => this.openForm(model));
		const remove = append(actions, document.createElement('button')) as HTMLButtonElement;
		remove.className = 'sessions-models-delete';
		remove.type = 'button';
		remove.textContent = 'Delete';
		remove.addEventListener('click', () => void this.service.remove(model.id));

		return row;
	}

	private renderForm(): HTMLElement {
		const editing = this.editing;
		const form = document.createElement('form');
		form.className = 'sessions-models-form';

		const formTitle = append(form, document.createElement('div'));
		formTitle.className = 'sessions-models-form-title';
		formTitle.textContent = editing ? 'Edit model' : 'Add model';

		const labelInput = this.field(form, 'Label', 'sessions-models-field-label', editing?.label ?? '');

		const providerRow = append(form, document.createElement('label'));
		providerRow.className = 'sessions-models-field';
		append(providerRow, document.createElement('span')).textContent = 'Provider';
		const providerWrap = append(providerRow, document.createElement('div'));
		providerWrap.className = 'sessions-models-select';
		const providerSelect = append(providerWrap, document.createElement('select')) as HTMLSelectElement;
		providerSelect.className = 'sessions-models-field-provider';
		for (const provider of ['openai-compatible', 'anthropic'] as const) {
			const option = append(providerSelect, document.createElement('option')) as HTMLOptionElement;
			option.value = provider;
			option.textContent = provider === 'openai-compatible' ? 'OpenAI-compatible (Kimi / GLM / DeepSeek / …)' : 'Anthropic (Claude)';
		}
		providerSelect.value = editing?.provider ?? 'openai-compatible';
		const providerChevron = append(providerWrap, document.createElement('span'));
		providerChevron.className = 'codicon codicon-chevron-down sessions-models-select-chevron';
		providerChevron.setAttribute('aria-hidden', 'true');

		const baseUrlInput = this.field(form, 'Base URL', 'sessions-models-field-baseurl', editing?.baseURL ?? '', 'https://api.moonshot.cn/v1');
		const modelInput = this.field(form, 'Model', 'sessions-models-field-model', editing?.model ?? '', 'kimi-k2');

		const keyRow = append(form, document.createElement('label'));
		keyRow.className = 'sessions-models-field';
		append(keyRow, document.createElement('span')).textContent = 'API key';
		const apiKeyInput = append(keyRow, document.createElement('input')) as HTMLInputElement;
		apiKeyInput.className = 'sessions-models-field-apikey';
		apiKeyInput.type = 'password';
		apiKeyInput.placeholder = editing?.hasApiKey ? '•••••••• (leave blank to keep)' : 'sk-…';

		const thinkingRow = append(form, document.createElement('label'));
		thinkingRow.className = 'sessions-models-field sessions-models-field-inline';
		const thinkingInput = append(thinkingRow, document.createElement('input')) as HTMLInputElement;
		thinkingInput.className = 'sessions-models-field-thinking';
		thinkingInput.type = 'checkbox';
		thinkingInput.checked = editing?.params?.thinking ?? false;
		append(thinkingRow, document.createElement('span')).textContent = 'Enable thinking';

		if (this.formError) {
			const error = append(form, document.createElement('div'));
			error.className = 'sessions-models-error';
			error.setAttribute('role', 'alert');
			error.textContent = this.formError;
		}

		const actions = append(form, document.createElement('div'));
		actions.className = 'sessions-models-form-actions';
		const save = append(actions, document.createElement('button')) as HTMLButtonElement;
		save.className = 'sessions-models-save';
		save.type = 'submit';
		save.textContent = editing ? 'Save' : 'Add';
		const cancel = append(actions, document.createElement('button')) as HTMLButtonElement;
		cancel.className = 'sessions-models-cancel';
		cancel.type = 'button';
		cancel.textContent = 'Cancel';
		cancel.addEventListener('click', () => this.closeForm());

		form.addEventListener('submit', event => {
			event.preventDefault();
			const input: IModelConfigInput = {
				...(editing ? { id: editing.id } : {}),
				label: labelInput.value.trim(),
				provider: providerSelect.value as ModelProvider,
				baseURL: baseUrlInput.value.trim(),
				model: modelInput.value.trim(),
				...(apiKeyInput.value.length > 0 ? { apiKey: apiKeyInput.value } : {}),
				...(thinkingInput.checked ? { params: { thinking: true } } : {}),
			};
			void this.submit(input);
		});

		return form;
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

	private openForm(model: IModelConfigView | undefined): void {
		this.formOpen = true;
		this.editing = model;
		this.formError = undefined;
		this.render();
	}

	private closeForm(): void {
		this.formOpen = false;
		this.editing = undefined;
		this.formError = undefined;
		this.render();
	}

	private async submit(input: IModelConfigInput): Promise<void> {
		if (!input.label || !input.baseURL || !input.model) {
			this.formError = 'Label, base URL, and model are required.';
			this.render();
			return;
		}

		try {
			await this.service.upsert(input);
		} catch (error) {
			this.formError = error instanceof Error ? error.message : String(error);
			this.render();
			return;
		}

		this.closeForm();
	}
}
