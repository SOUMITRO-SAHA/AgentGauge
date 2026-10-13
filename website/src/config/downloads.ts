export const DOWNLOADS_BASE_URL =
	'https://agentgauge.soumitrasaha.com/downloads';

export function downloadsAreAvailable(setting: string | undefined): boolean {
	return setting === 'true';
}
