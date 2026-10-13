import { downloadsAreAvailable, DOWNLOADS_BASE_URL } from './downloads';

export const site = {
	name: 'AgentGauge',
	title: 'AgentGauge — know your AI coding quota before it runs out',
	description:
		'A local-first macOS app that shows how much of your AI coding-plan quotas you have left, when each window resets, and what your local sessions actually cost — without ever asking for your API keys.',
	url: 'https://agentgauge.soumitrasaha.com',
	downloadsBaseUrl: DOWNLOADS_BASE_URL,
	installerUrl: 'https://agentgauge.soumitrasaha.com/install.sh',
	downloadsAvailable: downloadsAreAvailable(
		import.meta.env.PUBLIC_AGENTGAUGE_DOWNLOADS_ENABLED,
	),
	repository: 'https://github.com/SOUMITRO-SAHA/AgentGauge',
	license: 'Apache 2.0 based, with a non-commercial redistribution restriction',
} as const;
