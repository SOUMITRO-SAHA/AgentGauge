import type { IconName } from './icons';

export interface Feature {
	icon: IconName;
	title: string;
	body: string;
}

export type CapabilityState = 'supported' | 'partial' | 'planned';

export interface Capability {
	label: string;
	detail: string;
}

export interface HarnessRow {
	name: string;
	role: string;
	state: CapabilityState;
	stateLabel: string;
	source: string;
	capabilities: CapabilityState[];
	capabilityLabels: string[];
}

export interface ReadingState {
	icon: IconName;
	state: string;
	meaning: string;
}

export interface Faq {
	question: string;
	answer: string;
}

/**
 * Capability order follows PRD §3.2. A harness may support monitoring without
 * kickoff, or kickoff-capable prompting without reset visibility — the matrix
 * exists so that conflation is visible rather than implied by a single flag.
 */
export const capabilityColumns = [
	'Discovery',
	'Connection',
	'Usage windows',
	'Rollover signal',
	'Model discovery',
	'Model enforcement',
	'Prompt execution',
	'Local analytics',
];

export const harnesses: HarnessRow[] = [
	{
		name: 'Codex',
		role: 'First integration',
		state: 'supported',
		stateLabel: 'Shipped',
		source: 'codex app-server',
		capabilities: ['supported', 'supported', 'supported', 'partial', 'supported', 'supported', 'supported', 'supported'],
		capabilityLabels: [
			'Locates the local install',
			'Initialises and queries it',
			'Five-hour and weekly windows with reported resets',
			'Watches the reported reset change; does not confirm the rollover',
			'Lists the models the harness exposes',
			'Applies your choice to the kickoff session',
			'Sends one opted-in Hi',
			'Reads your local rollout logs',
		],
	},
	{
		name: 'OpenCode',
		role: 'Second integration',
		state: 'partial',
		stateLabel: 'Partial',
		source: 'OpenCode CLI and connected coding-plan endpoints',
		capabilities: ['supported', 'supported', 'partial', 'partial', 'supported', 'supported', 'supported', 'supported'],
		capabilityLabels: [
			'Locates the local install',
			'Initialises and queries it',
			'Reads connected plans, not an OpenCode-owned entitlement',
			'Watches the reported reset change; does not confirm the rollover',
			'Lists the models the harness exposes',
			'Applies your choice to the kickoff session',
			'Sends one opted-in Hi',
			'Reads your local session database',
		],
	},
	{
		name: 'Pi',
		role: 'Third integration',
		state: 'planned',
		stateLabel: 'Planned',
		source: 'Local RPC, to be validated',
		capabilities: ['planned', 'planned', 'planned', 'planned', 'planned', 'planned', 'planned', 'planned'],
		capabilityLabels: [
			'Under investigation',
			'Under investigation',
			'Unknown until the interface is read',
			'Under investigation',
			'Under investigation',
			'Under investigation',
			'Under investigation',
			'Under investigation',
		],
	},
	{
		name: 'Claude Code · Kilo Code · Kimi Code',
		role: 'Fourth wave',
		state: 'planned',
		stateLabel: 'Planned',
		source: 'Evaluated individually after Pi',
		capabilities: ['planned', 'planned', 'planned', 'planned', 'planned', 'planned', 'planned', 'planned'],
		capabilityLabels: [
			'Not started',
			'Not started',
			'Not started',
			'Not started',
			'Not started',
			'Not started',
			'Not started',
			'Not started',
		],
	},
];

export const platforms = [
	{
		name: 'macOS',
		status: 'available',
		statusLabel: 'Available',
		note: 'The only platform we have built and exercised. The widget and background scheduling are macOS-only.',
	},
	{
		name: 'Windows',
		status: 'planned',
		statusLabel: 'Coming soon',
		note: 'Nothing is shipped here yet. Background scheduling needs its own implementation and evidence.',
	},
	{
		name: 'Linux',
		status: 'planned',
		statusLabel: 'Coming soon',
		note: 'Nothing is shipped here yet, and support will be proven per distribution rather than assumed.',
	},
];

export const pillars = [
	{
		icon: 'eye' as IconName,
		title: 'Subscription observability',
		body: 'See which harnesses are installed and connected, which usage windows they genuinely expose, how much of each is used, and when the reported reset lands — with the source and the read time attached to every number.',
	},
	{
		icon: 'clock-countdown' as IconName,
		title: 'Opt-in kickoff automation',
		body: 'If you turn it on, AgentGauge sends one small Hi through a harness and model that you picked, shortly after the reset the provider reported. It is off by default, pausable at any time, and it spends your quota.',
	},
];

export const steps = [
	{
		icon: 'plug' as IconName,
		title: 'Point it at the harnesses you already run',
		body: 'AgentGauge finds Codex and OpenCode on your machine and asks them, through their own supported local interfaces, what they can tell it. It never asks you for an API key and never signs in for you.',
	},
	{
		icon: 'gauge' as IconName,
		title: 'Read the window as the provider reports it',
		body: 'Each plan shows the window it actually exposes, how much is used, and the reset timestamp that came with the reading — not a countdown the app guessed.',
	},
	{
		icon: 'clock-countdown' as IconName,
		title: 'Decide whether to automate, and when',
		body: 'Off by default. If you opt in per connection, a single Hi follows the reported reset through your chosen model — and a rollover that was never confirmed is skipped, not guessed at.',
	},
];

export const features: Feature[] = [
	{
		icon: 'gauge',
		title: 'Windows the provider actually reports',
		body: 'Five-hour and weekly windows with their real reset timestamps. A harness that exposes no window is shown as unsupported, never as an invented percentage.',
	},
	{
		icon: 'chart-line-up',
		title: 'Analytics with their provenance attached',
		body: 'Where a provider publishes token history, it is used. Where it does not, your local session records fill the gap and say so. Estimated costs are labelled as estimates, with the price list and coverage shown.',
	},
	{
		icon: 'pulse',
		title: 'Five honest states, never a silent zero',
		body: 'Live, cached, stale, unavailable, and unsupported each mean something different and each render as themselves. A missing reading is never translated into zero.',
	},
	{
		icon: 'terminal-window',
		title: 'A desktop widget you place yourself',
		body: 'A native WidgetKit extension puts the selected provider’s quotas on your desktop. You add it from the system gallery — macOS decides where it goes, and the app never claims otherwise.',
	},
	{
		icon: 'hard-drives',
		title: 'See what your toolchain is doing',
		body: 'A read-only Processes screen lists what Codex and OpenCode are running, what ports they are listening on, and how much disk their local data takes. It has no stop, delete, or kill control at all.',
	},
	{
		icon: 'shield-check',
		title: 'Credentials stay in your harness',
		body: 'AgentGauge never asks for an API key, password, or token, and never copies your harness credential files. Everything it knows, it learned from a local interface.',
	},
];

export const principles = [
	{
		icon: 'terminal-window' as IconName,
		title: 'Harness first',
		body: 'We talk to the coding tool you already installed and authenticated — never straight to a model provider’s API.',
	},
	{
		icon: 'info' as IconName,
		title: 'Source before UI',
		body: 'If the source did not say it, the screen does not show it. A missing value is never quietly turned into zero.',
	},
	{
		icon: 'check-circle' as IconName,
		title: 'Action requires proof',
		body: 'An automated send needs both a reset the provider reported and a model we can actually enforce on that session.',
	},
	{
		icon: 'users-three' as IconName,
		title: 'You choose the model',
		body: 'Model, connection, and on/off are explicit settings. Nothing is substituted silently, and nothing is sent without your opt-in.',
	},
	{
		icon: 'lock-simple' as IconName,
		title: 'Local by default',
		body: 'Settings, snapshots, and analytics stay on your device. There is no AgentGauge account and no hosted backend.',
	},
	{
		icon: 'key' as IconName,
		title: 'No conflation',
		body: 'Session activity, subscription limits, and estimated money are three different datasets. We never add them into one tidy total.',
	},
];

export const readings: ReadingState[] = [
	{
		icon: 'check-circle',
		state: 'Live',
		meaning: 'Read from the source moments ago.',
	},
	{
		icon: 'arrow-clockwise',
		state: 'Cached',
		meaning: 'A previous reading, shown with its age.',
	},
	{
		icon: 'clock-countdown',
		state: 'Stale',
		meaning: 'Too old to trust as current.',
	},
	{
		icon: 'info',
		state: 'Unavailable',
		meaning: 'Could not be read, and the reason is shown.',
	},
	{
		icon: 'code',
		state: 'Unsupported',
		meaning: 'This harness does not expose it at all.',
	},
];

export const faqs: Faq[] = [
	{
		question: 'Do I have to give AgentGauge my API keys?',
		answer: 'No, and you never will. It reads through the harnesses you have already signed in to, and it never opens, copies, or stores your credential files. If a harness is not signed in, the app tells you to sign in there.',
	},
	{
		question: 'Does it only work with OpenAI and Z.AI?',
		answer: 'Today it reads Codex, and the coding plans OpenCode has connected. Pi is next, then Claude Code, Kilo Code, and Kimi Code, each evaluated on its own. A harness appears here only once we have actually read it.',
	},
	{
		question: 'Will this restart my usage window?',
		answer: 'No. Nothing can. The provider owns its window and its timing, and a prompt only ever spends quota in whichever window is already active. AgentGauge reads the reset the provider reports; it never manufactures one.',
	},
	{
		question: 'What exactly does the automation send?',
		answer: 'A single Hi, through the harness and model you selected, shortly after the reset that was reported. It is off by default, can be paused immediately, and is skipped rather than sent when a rollover was not confirmed.',
	},
	{
		question: 'Is my code sent anywhere?',
		answer: 'No. AgentGauge reads session history locally and does not upload usage data. It fetches static update metadata and Tauri-updater-signed update archives, but never sends your sessions or provider credentials.',
	},
	{
		question: 'Can I use it on Windows or Linux?',
		answer: 'Not yet. macOS is the only platform we have built and exercised, so we would rather say that plainly than imply coverage we have not proven. Both are on the roadmap.',
	},
	{
		question: 'How can I install AgentGauge?',
		answer: 'macOS is the only supported platform today. When a release is available, this page lists the direct DMG, Homebrew Cask, and macOS installer script. Initial releases are ad-hoc signed and not notarized, so macOS may require you to approve the first launch.',
	},
];
