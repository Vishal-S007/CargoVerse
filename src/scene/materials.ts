// Shared materials and procedurally drawn canvas textures (no external assets).
import * as THREE from 'three';
import type { Carrier, PalletLook } from '../data/types';

export const C = {
  ground: '#e4e9f4',
  yard: '#f0f3f9',
  road: '#d6ddec',
  roadLine: '#ffffff',
  curb: '#c8d1e4',
  marking: '#f1c24f',
  blue: '#2c5be4',
  blueRoof: '#3b6cf1',
  blueDark: '#2149c8',
  white: '#f6f8fc',
  wallGrey: '#e2e7f1',
  doorDark: '#262d3d',
  rollDoor: '#cfd6e4',
  trunk: '#a08b72',
  leaf: '#69c08a',
  leafDark: '#58ae79',
  cardboard: '#d9a86b',
  cardboardDark: '#c3904f',
  wood: '#c9a27a',
  crate: '#2f5fe8',
  crateDark: '#244cc4',
  wrap: '#f3f6fb',
  yellow: '#f6b818',
  yellowDark: '#d99c0c',
  steel: '#2c3242',
  steelLight: '#5d6577',
  tire: '#2a2f3a',
  glass: '#2a3a58',
  fence: '#9fabc3',
};

const cache = new Map<string, THREE.Material>();
export function mat(color: string, opts: { rough?: number; metal?: number; opacity?: number; emissive?: string } = {}): THREE.MeshStandardMaterial {
  const key = `${color}|${opts.rough ?? 0.85}|${opts.metal ?? 0}|${opts.opacity ?? 1}|${opts.emissive ?? ''}`;
  let m = cache.get(key) as THREE.MeshStandardMaterial | undefined;
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      ...(opts.emissive ? { emissive: new THREE.Color(opts.emissive), emissiveIntensity: 0.6 } : {}),
      roughness: opts.rough ?? 0.85,
      metalness: opts.metal ?? 0,
      transparent: (opts.opacity ?? 1) < 1,
      opacity: opts.opacity ?? 1,
      depthWrite: (opts.opacity ?? 1) >= 1,
    });
    cache.set(key, m);
  }
  return m;
}

const texCache = new Map<string, THREE.Texture>();
function canvasTexture(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.Texture {
  const hit = texCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (g) draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}

function cubeIcon(g: CanvasRenderingContext2D, x: number, y: number, s: number, color: string) {
  g.save();
  g.translate(x, y);
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(0, -s); g.lineTo(s * 0.9, -s * 0.5); g.lineTo(s * 0.9, s * 0.5); g.lineTo(0, s); g.lineTo(-s * 0.9, s * 0.5); g.lineTo(-s * 0.9, -s * 0.5);
  g.closePath();
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.45)';
  g.beginPath();
  g.moveTo(0, -s); g.lineTo(s * 0.9, -s * 0.5); g.lineTo(0, 0); g.lineTo(-s * 0.9, -s * 0.5);
  g.closePath();
  g.fill();
  g.restore();
}

export const CARRIER_STYLE: Record<Carrier, { cab: string; stripe: string; text: string }> = {
  WareTrack: { cab: '#2c5be4', stripe: '#2c5be4', text: '#2c5be4' },
  Bluepeak: { cab: '#f4f6fa', stripe: '#1f3b8f', text: '#1f3b8f' },
  Nordline: { cab: '#f4f6fa', stripe: '#1e8f80', text: '#1e7f73' },
  Cargoviva: { cab: '#f4f6fa', stripe: '#f07b2c', text: '#e0661a' },
};

export function trailerLogo(carrier: Carrier): THREE.Texture {
  return canvasTexture(`logo-${carrier}`, 512, 160, (g) => {
    const st = CARRIER_STYLE[carrier];
    g.clearRect(0, 0, 512, 160);
    g.fillStyle = st.text;
    if (carrier === 'WareTrack') cubeIcon(g, 70, 80, 42, st.text);
    else if (carrier === 'Bluepeak') {
      g.beginPath(); g.moveTo(30, 118); g.lineTo(78, 40); g.lineTo(104, 82); g.lineTo(118, 64); g.lineTo(150, 118); g.closePath(); g.fill();
    } else if (carrier === 'Nordline') {
      g.beginPath(); g.moveTo(30, 118); g.lineTo(62, 44); g.lineTo(84, 92); g.lineTo(110, 44); g.lineTo(140, 118); g.closePath(); g.fill();
    } else {
      for (let i = 0; i < 3; i++) { g.fillRect(36, 52 + i * 24, 90 - i * 18, 13); }
    }
    const label = carrier === 'WareTrack' ? 'CargoVerse' : carrier;
    let size = 74;
    g.font = `bold ${size}px Inter, Helvetica, Arial, sans-serif`;
    while (size > 40 && g.measureText(label).width > 340) { size -= 2; g.font = `bold ${size}px Inter, Helvetica, Arial, sans-serif`; }
    g.textBaseline = 'middle';
    g.fillText(label, 160, 84);
  });
}

export function roofLogo(text: string): THREE.Texture {
  return canvasTexture(`roof-${text}`, 256, 256, (g) => {
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.beginPath(); g.arc(128, 110, 92, 0, Math.PI * 2); g.fill();
    cubeIcon(g, 128, 110, 52, '#2c5be4');
    g.fillStyle = '#ffffff';
    g.font = 'bold 40px Inter, Helvetica, Arial, sans-serif';
    g.textAlign = 'center';
    g.fillText(text, 128, 244);
  });
}

export function wallSign(text: string, sub: string): THREE.Texture {
  return canvasTexture(`sign-${text}-${sub}`, 512, 160, (g) => {
    g.clearRect(0, 0, 512, 160);
    cubeIcon(g, 56, 70, 36, '#2c5be4');
    g.fillStyle = '#2c5be4';
    g.font = 'bold 64px Inter, Helvetica, Arial, sans-serif';
    g.textBaseline = 'middle';
    g.fillText(text, 110, 66);
    g.fillStyle = '#6b7590';
    g.font = '30px Inter, Helvetica, Arial, sans-serif';
    g.fillText(sub, 112, 126);
  });
}

export function windowTexture(): THREE.Texture {
  const t = canvasTexture('windows', 128, 128, (g) => {
    g.fillStyle = '#f5f7fb';
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#8ea8e8';
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) g.fillRect(14 + x * 64, 18 + y * 64, 36, 30);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export function glassTexture(): THREE.Texture {
  const t = canvasTexture('glass', 128, 128, (g) => {
    g.fillStyle = '#3f6fe9';
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(255,255,255,0.65)';
    g.lineWidth = 4;
    for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * 32, 0); g.lineTo(i * 32, 128); g.stroke(); }
    for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(0, i * 32); g.lineTo(128, i * 32); g.stroke(); }
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(0, 0, 64, 128);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export function containerTexture(color: string): THREE.Texture {
  const t = canvasTexture(`container-${color}`, 256, 64, (g) => {
    g.fillStyle = color;
    g.fillRect(0, 0, 256, 64);
    g.fillStyle = 'rgba(0,0,0,0.12)';
    for (let i = 0; i < 32; i++) g.fillRect(i * 8, 0, 3, 64);
  });
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

export function glowTexture(): THREE.Texture {
  return canvasTexture('glow', 128, 128, (g) => {
    const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grd.addColorStop(0, 'rgba(47,98,224,0.55)');
    grd.addColorStop(1, 'rgba(47,98,224,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
  });
}

export function lookColors(look: PalletLook): { main: string; dark: string } {
  if (look === 'blue') return { main: C.crate, dark: C.crateDark };
  if (look === 'white') return { main: C.wrap, dark: '#d9e0ec' };
  return { main: C.cardboard, dark: C.cardboardDark };
}

/** Company sign: coloured square logo with the company initial, name and a sub-line. */
export function companySign(name: string, sub: string, color: string): THREE.Texture {
  return canvasTexture(`csign-${name}-${sub}-${color}`, 640, 160, (g) => {
    g.clearRect(0, 0, 640, 160);
    g.fillStyle = 'rgba(255,255,255,0.94)';
    g.beginPath(); g.roundRect(4, 8, 632, 144, 22); g.fill();
    g.fillStyle = color;
    g.beginPath(); g.roundRect(20, 26, 108, 108, 18); g.fill();
    g.fillStyle = '#ffffff';
    g.font = 'bold 70px Inter, Helvetica, Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(name.charAt(0), 74, 84);
    g.textAlign = 'left';
    g.fillStyle = '#1f2a44';
    let size = 54;
    g.font = `bold ${size}px Inter, Helvetica, Arial, sans-serif`;
    while (g.measureText(name).width > 480 && size > 28) { size -= 2; g.font = `bold ${size}px Inter, Helvetica, Arial, sans-serif`; }
    g.fillText(name, 148, 66);
    g.fillStyle = '#6b7590';
    g.font = '30px Inter, Helvetica, Arial, sans-serif';
    g.fillText(sub, 150, 118);
  });
}

/** Overhead road sign (green, white text). */
export function roadSign(title: string, sub: string, arrow: 'left' | 'right' | 'up'): THREE.Texture {
  return canvasTexture(`rsign-${title}-${sub}-${arrow}`, 640, 220, (g) => {
    g.fillStyle = '#1f7a4d';
    g.beginPath(); g.roundRect(0, 0, 640, 220, 20); g.fill();
    g.strokeStyle = '#ffffff'; g.lineWidth = 6;
    g.beginPath(); g.roundRect(10, 10, 620, 200, 14); g.stroke();
    g.fillStyle = '#ffffff';
    g.font = 'bold 64px Inter, Helvetica, Arial, sans-serif';
    g.textBaseline = 'middle';
    const ax = arrow === 'left' ? 70 : 570;
    g.textAlign = arrow === 'left' ? 'left' : 'right';
    g.fillText(title, arrow === 'left' ? 140 : 500, 82);
    g.font = '38px Inter, Helvetica, Arial, sans-serif';
    g.fillText(sub, arrow === 'left' ? 140 : 500, 152);
    g.beginPath();
    if (arrow === 'left') { g.moveTo(ax - 40, 110); g.lineTo(ax + 20, 60); g.lineTo(ax + 20, 160); }
    else if (arrow === 'right') { g.moveTo(ax + 40, 110); g.lineTo(ax - 20, 60); g.lineTo(ax - 20, 160); }
    else { g.moveTo(ax, 50); g.lineTo(ax - 45, 120); g.lineTo(ax + 45, 120); }
    g.closePath(); g.fill();
  });
}

/** Painted letters on the ground (e.g. lane arrows, "IMPORTS"). */
export function groundText(text: string, color = '#ffffff'): THREE.Texture {
  return canvasTexture(`gtext-${text}-${color}`, 512, 128, (g) => {
    g.clearRect(0, 0, 512, 128);
    g.fillStyle = color;
    g.font = 'bold 84px Inter, Helvetica, Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 256, 68);
  });
}
