/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '../../../base/common/observable.js';
import type { IModelConfigInput, IModelRegistryView, IModelsBridge } from '../common/models.js';

const EMPTY_REGISTRY: IModelRegistryView = { models: [] };

export interface IModelsService {
	readonly registry: IObservable<IModelRegistryView>;
	initialize(): Promise<void>;
	upsert(input: IModelConfigInput): Promise<void>;
	remove(id: string): Promise<void>;
	setDefault(id: string): Promise<void>;
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

	async upsert(input: IModelConfigInput): Promise<void> {
		if (!this.bridge) {
			return;
		}

		this.registryValue.set(await this.bridge.upsert(input));
	}

	async remove(id: string): Promise<void> {
		if (!this.bridge) {
			return;
		}

		this.registryValue.set(await this.bridge.remove(id));
	}

	async setDefault(id: string): Promise<void> {
		if (!this.bridge) {
			return;
		}

		this.registryValue.set(await this.bridge.setDefault(id));
	}
}
