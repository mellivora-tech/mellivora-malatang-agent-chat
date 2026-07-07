/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Model configuration contracts shared between the main process (where the
 * config — including the API key — is stored) and the renderer (which only ever
 * sees a redacted view).
 *
 * A provider is one API endpoint. The user only supplies a name, base URL and
 * key — the wire format (OpenAI-compatible vs Anthropic) is derived, never
 * chosen. There is no "default model": each model carries an `enabled` flag
 * (whether it is offered in the composer's model picker) and models are ordered,
 * so the first enabled one is used when nothing is selected.
 */

export type ModelProvider = 'openai-compatible' | 'anthropic';

/**
 * Reasoning-effort levels across providers. Which subset a model actually
 * accepts is declared per preset model (`efforts`) — e.g. GPT-5.5 takes
 * none→xhigh, Claude takes low→max, GLM-5.2/DeepSeek V4 only high/max.
 */
export type ModelEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const MODEL_EFFORTS: readonly ModelEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface IModelParams {
	readonly temperature?: number;
	readonly maxTokens?: number;
	/** Adaptive thinking / reasoning toggle where the provider supports it. */
	readonly thinking?: boolean;
	/** Reasoning effort; omitted = provider default (nothing is sent). */
	readonly effort?: ModelEffort;
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
	/** Whether the model is offered in the composer's model picker (default true). */
	readonly enabled?: boolean;
	readonly params?: IModelParams;
}

export interface IModelEntryView {
	readonly id: string;
	readonly model: string;
	readonly label: string;
	readonly contextLength?: number;
	readonly enabled: boolean;
	readonly params?: IModelParams;
}

/** Provider upsert payload. `apiKey` is write-only; `models` seeds the list on create. */
export interface IProviderInput {
	/** Present when editing an existing provider; absent when creating. */
	readonly id?: string;
	readonly name: string;
	/** Wire format — system-derived (from a preset or the base URL), not user-chosen. */
	readonly type: ModelProvider;
	readonly baseURL: string;
	/** The catalog preset this provider came from, if any (`undefined` for custom). */
	readonly presetId?: string;
	/** Set or rotate the key. Omit to keep the existing key (edit) or leave unset (create). */
	readonly apiKey?: string;
	/** Initial models, applied only when creating a provider (ignored on edit). */
	readonly models?: readonly IModelEntryInput[];
}

/** The redacted provider the renderer receives — no raw key, only whether one is set. */
export interface IProviderView {
	readonly id: string;
	readonly name: string;
	readonly type: ModelProvider;
	readonly baseURL: string;
	readonly presetId?: string;
	readonly hasApiKey: boolean;
	readonly models: readonly IModelEntryView[];
}

export interface IModelRegistryView {
	readonly providers: readonly IProviderView[];
}

/**
 * Ask the provider's list-models endpoint what it serves. Used to verify
 * connectivity/key before saving a provider and to suggest candidates when
 * adding a model. `providerId` fills any omitted field (including the stored
 * API key) from the saved provider.
 */
export interface IRemoteModelsRequest {
	readonly providerId?: string;
	readonly type?: ModelProvider;
	readonly baseURL?: string;
	/** Omit to use the stored key of {@link providerId}. */
	readonly apiKey?: string;
}

export interface IRemoteModel {
	readonly id: string;
	/** Only some providers report it (e.g. Anthropic's max_input_tokens). */
	readonly contextLength?: number;
}

/**
 * Verify a provider end to end before saving: reachability, then a one-token
 * chat probe as the authoritative key check (list-models is often served
 * unauthenticated). Resolves when the connection is usable; rejects with a
 * user-facing message otherwise.
 */
export interface IProviderVerificationRequest extends IRemoteModelsRequest {
	/** A known chat model to probe with; falls back to the endpoint's first listed model. */
	readonly probeModel?: string;
}

/** The shape exposed on `agentWindow.models` by the preload script. */
export interface IModelsBridge {
	list(): Promise<IModelRegistryView>;
	upsertProvider(input: IProviderInput): Promise<IModelRegistryView>;
	removeProvider(id: string): Promise<IModelRegistryView>;
	upsertModel(providerId: string, input: IModelEntryInput): Promise<IModelRegistryView>;
	removeModel(modelId: string): Promise<IModelRegistryView>;
	setModelEnabled(modelId: string, enabled: boolean): Promise<IModelRegistryView>;
	/** Set or clear (undefined = provider default) the model's reasoning effort. */
	setModelEffort(modelId: string, effort: ModelEffort | undefined): Promise<IModelRegistryView>;
	/** Reorder a model within its provider (order sets priority; first enabled is the default). */
	moveModel(modelId: string, direction: 'up' | 'down'): Promise<IModelRegistryView>;
	/** List the models the endpoint actually serves; rejects when unreachable or the key is bad. */
	listRemoteModels(request: IRemoteModelsRequest): Promise<readonly IRemoteModel[]>;
	/** See {@link IProviderVerificationRequest}. */
	verifyProvider(request: IProviderVerificationRequest): Promise<void>;
}
