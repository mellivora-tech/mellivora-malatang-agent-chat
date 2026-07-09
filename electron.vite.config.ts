/**---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname);

export default defineConfig({
	main: {
		build: {
			outDir: resolve(root, 'dist/main'),
			sourcemap: true,
			rollupOptions: {
				input: resolve(root, 'src/main/main.ts'),
				output: {
					entryFileNames: 'main.js',
					format: 'es',
				},
			},
		},
	},
	preload: {
		build: {
			outDir: resolve(root, 'dist/preload'),
			sourcemap: true,
			rollupOptions: {
				input: resolve(root, 'src/preload/preload.ts'),
				output: {
					entryFileNames: 'preload.js',
					format: 'es',
				},
			},
		},
	},
	renderer: {
		root: resolve(root, 'src/sessions/electron-browser'),
		base: './',
		publicDir: resolve(root, 'public'),
		resolve: {
			extensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'],
		},
		build: {
			outDir: resolve(root, 'dist/sessions/electron-browser'),
			sourcemap: true,
			rollupOptions: {
				input: {
					sessions: resolve(root, 'src/sessions/electron-browser/sessions.html'),
				},
				output: {
					entryFileNames: 'assets/[name]-[hash].js',
					assetFileNames: 'assets/[name]-[hash][extname]',
				},
			},
		},
	},
});
