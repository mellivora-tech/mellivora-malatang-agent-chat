/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Model configuration contracts shared between the main process (where the
 * config — including the API key — is stored) and the renderer (which only ever
 * sees a redacted view). Configuration is provider-centric: a provider holds the
 * endpoint and key once and offers many models. Model ids are globally unique,
 * so the default selection and the agent runtime still address a single model by
 * its id. The raw API key never crosses back over IPC.
 */

export type ModelProvider = 'openai-compatible' | 'anthropic';

export interface IModelParams {
	readonly temperature?: number;
	readonly maxTokens?: number;
	/** Adaptive thinking / reasoning toggle where the provider supports it. */
	readonly thinking?: boolean;
}

/** A model offered by a provider. Upsert payload from the renderer. */
export interface IModelEntryInput {
	/** Present when editing an existing model; absent when adding. */
	readonly id?: string;
	/** The API model string, e.g. `glm-4.6`. */
	readonly model: string;
	/** Display name; defaults to {@link model}. */
	readonly label?: string;
	/** Context window in tokens, used for the list badge (e.g. 1000000 -> "1M"). */
	readonly contextLength?: number;
	readonly params?: IModelParams;
}

export interface IModelEntryView {
	readonly id: string;
	readonly model: string;
	readonly label: string;
	readonly contextLength?: number;
	readonly params?: IModelParams;
}

/** Provider upsert payload. `apiKey` is write-only; models are managed separately. */
export interface IProviderInput {
	/** Present when editing an existing provider; absent when creating. */
	readonly id?: string;
	readonly name: string;
	readonly type: ModelProvider;
	readonly baseURL: string;
	readonly enabled?: boolean;
	/** Set or rotate the key. Omit to keep the existing key (edit) or leave unset (create). */
	readonly apiKey?: string;
}

/** The redacted provider the renderer receives — no raw key, only whether one is set. */
export interface IProviderView {
	readonly id: string;
	readonly name: string;
	readonly type: ModelProvider;
	readonly baseURL: string;
	readonly enabled: boolean;
	readonly hasApiKey: boolean;
	readonly models: readonly IModelEntryView[];
}

export interface IModelRegistryView {
	readonly providers: readonly IProviderView[];
	readonly defaultModelId?: string;
}

/** The shape exposed on `agentWindow.models` by the preload script. */
export interface IModelsBridge {
	list(): Promise<IModelRegistryView>;
	upsertProvider(input: IProviderInput): Promise<IModelRegistryView>;
	removeProvider(id: string): Promise<IModelRegistryView>;
	upsertModel(providerId: string, input: IModelEntryInput): Promise<IModelRegistryView>;
	removeModel(modelId: string): Promise<IModelRegistryView>;
	setDefaultModel(modelId: string): Promise<IModelRegistryView>;
}
