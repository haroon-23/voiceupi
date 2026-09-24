import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';

type VoiceButtonProps = {
  onResult: (text: string) => void;
};

export default function VoiceButton({ onResult }: VoiceButtonProps) {
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [manualText, setManualText] = useState('');
  const [speechUnsupported, setSpeechUnsupported] = useState(false);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const finalRef = useRef(false);
  const userStoppedRef = useRef(false);
  const startingRef = useRef(false);

  // Web-only capability probe. Never assumes recognition exists: iPhone Safari
  // and many desktop browsers lack the Web Speech recognition API, in which
  // case the component falls back to manual text input below.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    try {
      if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
        setSpeechUnsupported(true);
      }
    } catch {
      setSpeechUnsupported(true);
    }
  }, []);

  useSpeechRecognitionEvent('start', () => {
    startingRef.current = false;
    setListening(true);
    setError(null);
    finalRef.current = false;
    userStoppedRef.current = false;
  });

  useSpeechRecognitionEvent('end', () => {
    startingRef.current = false;
    setListening(false);
    if (!finalRef.current && !userStoppedRef.current) {
      setError("Didn't catch that. Try again.");
    }
  });

  useSpeechRecognitionEvent('result', event => {
    const transcript = event.results[0]?.transcript ?? '';
    if (!transcript.trim()) return;
    setHeard(transcript);
    if (event.isFinal) {
      finalRef.current = true;
      onResultRef.current(transcript.trim());
    }
  });

  useSpeechRecognitionEvent('nomatch', () => {
    setError("Couldn't understand that. Try again.");
  });

  useSpeechRecognitionEvent('error', event => {
    startingRef.current = false;
    setListening(false);
    if (event.error === 'aborted' || event.error === 'busy') return;
    if (event.error === 'not-allowed') {
      setError('Microphone permission is needed for voice commands.');
      return;
    }
    if (event.error === 'no-speech') {
      if (!userStoppedRef.current) setError("Didn't catch that. Try again.");
      return;
    }
    setError(event.message || 'Speech recognition failed. Try again.');
  });

  function submitManual() {
    const text = manualText.trim();
    if (!text) {
      setError('Type your payment command first.');
      return;
    }
    setError(null);
    setHeard(text);
    onResultRef.current(text);
  }

  async function toggle() {    if (startingRef.current) return;
    if (listening) {
      userStoppedRef.current = true;
      ExpoSpeechRecognitionModule.stop();
      return;
    }
    setHeard('');
    setError(null);
    startingRef.current = true;
    try {
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!permission.granted) {
        startingRef.current = false;
        setError('Microphone permission is needed for voice commands. Allow it in Settings to use voice input.');
        return;
      }
      ExpoSpeechRecognitionModule.start({
        lang: 'en-IN',
        interimResults: true,
        continuous: false,
        maxAlternatives: 1,
      });
    } catch {
      startingRef.current = false;
      setListening(false);
      setError('Could not start speech recognition.');
    }
  }

  return (
    <View style={styles.wrap}>
      {speechUnsupported ? (
        <View style={styles.manualWrap}>
          <Text style={styles.fallback}>Voice input isn&apos;t supported in this browser. Type your payment command instead.</Text>
          <TextInput
            value={manualText}
            onChangeText={setManualText}
            placeholder="e.g. Pay ₹500 for lunch"
            placeholderTextColor="#777"
            style={styles.manualInput}
            maxLength={200}
            onSubmitEditing={submitManual}
            returnKeyType="done"
          />
          <Pressable onPress={submitManual} style={styles.submit}>
            <Text style={styles.submitText}>Use this command</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable onPress={toggle} style={[styles.button, listening && styles.active]}>
          <Text style={styles.mic}>{listening ? '■' : '●'}</Text>
          <Text style={styles.label}>{listening ? 'Listening…' : 'Speak payment'}</Text>
        </Pressable>
      )}
      {!!heard && <Text style={styles.heard}>“{heard}”</Text>}
      {!!error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', width: '100%' },
  button: { width: 190, height: 190, borderRadius: 95, backgroundColor: '#F4F0E8', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#D7D0C2' },
  active: { transform: [{ scale: 1.04 }], backgroundColor: '#E8E0D1' },
  mic: { fontSize: 36, color: '#171717', marginBottom: 10 },
  label: { fontSize: 18, fontWeight: '700', color: '#171717' },
  heard: { marginTop: 16, color: '#8B877E', textAlign: 'center', fontSize: 15 },
  error: { marginTop: 8, color: '#8B877E', textAlign: 'center', fontSize: 13 },
  manualWrap: { width: '100%', maxWidth: 420, alignItems: 'stretch' },
  fallback: { color: '#8B877E', fontSize: 13, lineHeight: 19, textAlign: 'center', marginBottom: 12 },
  manualInput: { borderWidth: 1, borderColor: '#D7D0C2', borderRadius: 14, padding: 15, fontSize: 16, color: '#171717', backgroundColor: '#FFFDF8' },
  submit: { marginTop: 12, backgroundColor: '#171717', paddingVertical: 15, paddingHorizontal: 24, borderRadius: 14, alignItems: 'center' },
  submitText: { color: '#FFF', fontWeight: '800' }
});
