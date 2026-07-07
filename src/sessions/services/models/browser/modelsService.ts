/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '../../../base/common/observable.js';
import type { IModelEntryInput, IModelRegistryView, IModelsBridge, IProviderInput } from '../common/models.js';

const EMPTY_REGISTRY: IModelRegistryView = { providers: [] };

export interface IModelsService {
	readonly registry: IObservable<IModelRegistryView>;
	initialize(): Promise<void>;
	upsertProvider(input: IProviderInput): Promise<void>;
	removeProvider(id: string): Promise<void>;
	upsertModel(providerId: string, input: IModelEntryInput): Promise<void>;
	removeModel(modelId: string): Promise<void>;
	setModelEnabled(modelId: string, enabled: boolean): Promise<void>;
	moveModel(modelId: string, direction: 'up' | 'down'): Promise<void>;
}

/**
 * Renderer-side view of the model registry. Every mutating bridge call returns
 * the fresh (redacted) registry, so the observable is simply set to the result.
 */
export class ModelsService implements IModelsService {
	private readonly registryValue = observableValue<IModelRegistryView>(EMPTY_REGISTRY);
	readonly registry: IObservable<IModelRegistryView> = this.registryValue;

	constructor(private readonly bridge: IModelsBridge | undefined) {}

	async initialize(): Promise<void> {
		if (!this.bridge) {
			return;
		}

		this.registryValue.set(await this.bridge.list());
	}

	async upsertProvider(input: IProviderInput): Promise<void> {
		if (!this.bridge) {
			return;
		}

		this.registryValue.set(await this.bridge.upsertProvider(input));
	}

	async removeProvider(id: string): Promise<void> {
		if (!this.bridge) {
			return;
		}

		this.registryValue.set(await this.bridge.removeProvider(id));
	}

	async upsertModel(providerId: string, input: IModelEntryInput): Promise<void> {
		if (!this.bridge) {
			return;
		}

		this.registryValue.set(await this.bridge.upsertModel(providerId, input));
	}

	async removeModel(modelId: string): Promise<void> {
		if (!this.bridge) {
			return;
		}

		this.registryValue.set(await this.bridge.removeModel(modelId));
	}

	async setModelEnabled(modelId: string, enabled: boolean): Promise<void> {
		if (!this.bridge) {
			return;
		}

		this.registryValue.set(await this.bridge.setModelEnabled(modelId, enabled));
	}

	async moveModel(modelId: string, direction: 'up' | 'down'): Promise<void> {
		if (!this.bridge) {
			return;
		}

		this.registryValue.set(await this.bridge.moveModel(modelId, direction));
	}
}
