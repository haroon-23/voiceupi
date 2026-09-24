export type TransactionKind = 'manual_note' | 'upi_handoff';

// Pure VPA validation (zero dependencies so intent.ts and upi.ts can share it).
const VPA_RE = /^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/;

export function isValidVpa(pa: string): boolean {
  return VPA_RE.test(pa);
}
export type TransactionStatus =
  | 'initiated'
  | 'pending'
  | 'success'
  | 'failed'
  | 'recorded';

export type IntentAction =
  | 'SCAN_AND_PAY'
  | 'RECORD_EXPENSE'
  | 'SHOW_HISTORY'
  | 'CANCEL'
  | 'GO_BACK'
  | 'START_OVER'
  | 'REPEAT'
  | 'HELP'
  | 'UNKNOWN';

export type PaymentIntent = {
  action: IntentAction;
  purpose: string | null;
  category: string | null;
  amount: number | null;
  recipient: string | null;
  recipientVpa: string | null;
  explicitQr: boolean;
  missing: Array<'amount' | 'recipient'>;
  clarification: string | null;
  rawText: string;
  confidence: number;
};

export type Transaction = {
  id: string;
  kind: TransactionKind;
  status: TransactionStatus;
  amount: number | null;
  merchantName: string | null;
  merchantVpa: string | null;
  category: string | null;
  purpose: string | null;
  rawCommand: string;
  createdAt: string;
  upiUrl: string | null;
};
