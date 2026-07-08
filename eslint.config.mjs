/**---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
	js.configs.recommended,
	...tseslint.configs.recommended,
	prettierConfig,
	{
		files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.mjs', 'electron.vite.config.ts', 'playwright.config.ts'],
		languageOptions: {
			parserOptions: {
				project: './tsconfig.json',
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
			'@typescript-eslint/consistent-type-imports': 'error',
		},
	},
	{
		ignores: ['dist/', 'node_modules/', 'test-results/', 'playwright-report/', 'public/', 'package-lock.json'],
	},
	{
		files: ['scripts/**/*.mjs'],
		languageOptions: {
			globals: {
				console: 'readonly',
				process: 'readonly',
			},
			parserOptions: {
				project: false,
			},
		},
	},
);
