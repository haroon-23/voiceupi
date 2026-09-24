import * as Linking from 'expo-linking';
import { isValidVpa } from './types';

export { isValidVpa };

export type ParsedUpi = {
  pa: string;
  pn?: string;
  am?: string;
  cu?: string;
  tn?: string;
  tr?: string;
  raw: string;
};

const MAX_URI_LENGTH = 2048;

export function parseUpiUri(raw: string): ParsedUpi | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_URI_LENGTH) return null;
  if (!/^upi:\/\/pay\?/i.test(value)) return null;
  try {
    const q = value.slice(value.indexOf('?') + 1);
    const params = new URLSearchParams(q);
    const pa = params.get('pa');
    if (!pa || !isValidVpa(pa)) return null;
    const cu = params.get('cu') ?? 'INR';
    if (cu.toUpperCase() !== 'INR') return null;
    const amRaw = params.get('am');
    let am: string | undefined;
    if (amRaw !== null && amRaw !== '') {
      const n = Number(amRaw);
      am = Number.isFinite(n) && n > 0 ? amRaw : undefined;
    }
    return {
      pa,
      pn: params.get('pn') ?? undefined,
      am,
      cu: 'INR',
      tn: params.get('tn') ?? undefined,
      tr: params.get('tr') ?? undefined,
      raw: value
    };
  } catch {
    return null;
  }
}

// User-facing explanation for a rejected QR. Never throws.
export function describeUpiQrProblem(raw: string): string {
  const value = raw.trim();
  if (!value) return 'Empty code. Point the camera at a merchant UPI QR.';
  if (!/^upi:\/\//i.test(value)) return 'This QR is not a UPI code. Point the camera at a merchant UPI QR.';
  if (!/^upi:\/\/pay\?/i.test(value)) return 'Unsupported UPI QR type. Only merchant payment codes are supported.';
  try {
    const params = new URLSearchParams(value.slice(value.indexOf('?') + 1));
    const pa = params.get('pa');
    if (!pa) return 'This UPI QR is missing the payee address.';
    if (!isValidVpa(pa)) return 'This UPI QR has an invalid payee address.';
    const cu = params.get('cu');
    if (cu && cu.toUpperCase() !== 'INR') return 'Only INR payments are supported.';
    return 'This UPI QR could not be read. Try another code.';
  } catch {
    return 'This UPI QR could not be read. Try another code.';
  }
}

export function buildUpiPayUrl(data: ParsedUpi, amountOverride?: number | null, purpose?: string | null) {
  const params = new URLSearchParams();
  params.set('pa', data.pa);
  if (data.pn) params.set('pn', data.pn);
  const amount = amountOverride ?? (data.am ? Number(data.am) : null);
  if (amount && Number.isFinite(amount)) params.set('am', amount.toFixed(2));
  params.set('cu', data.cu || 'INR');
  if (purpose) params.set('tn', purpose.slice(0, 80));
  if (data.tr) params.set('tr', data.tr);
  return `upi://pay?${params.toString()}`;
}

export async function openUpi(url: string) {
  return Linking.openURL(url);
}
