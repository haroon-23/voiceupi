import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import jsQR from 'jsqr';

type WebQrScannerProps = {
  hint: string;
  error: string | null;
  onScanned: (data: string) => void;
  onManualEntry: () => void;
  onCancel: () => void;
};

type CameraState = 'checking' | 'ready' | 'denied' | 'unavailable';

// Web-only QR scanner (rendered only when Platform.OS === 'web').
// Uses getUserMedia + canvas frame capture + jsQR decoding. The parent owns
// validation (parseUpiUri), single-handle-per-session, and error rate-limiting;
// this component just delivers decoded strings and manages camera lifecycle.
export default function WebQrScanner({ hint, error, onScanned, onManualEntry, onCancel }: WebQrScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [cameraState, setCameraState] = useState<CameraState>('checking');
  const [attempt, setAttempt] = useState(0);
  const onScannedRef = useRef(onScanned);
  onScannedRef.current = onScanned;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let lastTick = 0;
    let cancelled = false;
    // getUserMedia hang protection: never leave the user on a spinner forever.
    const timeout = setTimeout(() => {
      if (!cancelled) setCameraState(prev => (prev === 'checking' ? 'unavailable' : prev));
    }, 15000);

    async function setup() {
      try {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
          if (!cancelled) setCameraState('unavailable');
          return;
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        const video = videoRef.current;
        if (!video || cancelled) {
          // Late resolution after timeout/unmount: release the camera immediately.
          for (const track of stream.getTracks()) track.stop();
          stream = null;
          return;
        }
        video.srcObject = stream;
        await video.play();
        if (!cancelled) setCameraState('ready');
      } catch (e) {
        if (cancelled) return;
        if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
          setCameraState('denied');
        } else {
          setCameraState('unavailable');
        }
        return;
      }

      const tick = (now: number) => {
        if (cancelled) return;
        if (now - lastTick > 500) {
          lastTick = now;
          const video = videoRef.current;
          const canvas = canvasRef.current;
          if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
            const w = video.videoWidth;
            const h = video.videoHeight;
            if (w > 0 && h > 0) {
              canvas.width = w;
              canvas.height = h;
              const ctx = canvas.getContext('2d', { willReadFrequently: true });
              if (ctx) {
                ctx.drawImage(video, 0, 0, w, h);
                const imageData = ctx.getImageData(0, 0, w, h);
                const code = jsQR(imageData.data, w, h);
                // Parent guards duplicates/invalid codes; keep the loop alive so a
                // rejected QR can be retried without reopening the camera.
                if (code?.data) onScannedRef.current(code.data);
              }
            }
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    setup();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      cancelAnimationFrame(raf);
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
        stream = null;
      }
    };
  }, [attempt]);

  // The <video> element must stay mounted from the first render: setup()
  // attaches the stream to it, so hiding it behind a loading screen would
  // leave videoRef.current null and stall on "Starting camera…" forever.
  if (cameraState === 'denied' || cameraState === 'unavailable') {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>
          {cameraState === 'denied' ? 'Camera access denied' : 'Camera unavailable'}
        </Text>
        <Text style={styles.body}>
          {cameraState === 'denied'
            ? 'Allow camera access in Safari settings to scan QR codes, or enter the UPI ID manually.'
            : 'This browser could not open the camera. Enter the UPI ID manually instead.'}
        </Text>
        <Pressable onPress={onManualEntry} style={styles.primary}>
          <Text style={styles.primaryText}>Enter UPI ID manually</Text>
        </Pressable>
        <Pressable onPress={() => { setCameraState('checking'); setAttempt(a => a + 1); }}><Text style={styles.link}>Try again</Text></Pressable>
        <Pressable onPress={onCancel}><Text style={styles.link}>Cancel</Text></Pressable>
      </View>
    );
  }

  return (
    <View style={styles.camera}>
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover', display: cameraState === 'ready' ? 'block' : 'none' }}
      />
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      {cameraState === 'checking' ? (
        <View style={styles.loadingOverlay}>
          <Text style={styles.scanTitle}>Starting camera…</Text>
          <Pressable onPress={onCancel}><Text style={styles.scanAlt}>Cancel</Text></Pressable>
        </View>
      ) : (
        <View style={styles.overlay}>
          <Text style={styles.scanTitle}>Scan UPI QR</Text>
          <View style={styles.scanBox} />
          <Text style={styles.scanHint}>{hint}</Text>
          {!!error && <Text style={styles.scanError}>{error}</Text>}
          <Pressable onPress={onCancel} style={styles.cancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable onPress={onManualEntry}>
            <Text style={styles.scanAlt}>Enter UPI ID manually</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  camera: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, backgroundColor: '#F7F4EE', alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { fontSize: 24, fontWeight: '800', color: '#171717', textAlign: 'center' },
  body: { color: '#777168', fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 12, marginBottom: 24, maxWidth: 340 },
  link: { color: '#4A463F', fontWeight: '700', marginTop: 16, paddingVertical: 12 },
  primary: { backgroundColor: '#171717', paddingVertical: 15, paddingHorizontal: 24, borderRadius: 14, alignItems: 'center', width: '100%', maxWidth: 340 },
  primaryText: { color: '#FFF', fontWeight: '800' },
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'space-between', paddingTop: 55, paddingBottom: 30 },
  loadingOverlay: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scanTitle: { color: '#FFF', fontSize: 25, fontWeight: '800' },
  scanBox: { width: 270, height: 270, borderWidth: 3, borderColor: '#FFF', borderRadius: 24 },
  scanHint: { color: '#FFF', fontSize: 15, fontWeight: '700', backgroundColor: 'rgba(0,0,0,.45)', padding: 10, borderRadius: 12 },
  scanError: { color: '#FFD9D9', fontSize: 13, fontWeight: '700', backgroundColor: 'rgba(0,0,0,.55)', padding: 10, borderRadius: 12, textAlign: 'center' },
  cancel: { backgroundColor: '#FFF', paddingHorizontal: 28, paddingVertical: 13, borderRadius: 14 },
  cancelText: { color: '#171717', fontWeight: '800' },
  scanAlt: { color: '#FFF', fontWeight: '700', marginTop: 14, paddingVertical: 12 },
});
