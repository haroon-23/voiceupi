import AsyncStorage from '@react-native-async-storage/async-storage';
import { Transaction, TransactionKind, TransactionStatus } from './types';

const KEY = '@voiceupi/transactions/v1';
const MAX_STORED = 500;

const KINDS: readonly TransactionKind[] = ['manual_note', 'upi_handoff'];
const STATUSES: readonly TransactionStatus[] = ['initiated', 'pending', 'success', 'failed', 'recorded'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toFiniteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toValidStatus(value: unknown): TransactionStatus | null {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
    ? (value as TransactionStatus)
    : null;
}

function isLegacyHandoff(record: Record<string, unknown>): boolean {
  return typeof record.upiUrl === 'string' || typeof record.merchantVpa === 'string';
}

// Records written before `kind` existed are classified conservatively and never
// upgraded into verified settlements:
// - no upiUrl and no merchantVpa -> spoken/typed note -> manual_note / recorded
// - otherwise -> upi_handoff; a legacy 'success' is demoted to 'pending' because
//   the old substring status matcher could not prove settlement.
function normalizeTransaction(value: unknown): Transaction | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  const createdAt = value.createdAt;
  if (typeof createdAt !== 'string' || createdAt.length === 0) return null;

  const rawKind = value.kind;
  const hasKind =
    typeof rawKind === 'string' && (KINDS as readonly string[]).includes(rawKind);
  const kind: TransactionKind = hasKind
    ? (rawKind as TransactionKind)
    : isLegacyHandoff(value)
      ? 'upi_handoff'
      : 'manual_note';

  const rawStatus = toValidStatus(value.status);
  let status: TransactionStatus;
  if (kind === 'manual_note') {
    status = 'recorded';
  } else if (!hasKind && rawStatus === 'success') {
    status = 'pending';
  } else {
    status = rawStatus ?? 'initiated';
  }

  return {
    id,
    kind,
    status,
    amount: toFiniteNumberOrNull(value.amount),
    merchantName: toStringOrNull(value.merchantName),
    merchantVpa: toStringOrNull(value.merchantVpa),
    category: toStringOrNull(value.category),
    purpose: toStringOrNull(value.purpose),
    rawCommand: typeof value.rawCommand === 'string' ? value.rawCommand : '',
    createdAt,
    upiUrl: toStringOrNull(value.upiUrl),
  };
}

export async function getTransactions(): Promise<Transaction[]> {
  let parsed: unknown;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const valid: Transaction[] = [];
  for (const item of parsed) {
    const tx = normalizeTransaction(item);
    if (tx) valid.push(tx);
  }
  return valid;
}

export async function saveTransaction(tx: Transaction) {
  const all = await getTransactions();
  await AsyncStorage.setItem(KEY, JSON.stringify([tx, ...all].slice(0, MAX_STORED)));
}

export async function updateTransaction(id: string, patch: Partial<Transaction>) {
  const all = await getTransactions();
  const updated = all.map(t => t.id === id ? { ...t, ...patch } : t);
  await AsyncStorage.setItem(KEY, JSON.stringify(updated));
  return updated;
}

export async function deleteTransaction(id: string) {
  const all = await getTransactions();
  const updated = all.filter(t => t.id !== id);
  await AsyncStorage.setItem(KEY, JSON.stringify(updated));
  return updated;
}

export async function clearTransactions() {
  await AsyncStorage.removeItem(KEY);
}
