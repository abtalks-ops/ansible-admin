"use client";
// Speech input (Web Speech API, with a Whisper fallback via MediaRecorder) and speech output.
import { useCallback, useEffect, useRef, useState } from "react";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Mode = "webspeech" | "whisper" | "none";

export function useSpeechInput(onFinal: (text: string) => void, onInterim: (text: string) => void) {
  const [mode, setMode] = useState<Mode>("none");
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<any>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const finalRef = useRef(onFinal);
  const interimRef = useRef(onInterim);
  finalRef.current = onFinal;
  interimRef.current = onInterim;

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SR) return setMode("webspeech");
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices) return;
    fetch("/api/transcribe")
      .then((r) => r.json())
      .then((d) => d.enabled && setMode("whisper"))
      .catch(() => {});
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (mode === "webspeech") {
      const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      const rec = new SR();
      rec.lang = navigator.language || "en-US";
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (e: any) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalRef.current(r[0].transcript.trim());
          else interim += r[0].transcript;
        }
        interimRef.current(interim);
      };
      rec.onerror = (e: any) => {
        if (e.error !== "no-speech" && e.error !== "aborted") setError(`Speech error: ${e.error}`);
      };
      rec.onend = () => {
        setListening(false);
        interimRef.current("");
      };
      recRef.current = rec;
      rec.start();
      setListening(true);
    } else if (mode === "whisper") {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const chunks: Blob[] = [];
        const mr = new MediaRecorder(stream);
        mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        mr.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          setListening(false);
          interimRef.current("transcribing…");
          const fd = new FormData();
          fd.append("audio", new Blob(chunks, { type: mr.mimeType }));
          try {
            const r = await fetch("/api/transcribe", { method: "POST", body: fd });
            const d = await r.json();
            if (d.text) finalRef.current(d.text);
            else if (d.error) setError(d.error);
          } catch {
            setError("Transcription request failed");
          } finally {
            interimRef.current("");
          }
        };
        mediaRef.current = mr;
        mr.start();
        setListening(true);
      } catch {
        setError("Microphone permission denied");
      }
    }
  }, [mode]);

  const stop = useCallback(() => {
    recRef.current?.stop();
    if (mediaRef.current?.state === "recording") mediaRef.current.stop();
  }, []);

  return { supported: mode !== "none", mode, listening, error, start, stop };
}

/** Turns Markdown into something pleasant to hear: code is announced, not read. */
export function speakableText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " (code block shown on screen) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_~>|]/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\n{2,}/g, ". ")
    .trim();
}

export function speak(md: string, onEnd?: () => void) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const text = speakableText(md);
  // Long utterances get cut off in some browsers, so speak sentence groups.
  const parts = text.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [text];
  const voices = window.speechSynthesis.getVoices();
  const voice = voices.find((v) => /en/i.test(v.lang) && /google|natural|daniel|samantha/i.test(v.name)) ?? voices.find((v) => /en/i.test(v.lang));
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p.trim());
    if (voice) u.voice = voice;
    u.rate = 1.05;
    if (i === parts.length - 1 && onEnd) u.onend = onEnd;
    window.speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  if (typeof window !== "undefined") window.speechSynthesis?.cancel();
}
