/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const serviceIdentifiers = new Map<string, ServiceIdentifier<unknown>>();

export type ServiceIdentifier<T> = symbol & { readonly __service?: T };

export function createDecorator<T>(id: string): ServiceIdentifier<T> {
	let identifier = serviceIdentifiers.get(id);
	if (!identifier) {
		identifier = Symbol(id) as ServiceIdentifier<unknown>;
		serviceIdentifiers.set(id, identifier);
	}

	return identifier as ServiceIdentifier<T>;
}

export class ServiceCollection {
	private readonly services = new Map<ServiceIdentifier<unknown>, unknown>();

	set<T>(id: ServiceIdentifier<T>, instance: T): void {
		this.services.set(id, instance);
	}

	get<T>(id: ServiceIdentifier<T>): T {
		const value = this.services.get(id);
		if (value === undefined) {
			throw new Error(`Unknown service: ${String(id.description ?? id.toString())}`);
		}

		return value as T;
	}

	has<T>(id: ServiceIdentifier<T>): boolean {
		return this.services.has(id);
	}
}

export class InstantiationService {
	constructor(private readonly services: ServiceCollection) {}

	get<T>(id: ServiceIdentifier<T>): T {
		return this.services.get(id);
	}
}
