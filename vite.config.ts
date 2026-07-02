import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [react() as unknown as never],
	base: './',
	server: {
		host: '127.0.0.1',
		port: 5173,
		strictPort: true
	},
	build: {
		outDir: 'dist-renderer',
		emptyOutDir: true
	},
	test: {
		include: ['src/**/*.{test,spec}.{ts,tsx}'],
		environment: 'jsdom',
		globals: true,
		setupFiles: './src/test/setup.ts',
		exclude: ['e2e/**']
	}
});
