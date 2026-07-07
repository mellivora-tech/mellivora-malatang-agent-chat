/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, clearNode } from '../../base/browser/dom.js';
import { Disposable } from '../../base/common/lifecycle.js';
import type { IModelsService } from '../../services/models/browser/modelsService.js';
import type { IModelEntryInput, IModelEntryView, IProviderInput, IProviderView, IRemoteModel } from '../../services/models/common/models.js';
import { PROVIDER_PRESETS, type IProviderPreset } from '../../services/models/common/providerPresets.js';
import { settingsToggle } from './settingsControls.js';

/**
 * One row in the fixed provider catalog: a built-in preset merged with its
 * stored configuration (if any). Legacy providers without a matching preset
 * are appended so they stay reachable (and removable).
 */
interface ICatalogRow {
	readonly key: string;
	readonly name: string;
	readonly preset: IProviderPreset | undefined;
	readonly provider: IProviderView | undefined;
}

interface IModelCandidatesState {
	readonly providerId: string;
	readonly status: 'loading' | 'ready' | 'error';
	readonly models: readonly IRemoteModel[];
}

/**
 * Provider-centric model manager over a fixed catalog. The left column always
 * lists every built-in provider — there is no "add provider"; unconfigured ones
 * are dimmed and selecting one opens its setup form (prefilled base URL + API
 * key). Saving seeds the preset's model list. Models carry an `enabled` flag
 * and an order (priority) — there is no default model.
 */
export class ModelSettingsView extends Disposable {
	readonly element: HTMLElement;

	private selectedKey: string | undefined;
	private mode: 'detail' | 'form' = 'detail';
	private expandedModel: { readonly providerId: string; readonly editing: IModelEntryView | undefined } | undefined;
	private formError: string | undefined;
	/** Typed-but-unsaved provider form values, kept across an error re-render. */
	private providerDraft: { readonly key: string; readonly baseURL: string; readonly apiKey: string } | undefined;
	/** Models reported by the provider's endpoint, offered as candidates when adding a model. */
	private modelCandidates: IModelCandidatesState | undefined;

	constructor(private readonly service: IModelsService) {
		super();
		this.element = document.createElement('div');
		this.element.className = 'sessions-models';
		this._register(this.service.registry.subscribe(() => this.render()));
		this.render();
	}

	private render(): void {
		clearNode(this.element);
		const rows = this.buildCatalog(this.service.registry.get().providers);

		if (!this.selectedKey || !rows.some(row => row.key === this.selectedKey)) {
			this.selectedKey = (rows.find(row => row.provider) ?? rows[0])?.key;
			this.mode = 'detail';
		}

		this.renderProviderColumn(rows);
		this.renderDetailColumn(rows);
	}

	private buildCatalog(providers: readonly IProviderView[]): ICatalogRow[] {
		const rows: ICatalogRow[] = PROVIDER_PRESETS.map(preset => ({
			key: preset.id,
			name: preset.name,
			preset,
			provider: providers.find(provider => provider.presetId === preset.id),
		}));
		for (const provider of providers) {
			if (!PROVIDER_PRESETS.some(preset => preset.id === provider.presetId)) {
				rows.push({ key: provider.id, name: provider.name, preset: undefined, provider });
			}
		}

		return rows;
	}

	private renderProviderColumn(rows: readonly ICatalogRow[]): void {
		const column = append(this.element, document.createElement('div'));
		column.className = 'sessions-models-providers';

		const title = append(column, document.createElement('div'));
		title.className = 'sessions-models-column-title';
		title.textContent = 'Providers';

		for (const entry of rows) {
			const row = append(column, document.createElement('button')) as HTMLButtonElement;
			row.className = 'sessions-models-provider';
			row.type = 'button';
			row.dataset.providerId = entry.key;
			if (entry.key === this.selectedKey) {
				row.classList.add('active');
			}
			if (!entry.provider) {
				row.classList.add('unconfigured');
			}
			const name = append(row, document.createElement('span'));
			name.className = 'sessions-models-provider-row-name';
			name.textContent = entry.name;
			const dot = append(row, document.createElement('span'));
			dot.className = entry.provider?.hasApiKey ? 'sessions-models-provider-dot on' : 'sessions-models-provider-dot';
			dot.setAttribute('aria-hidden', 'true');
			row.addEventListener('click', () => {
				this.selectedKey = entry.key;
				this.mode = 'detail';
				this.expandedModel = undefined;
				this.formError = undefined;
				this.providerDraft = undefined;
				this.render();
			});
		}
	}

	private renderDetailColumn(rows: readonly ICatalogRow[]): void {
		const detail = append(this.element, document.createElement('div'));
		detail.className = 'sessions-models-detail';

		const row = rows.find(candidate => candidate.key === this.selectedKey);
		if (!row) {
			return;
		}

		if (row.provider && this.mode === 'detail') {
			this.renderProviderDetail(detail, row.provider, row.preset !== undefined);
			return;
		}

		detail.appendChild(this.renderProviderForm(row));
	}

	private renderProviderDetail(detail: HTMLElement, provider: IProviderView, isPreset: boolean): void {
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
		edit.addEventListener('click', () => {
			this.mode = 'form';
			this.expandedModel = undefined;
			this.formError = undefined;
			this.render();
		});
		// Preset providers cannot be removed from the catalog — clearing resets
		// them to the unconfigured state; legacy rows disappear entirely.
		const remove = append(actions, document.createElement('button')) as HTMLButtonElement;
		remove.className = 'sessions-models-delete-provider';
		remove.type = 'button';
		remove.textContent = isPreset ? 'Clear' : 'Remove';
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

		const modelInput = this.field(form, 'Model', 'sessions-models-field-model', editing?.model ?? '', 'glm-5.2');
		const labelInput = this.field(form, 'Display name (optional)', 'sessions-models-field-modellabel', editing?.label ?? '', 'GLM-5.2');
		const contextInput = this.field(form, 'Context length (optional)', 'sessions-models-field-context', editing?.contextLength ? String(editing.contextLength) : '', '200000');
		contextInput.inputMode = 'numeric';
		if (!editing) {
			this.appendModelCandidates(form, providerId, modelInput, contextInput);
		}

		this.appendFormError(form);
		this.appendFormActions(form, editing ? 'Save' : 'Add', 'sessions-models-model-save', 'sessions-models-model-cancel', () => this.closeModelForm());

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

	private renderProviderForm(row: ICatalogRow): HTMLElement {
		const editing = row.provider;
		const draft = this.providerDraft?.key === row.key ? this.providerDraft : undefined;
		const form = document.createElement('form');
		form.className = 'sessions-models-form sessions-models-provider-form';

		const title = append(form, document.createElement('div'));
		title.className = 'sessions-models-form-title';
		title.textContent = editing ? `Edit ${row.name}` : `Set up ${row.name}`;
		const subtitle = append(form, document.createElement('div'));
		subtitle.className = 'sessions-models-detail-meta';
		subtitle.textContent = editing ? 'Update the endpoint or rotate the key.' : 'Enter an API key to start using this provider.';

		const baseUrlInput = this.field(
			form,
			'Base URL',
			'sessions-models-field-baseurl',
			draft?.baseURL ?? editing?.baseURL ?? row.preset?.baseURL ?? '',
			'https://api.example.com/v1',
		);

		const keyRow = append(form, document.createElement('label'));
		keyRow.className = 'sessions-models-field';
		append(keyRow, document.createElement('span')).textContent = 'API key';
		const apiKeyInput = append(keyRow, document.createElement('input')) as HTMLInputElement;
		apiKeyInput.className = 'sessions-models-field-apikey';
		apiKeyInput.type = 'password';
		apiKeyInput.placeholder = editing?.hasApiKey ? '•••••••• (leave blank to keep)' : 'Enter API key';
		apiKeyInput.value = draft?.apiKey ?? '';

		this.appendFormError(form);
		// Setup has nothing to cancel back to — the row simply stays unconfigured.
		const save = this.appendFormActions(form, 'Save', 'sessions-models-provider-save', 'sessions-models-provider-cancel', editing ? () => this.closeProviderForm() : undefined);

		form.addEventListener('submit', event => {
			event.preventDefault();
			const input: IProviderInput = {
				...(editing ? { id: editing.id } : {}),
				name: row.name,
				type: editing?.type ?? row.preset?.type ?? 'openai-compatible',
				baseURL: baseUrlInput.value.trim(),
				...(row.preset ? { presetId: row.preset.id } : {}),
				...(apiKeyInput.value.length > 0 ? { apiKey: apiKeyInput.value } : {}),
				...(!editing && row.preset
					? { models: row.preset.models.map(model => ({ model: model.model, label: model.label, ...(model.contextLength ? { contextLength: model.contextLength } : {}) })) }
					: {}),
			};
			void this.submitProvider(row, input, save);
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

	private appendFormActions(form: HTMLElement, saveLabel: string, saveClass: string, cancelClass: string, onCancel: (() => void) | undefined): HTMLButtonElement {
		const actions = append(form, document.createElement('div'));
		actions.className = 'sessions-models-form-actions';
		const save = append(actions, document.createElement('button')) as HTMLButtonElement;
		save.className = saveClass;
		save.type = 'submit';
		save.textContent = saveLabel;
		if (onCancel) {
			const cancel = append(actions, document.createElement('button')) as HTMLButtonElement;
			cancel.className = cancelClass;
			cancel.type = 'button';
			cancel.textContent = 'Cancel';
			cancel.addEventListener('click', onCancel);
		}

		return save;
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

	private openModelForm(providerId: string, model: IModelEntryView | undefined): void {
		this.expandedModel = { providerId, editing: model };
		this.formError = undefined;
		if (!model) {
			this.loadModelCandidates(providerId);
		}
		this.render();
	}

	private loadModelCandidates(providerId: string): void {
		if (this.modelCandidates?.providerId === providerId && this.modelCandidates.status !== 'error') {
			return;
		}
		this.modelCandidates = { providerId, status: 'loading', models: [] };
		void this.service.listRemoteModels({ providerId }).then(
			models => this.setModelCandidates(providerId, { providerId, status: 'ready', models }),
			() => this.setModelCandidates(providerId, { providerId, status: 'error', models: [] }),
		);
	}

	private setModelCandidates(providerId: string, state: IModelCandidatesState): void {
		if (this.modelCandidates?.providerId !== providerId) {
			return;
		}
		this.modelCandidates = state;
		// Only re-render while the add-model form (the candidates' consumer) is open.
		if (this.expandedModel && this.expandedModel.providerId === providerId && !this.expandedModel.editing) {
			this.render();
		}
	}

	/** Suggestions from the provider's live model list; manual entry always works. */
	private appendModelCandidates(form: HTMLElement, providerId: string, modelInput: HTMLInputElement, contextInput: HTMLInputElement): void {
		const candidates = this.modelCandidates?.providerId === providerId ? this.modelCandidates : undefined;
		if (!candidates) {
			return;
		}

		// The suggestions belong visually right under the Model field.
		const modelRow = modelInput.parentElement ?? form;

		if (candidates.status === 'loading') {
			const note = document.createElement('div');
			note.className = 'sessions-models-candidates-note';
			note.textContent = 'Fetching available models…';
			modelRow.insertAdjacentElement('afterend', note);
			return;
		}
		if (candidates.status === 'error') {
			const note = document.createElement('div');
			note.className = 'sessions-models-candidates-note';
			note.textContent = 'Could not fetch the provider’s model list — enter a model manually.';
			modelRow.insertAdjacentElement('afterend', note);
			return;
		}

		const existing = new Set(
			this.service.registry
				.get()
				.providers.find(provider => provider.id === providerId)
				?.models.map(model => model.model),
		);
		const available = candidates.models.filter(model => !existing.has(model.id));
		if (available.length === 0) {
			return;
		}

		const list = document.createElement('div');
		list.className = 'sessions-models-candidates';
		modelRow.insertAdjacentElement('afterend', list);
		for (const candidate of available) {
			const chip = append(list, document.createElement('button')) as HTMLButtonElement;
			chip.className = 'sessions-models-candidate';
			chip.type = 'button';
			chip.textContent = candidate.id;
			chip.addEventListener('click', () => {
				modelInput.value = candidate.id;
				if (candidate.contextLength) {
					contextInput.value = String(candidate.contextLength);
				}
				modelInput.focus();
			});
		}
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

	private closeModelForm(): void {
		this.expandedModel = undefined;
		this.formError = undefined;
		this.render();
	}

	private closeProviderForm(): void {
		this.mode = 'detail';
		this.formError = undefined;
		this.providerDraft = undefined;
		this.render();
	}

	private async submitProvider(row: ICatalogRow, input: IProviderInput, save: HTMLButtonElement): Promise<void> {
		// Keep the typed values so an error re-render doesn't wipe the form.
		this.providerDraft = { key: row.key, baseURL: input.baseURL, apiKey: input.apiKey ?? '' };

		if (!input.baseURL) {
			this.formError = 'Base URL is required.';
			this.render();
			return;
		}
		if (input.id === undefined && !input.apiKey) {
			this.formError = 'API key is required.';
			this.render();
			return;
		}

		save.disabled = true;
		save.textContent = 'Testing connection…';

		// A known chat model gives the verification probe something real to call.
		const probeModel = row.provider?.models[0]?.model ?? row.preset?.models[0]?.model;

		try {
			// Reachability + one-token chat probe; nothing is persisted when it fails.
			await this.service.verifyProvider({
				type: input.type,
				baseURL: input.baseURL,
				...(input.apiKey ? { apiKey: input.apiKey } : {}),
				...(input.id ? { providerId: input.id } : {}),
				...(probeModel ? { probeModel } : {}),
			});
			await this.service.upsertProvider(input);
		} catch (error) {
			this.formError = error instanceof Error ? error.message : String(error);
			this.render();
			return;
		}

		this.mode = 'detail';
		this.formError = undefined;
		this.providerDraft = undefined;
		// The key or base URL may have changed — refetch candidates next time.
		this.modelCandidates = undefined;
		this.render();
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
