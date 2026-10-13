// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
	site: 'https://agentgauge.soumitrasaha.com',
	output: 'static',
	trailingSlash: 'never',
	build: {
		inlineStylesheets: 'auto',
	},
	vite: {
		plugins: [tailwindcss()],
	},
});
