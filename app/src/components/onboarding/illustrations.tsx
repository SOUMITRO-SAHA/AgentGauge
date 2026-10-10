/**
 * Static illustrations for the onboarding steps.
 *
 * One decorative SVG per step, drawn with theme tokens (`fill-*`/`stroke-*`
 * utilities over the semantic palette) so light and dark both render without
 * raw palette values. They depict the concept a step explains; they never
 * render live data, real panels, or provider state — the flow must look the
 * same whether Codex is installed, signed out, or unreachable.
 */

import type { ReactElement, ReactNode } from "react";
import {
  CalendarBlank,
  Clock,
  ClockCounterClockwise,
  Code,
  Eye,
  LockKey,
  Question,
  ShieldCheck,
  SquaresFour,
  TerminalWindow,
} from "@phosphor-icons/react";

/** Shared canvas: one viewBox keeps every step's art scaling identically. */
function StepArt({ children }: { readonly children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 320 200"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className="h-full w-full"
    >
      {children}
    </svg>
  );
}

export function WelcomeArt(): ReactElement {
  return (
    <StepArt>
      <rect
        x="80"
        y="34"
        width="160"
        height="132"
        rx="16"
        strokeWidth="2"
        className="fill-surface-raised/70 stroke-border"
      />
      <path
        d="M 110 130 A 50 50 0 0 1 210 130"
        strokeWidth="6"
        strokeLinecap="round"
        className="stroke-border"
      />
      <path
        d="M 110 130 A 50 50 0 0 1 124.6 94.6"
        strokeWidth="6"
        strokeLinecap="round"
        className="stroke-brand-teal"
      />
      <path
        d="M 160 130 L 138 104"
        strokeWidth="3"
        strokeLinecap="round"
        className="stroke-brand-amber"
      />
      <circle cx="160" cy="130" r="5" className="fill-brand-amber" />
      <rect x="130" y="146" width="60" height="6" rx="3" className="fill-muted-foreground/70" />
      <rect x="140" y="158" width="40" height="6" rx="3" className="fill-muted-foreground/40" />
      <rect
        x="8"
        y="70"
        width="54"
        height="54"
        rx="12"
        strokeWidth="2"
        className="fill-surface-raised/70 stroke-border"
      />
      <TerminalWindow x="20" y="82" size={30} weight="regular" className="text-brand-teal" data-art-icon="terminal" />
      <rect
        x="258"
        y="76"
        width="54"
        height="54"
        rx="12"
        strokeWidth="2"
        className="fill-surface-raised/70 stroke-border"
      />
      <Code x="270" y="88" size={30} weight="regular" className="text-brand-teal" data-art-icon="code" />
      <path
        d="M 62 97 H 80"
        strokeWidth="2"
        strokeDasharray="1 4"
        strokeLinecap="round"
        className="stroke-border"
      />
      <path
        d="M 240 103 H 258"
        strokeWidth="2"
        strokeDasharray="1 4"
        strokeLinecap="round"
        className="stroke-border"
      />
    </StepArt>
  );
}

export function StatusArt(): ReactElement {
  return (
    <StepArt>
      <rect
        x="52"
        y="28"
        width="216"
        height="144"
        rx="16"
        strokeWidth="2"
        className="fill-surface-raised/70 stroke-border"
      />
      <ShieldCheck x="74" y="48" size={44} className="text-brand-teal" data-art-icon="verified" />
      <rect x="132" y="54" width="100" height="8" rx="4" className="fill-muted-foreground/70" />
      <rect x="132" y="72" width="68" height="6" rx="3" className="fill-muted-foreground/40" />
      <path d="M 72 100 H 248" strokeWidth="2" className="stroke-border" />
      <ClockCounterClockwise x="78" y="117" size={28} className="text-brand-amber" data-art-icon="freshness" />
      <rect x="116" y="120" width="88" height="7" rx="3.5" className="fill-muted-foreground/70" />
      <rect x="116" y="136" width="64" height="6" rx="3" className="fill-muted-foreground/40" />
      <Question x="218" y="118" size={26} className="text-muted-foreground" />
    </StepArt>
  );
}

export function RolloverArt(): ReactElement {
  return (
    <StepArt>
      <rect
        x="50"
        y="40"
        width="220"
        height="120"
        rx="16"
        strokeWidth="2"
        className="fill-surface-raised/70 stroke-border"
      />
      <Clock x="76" y="54" size={24} className="text-muted-foreground" />
      <rect x="110" y="62" width="90" height="8" rx="4" className="fill-muted-foreground/70" />
      <rect x="74" y="92" width="148" height="10" rx="5" className="fill-surface-sunken" />
      <rect x="74" y="92" width="112" height="10" rx="5" className="fill-brand-amber" />
      <circle
        cx="244"
        cy="97"
        r="15"
        strokeWidth="2"
        className="fill-surface stroke-brand-teal"
      />
      <Eye x="233" y="86" size={22} className="text-brand-teal" data-art-icon="observed" />
      <path
        d="M 74 116 H 222"
        strokeWidth="2"
        strokeDasharray="3 5"
        strokeLinecap="round"
        className="stroke-border"
      />
      <rect x="74" y="128" width="148" height="10" rx="5" className="fill-surface-sunken" />
      <rect x="74" y="128" width="30" height="10" rx="5" className="fill-brand-teal" />
    </StepArt>
  );
}

export function WidgetArt(): ReactElement {
  return (
    <StepArt>
      <rect x="24" y="30" width="272" height="140" rx="18" className="fill-surface-sunken/50" />
      <rect
        x="104"
        y="52"
        width="112"
        height="96"
        rx="16"
        strokeWidth="2"
        className="fill-surface-raised/80 stroke-border"
      />
      <path
        d="M 128 116 A 32 32 0 0 1 192 116"
        strokeWidth="6"
        strokeLinecap="round"
        className="stroke-border"
      />
      <path
        d="M 128 116 A 32 32 0 0 1 137.4 93.4"
        strokeWidth="6"
        strokeLinecap="round"
        className="stroke-brand-teal"
      />
      <Clock x="114" y="122" size={14} className="text-brand-teal" />
      <rect x="136" y="126" width="64" height="6" rx="3" className="fill-surface-sunken" />
      <rect x="136" y="126" width="40" height="6" rx="3" className="fill-brand-teal" />
      <CalendarBlank x="114" y="134" size={14} className="text-brand-amber" />
      <rect x="136" y="138" width="64" height="6" rx="3" className="fill-surface-sunken" />
      <rect x="136" y="138" width="24" height="6" rx="3" className="fill-brand-amber" />
      <circle cx="238" cy="138" r="14" className="fill-brand-teal" />
      <SquaresFour x="228" y="128" size={20} className="text-background" data-art-icon="widget" />
    </StepArt>
  );
}

export function AutomationArt(): ReactElement {
  return (
    <StepArt>
      <rect
        x="70"
        y="34"
        width="220"
        height="110"
        rx="16"
        strokeWidth="2"
        strokeDasharray="4 6"
        className="stroke-border"
      />
      <rect
        x="52"
        y="56"
        width="220"
        height="110"
        rx="16"
        strokeWidth="2"
        className="fill-surface-raised/70 stroke-border"
      />
      <circle cx="108" cy="111" r="26" strokeWidth="2" className="stroke-border" />
      <Eye x="89" y="92" size={38} className="text-brand-teal" data-art-icon="watch" />
      <path
        d="M 152 111 H 170 L 178 95 L 190 127 L 198 111 H 246"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-brand-amber"
      />
      <circle cx="238" cy="72" r="16" className="fill-surface stroke-border" strokeWidth="2" />
      <LockKey x="228" y="62" size={20} className="text-brand-amber" data-art-icon="no-send" />
      <rect x="152" y="69" width="60" height="6" rx="3" className="fill-muted-foreground/40" />
    </StepArt>
  );
}
