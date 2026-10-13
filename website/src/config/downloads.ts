export const DOWNLOADS_BASE_URL =
	'https://github.com/SOUMITRO-SAHA/AgentGauge/releases/latest/download';

export function downloadsAreAvailable(setting: string | undefined): boolean {
	return setting === 'true';
}
