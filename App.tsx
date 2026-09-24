import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Platform, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Linking from 'expo-linking';
import * as Speech from 'expo-speech';
import VoiceButton from './src/components/VoiceButton';
import WebQrScanner from './src/components/WebQrScanner';
import { MAX_UPI_AMOUNT, parseAmountInput, parseIntent } from './src/lib/intent';
import { buildUpiPayUrl, describeUpiQrProblem, isValidVpa, openUpi, parseUpiUri, ParsedUpi } from './src/lib/upi';
import { getTransactions, saveTransaction, updateTransaction, deleteTransaction } from './src/lib/storage';
import { PaymentIntent, Transaction } from './src/lib/types';

type Screen = 'home' | 'scan' | 'confirm' | 'history' | 'detail';

type Draft = {
  amount: number | null;
  vpa: string | null;
  name: string | null;
  purpose: string | null;
  category: string | null;
  rawText: string;
};

function money(n: number | null) { return n == null ? '—' : `₹${n.toLocaleString('en-IN')}`; }

function formatDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'Unknown date' : d.toLocaleString();
}

// Display-only labels. 'success' in storage means an exact-token callback was
// received — never bank-grade proof — so the UI must not print bare "success".
function statusLabel(item: Transaction) {
  if (item.kind === 'manual_note') return 'note';
  if (item.status === 'success') return 'callback-confirmed';
  return item.status;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [qr, setQr] = useState<ParsedUpi | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [amount, setAmount] = useState('');
  const [purposeEdit, setPurposeEdit] = useState('');
  const [categoryEdit, setCategoryEdit] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  // Barcode scanning is unsupported on web, so the manual UPI-ID form is the
  // primary path there; on native it stays an opt-in fallback below the camera.
  const [manualEntry, setManualEntry] = useState(false);
  const [vpaInput, setVpaInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [permission, requestPermission] = useCameraPermissions();
  const [callbackTx, setCallbackTx] = useState<string | null>(null);
  const lastScanErrorAt = useRef(0);
  const handledScanRef = useRef(false);
  const lastNoteRef = useRef<{ text: string; at: number } | null>(null);
  const confirmSpokenRef = useRef<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [awaiting, setAwaiting] = useState<'amount' | 'recipient' | null>(null);
  const [clarifyMsg, setClarifyMsg] = useState<string | null>(null);
  const [clarifyAmount, setClarifyAmount] = useState('');
  const [clarifyVpa, setClarifyVpa] = useState('');
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);

  const refresh = useCallback(async () => setTransactions(await getTransactions()), []);
  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (screen === 'scan') {
      handledScanRef.current = false;
      setScanError(null);
      setManualEntry(false);
      setVpaInput('');
      setNameInput('');
    }
    if (screen === 'confirm' && qr) {
      // Read the details aloud exactly once per confirmation (never on re-render).
      if (confirmSpokenRef.current !== qr.raw) {
        confirmSpokenRef.current = qr.raw;
        speakConfirm();
      }
    } else if (screen !== 'confirm') {
      confirmSpokenRef.current = null;
    }
  }, [screen, qr]);

  useEffect(() => {
    const sub = Linking.addEventListener('url', async ({ url }) => {
      const parsed = Linking.parse(url);
      const txId = typeof parsed.queryParams?.txId === 'string' ? parsed.queryParams.txId : callbackTx;
      const response = typeof parsed.queryParams?.Status === 'string' ? parsed.queryParams.Status.toLowerCase().trim() : '';
      // Exact-token matching only: never infer success from substrings, and never
      // treat unknown/pending responses as failure. Most UPI apps never call back,
      // so the transaction normally remains initiated/pending (unverified).
      if (txId && response) {
        if (response === 'success') {
          await updateTransaction(txId, { status: 'success' });
        } else if (response === 'failure' || response === 'failed' || response === 'fail') {
          await updateTransaction(txId, { status: 'failed' });
        }
        await refresh();
        setCallbackTx(null);
      }
    });
    return () => sub.remove();
  }, [callbackTx, refresh]);

  function say(text: string) {
    if (muted) return;
    try {
      Speech.speak(text);
    } catch {
      // TTS must never block the payment flow.
    }
  }

  function toggleMute() {
    setMuted(m => {
      if (!m) {
        try {
          Speech.stop();
        } catch {
          // Never block on TTS teardown.
        }
      }
      return !m;
    });
  }

  function resetFlow() {
    setDraft(null);
    setAwaiting(null);
    setClarifyMsg(null);
    setClarifyAmount('');
    setClarifyVpa('');
    setSelectedTx(null);
    setScreen('home');
  }

  function goBack() {
    if (screen === 'confirm') setScreen('scan');
    else if (screen === 'detail') setScreen('history');
    else if (screen === 'scan' || screen === 'history') resetFlow();
  }

  function intentFromDraft(d: Draft): PaymentIntent {
    return {
      action: 'SCAN_AND_PAY', purpose: d.purpose, category: d.category, amount: d.amount,
      recipient: d.name, recipientVpa: d.vpa, explicitQr: false, missing: [],
      clarification: null, rawText: d.rawText, confidence: 0.9,
    };
  }

  function manualUpi(d: Draft): ParsedUpi {
    const pa = d.vpa ?? '';
    return {
      pa, pn: d.name ?? undefined,
      am: d.amount != null ? String(d.amount) : undefined,
      cu: 'INR', tn: d.purpose ?? undefined, tr: undefined, raw: `voice:${pa}`,
    };
  }

  function askSlot(d: Draft, slot: 'amount' | 'recipient') {
    const msg =
      slot === 'amount'
        ? 'How much should I pay?'
        : 'Who should I pay? Say or type the UPI ID, or say “scan” to scan their QR.';
    setDraft(d);
    setAwaiting(slot);
    setClarifyMsg(msg);
    say(msg);
  }

  function clearAwait() {
    setAwaiting(null);
    setClarifyMsg(null);
    setClarifyAmount('');
    setClarifyVpa('');
  }

  function describeDraft(d: Draft) {
    const amountText = d.amount != null ? money(d.amount) : 'an unknown amount';
    const toText = d.vpa ?? d.name ?? 'an unknown recipient';
    const what = d.category ?? d.purpose ?? 'payment';
    return `${amountText} to ${toText} for ${what}`;
  }

  function speakConfirm() {
    if (!qr) return;
    say(`Confirm. Pay ${amount || 'no amount entered'} to ${qr.pn ?? qr.pa}. You will approve this in your UPI app.`);
  }

  function repeatContext() {
    if (screen === 'confirm' && qr) {
      speakConfirm();
    } else if (awaiting && draft) {
      say(clarifyMsg ?? describeDraft(draft));
    } else if (screen === 'history') {
      say(`${handoffs.length} handoffs and ${manualNotes.length} notes recorded.`);
    } else if (screen === 'scan') {
      say('Point the camera at a merchant QR code, or enter the UPI ID manually.');
    } else {
      say('Say what you are paying for. For example: pay 250 rupees to a UPI ID.');
    }
  }

  function showHelp() {
    const msg = 'Try: “Pay 250 rupees to name@bank”, “Pay 120 using this QR code”, “Show my recent transactions”, “Repeat”, “Cancel”, or “Start over”.';
    Alert.alert('What can I say?', msg);
    say('You can pay by UPI ID or QR code, review history, or ask me to repeat.');
  }
  function handleVoice(text: string) {
    if (!text.trim()) {
      Alert.alert('No voice input', 'Nothing was heard. Tap “Speak payment” and try again.');
      return;
    }
    const next = parseIntent(text);

    // Confirmation-state voice: "yes" confirms only here, never elsewhere.
    if (screen === 'confirm' && qr) {
      const t = next.rawText.toLowerCase();
      if (/\byes\b|\bconfirm\b|\bcontinue\b|\bproceed\b/.test(t)) {
        startPayment();
        return;
      }
      if (/\bno\b|\bcancel\b|\bstop\b/.test(t)) {
        resetFlow();
        say('Payment cancelled.');
        return;
      }
      if (next.action === 'REPEAT') {
        speakConfirm();
        return;
      }
      if (next.action === 'GO_BACK') {
        setScreen('scan');
        return;
      }
    }

    switch (next.action) {
      case 'CANCEL':
        resetFlow();
        say('Cancelled.');
        return;
      case 'START_OVER':
        resetFlow();
        say('Starting over. What are you paying for?');
        return;
      case 'GO_BACK':
        goBack();
        return;
      case 'REPEAT':
        repeatContext();
        return;
      case 'HELP':
        showHelp();
        return;
      case 'SHOW_HISTORY':
        setScreen('history');
        return;
      case 'RECORD_EXPENSE': {
        const now = Date.now();
        if (lastNoteRef.current && lastNoteRef.current.text === next.rawText && now - lastNoteRef.current.at < 5000) return;
        lastNoteRef.current = { text: next.rawText, at: now };
        const tx: Transaction = {
          id: cryptoRandom(), kind: 'manual_note', status: 'recorded', amount: next.amount, merchantName: null, merchantVpa: null,
          category: next.category, purpose: next.purpose, rawCommand: next.rawText, createdAt: new Date().toISOString(), upiUrl: null
        };
        saveTransaction(tx).then(refresh).catch(() => {
          Alert.alert('Could not save', 'This note was not saved. Storage may be unavailable — try again.');
        });
        setIntent(next);
        say(next.category ? `${next.category}. Expense noted.` : 'Expense noted.');
        Alert.alert('Expense recorded', `${money(next.amount)} · ${next.category ?? next.purpose ?? 'Uncategorized'}`);
        return;
      }
      case 'SCAN_AND_PAY':
        routePayment(next);
        return;
      default:
        break;
    }

    // Follow-up utterance while clarification is pending: fill the open slot.
    if (awaiting && draft) {
      fillAwaiting(next);
      return;
    }

    Alert.alert('Try saying', '“Pay 250 rupees to name@bank”, “Pay 120 using this QR code”, or “Show my recent transactions”.');
  }

  function routePayment(next: PaymentIntent) {
    const d: Draft = {
      amount: next.amount, vpa: next.recipientVpa, name: next.recipient,
      purpose: next.purpose, category: next.category, rawText: next.rawText,
    };
    setIntent(next);
    if (d.amount != null && d.vpa != null) {
      setDraft(d);
      clearAwait();
      enterConfirm(manualUpi(d), next);
      return;
    }
    if (next.explicitQr) {
      setDraft(d);
      clearAwait();
      say('Opening scanner.');
      setScreen('scan');
      return;
    }
    if (d.amount != null) {
      say(next.category ? `${next.category}. ` : '');
      askSlot(d, 'recipient');
      return;
    }
    if (d.vpa != null) {
      askSlot(d, 'amount');
      return;
    }
    // No amount and no recipient ("scan this for groceries"): legacy scanner path.
    setDraft(d);
    clearAwait();
    say(next.category ? `${next.category}. Opening scanner.` : 'Opening scanner.');
    setScreen('scan');
  }

  function fillAwaiting(next: PaymentIntent) {
    if (!draft || !awaiting) return;
    if (awaiting === 'amount') {
      const n = parseAmountInput(next.rawText) ?? next.amount;
      const d: Draft = {
        ...draft,
        amount: n ?? draft.amount,
        vpa: next.recipientVpa ?? draft.vpa,
        purpose: next.purpose ?? draft.purpose,
        category: next.category ?? draft.category,
      };
      if (d.amount != null && d.vpa != null) {
        setDraft(d);
        clearAwait();
        enterConfirm(manualUpi(d), intentFromDraft(d));
      } else if (d.amount != null) {
        askSlot(d, 'recipient');
      } else {
        askSlot(d, 'amount');
      }
      return;
    }
    // awaiting recipient
    if (/\bscan\b|\bqr\b/.test(next.rawText) && !next.recipientVpa) {
      setIntent(intentFromDraft(draft));
      clearAwait();
      say('Opening scanner.');
      setScreen('scan');
      return;
    }
    const v = next.recipientVpa ?? (isValidVpa(next.rawText.trim()) ? next.rawText.trim() : null);
    const d: Draft = {
      ...draft,
      vpa: v ?? draft.vpa,
      amount: next.amount ?? draft.amount,
      purpose: next.purpose ?? draft.purpose,
      category: next.category ?? draft.category,
    };
    if (d.amount != null && d.vpa != null) {
      setDraft(d);
      clearAwait();
      enterConfirm(manualUpi(d), intentFromDraft(d));
    } else if (d.vpa != null) {
      askSlot(d, 'amount');
    } else {
      askSlot(d, 'recipient');
    }
  }

  function submitClarify() {
    if (!draft || !awaiting) return;
    if (awaiting === 'amount') {
      const n = parseAmountInput(clarifyAmount);
      if (n === null) {
        Alert.alert('Invalid amount', `Enter an amount between ${money(1)} and ${money(MAX_UPI_AMOUNT)}.`);
        return;
      }
      const d: Draft = { ...draft, amount: n };
      setDraft(d);
      setClarifyAmount('');
      if (d.vpa != null) {
        clearAwait();
        enterConfirm(manualUpi(d), intentFromDraft(d));
      } else {
        askSlot(d, 'recipient');
      }
      return;
    }
    const v = clarifyVpa.trim();
    if (!isValidVpa(v)) {
      Alert.alert('Invalid UPI ID', 'Enter a valid UPI ID like name@bank.');
      return;
    }
    const d: Draft = { ...draft, vpa: v };
    setDraft(d);
    setClarifyVpa('');
    if (d.amount != null) {
      clearAwait();
      enterConfirm(manualUpi(d), intentFromDraft(d));
    } else {
      askSlot(d, 'amount');
    }
  }

  function enterConfirm(data: ParsedUpi, intentSnap: PaymentIntent | null = intent) {
    handledScanRef.current = true;
    setScanError(null);
    setQr(data);
    const detectedAmount = intentSnap?.amount ?? (data.am ? Number(data.am) : null);
    setAmount(detectedAmount && Number.isFinite(detectedAmount) ? String(detectedAmount) : '');
    setPurposeEdit(intentSnap?.purpose ?? '');
    setCategoryEdit(intentSnap?.category ?? '');
    setScreen('confirm');
  }

  async function onScanned(raw: string) {
    if (handledScanRef.current) return;
    const parsed = parseUpiUri(raw);
    if (!parsed) {
      const now = Date.now();
      if (now - lastScanErrorAt.current > 3000) {
        lastScanErrorAt.current = now;
        setScanError(describeUpiQrProblem(raw));
      }
      return;
    }
    enterConfirm(parsed);
  }

  function submitManualVpa() {
    if (handledScanRef.current) return;
    const pa = vpaInput.trim();
    if (!isValidVpa(pa)) {
      Alert.alert('Invalid UPI ID', 'Enter a valid UPI ID like name@bank.');
      return;
    }
    const name = nameInput.trim() || null;
    enterConfirm({ pa, pn: name ?? undefined, am: undefined, cu: 'INR', tn: undefined, tr: undefined, raw: `manual:${pa}` });
  }

  async function startPayment() {
    if (paying || !qr) return;
    const amountNum = parseAmountInput(amount);
    if (amountNum === null) {
      Alert.alert('Amount required', `Enter an amount between ${money(1)} and ${money(MAX_UPI_AMOUNT)}.`);
      return;
    }
    setPaying(true);
    try {
      const purpose = purposeEdit.trim() || null;
      const category = categoryEdit.trim() || null;
      const txId = cryptoRandom();
      const payUrl = buildUpiPayUrl(qr, amountNum, purpose ?? category);
      const tx: Transaction = {
        id: txId, kind: 'upi_handoff', status: 'initiated', amount: amountNum, merchantName: qr.pn ?? null, merchantVpa: qr.pa,
        category, purpose, rawCommand: intent?.rawText ?? '', createdAt: new Date().toISOString(), upiUrl: payUrl
      };
      try {
        await saveTransaction(tx);
      } catch {
        Alert.alert('Could not save', 'The handoff record could not be saved, so the UPI app was not opened. Try again.');
        return;
      }
      setCallbackTx(txId);
      await refresh();
      try {
        await openUpi(payUrl);
        // Handoff launched: return to a fresh home screen so a return to the
        // app never lands on a stale confirmation.
        setDraft(null);
        clearAwait();
        setScreen('home');
      } catch {
        await updateTransaction(txId, { status: 'pending' });
        await refresh();
        Alert.alert('No UPI app opened', 'Install a UPI app such as PhonePe, Google Pay, BHIM or Paytm, then try again. Your handoff was saved as initiated.');
      }
    } finally {
      setPaying(false);
    }
  }

  const manualNotes = useMemo(() => transactions.filter(t => t.kind === 'manual_note'), [transactions]);
  const handoffs = useMemo(() => transactions.filter(t => t.kind === 'upi_handoff'), [transactions]);
  const manualTotal = useMemo(() => manualNotes.reduce((s, t) => s + (t.amount ?? 0), 0), [manualNotes]);
  const handoffTotal = useMemo(() => handoffs.reduce((s, t) => s + (t.amount ?? 0), 0), [handoffs]);
  const verifiedHandoffs = useMemo(() => handoffs.filter(t => t.status === 'success').length, [handoffs]);
  const openHandoffs = useMemo(() => handoffs.filter(t => t.status === 'initiated' || t.status === 'pending').length, [handoffs]);
  const failedHandoffs = useMemo(() => handoffs.filter(t => t.status === 'failed').length, [handoffs]);

  if (screen === 'scan') {
    if (manualEntry) {
      return (
        <SafeAreaView style={styles.container}>
          <View style={styles.header}><Text style={styles.brand}>VOICEUPI</Text><Pressable onPress={() => setScreen('home')}><Text style={styles.link}>Cancel</Text></Pressable></View>
          <Text style={styles.title}>Pay by UPI ID</Text>
          <Text style={styles.heroSub}>Enter the merchant UPI ID instead of scanning.</Text>
          <TextInput value={vpaInput} onChangeText={setVpaInput} placeholder="name@bank" placeholderTextColor="#777" style={styles.amountInput} autoCapitalize="none" autoCorrect={false} maxLength={100} returnKeyType="next" />
          <TextInput value={nameInput} onChangeText={setNameInput} placeholder="Merchant name (optional)" placeholderTextColor="#777" style={styles.editInput} maxLength={80} />
          <View style={styles.gap} />
          <Pressable style={styles.primary} onPress={submitManualVpa}><Text style={styles.primaryText}>Continue</Text></Pressable>
          <Pressable onPress={() => setManualEntry(false)}><Text style={styles.linkCenter}>Back to scanner</Text></Pressable>
        </SafeAreaView>
      );
    }
    if (Platform.OS === 'web') {
      return (
        <SafeAreaView style={styles.camera}>
          <WebQrScanner
            hint={intent?.category ? `Purpose: ${intent.category}` : 'Point at a merchant UPI QR'}
            error={scanError}
            onScanned={onScanned}
            onManualEntry={() => setManualEntry(true)}
            onCancel={() => setScreen('home')}
          />
        </SafeAreaView>
      );
    }
    if (!permission) return <SafeAreaView style={styles.center}><Text style={styles.title}>Checking camera…</Text></SafeAreaView>;
    if (!permission.granted) return <SafeAreaView style={styles.center}><Text style={styles.title}>Camera permission needed</Text><Pressable style={styles.primary} onPress={requestPermission}><Text style={styles.primaryText}>Allow camera</Text></Pressable><Pressable onPress={() => setManualEntry(true)}><Text style={styles.linkCenter}>Enter UPI ID manually</Text></Pressable><Pressable onPress={() => setScreen('home')}><Text style={styles.link}>Cancel</Text></Pressable></SafeAreaView>;
    return <SafeAreaView style={styles.camera}><CameraView style={StyleSheet.absoluteFill} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => onScanned(data)} /><View style={styles.scanOverlay}><Text style={styles.scanTitle}>Scan UPI QR</Text><View style={styles.scanBox} /><Text style={styles.scanHint}>{intent?.category ? `Purpose: ${intent.category}` : 'Point at a merchant UPI QR'}</Text>{!!scanError && <Text style={styles.scanError}>{scanError}</Text>}<Pressable style={styles.cancel} onPress={() => setScreen('home')}><Text style={styles.cancelText}>Cancel</Text></Pressable><Pressable onPress={() => setManualEntry(true)}><Text style={styles.scanAlt}>Enter UPI ID manually</Text></Pressable></View></SafeAreaView>;
  }

  if (screen === 'confirm' && qr) return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}><Text style={styles.brand}>VOICEUPI</Text><Pressable onPress={() => setScreen('scan')}><Text style={styles.link}>Back</Text></Pressable></View>
      <View style={styles.confirmCard}>
        <Text style={styles.eyebrow}>UPI HANDOFF · NOT YET PAID</Text>
        <Text style={styles.merchant} numberOfLines={2}>{qr.pn ?? 'UPI Merchant'}</Text>
        <Text style={styles.vpa} numberOfLines={1}>{qr.pa}</Text>
        <Text style={styles.purpose}>{categoryEdit.trim() || purposeEdit.trim() || 'Uncategorized'}</Text>
        <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="Amount" placeholderTextColor="#777" style={styles.amountInput} />
        <TextInput value={purposeEdit} onChangeText={setPurposeEdit} placeholder="Purpose (optional)" placeholderTextColor="#777" style={styles.editInput} maxLength={80} />
        <TextInput value={categoryEdit} onChangeText={setCategoryEdit} placeholder="Category (optional)" placeholderTextColor="#777" style={styles.editInput} maxLength={40} />
        <Text style={styles.note}>Payment happens in your UPI app, where you approve the exact amount. VoiceUPI never sees your UPI PIN and cannot confirm settlement.</Text>
        <Text style={styles.voiceHint}>Say “yes” to continue, “repeat” to hear the details, or “cancel”.</Text>
        <Pressable style={[styles.primary, paying && styles.disabled]} onPress={startPayment} disabled={paying}><Text style={styles.primaryText}>{paying ? 'Opening UPI…' : 'Continue to UPI'}</Text></Pressable>
      </View>
    </SafeAreaView>
  );

  if (screen === 'history') return <SafeAreaView style={styles.container}><View style={styles.header}><Text style={styles.brand}>HISTORY</Text><Pressable onPress={() => setScreen('home')}><Text style={styles.link}>Home</Text></Pressable></View><Text style={styles.total}>{money(manualTotal)}</Text><Text style={styles.muted}>{manualNotes.length} manual notes · never bank-verified</Text><Text style={styles.total}>{money(handoffTotal)}</Text><Text style={styles.muted}>{handoffs.length} UPI handoffs · {openHandoffs} initiated/pending · {failedHandoffs} failed · {verifiedHandoffs} callback-confirmed</Text><FlatList data={transactions} keyExtractor={x => x.id} contentContainerStyle={{ paddingBottom: 40 }} ListEmptyComponent={<Text style={styles.empty}>No transactions yet. Your manual notes and UPI handoffs will appear here.</Text>} renderItem={({ item }) => <Pressable style={styles.row} onPress={() => { setSelectedTx(item); setScreen('detail'); }}><View style={{ flex: 1 }}><Text style={styles.rowTitle} numberOfLines={2}>{item.category ?? item.purpose ?? 'Uncategorized'}</Text><Text style={styles.rowSub} numberOfLines={3}>{item.merchantName ?? item.merchantVpa ?? 'Manual expense'} · {formatDate(item.createdAt)} · {item.kind === 'manual_note' ? 'Manual note' : 'UPI handoff'}</Text></View><View><Text style={styles.rowAmount}>{money(item.amount)}</Text><Text style={styles.status}>{statusLabel(item)}</Text></View></Pressable>} /></SafeAreaView>;

  if (screen === 'detail' && selectedTx) {
    const tx = selectedTx;
    const isOpen = tx.kind === 'upi_handoff' && (tx.status === 'initiated' || tx.status === 'pending');
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}><Text style={styles.brand}>DETAILS</Text><Pressable onPress={() => setScreen('history')}><Text style={styles.link}>Back</Text></Pressable></View>
        <View style={styles.confirmCard}>
          <Text style={styles.eyebrow}>{tx.kind === 'manual_note' ? 'RECORDED NOTE · LOCAL ONLY' : 'UPI HANDOFF · NOT BANK-VERIFIED'}</Text>
          <Text style={styles.merchant} numberOfLines={2}>{tx.category ?? tx.purpose ?? 'Uncategorized'}</Text>
          <Text style={styles.vpa} numberOfLines={2}>{tx.merchantName ?? tx.merchantVpa ?? 'Manual expense'}</Text>
          <Text style={styles.rowAmount}>{money(tx.amount)}</Text>
          <Text style={styles.status}>{statusLabel(tx)} · {formatDate(tx.createdAt)}</Text>
          {!!tx.rawCommand && <Text style={styles.note} numberOfLines={3}>You said: “{tx.rawCommand}”</Text>}
          {isOpen && <Text style={styles.note}>Check your UPI app to see whether this payment went through. VoiceUPI cannot verify it — this record stays unverified unless your UPI app confirms it.</Text>}
          {isOpen && (
            <Pressable
              style={styles.primary}
              onPress={() => {
                Alert.alert('Mark as failed?', 'This only updates your local record. It does not affect your bank.', [
                  { text: 'Keep', style: 'cancel' },
                  {
                    text: 'Mark failed', style: 'destructive',
                    onPress: () => {
                      updateTransaction(tx.id, { status: 'failed' }).then(refresh).catch(() => {
                        Alert.alert('Could not save', 'Storage may be unavailable — try again.');
                      });
                      setSelectedTx({ ...tx, status: 'failed' });
                    },
                  },
                ]);
              }}
            >
              <Text style={styles.primaryText}>Mark as failed</Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => {
              Alert.alert('Delete record?', 'This removes the local record permanently.', [
                { text: 'Keep', style: 'cancel' },
                {
                  text: 'Delete', style: 'destructive',
                  onPress: () => {
                    deleteTransaction(tx.id).then(refresh).catch(() => {
                      Alert.alert('Could not delete', 'Storage may be unavailable — try again.');
                    });
                    setSelectedTx(null);
                    setScreen('history');
                  },
                },
              ]);
            }}
          >
            <Text style={styles.danger}>Delete record</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const recent = useMemo(() => transactions.slice(0, 3), [transactions]);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <View><Text style={styles.brand}>VOICEUPI</Text><Text style={styles.tagline}>Say what you&apos;re paying for.</Text></View>
        <View style={styles.headerLinks}>
          <Pressable onPress={toggleMute}><Text style={styles.link}>{muted ? 'Unmute' : 'Mute'}</Text></Pressable>
          <Pressable onPress={() => setScreen('history')}><Text style={styles.link}>History</Text></Pressable>
        </View>
      </View>
      <View style={styles.hero}>
        <Text style={styles.heroTitle}>What are you paying for?</Text>
        <Text style={styles.heroSub}>Speak naturally. We turn your words into payment intent.</Text>
        <VoiceButton onResult={handleVoice} />
        <View style={styles.examples}>
          <Text style={styles.example}>“Pay 250 rupees to name@bank”</Text>
          <Text style={styles.example}>“Pay 120 using this QR code”</Text>
          <Text style={styles.example}>“Show my recent transactions”</Text>
        </View>
      </View>
      {!!awaiting && (
        <View style={styles.clarifyCard}>
          <Text style={styles.eyebrow}>NEED MORE INFORMATION</Text>
          <Text style={styles.clarifyQ}>{clarifyMsg ?? 'One more detail needed.'}</Text>
          {awaiting === 'amount' ? (
            <TextInput value={clarifyAmount} onChangeText={setClarifyAmount} keyboardType="decimal-pad" placeholder="Amount" placeholderTextColor="#777" style={styles.editInput} maxLength={12} returnKeyType="done" onSubmitEditing={submitClarify} />
          ) : (
            <TextInput value={clarifyVpa} onChangeText={setClarifyVpa} placeholder="name@bank" placeholderTextColor="#777" style={styles.editInput} autoCapitalize="none" autoCorrect={false} maxLength={100} returnKeyType="done" onSubmitEditing={submitClarify} />
          )}
          <View style={styles.clarifyRow}>
            <Pressable style={[styles.primary, styles.clarifyBtn]} onPress={submitClarify}><Text style={styles.primaryText}>Continue</Text></Pressable>
            <Pressable style={[styles.cancel, styles.clarifyBtn]} onPress={resetFlow}><Text style={styles.cancelText}>Cancel</Text></Pressable>
          </View>
        </View>
      )}
      {transactions.length > 0 && (
        <View style={styles.recent}>
          <View style={styles.recentHead}>
            <Text style={styles.recentTitle}>Recent</Text>
            <Pressable onPress={() => setScreen('history')}><Text style={styles.link}>View all</Text></Pressable>
          </View>
          {recent.map(item => (
            <Pressable
              key={item.id}
              style={styles.recentRow}
              onPress={() => { setSelectedTx(item); setScreen('detail'); }}
            >
              <Text style={styles.recentText} numberOfLines={1}>{item.category ?? item.purpose ?? 'Uncategorized'}</Text>
              <Text style={styles.recentAmount}>{money(item.amount)}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <View style={styles.footer}><Text style={styles.privacy}>Local-first MVP · No bank credentials · No UPI PIN</Text></View>
    </SafeAreaView>
  );
}

function cryptoRandom() { return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F7F4EE', paddingHorizontal: 22, width: '100%', maxWidth: 640, alignSelf: 'center' },
  center: { flex: 1, backgroundColor: '#F7F4EE', alignItems: 'center', justifyContent: 'center', gap: 18, padding: 24 },
  camera: { flex: 1, backgroundColor: '#000' },
  header: { paddingTop: 18, paddingBottom: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  brand: { fontSize: 15, fontWeight: '900', letterSpacing: 3, color: '#171717' },
  tagline: { color: '#777168', marginTop: 3, fontSize: 12 },
  link: { color: '#4A463F', fontWeight: '700' },
  headerLinks: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  clarifyCard: { backgroundColor: '#FFFDF8', borderRadius: 20, padding: 18, marginBottom: 14, borderWidth: 1, borderColor: '#E3DDD2' },
  clarifyQ: { fontSize: 17, fontWeight: '700', color: '#171717', marginTop: 8 },
  clarifyRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  clarifyBtn: { flex: 1 },
  recent: { marginBottom: 12 },
  recentHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  recentTitle: { fontSize: 13, fontWeight: '800', letterSpacing: 2, color: '#918A7E' },
  recentRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#E3DDD2' },
  recentText: { fontWeight: '700', fontSize: 14, color: '#171717', flex: 1, paddingRight: 10 },
  recentAmount: { fontWeight: '800', fontSize: 14, color: '#171717' },
  voiceHint: { color: '#8B877E', fontSize: 12, lineHeight: 17, marginBottom: 12 },
  danger: { color: '#A33A2E', fontWeight: '700', textAlign: 'center', marginTop: 16, paddingVertical: 12 },
  linkCenter: { color: '#4A463F', fontWeight: '700', textAlign: 'center', marginTop: 16, paddingVertical: 12 },
  gap: { height: 12 },
  scanAlt: { color: '#FFF', fontWeight: '700', marginTop: 14, paddingVertical: 12 },
  hero: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  heroTitle: { fontSize: 29, fontWeight: '800', color: '#171717', textAlign: 'center', marginBottom: 10 },
  heroSub: { fontSize: 14, lineHeight: 21, color: '#777168', textAlign: 'center', maxWidth: 320, marginBottom: 36 },
  examples: { marginTop: 30, gap: 10, alignItems: 'center' },
  example: { color: '#777168', fontSize: 13, fontStyle: 'italic' },
  footer: { paddingBottom: 18, alignItems: 'center' },
  privacy: { color: '#9A958B', fontSize: 11 },
  primary: { backgroundColor: '#171717', paddingVertical: 15, paddingHorizontal: 24, borderRadius: 14, alignItems: 'center' },
  primaryText: { color: '#FFF', fontWeight: '800' },
  title: { fontSize: 24, fontWeight: '800' },
  confirmCard: { backgroundColor: '#FFFDF8', borderRadius: 24, padding: 24, marginTop: 35, borderWidth: 1, borderColor: '#E3DDD2' },
  eyebrow: { fontSize: 11, letterSpacing: 2, color: '#918A7E', fontWeight: '800' },
  merchant: { fontSize: 27, fontWeight: '800', marginTop: 10, color: '#171717' },
  vpa: { color: '#8B877E', marginTop: 4 },
  purpose: { marginTop: 24, backgroundColor: '#EEE9DF', alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 99, fontWeight: '700', color: '#4A463F' },
  amountInput: { marginTop: 22, borderWidth: 1, borderColor: '#D8D0C3', borderRadius: 14, padding: 15, fontSize: 23, fontWeight: '700', color: '#171717' },
  editInput: { marginTop: 12, borderWidth: 1, borderColor: '#D8D0C3', borderRadius: 14, padding: 13, fontSize: 15, fontWeight: '600', color: '#171717' },
  disabled: { opacity: 0.6 },
  empty: { color: '#8B877E', fontSize: 14, textAlign: 'center', marginTop: 40, lineHeight: 22 },
  note: { color: '#8B877E', fontSize: 12, lineHeight: 18, marginVertical: 18 },
  scanOverlay: { flex: 1, alignItems: 'center', justifyContent: 'space-between', paddingTop: 55, paddingBottom: 30 },
  scanTitle: { color: '#FFF', fontSize: 25, fontWeight: '800' },
  scanBox: { width: 270, height: 270, borderWidth: 3, borderColor: '#FFF', borderRadius: 24 },
  scanHint: { color: '#FFF', fontSize: 15, fontWeight: '700', backgroundColor: 'rgba(0,0,0,.45)', padding: 10, borderRadius: 12 },
  scanError: { color: '#FFD9D9', fontSize: 13, fontWeight: '700', backgroundColor: 'rgba(0,0,0,.55)', padding: 10, borderRadius: 12, textAlign: 'center' },
  cancel: { backgroundColor: '#FFF', paddingHorizontal: 28, paddingVertical: 13, borderRadius: 14 },
  cancelText: { color: '#171717', fontWeight: '800' },
  total: { fontSize: 40, fontWeight: '900', color: '#171717', marginTop: 25 },
  muted: { color: '#8B877E', marginBottom: 20 },
  row: { paddingVertical: 17, borderBottomWidth: 1, borderBottomColor: '#E3DDD2', flexDirection: 'row' },
  rowTitle: { fontWeight: '800', fontSize: 16, color: '#171717' },
  rowSub: { color: '#8B877E', marginTop: 5, fontSize: 11, paddingRight: 10 },
  rowAmount: { fontWeight: '800', textAlign: 'right' },
  status: { color: '#8B877E', fontSize: 10, textAlign: 'right', marginTop: 4 }
});
