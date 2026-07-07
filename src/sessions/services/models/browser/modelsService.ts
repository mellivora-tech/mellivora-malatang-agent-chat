/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '../../../base/common/observable.js';
import type {
	IModelEntryInput,
	IModelRegistryView,
	IModelsBridge,
	IProviderInput,
	IProviderVerificationRequest,
	IRemoteModel,
	IRemoteModelsRequest,
	ModelEffort,
} from '../common/models.js';
import { PROVIDER_PRESETS } from '../common/providerPresets.js';

const EMPTY_REGISTRY: IModelRegistryView = { providers: [] };
const SELECTED_MODEL_STORAGE_KEY = 'agentSessions.selectedModelId';

/** An enabled model flattened for the composer's picker and the agent run path. */
export interface IEnabledModel {
	/** The model entry id — what `agent.run` resolves. */
	readonly id: string;
	/** The wire model string, e.g. `glm-5.2`. */
	readonly model: string;
	readonly label: string;
	/** Context window in tokens, when the model entry declares one. */
	readonly contextLength?: number;
	/** The stored reasoning-effort pick; omitted = provider default. */
	readonly effort?: ModelEffort;
	/** Effort levels the model's API accepts (from its preset); omitted = no effort knob. */
	readonly efforts?: readonly ModelEffort[];
	readonly providerId: string;
	readonly providerName: string;
}

/** Enabled models across providers, in provider order then priority order. */
export function listEnabledModels(registry: IModelRegistryView): IEnabledModel[] {
	const models: IEnabledModel[] = [];
	for (const provider of registry.providers) {
		const preset = PROVIDER_PRESETS.find(candidate => candidate.id === provider.presetId);
		for (const model of provider.models) {
			if (model.enabled) {
				// Effort capability comes from the preset catalog, matched by
				// wire id — hand-added or unknown models get no effort knob.
				const efforts = preset?.models.find(candidate => candidate.model === model.model)?.efforts;
				models.push({
					id: model.id,
					model: model.model,
					label: model.label,
					...(model.contextLength ? { contextLength: model.contextLength } : {}),
					...(model.params?.effort ? { effort: model.params.effort } : {}),
					...(efforts && efforts.length > 0 ? { efforts } : {}),
					providerId: provider.id,
					providerName: provider.name,
				});
			}
		}
	}

	return models;
}

/** The explicit pick while it is still enabled, else the first enabled model. */
export function resolveSelectedModel(registry: IModelRegistryView, explicitId: string | undefined): IEnabledModel | undefined {
	const enabled = listEnabledModels(registry);
	return enabled.find(model => model.id === explicitId) ?? enabled[0];
}

export interface IModelsService {
	readonly registry: IObservable<IModelRegistryView>;
	/** The model the composer sends with — see {@link resolveSelectedModel}. */
	readonly selectedModel: IObservable<IEnabledModel | undefined>;
	initialize(): Promise<void>;
	setSelectedModel(modelId: string): void;
	upsertProvider(input: IProviderInput): Promise<void>;
	removeProvider(id: string): Promise<void>;
	upsertModel(providerId: string, input: IModelEntryInput): Promise<void>;
	removeModel(modelId: string): Promise<void>;
	setModelEnabled(modelId: string, enabled: boolean): Promise<void>;
	/** Set or clear (undefined = provider default) the model's reasoning effort. */
	setModelEffort(modelId: string, effort: ModelEffort | undefined): Promise<void>;
	moveModel(modelId: string, direction: 'up' | 'down'): Promise<void>;
	/** Probe the provider's list-models endpoint; rejects when unreachable or the key is bad. */
	listRemoteModels(request: IRemoteModelsRequest): Promise<readonly IRemoteModel[]>;
	/** Verify reachability + key with a one-token chat probe; rejects with a user-facing message. */
	verifyProvider(request: IProviderVerificationRequest): Promise<void>;
}

/**
 * Renderer-side view of the model registry. Every mutating bridge call returns
 * the fresh (redacted) registry, so the observable is simply set to the result.
 * The selected model rides along: an explicit pick is persisted and falls back
 * to the first enabled model whenever it disappears or gets disabled.
 */
export class ModelsService implements IModelsService {
	private readonly registryValue = observableValue<IModelRegistryView>(EMPTY_REGISTRY);
	readonly registry: IObservable<IModelRegistryView> = this.registryValue;

	private readonly selectedModelValue = observableValue<IEnabledModel | undefined>(undefined);
	readonly selectedModel: IObservable<IEnabledModel | undefined> = this.selectedModelValue;

	private explicitModelId = readStoredSelection();

	constructor(private readonly bridge: IModelsBridge | undefined) {}

	setSelectedModel(modelId: string): void {
		this.explicitModelId = modelId;
		storeSelection(modelId);
		this.recomputeSelection();
	}

	private updateRegistry(view: IModelRegistryView): void {
		this.registryValue.set(view);
		this.recomputeSelection();
	}

	private recomputeSelection(): void {
		const next = resolveSelectedModel(this.registryValue.get(), this.explicitModelId);
		const current = this.selectedModelValue.get();
		if (JSON.stringify(next) !== JSON.stringify(current)) {
			this.selectedModelValue.set(next);
		}
	}

	async initialize(): Promise<void> {
		if (!this.bridge) {
			return;
		}

		this.updateRegistry(await this.bridge.list());
	}

	async upsertProvider(input: IProviderInput): Promise<void> {
		if (!this.bridge) {
			return;
		}

		this.updateRegistry(await this.bridge.upsertProvider(input));
	}

	async removeProvider(id: string): Promise<void> {
		if (!this.bridge) {
			return;
		}

		this.updateRegistry(await this.bridge.removeProvider(id));
	}

	async upsertModel(providerId: string, input: IModelEntryInput): Promise<void> {
		if (!this.bridge) {
			return;
		}

		this.updateRegistry(await this.bridge.upsertModel(providerId, input));
	}

	async removeModel(modelId: string): Promise<void> {
		if (!this.bridge) {
			return;
		}

		this.updateRegistry(await this.bridge.removeModel(modelId));
	}

	async setModelEnabled(modelId: string, enabled: boolean): Promise<void> {
		if (!this.bridge) {
			return;
		}

		this.updateRegistry(await this.bridge.setModelEnabled(modelId, enabled));
	}

	async setModelEffort(modelId: string, effort: ModelEffort | undefined): Promise<void> {
		if (!this.bridge) {
			return;
		}

		this.updateRegistry(await this.bridge.setModelEffort(modelId, effort));
	}

	async moveModel(modelId: string, direction: 'up' | 'down'): Promise<void> {
		if (!this.bridge) {
			return;
		}

		this.updateRegistry(await this.bridge.moveModel(modelId, direction));
	}

	async listRemoteModels(request: IRemoteModelsRequest): Promise<readonly IRemoteModel[]> {
		if (!this.bridge) {
			return [];
		}

		return this.bridge.listRemoteModels(request);
	}

	async verifyProvider(request: IProviderVerificationRequest): Promise<void> {
		if (!this.bridge) {
			return;
		}

		await this.bridge.verifyProvider(request);
	}
}

function readStoredSelection(): string | undefined {
	try {
		return globalThis.localStorage?.getItem(SELECTED_MODEL_STORAGE_KEY) ?? undefined;
	} catch {
		return undefined;
	}
}

function storeSelection(modelId: string): void {
	try {
		globalThis.localStorage?.setItem(SELECTED_MODEL_STORAGE_KEY, modelId);
	} catch {
		// Selection just won't survive a relaunch.
	}
}
