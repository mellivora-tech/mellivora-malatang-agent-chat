/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, clearNode } from '../../base/browser/dom.js';
import { Disposable } from '../../base/common/lifecycle.js';
import type { IEnvironmentsService } from '../../services/environments/browser/environmentsService.js';
import {
	isReadOnlyForced,
	type DatabaseDriver,
	type EnvironmentRole,
	type IDataSource,
	type IDataSourceView,
	type IEnvironment,
	type IWorkspaceConfigView,
} from '../../services/environments/common/environments.js';
import { settingsButton, settingsSection } from './settingsControls.js';

type EditState =
	| { readonly kind: 'none' }
	| { readonly kind: 'env'; readonly env?: IEnvironment }
	| { readonly kind: 'ds'; readonly environmentId: string; readonly ds?: IDataSource }
	| { readonly kind: 'cred'; readonly ds: IDataSourceView };

/**
 * Per-project environments & data-sources editor. dev/prod live here (the data
 * layer only); code and knowledge are elsewhere. Prod (role 'target') forces
 * read-only in the UI. Credentials are set through a separate form and never
 * read back — the row only shows whether one is on file.
 */
export class EnvironmentsConfigView extends Disposable {
	readonly element: HTMLElement;
	private config: IWorkspaceConfigView = { environments: [], dataSources: [] };
	private edit: EditState = { kind: 'none' };
	private error: string | undefined;

	constructor(
		private readonly projectId: string,
		private readonly service: IEnvironmentsService,
	) {
		super();
		this.element = document.createElement('div');
		this.element.className = 'sessions-settings-page sessions-env-config';
		this.renderLoading();
		void this.reload();
	}

	private renderLoading(): void {
		clearNode(this.element);
		const loading = append(this.element, document.createElement('div'));
		loading.className = 'sessions-env-empty';
		loading.textContent = 'Loading…';
	}

	private async reload(): Promise<void> {
		this.config = await this.service.get(this.projectId);
		this.render();
	}

	/** Run a mutation, adopt its returned view, drop edit state; surface errors inline. */
	private async mutate(op: () => Promise<IWorkspaceConfigView>): Promise<void> {
		try {
			this.config = await op();
			this.edit = { kind: 'none' };
			this.error = undefined;
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		}
		this.render();
	}

	private render(): void {
		clearNode(this.element);

		const title = append(this.element, document.createElement('h2'));
		title.className = 'sessions-settings-page-title';
		title.textContent = 'Environments & data sources';

		const intro = append(this.element, document.createElement('p'));
		intro.className = 'sessions-settings-page-intro';
		intro.textContent = 'dev/prod live on the data layer only. Add environments, then the databases each one exposes (read-only account). The agent diffs the same data source across environments to locate config drift.';

		if (this.error) {
			const error = append(this.element, document.createElement('div'));
			error.className = 'sessions-skills-error';
			error.setAttribute('role', 'alert');
			error.textContent = this.error;
		}

		if (this.config.environments.length === 0 && this.edit.kind !== 'env') {
			const empty = append(settingsSection(this.element), document.createElement('div'));
			empty.className = 'sessions-env-empty';
			empty.textContent = 'No environments yet.';
		}

		for (const environment of this.config.environments) {
			this.renderEnvironment(environment);
		}

		if (this.edit.kind === 'env') {
			this.renderEnvironmentEditor(this.edit.env);
		} else {
			const actions = append(this.element, document.createElement('div'));
			actions.className = 'sessions-skills-actions';
			settingsButton(actions, 'Add environment', () => {
				this.edit = { kind: 'env' };
				this.render();
			});
		}
	}

	private renderEnvironment(environment: IEnvironment): void {
		const card = settingsSection(this.element, undefined);

		const head = append(card, document.createElement('div'));
		head.className = 'sessions-env-head';
		const name = append(head, document.createElement('span'));
		name.className = 'sessions-env-name';
		name.textContent = environment.name;
		const role = append(head, document.createElement('span'));
		role.className = `sessions-env-role role-${environment.role}`;
		role.textContent = roleLabel(environment.role);
		const controls = append(head, document.createElement('div'));
		controls.className = 'sessions-env-head-actions';
		settingsButton(controls, 'Edit', () => {
			this.edit = { kind: 'env', env: environment };
			this.render();
		});
		settingsButton(controls, 'Delete', () => void this.mutate(() => this.service.removeEnvironment(this.projectId, environment.id)));

		for (const dataSource of this.config.dataSources.filter(ds => ds.environmentId === environment.id)) {
			this.renderDataSource(card, environment, dataSource);
		}

		if (this.edit.kind === 'ds' && this.edit.environmentId === environment.id && !this.edit.ds) {
			this.renderDataSourceEditor(environment, undefined);
		} else {
			const add = append(card, document.createElement('div'));
			add.className = 'sessions-skills-actions';
			settingsButton(add, 'Add data source', () => {
				this.edit = { kind: 'ds', environmentId: environment.id };
				this.render();
			});
		}
	}

	private renderDataSource(card: HTMLElement, environment: IEnvironment, dataSource: IDataSourceView): void {
		if (this.edit.kind === 'ds' && this.edit.ds?.id === dataSource.id) {
			this.renderDataSourceEditor(environment, dataSource);
			return;
		}
		if (this.edit.kind === 'cred' && this.edit.ds.id === dataSource.id) {
			this.renderCredentialEditor(dataSource);
			return;
		}

		const row = append(card, document.createElement('div'));
		row.className = 'sessions-env-ds-row';
		const main = append(row, document.createElement('div'));
		main.className = 'sessions-env-ds-main';
		const label = append(main, document.createElement('span'));
		label.className = 'sessions-env-ds-label';
		label.textContent = dataSource.label;
		const coords = append(main, document.createElement('span'));
		coords.className = 'sessions-env-ds-coords';
		coords.textContent = `${dataSource.coordinates.driver} · ${dataSource.coordinates.host}:${dataSource.coordinates.port}/${dataSource.coordinates.database}`;

		const badges = append(row, document.createElement('div'));
		badges.className = 'sessions-env-ds-badges';
		const access = append(badges, document.createElement('span'));
		const forced = isReadOnlyForced(environment.role);
		access.className = `sessions-env-badge ${forced || dataSource.access === 'read-only' ? 'read-only' : 'read-write'}`;
		access.textContent = forced || dataSource.access === 'read-only' ? 'read-only' : 'read-write';
		const cred = append(badges, document.createElement('span'));
		cred.className = `sessions-env-badge ${dataSource.hasCredential ? 'cred-set' : 'cred-missing'}`;
		cred.textContent = dataSource.hasCredential ? 'credential set' : 'no credential';

		const controls = append(row, document.createElement('div'));
		controls.className = 'sessions-env-ds-actions';
		settingsButton(controls, 'Credential', () => {
			this.edit = { kind: 'cred', ds: dataSource };
			this.render();
		});
		settingsButton(controls, 'Edit', () => {
			this.edit = { kind: 'ds', environmentId: environment.id, ds: dataSource };
			this.render();
		});
		settingsButton(controls, 'Delete', () => void this.mutate(() => this.service.removeDataSource(this.projectId, dataSource.id)));
	}

	private renderEnvironmentEditor(environment: IEnvironment | undefined): void {
		const editor = append(this.element, document.createElement('div'));
		editor.className = 'sessions-skills-editor';

		const nameInput = labeledInput(editor, 'Name (e.g. dev / prod)', environment?.name ?? '');
		const roleSelect = labeledSelect(
			editor,
			'Role',
			[
				{ value: 'baseline', label: 'baseline (known-good, e.g. dev)' },
				{ value: 'target', label: 'target (under investigation, e.g. prod — forced read-only)' },
				{ value: 'other', label: 'other' },
			],
			environment?.role ?? 'baseline',
		);

		const actions = append(editor, document.createElement('div'));
		actions.className = 'sessions-skills-actions';
		settingsButton(actions, 'Save', () =>
			void this.mutate(() =>
				this.service.upsertEnvironment(this.projectId, {
					...(environment ? { id: environment.id } : {}),
					name: nameInput.value,
					role: roleSelect.value as EnvironmentRole,
				}),
			),
		);
		settingsButton(actions, 'Cancel', () => {
			this.edit = { kind: 'none' };
			this.render();
		});
		nameInput.focus();
	}

	private renderDataSourceEditor(environment: IEnvironment, dataSource: IDataSource | undefined): void {
		const editor = append(this.element, document.createElement('div'));
		editor.className = 'sessions-skills-editor';

		const labelInput = labeledInput(editor, 'Label (logical name — paired across environments for diff, e.g. 订单库)', dataSource?.label ?? '');
		const driverSelect = labeledSelect(
			editor,
			'Driver',
			[
				{ value: 'mysql', label: 'MySQL' },
				{ value: 'postgres', label: 'PostgreSQL' },
			],
			dataSource?.coordinates.driver ?? 'mysql',
		);
		const hostInput = labeledInput(editor, 'Host', dataSource?.coordinates.host ?? '');
		const portInput = labeledInput(editor, 'Port', dataSource ? String(dataSource.coordinates.port) : '');
		portInput.type = 'number';
		const dbInput = labeledInput(editor, 'Database', dataSource?.coordinates.database ?? '');

		const forced = isReadOnlyForced(environment.role);
		const accessSelect = labeledSelect(
			editor,
			forced ? 'Access (forced read-only for a target/prod environment)' : 'Access',
			[
				{ value: 'read-only', label: 'read-only' },
				{ value: 'read-write', label: 'read-write' },
			],
			forced ? 'read-only' : (dataSource?.access ?? 'read-only'),
		);
		accessSelect.disabled = forced;

		const actions = append(editor, document.createElement('div'));
		actions.className = 'sessions-skills-actions';
		settingsButton(actions, 'Save', () => {
			const driver = driverSelect.value as DatabaseDriver;
			const port = Number.parseInt(portInput.value, 10);
			void this.mutate(() =>
				this.service.upsertDataSource(this.projectId, {
					...(dataSource ? { id: dataSource.id } : {}),
					environmentId: environment.id,
					label: labelInput.value,
					access: forced ? 'read-only' : accessSelect.value === 'read-write' ? 'read-write' : 'read-only',
					coordinates: {
						driver,
						host: hostInput.value.trim(),
						port: Number.isFinite(port) && port > 0 ? port : driver === 'mysql' ? 3306 : 5432,
						database: dbInput.value.trim(),
					},
				}),
			);
		});
		settingsButton(actions, 'Cancel', () => {
			this.edit = { kind: 'none' };
			this.render();
		});
		labelInput.focus();
	}

	private renderCredentialEditor(dataSource: IDataSourceView): void {
		const editor = append(this.element, document.createElement('div'));
		editor.className = 'sessions-skills-editor';

		const heading = append(editor, document.createElement('div'));
		heading.className = 'sessions-env-cred-heading';
		heading.textContent = `Credential for ${dataSource.label} — stored securely, never shown again.`;

		const userInput = labeledInput(editor, 'Username (use a READ-ONLY account)', '');
		const passInput = labeledInput(editor, dataSource.hasCredential ? 'Password (leave blank to keep current)' : 'Password', '');
		passInput.type = 'password';

		const actions = append(editor, document.createElement('div'));
		actions.className = 'sessions-skills-actions';
		settingsButton(actions, 'Save', () =>
			void this.mutate(() => this.service.setDataSourceCredential(this.projectId, dataSource.id, { username: userInput.value.trim(), password: passInput.value })),
		);
		if (dataSource.hasCredential) {
			settingsButton(actions, 'Clear', () => void this.mutate(() => this.service.setDataSourceCredential(this.projectId, dataSource.id, {})));
		}
		settingsButton(actions, 'Cancel', () => {
			this.edit = { kind: 'none' };
			this.render();
		});
		userInput.focus();
	}
}

function labeledInput(parent: HTMLElement, label: string, value: string): HTMLInputElement {
	const wrap = append(parent, document.createElement('label'));
	wrap.className = 'sessions-env-field';
	const text = append(wrap, document.createElement('span'));
	text.className = 'sessions-env-field-label';
	text.textContent = label;
	const input = append(wrap, document.createElement('input')) as HTMLInputElement;
	input.className = 'sessions-skills-input';
	input.value = value;
	return input;
}

function labeledSelect(parent: HTMLElement, label: string, options: readonly { value: string; label: string }[], value: string): HTMLSelectElement {
	const wrap = append(parent, document.createElement('label'));
	wrap.className = 'sessions-env-field';
	const text = append(wrap, document.createElement('span'));
	text.className = 'sessions-env-field-label';
	text.textContent = label;
	const select = append(wrap, document.createElement('select')) as HTMLSelectElement;
	select.className = 'sessions-skills-input';
	for (const option of options) {
		const element = append(select, document.createElement('option')) as HTMLOptionElement;
		element.value = option.value;
		element.textContent = option.label;
	}
	select.value = value;
	return select;
}

function roleLabel(role: EnvironmentRole): string {
	return role === 'baseline' ? 'baseline' : role === 'target' ? 'target' : 'other';
}
