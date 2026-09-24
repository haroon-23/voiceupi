import { IntentAction, isValidVpa, PaymentIntent } from './types';

const categories: Record<string, string> = {
  groceries: 'Groceries', grocery: 'Groceries', supermarket: 'Groceries', food: 'Food', restaurant: 'Food', lunch: 'Food', dinner: 'Food',
  travel: 'Travel', taxi: 'Travel', cab: 'Travel', uber: 'Travel', ola: 'Travel', fuel: 'Transport', petrol: 'Transport', diesel: 'Transport',
  rent: 'Rent', electricity: 'Bills', bill: 'Bills', recharge: 'Bills', medicine: 'Health', medical: 'Health', shopping: 'Shopping',
  clothes: 'Shopping', entertainment: 'Entertainment', movie: 'Entertainment', subscription: 'Subscriptions', subscriptions: 'Subscriptions',
  education: 'Education', business: 'Business', office: 'Business', home: 'Home', family: 'Family', gift: 'Gifts'
};

export const MAX_UPI_AMOUNT = 100000;

// Strictly parses a standalone amount string (confirm-screen input). Returns null
// for missing, malformed, non-positive, non-finite, or over-limit values.
export function parseAmountInput(value: string): number | null {
  const cleaned = value.replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_UPI_AMOUNT) return null;
  return Math.round(n * 100) / 100;
}

function extractAmount(text: string): number | null {
  // Prefer an explicitly currency-marked figure: "Pay ₹500 for lunch".
  const anchored = text.match(/(?:₹|rs\.?|inr)\s*(-?\d+(?:\.\d{1,2})?)/i);
  if (anchored?.[1]) return parseAmountInput(anchored[1]);
  // Otherwise accept a bare number only when it is the single number present.
  // Multiple unrelated numbers ("pay 2 coffees 400") are ambiguous: return null
  // rather than inventing an amount.
  const bare = text.match(/-?\d+(?:\.\d{1,2})?/g) ?? [];
  if (bare.length !== 1 || !bare[0]) return null;
  return parseAmountInput(bare[0]);
}

function detectCategory(text: string): { category: string | null; purpose: string | null } {
  const lower = text.toLowerCase();
  for (const [keyword, category] of Object.entries(categories)) {
    if (new RegExp(`\\b${keyword}\\b`, 'i').test(lower)) return { category, purpose: keyword };
  }
  const purposeMatch = lower.match(/(?:for|on|towards)\s+([a-z][a-z\s-]{1,30})/i);
  return { category: null, purpose: purposeMatch?.[1]?.trim() ?? null };
}

function isRecordExpense(text: string) {
  return /record|log|add|spent|expense/i.test(text) && !/pay|scan|send/i.test(text);
}

function extractVpa(text: string): string | null {
  const m = text.match(/[\w.\-]{2,256}@[a-zA-Z]{2,64}/);
  return m && isValidVpa(m[0]) ? m[0] : null;
}

function explicitQrRequest(text: string): boolean {
  return /\bqr\b|scan|scanner|this code/i.test(text);
}

// Navigation / meta commands, checked before payment classification so words
// like "stop" or "back" are never mistaken for a payment.
function detectMetaAction(text: string): IntentAction | null {
  if (/\bstart over\b|\brestart\b|\breset\b/i.test(text)) return 'START_OVER';
  if (/\bgo back\b|\bback\b/i.test(text)) return 'GO_BACK';
  if (/\bcancel\b|\bstop\b|\bnever mind\b|\bforget it\b/i.test(text)) return 'CANCEL';
  if (/\brepeat\b|\bsay (that|it) again\b|\bread (that|it) (again|aloud|out loud)\b/i.test(text)) return 'REPEAT';
  if (/\bhelp\b|\bwhat can you do\b|\bhow do i\b|\bhow to\b/i.test(text)) return 'HELP';
  if (/\bshow\b.*\b(transactions|history|recent)\b|\b(recent|my) (transactions|history|payments)\b|\bhistory\b/i.test(text)) return 'SHOW_HISTORY';
  return null;
}

export function parseIntent(rawText: string): PaymentIntent {
  const text = rawText.trim();
  const meta = detectMetaAction(text);
  if (meta) {
    return {
      action: meta, purpose: null, category: null, amount: null, recipient: null,
      recipientVpa: null, explicitQr: false, missing: [], clarification: null,
      rawText: text, confidence: 0.9,
    };
  }
  const { category, purpose } = detectCategory(text);
  const amount = extractAmount(text);
  const recipientMatch = text.match(/(?:to|pay)\s+([A-Za-z][A-Za-z .'-]{1,40}?)(?:\s+(?:for|₹|rs\.?|inr)|$)/i);
  const recipient = recipientMatch?.[1]?.trim() ?? null;
  const recipientVpa = extractVpa(text);
  const explicitQr = explicitQrRequest(text);
  const recordOnly = isRecordExpense(text);
  const paymentWords = /\b(pay|scan|send|transfer|upi|payment|paying)\b/i.test(text);
  const action: IntentAction = recordOnly ? 'RECORD_EXPENSE' : paymentWords ? 'SCAN_AND_PAY' : 'UNKNOWN';

  // Never invent payment facts: report exactly what is missing and how to ask.
  const missing: Array<'amount' | 'recipient'> = [];
  let clarification: string | null = null;
  if (action === 'SCAN_AND_PAY' && !explicitQr) {
    if (amount === null) missing.push('amount');
    if (recipientVpa === null) missing.push('recipient');
    if (missing.length > 0) {
      clarification =
        missing.includes('amount') && missing.includes('recipient')
          ? 'How much should I pay, and what is the UPI ID?'
          : missing.includes('amount')
            ? 'How much should I pay?'
            : 'Who should I pay? Say or type the UPI ID, or say “scan” to scan their QR.';
    }
  }

  return {
    action,
    purpose,
    category,
    amount,
    recipient,
    recipientVpa,
    explicitQr,
    missing,
    clarification,
    rawText: text,
    confidence: category || paymentWords ? 0.9 : 0.45
  };
}
