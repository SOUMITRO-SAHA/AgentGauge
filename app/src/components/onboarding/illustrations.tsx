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

/** The dashboard as one clear panel with a gauge, flanked by tool chips. */
export function WelcomeArt(): ReactElement {
  return (
    <StepArt>
      <rect
        x="70"
        y="34"
        width="180"
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
      <rect x="140" y="158" width="40" height="6" rx="3" className="fill-border" />
      <rect
        x="18"
        y="70"
        width="54"
        height="54"
        rx="12"
        strokeWidth="2"
        className="fill-surface-raised/70 stroke-border"
      />
      <path
        d="M 34 88 L 44 97 L 34 106"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-brand-teal"
      />
      <path
        d="M 48 106 H 58"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="stroke-muted-foreground"
      />
      <rect
        x="248"
        y="76"
        width="54"
        height="54"
        rx="12"
        strokeWidth="2"
        className="fill-surface-raised/70 stroke-border"
      />
      <path
        d="M 258 103 H 266 L 271 93 L 278 113 L 283 103 H 292"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-brand-teal"
      />
      <path
        d="M 72 97 H 98"
        strokeWidth="2"
        strokeDasharray="3 5"
        strokeLinecap="round"
        className="stroke-border"
      />
      <path
        d="M 250 103 H 222"
        strokeWidth="2"
        strokeDasharray="3 5"
        strokeLinecap="round"
        className="stroke-border"
      />
    </StepArt>
  );
}

/** A status card: a check, a live badge, and the source line underneath. */
export function StatusArt(): ReactElement {
  return (
    <StepArt>
      <rect
        x="60"
        y="36"
        width="200"
        height="128"
        rx="16"
        strokeWidth="2"
        className="fill-surface-raised/70 stroke-border"
      />
      <circle cx="92" cy="70" r="12" strokeWidth="2" className="stroke-ok" />
      <path
        d="M 87 70 L 91 74 L 98 66"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-ok"
      />
      <rect x="112" y="61" width="76" height="8" rx="4" className="fill-muted-foreground/70" />
      <rect x="112" y="76" width="52" height="6" rx="3" className="fill-border" />
      <rect
        x="204"
        y="58"
        width="40"
        height="20"
        rx="10"
        strokeWidth="1.5"
        className="fill-brand-teal/15 stroke-brand-teal"
      />
      <circle cx="216" cy="68" r="3" className="fill-brand-teal" />
      <rect x="223" y="65.5" width="14" height="5" rx="2.5" className="fill-brand-teal" />
      <circle cx="92" cy="104" r="4" className="fill-border" />
      <rect x="104" y="101" width="110" height="6" rx="3" className="fill-border" />
      <circle cx="92" cy="124" r="4" className="fill-border" />
      <rect x="104" y="121" width="84" height="6" rx="3" className="fill-border" />
      <path
        d="M 76 142 H 244"
        strokeWidth="2"
        strokeLinecap="round"
        className="stroke-border"
      />
      <circle cx="92" cy="152" r="5" strokeWidth="2" className="stroke-brand-amber" />
      <circle cx="92" cy="152" r="1.5" className="fill-brand-amber" />
      <rect x="106" y="149" width="96" height="6" rx="3" className="fill-muted-foreground/70" />
    </StepArt>
  );
}

/** A spent window bar, the reset arrow over its end, and a fresh one below. */
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
      <circle cx="88" cy="66" r="12" strokeWidth="2" className="stroke-muted-foreground" />
      <path
        d="M 88 60 V 66 L 93 69"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-muted-foreground"
      />
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
      <path
        d="M 244 89 A 8 8 0 1 1 236 97"
        strokeWidth="2"
        strokeLinecap="round"
        className="stroke-brand-teal"
      />
      <path
        d="M 239.5 85 L 244 89 L 239.5 93"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-brand-teal"
      />
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

/** A desktop widget: mini gauge, the two windows it shows, and the add badge. */
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
      <rect x="128" y="126" width="64" height="6" rx="3" className="fill-surface-sunken" />
      <rect x="128" y="126" width="40" height="6" rx="3" className="fill-brand-teal" />
      <rect x="128" y="138" width="64" height="6" rx="3" className="fill-surface-sunken" />
      <rect x="128" y="138" width="24" height="6" rx="3" className="fill-brand-amber" />
      <circle cx="238" cy="138" r="14" className="fill-brand-teal" />
      <path
        d="M 238 131 V 145 M 231 138 H 245"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="stroke-background"
      />
    </StepArt>
  );
}

/** The monitor: a radar sweep and a pulse line, layered over a dim window. */
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
      <circle cx="108" cy="111" r="14" strokeWidth="2" className="stroke-brand-teal/50" />
      <circle cx="108" cy="111" r="4" className="fill-brand-teal" />
      <path
        d="M 108 111 L 126 93"
        strokeWidth="2"
        strokeLinecap="round"
        className="stroke-brand-teal"
      />
      <path
        d="M 152 111 H 170 L 178 95 L 190 127 L 198 111 H 246"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-brand-amber"
      />
      <circle cx="248" cy="72" r="5" className="fill-ok" />
      <rect x="152" y="69" width="60" height="6" rx="3" className="fill-border" />
    </StepArt>
  );
}
