import React from 'react';

// The three Studio icons: white shapes on a transparent background (no square behind them), drawn as inline SVG so they stay sharp at any size.
const W = '#fff';
const svg = (viewBox, size, children, label) => (
  <svg className="dash-ico" xmlns="http://www.w3.org/2000/svg" viewBox={viewBox} width={size} height={size} aria-hidden={label ? undefined : 'true'} role={label ? 'img' : undefined} aria-label={label}>
    {children}
  </svg>
);

export function IconDashboard({ size = 18, label }) {
  return svg('340 360 1250 1250', size, (
    <g fill={W}>
      <path d="M411 385H894A48 48 0 0 1 942 433V675A290 290 0 0 1 652 965H411A48 48 0 0 1 363 917V433A48 48 0 0 1 411 385Z" />
      <path d="M1036 385H1519A48 48 0 0 1 1567 433V917A48 48 0 0 1 1519 965H1278A290 290 0 0 1 988 675V433A48 48 0 0 1 1036 385Z" />
      <path d="M411 1008H652A290 290 0 0 1 942 1298V1540A48 48 0 0 1 894 1588H411A48 48 0 0 1 363 1540V1056A48 48 0 0 1 411 1008Z" />
      <path d="M1278 1008H1519A48 48 0 0 1 1567 1056V1540A48 48 0 0 1 1519 1588H1036A48 48 0 0 1 988 1540V1298A290 290 0 0 1 1278 1008Z" />
    </g>
  ), label);
}

export function IconAnalytics({ size = 18, label }) {
  return svg('600 170 730 710', size, (
    <g fill={W}>
      <rect x="628" y="587" width="97" height="260" rx="20" />
      <rect x="821" y="504" width="96" height="343" rx="20" />
      <rect x="1013" y="343" width="97" height="504" rx="20" />
      <rect x="1206" y="192" width="97" height="655" rx="20" />
      <rect x="628" y="762" width="675" height="97" rx="20" />
    </g>
  ), label);
}

export function IconContent({ size = 18, label }) {
  return svg('170 980 680 740', size, (
    <polygon points="228,1062 228,1646 776,1353" fill={W} stroke={W} strokeWidth="70" strokeLinejoin="round" />
  ), label);
}

export function IconUpload({ size = 18, label }) {
  return svg('1070 1070 690 690', size, (
    <g fill="none" stroke={W} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="1415" cy="1415" r="293" strokeWidth="62" />
      <polygon points="1415,1232 1334,1375 1496,1375" fill={W} strokeWidth="62" />
      <line x1="1414" y1="1380" x2="1414" y2="1588" strokeWidth="84" />
    </g>
  ), label);
}
