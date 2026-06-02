// The "Strata" mark — concentric rings (teal→blue→indigo) around a warm amber
// core. Recreated from doc/design/svg/static/ic_registry_full.svg.
// `live` animates the core pulse to signal the chain is producing blocks.
export function StrataMark({ size = 36, live = false }: { size?: number; live?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      role="img"
      aria-label="HARA Registry"
    >
      <defs>
        <linearGradient id="strata-shell" x1="20" y1="20" x2="180" y2="180" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2BD4C0" />
          <stop offset="0.5" stopColor="#3B6BFF" />
          <stop offset="1" stopColor="#5A45E0" />
        </linearGradient>
        <radialGradient id="strata-core" cx="97" cy="96" r="20" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFE6B8" />
          <stop offset="0.45" stopColor="#FFC56E" />
          <stop offset="1" stopColor="#F39B24" />
        </radialGradient>
      </defs>
      <g transform="rotate(0 100 100)">
        <path d="M42.84,67.00 A66,66 0 1 1 42.84,133.00" fill="none" stroke="url(#strata-shell)" strokeWidth="9" strokeLinecap="round" />
      </g>
      <g transform="rotate(140 100 100)">
        <path d="M58.43,76.00 A48,48 0 1 1 58.43,124.00" fill="none" stroke="url(#strata-shell)" strokeWidth="9" strokeLinecap="round" />
      </g>
      <g transform="rotate(40 100 100)">
        <path d="M73.15,84.50 A31,31 0 1 1 73.15,115.50" fill="none" stroke="url(#strata-shell)" strokeWidth="9" strokeLinecap="round" />
      </g>
      <circle cx="100" cy="100" r="13" fill="url(#strata-core)" className={live ? "animate-core" : undefined} />
      <circle cx="96" cy="96" r="3.8" fill="#ffffff" fillOpacity="0.55" />
    </svg>
  );
}
