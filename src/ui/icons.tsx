// Small SVG glyphs reproducing the illustrative icons used in the reference UI.
import type { SkuIcon, Carrier } from '../data/types';

export function LogoCube({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path d="M16 2.5 28.5 9.3v13.4L16 29.5 3.5 22.7V9.3z" fill="#2f5bea" />
      <path d="M16 2.5 28.5 9.3 16 16.1 3.5 9.3z" fill="#7ea2ff" />
      <path d="M16 16.1v13.4L3.5 22.7V9.3z" fill="#2449c9" />
    </svg>
  );
}

export function Avatar() {
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden>
      <circle cx="18" cy="18" r="18" fill="#dfe6f5" />
      <path d="M8 33c1.5-6 5.5-9 10-9s8.5 3 10 9" fill="#34405a" />
      <circle cx="18" cy="15" r="6.2" fill="#c98f6a" />
      <path d="M11.6 14.2c0-4.6 2.8-7 6.6-7s6.4 2.3 6.3 6.6c-1.6-1.8-4.3-2.4-7-2.2-2.3.1-4.4 1.1-5.9 2.6z" fill="#2a2420" />
      <path d="M14.5 26l3.5 4 3.5-4" fill="#ffffff" />
    </svg>
  );
}

export function SkuGlyph({ icon, size = 22 }: { icon: SkuIcon; size?: number }) {
  const s = size;
  switch (icon) {
    case 'container':
    case 'gloves':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <path d="M12 3 21 7.5v9L12 21 3 16.5v-9z" fill="#2f5bea" />
          <path d="M12 3 21 7.5 12 12 3 7.5z" fill="#6f95ff" />
          <path d="M12 12v9l-9-4.5v-9z" fill="#2449c9" />
        </svg>
      );
    case 'helmet':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <path d="M4 16c0-5 3.6-9 8-9s8 4 8 9z" fill="#f6b818" />
          <path d="M2.5 16h19v2.4h-19z" fill="#e09d0c" />
          <path d="M11 7.2h2v6h-2z" fill="#ffd257" />
        </svg>
      );
    case 'tape':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <ellipse cx="12" cy="12" rx="8.5" ry="8.5" fill="#d9a86b" />
          <ellipse cx="12" cy="12" rx="3.6" ry="3.6" fill="#f3e3cc" />
        </svg>
      );
    case 'panel':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <path d="M12 4 21 8.5v7L12 20 3 15.5v-7z" fill="#e3c08f" />
          <path d="M12 4 21 8.5 12 13 3 8.5z" fill="#f1d7ad" />
        </svg>
      );
    case 'chair':
    case 'box':
    default:
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <path d="M12 3 21 7.5v9L12 21 3 16.5v-9z" fill="#d9a86b" />
          <path d="M12 3 21 7.5 12 12 3 7.5z" fill="#ecc795" />
          <path d="M12 12v9l-9-4.5v-9z" fill="#c3904f" />
          <path d="M7.5 5.3l9 4.5" stroke="#b47f3f" strokeWidth="1.2" />
        </svg>
      );
  }
}

export function TruckGlyph({ color = '#2f5bea', w = 46 }: { color?: string; w?: number }) {
  return (
    <svg width={w} height={w * 0.62} viewBox="0 0 52 32" aria-hidden>
      <path d="M3 6h31v17H3z" fill="#ffffff" stroke="#c9d3e6" />
      <path d="M3 18h31v5H3z" fill={color} />
      <path d="M35 11h8l6 6v6H35z" fill={color} />
      <path d="M38 13h4.5l3.5 4h-8z" fill="#20304d" />
      <circle cx="11" cy="25" r="3.4" fill="#2a2f3a" />
      <circle cx="27" cy="25" r="3.4" fill="#2a2f3a" />
      <circle cx="43" cy="25" r="3.4" fill="#2a2f3a" />
    </svg>
  );
}

const CARRIER_COLOR: Record<Carrier, string> = { WareTrack: '#2f5bea', Bluepeak: '#1f3b8f', Nordline: '#1e8f80', Cargoviva: '#f07b2c' };
export function CarrierGlyph({ carrier }: { carrier: Carrier }) {
  const c = CARRIER_COLOR[carrier];
  if (carrier === 'WareTrack') return <TruckGlyph color={c} w={40} />;
  return (
    <svg width="34" height="26" viewBox="0 0 34 26" aria-hidden>
      <path d="M2 20 12 5l6 9 4-5 10 11z" fill={c} />
      <path d="M2 20h30v2H2z" fill={c} opacity=".5" />
    </svg>
  );
}
export const carrierColor = (c: Carrier) => CARRIER_COLOR[c];

export function ForkliftGlyph() {
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden>
      <path d="M6 14h13v11H6z" fill="#f6b818" />
      <path d="M8 6h9v2H8zM8 6h1.6v8H8zM15.4 6H17v8h-1.6z" fill="#2c3242" />
      <path d="M21 5h2v21h-2z" fill="#5d6577" />
      <path d="M23 24h8v2h-8z" fill="#5d6577" />
      <path d="M24 16h6v8h-6z" fill="#d9a86b" />
      <circle cx="10" cy="27" r="3" fill="#2a2f3a" />
      <circle cx="18" cy="27" r="3" fill="#2a2f3a" />
      <circle cx="12.5" cy="11" r="2" fill="#f08a24" />
    </svg>
  );
}

export function WarehouseGlyph() {
  return (
    <svg width="40" height="30" viewBox="0 0 40 30" aria-hidden>
      <path d="M3 13 20 5l17 8v12H3z" fill="#2f5bea" />
      <path d="M3 13 20 5l17 8-17 7z" fill="#5b82f5" />
      <path d="M8 18h7v7H8zM20 19h7v6h-7z" fill="#ffffff" />
    </svg>
  );
}

export function DockGlyph() {
  return (
    <svg width="34" height="30" viewBox="0 0 34 30" aria-hidden>
      <path d="M4 4h26v24H4z" fill="#eef2fb" stroke="#c9d3e6" />
      <path d="M8 9h18v19H8z" fill="#2c3242" />
      <path d="M8 9h18v5H8z" fill="#cfd6e4" />
      <path d="M6 7h22v2H6z" fill="#2f5bea" />
    </svg>
  );
}

export function ChargerGlyph() {
  return (
    <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden>
      <path d="M9 4h12v22H9z" fill="#ffffff" stroke="#c9d3e6" />
      <path d="M12 8h6v5h-6z" fill="#36c06a" />
      <path d="M16 15l-4 6h3l-1 4 4-6h-3z" fill="#2c3242" />
    </svg>
  );
}
