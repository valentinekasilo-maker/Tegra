import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Mic,
  MicOff,
  Keyboard,
  Volume2,
  RotateCcw,
  Send,
  X,
  Play,
  Square,
  AlertCircle,
  MessageSquare,
  Settings,
  Check,
  Trash2,
} from "lucide-react";
import {
  VoiceOrbVisualizer,
  AgentSessionState,
} from "./components/VoiceOrbVisualizer";
import { VOICE_OPTIONS, VoiceName } from "./data/personas";
import {
  float32ToPcm16Base64,
  pcm24kBase64ToFloat32,
  computeRmsLevel,
} from "./utils/audio";
import { setupGlobalHaptics, triggerHaptic } from "./utils/haptics";

export interface ExchangeItem {
  id: string;
  userText: string;
  agentText: string;
  timestamp: string;
  voiceName: VoiceName;
  audioBase64?: string;
}

const HELLO_GREETINGS = [
  "hello",
  "hola",
  "bonjour",
  "ciao",
  "こんにちは",
  "안녕하세요",
  "مرحبا",
  "hallo",
];

const SYSTEM_INSTRUCTION =
  "You are Tegra, a warm, natural, Siri-like voice assistant. Always respond in 1 to 2 concise, conversational sentences designed to be spoken out loud. Never use markdown bullet points, asterisks, or formatting symbols.";

function formatTime(date: Date = new Date()): string {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Iconic Apple iPhone-style continuous cursive "hello" SVG path with animated stroke drawing
 */
function AppleStyleHelloSvg({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 460 150"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="hello"
    >
      <defs>
        <linearGradient id="helloStrokeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="55%" stopColor="#e0f2fe" />
          <stop offset="100%" stopColor="#7dd3fc" />
        </linearGradient>
      </defs>
      <path
        d="M 38 108 C 58 92, 92 42, 84 22 C 76 6, 58 28, 56 66 C 54 96, 54 114, 56 116 C 58 100, 76 74, 94 76 C 110 78, 104 112, 120 112 C 136 112, 166 96, 172 78 C 176 66, 158 62, 148 76 C 136 92, 144 114, 172 112 C 202 110, 238 46, 232 20 C 226 4, 206 26, 204 72 C 202 104, 212 114, 234 112 C 264 108, 298 46, 292 20 C 286 4, 266 26, 264 72 C 262 104, 274 114, 300 112 C 322 110, 336 86, 356 84 C 378 82, 386 112, 360 114 C 334 116, 328 86, 354 78 C 378 72, 398 84, 420 76"
        stroke="url(#helloStrokeGrad)"
        strokeWidth="7.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="animate-hello-stroke"
      />
    </svg>
  );
}

export default function App() {
  const [isBooting, setIsBooting] = useState<boolean>(true);
  const [greetingIndex, setGreetingIndex] = useState<number>(0);

  const [selectedVoice, setSelectedVoice] = useState<VoiceName>("Zephyr");
  const [sessionState, setSessionState] = useState<AgentSessionState>("idle");
  const [isLiveConnected, setIsLiveConnected] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [inputLevel, setInputLevel] = useState<number>(0);
  const [outputLevel, setOutputLevel] = useState<number>(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Current Siri-style screen caption + modals
  const [currentPrompt, setCurrentPrompt] = useState<string>("");
  const [currentReply, setCurrentReply] = useState<string>("");
  const [currentAudioBase64, setCurrentAudioBase64] = useState<
    string | undefined
  >(undefined);
  const [history, setHistory] = useState<ExchangeItem[]>([]);
  const [showKeyboard, setShowKeyboard] = useState<boolean>(false);
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  const [settingsTab, setSettingsTab] = useState<"voices" | "history">(
    "voices"
  );
  const [textInput, setTextInput] = useState<string>("");
  const [playingId, setPlayingId] = useState<string | null>(null);

  // Refs for real-time audio & WebSocket callbacks
  const wsRef = useRef<WebSocket | null>(null);
  const isMutedRef = useRef<boolean>(false);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const liveUserDraftRef = useRef<string>("");
  const liveAgentDraftRef = useRef<string>("");
  const selectedVoiceRef = useRef<VoiceName>(selectedVoice);
  const waitingForLiveReplyRef = useRef<boolean>(false);

  // Initialize universal tactile haptic vibration listener on mount
  useEffect(() => {
    const cleanupHaptics = setupGlobalHaptics();
    return cleanupHaptics;
  }, []);

  // iPhone-style boot "hello" screen transition
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setIsBooting(false);
    }, 2200);
    return () => clearTimeout(timer);
  }, []);

  // Subtle cycling of international "hello" greetings on idle screen
  useEffect(() => {
    const interval = window.setInterval(() => {
      setGreetingIndex((prev) => (prev + 1) % HELLO_GREETINGS.length);
    }, 3200);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    selectedVoiceRef.current = selectedVoice;
  }, [selectedVoice]);

  const getOutputAudioContext = useCallback(async (): Promise<AudioContext> => {
    if (
      !outputAudioCtxRef.current ||
      outputAudioCtxRef.current.state === "closed"
    ) {
      const AudioCtx =
        window.AudioContext || (window as any).webkitAudioContext;
      outputAudioCtxRef.current = new AudioCtx({ sampleRate: 24000 });
    }
    if (outputAudioCtxRef.current.state === "suspended") {
      await outputAudioCtxRef.current.resume();
    }
    return outputAudioCtxRef.current;
  }, []);

  const stopOutputPlayback = useCallback(() => {
    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
        src.disconnect();
      } catch {}
    }
    activeSourcesRef.current = [];
    nextStartTimeRef.current = 0;
    setOutputLevel(0);
    setPlayingId(null);
  }, []);

  const playPcm24kChunk = useCallback(
    async (base64Data: string, onComplete?: () => void) => {
      try {
        const audioCtx = await getOutputAudioContext();
        const float32Samples = pcm24kBase64ToFloat32(base64Data);
        if (float32Samples.length === 0) {
          onComplete?.();
          return;
        }

        const level = computeRmsLevel(float32Samples);
        setOutputLevel(level);
        setSessionState("speaking");

        const audioBuffer = audioCtx.createBuffer(
          1,
          float32Samples.length,
          24000
        );
        audioBuffer.getChannelData(0).set(float32Samples);

        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioCtx.destination);

        const now = audioCtx.currentTime;
        const startTime = Math.max(now + 0.015, nextStartTimeRef.current);
        source.start(startTime);
        nextStartTimeRef.current = startTime + audioBuffer.duration;

        activeSourcesRef.current.push(source);

        source.onended = () => {
          activeSourcesRef.current = activeSourcesRef.current.filter(
            (s) => s !== source
          );
          if (activeSourcesRef.current.length === 0) {
            setOutputLevel(0);
            setSessionState((prev) =>
              wsRef.current && wsRef.current.readyState === WebSocket.OPEN
                ? "listening"
                : prev === "speaking"
                ? "idle"
                : prev
            );
            onComplete?.();
          }
        };
      } catch (err) {
        console.error("Audio playback error:", err);
        onComplete?.();
      }
    },
    [getOutputAudioContext]
  );

  const commitLiveTurnToHistory = useCallback(() => {
    const u = liveUserDraftRef.current.trim();
    const a = liveAgentDraftRef.current.trim();
    if (u && a) {
      setHistory((prev) => [
        {
          id: `turn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          userText: u,
          agentText: a,
          timestamp: formatTime(),
          voiceName: selectedVoiceRef.current,
        },
        ...prev,
      ]);
      liveUserDraftRef.current = "";
      liveAgentDraftRef.current = "";
    }
  }, []);

  const stopLiveSession = useCallback(() => {
    commitLiveTurnToHistory();
    stopOutputPlayback();
    waitingForLiveReplyRef.current = false;

    if (scriptProcessorRef.current) {
      try {
        scriptProcessorRef.current.disconnect();
      } catch {}
      scriptProcessorRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    if (
      inputAudioCtxRef.current &&
      inputAudioCtxRef.current.state !== "closed"
    ) {
      inputAudioCtxRef.current.close().catch(() => {});
      inputAudioCtxRef.current = null;
    }

    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }

    if (!liveAgentDraftRef.current.trim()) {
      setCurrentReply((prevReply) => {
        if (!prevReply) {
          setCurrentPrompt("");
        }
        return prevReply;
      });
    }

    setIsLiveConnected(false);
    setSessionState("idle");
    setInputLevel(0);
    setOutputLevel(0);
  }, [commitLiveTurnToHistory, stopOutputPlayback]);

  const startLiveSession = useCallback(async () => {
    setErrorMessage(null);
    stopOutputPlayback();
    setSessionState("connecting");

    try {
      await getOutputAudioContext();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      const AudioCtx =
        window.AudioContext || (window as any).webkitAudioContext;
      const inputCtx = new AudioCtx({ sampleRate: 16000 });
      inputAudioCtxRef.current = inputCtx;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const params = new URLSearchParams({
        voice: selectedVoice,
        instruction: SYSTEM_INSTRUCTION,
      });
      const ws = new WebSocket(
        `${protocol}//${window.location.host}/api/live-ws?${params.toString()}`
      );
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === "connected") {
            setIsLiveConnected(true);
            setSessionState("listening");
            liveUserDraftRef.current = "";
            liveAgentDraftRef.current = "";
            waitingForLiveReplyRef.current = false;

            const source = inputCtx.createMediaStreamSource(stream);
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = processor;

            processor.onaudioprocess = (audioEvent) => {
              if (
                !wsRef.current ||
                wsRef.current.readyState !== WebSocket.OPEN
              ) {
                return;
              }
              if (isMutedRef.current || waitingForLiveReplyRef.current) {
                setInputLevel(0);
                return;
              }
              const channelData = audioEvent.inputBuffer.getChannelData(0);
              const rms = computeRmsLevel(channelData);
              setInputLevel(rms);

              const base64Audio = float32ToPcm16Base64(
                channelData,
                inputCtx.sampleRate
              );
              wsRef.current.send(JSON.stringify({ audio: base64Audio }));
            };

            source.connect(processor);
            processor.connect(inputCtx.destination);
          } else if (msg.type === "inputTranscript" && msg.text) {
            if (liveAgentDraftRef.current) {
              commitLiveTurnToHistory();
            }
            liveUserDraftRef.current += msg.text;
            setCurrentPrompt(liveUserDraftRef.current.trim());
            setCurrentReply("");
            setCurrentAudioBase64(undefined);
          } else if (msg.type === "outputTranscript" && msg.text) {
            waitingForLiveReplyRef.current = false;
            liveAgentDraftRef.current += msg.text;
            setCurrentReply(liveAgentDraftRef.current.trim());
          } else if (msg.type === "audio" && msg.audio) {
            waitingForLiveReplyRef.current = false;
            playPcm24kChunk(msg.audio);
          } else if (msg.type === "interrupted") {
            waitingForLiveReplyRef.current = false;
            stopOutputPlayback();
            commitLiveTurnToHistory();
            setSessionState("listening");
          } else if (msg.type === "turnComplete") {
            waitingForLiveReplyRef.current = false;
            commitLiveTurnToHistory();
            if (activeSourcesRef.current.length === 0) {
              setSessionState("listening");
            }
          } else if (msg.type === "error") {
            setErrorMessage(
              msg.message || "Voice connection interrupted. Try again."
            );
            stopLiveSession();
          } else if (msg.type === "closed") {
            stopLiveSession();
          }
        } catch (e) {
          console.error("WebSocket message error:", e);
        }
      };

      ws.onerror = () => {
        setErrorMessage(
          "Could not establish live microphone stream. You can also type below."
        );
        stopLiveSession();
      };

      ws.onclose = () => {
        stopLiveSession();
      };
    } catch (err: any) {
      setErrorMessage(
        err?.name === "NotAllowedError"
          ? "Microphone access was blocked. Allow microphone permission in your browser, or type a question below."
          : err?.message || "Could not start microphone."
      );
      stopLiveSession();
    }
  }, [
    commitLiveTurnToHistory,
    getOutputAudioContext,
    playPcm24kChunk,
    selectedVoice,
    stopLiveSession,
    stopOutputPlayback,
  ]);

  useEffect(() => {
    return () => {
      stopLiveSession();
    };
  }, [stopLiveSession]);

  // Ask a prompt via text input (speaks back immediately)
  const askTegra = useCallback(
    async (promptText: string) => {
      const trimmed = promptText.trim();
      if (!trimmed) return;

      setErrorMessage(null);
      setCurrentPrompt(trimmed);
      setCurrentReply("");
      setCurrentAudioBase64(undefined);

      if (
        isLiveConnected &&
        wsRef.current &&
        wsRef.current.readyState === WebSocket.OPEN
      ) {
        liveUserDraftRef.current = trimmed;
        liveAgentDraftRef.current = "";
        waitingForLiveReplyRef.current = true;
        wsRef.current.send(JSON.stringify({ text: trimmed }));
        setSessionState("thinking");
        return;
      }

      stopOutputPlayback();
      setSessionState("thinking");

      try {
        await getOutputAudioContext();
        const flatHistory = history
          .slice(0, 6)
          .reverse()
          .flatMap((h) => [
            { role: "user", text: h.userText },
            { role: "agent", text: h.agentText },
          ]);

        const response = await fetch("/api/voice-turn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: trimmed,
            history: flatHistory,
            voiceName: selectedVoice,
            systemInstruction: SYSTEM_INSTRUCTION,
          }),
        });

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "Could not reach voice assistant.");
        }

        setCurrentReply(data.replyText);
        setCurrentAudioBase64(data.audioBase64 || undefined);

        const newItem: ExchangeItem = {
          id: `turn-${Date.now()}`,
          userText: trimmed,
          agentText: data.replyText,
          timestamp: formatTime(),
          voiceName: selectedVoice,
          audioBase64: data.audioBase64 || undefined,
        };
        setHistory((prev) => [newItem, ...prev]);

        if (data.audioBase64) {
          await playPcm24kChunk(data.audioBase64, () => {
            setSessionState("idle");
          });
        } else {
          setSessionState("idle");
        }
      } catch (err: any) {
        setErrorMessage(err?.message || "Failed to get a spoken response.");
        setCurrentPrompt("");
        setCurrentReply("");
        setSessionState("idle");
      }
    },
    [
      getOutputAudioContext,
      history,
      isLiveConnected,
      playPcm24kChunk,
      selectedVoice,
      stopOutputPlayback,
    ]
  );

  const handleOrbToggle = () => {
    triggerHaptic("heavy");
    if (isLiveConnected) {
      if (
        sessionState === "listening" &&
        liveUserDraftRef.current.trim().length > 0 &&
        !liveAgentDraftRef.current.trim() &&
        !waitingForLiveReplyRef.current &&
        wsRef.current?.readyState === WebSocket.OPEN
      ) {
        waitingForLiveReplyRef.current = true;
        setSessionState("thinking");
        wsRef.current.send(JSON.stringify({ endAudioTurn: true }));
        return;
      }
      stopLiveSession();
    } else if (sessionState === "connecting") {
      stopLiveSession();
    } else if (sessionState === "speaking") {
      stopOutputPlayback();
      setSessionState("idle");
    } else if (sessionState === "idle") {
      startLiveSession();
    }
  };

  const handleReplayText = async (
    text: string,
    voice: VoiceName,
    cachedAudio?: string,
    id: string = "current"
  ) => {
    triggerHaptic("medium");
    if (playingId === id) {
      stopOutputPlayback();
      return;
    }
    stopOutputPlayback();
    setPlayingId(id);

    if (cachedAudio) {
      await playPcm24kChunk(cachedAudio, () => {
        setPlayingId(null);
      });
      return;
    }

    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voiceName: voice,
        }),
      });
      const data = await res.json();
      if (res.ok && data.audioBase64) {
        if (id === "current") {
          setCurrentAudioBase64(data.audioBase64);
        }
        await playPcm24kChunk(data.audioBase64, () => {
          setPlayingId(null);
        });
      } else {
        setPlayingId(null);
      }
    } catch {
      setPlayingId(null);
    }
  };

  const handleTextFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = textInput.trim();
    if (!q) return;
    triggerHaptic("success");
    setTextInput("");
    await askTegra(q);
  };

  const handleReset = () => {
    triggerHaptic("warning");
    stopLiveSession();
    setCurrentPrompt("");
    setCurrentReply("");
    setCurrentAudioBase64(undefined);
    setErrorMessage(null);
  };

  // Full-screen iPhone-style Boot "hello" Screen on initial open
  if (isBooting) {
    return (
      <div
        data-haptic="medium"
        onClick={() => {
          triggerHaptic("medium");
          setIsBooting(false);
        }}
        className="min-h-screen flex flex-col items-center justify-center bg-[#070A12] text-white px-6 select-none cursor-pointer relative overflow-hidden"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(56,189,248,0.12),rgba(99,102,241,0.06)_40%,transparent_70%)]"
        />
        <AppleStyleHelloSvg className="w-64 sm:w-80 h-auto drop-shadow-[0_0_25px_rgba(125,211,252,0.35)]" />
        <p className="mt-6 text-lg sm:text-xl font-medium tracking-tight text-slate-200 animate-pulse">
          Hi, I'm Tegra. How can I help?
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col justify-between bg-[#070A12] text-slate-100 relative overflow-hidden">
      {/* Subtle Ambient Background Gradient */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_50%_75%,rgba(56,189,248,0.08),rgba(99,102,241,0.05)_35%,transparent_70%)]"
      />

      {/* Minimal Top Bar: Tegra Wordmark & Settings Modal Trigger */}
      <header className="relative z-20 flex items-center justify-between px-6 py-4 max-w-5xl w-full mx-auto">
        <a
          href="#top"
          data-haptic="selection"
          onClick={(e) => {
            e.preventDefault();
            handleReset();
          }}
          className="text-xl font-semibold tracking-tight text-white whitespace-nowrap cursor-pointer"
        >
          Tegra
        </a>

        <div className="flex items-center gap-3">
          <button
            type="button"
            data-haptic="light"
            onClick={() => {
              triggerHaptic("light");
              setSettingsTab("voices");
              setShowSettingsModal(true);
            }}
            aria-label="Open settings"
            className="min-h-[40px] flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-200 hover:text-white bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 rounded-xl transition-colors whitespace-nowrap cursor-pointer"
          >
            <Settings className="w-4 h-4 text-sky-400" />
            <span>Settings</span>
          </button>
        </div>
      </header>

      {/* Center Stage: Pure iPhone "hello" + "Hi, I'm Tegra. How can I help?" */}
      <main className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 max-w-2xl w-full mx-auto text-center my-auto py-6">
        {errorMessage && (
          <div
            role="alert"
            className="mb-6 w-full flex items-center justify-between gap-3 px-4 py-3 rounded-2xl bg-red-500/10 border border-red-500/25 text-xs text-red-200 text-left"
          >
            <div className="flex items-center gap-2.5">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
              <span>{errorMessage}</span>
            </div>
            <button
              type="button"
              data-haptic="light"
              onClick={() => {
                triggerHaptic("light");
                setErrorMessage(null);
              }}
              className="text-xs font-medium text-red-300 hover:text-white whitespace-nowrap cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {!currentPrompt && !currentReply ? (
          <div className="flex flex-col items-center justify-center space-y-6 w-full">
            {/* iPhone-style Boot "hello" Script + Multilingual Greeting */}
            <div className="flex flex-col items-center">
              <AppleStyleHelloSvg className="w-52 sm:w-64 h-auto drop-shadow-[0_0_20px_rgba(125,211,252,0.28)]" />
              <span
                key={greetingIndex}
                className="mt-1 text-sm font-display italic tracking-wide text-sky-300/80 transition-opacity duration-500"
              >
                {HELLO_GREETINGS[greetingIndex]}
              </span>
            </div>

            <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-white text-balance">
              {sessionState === "listening"
                ? "I'm listening..."
                : sessionState === "connecting"
                ? "Starting Tegra..."
                : "Hi, I'm Tegra. How can I help?"}
            </h1>
          </div>
        ) : (
          <div className="w-full space-y-6">
            {/* User's Spoken Words */}
            {currentPrompt && (
              <p className="text-base sm:text-lg font-medium text-slate-400 max-w-xl mx-auto">
                “{currentPrompt}”
              </p>
            )}

            {/* Tegra's Spoken Response */}
            {currentReply ? (
              <div className="space-y-4">
                <p className="text-2xl sm:text-3xl font-medium text-white leading-snug tracking-tight text-balance">
                  {currentReply}
                </p>
                <div className="flex items-center justify-center gap-4 pt-1">
                  <button
                    type="button"
                    data-haptic="medium"
                    onClick={() =>
                      handleReplayText(
                        currentReply,
                        selectedVoice,
                        currentAudioBase64,
                        "current"
                      )
                    }
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-medium text-sky-300 transition-colors cursor-pointer"
                  >
                    {playingId === "current" ? (
                      <>
                        <Square className="w-3.5 h-3.5" />
                        <span>Stop</span>
                      </>
                    ) : (
                      <>
                        <Volume2 className="w-3.5 h-3.5" />
                        <span>Speak Again</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    data-haptic="warning"
                    onClick={handleReset}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-medium text-slate-400 hover:text-white transition-colors cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Clear</span>
                  </button>
                </div>
              </div>
            ) : sessionState === "listening" ? (
              <div className="space-y-2">
                <p className="text-lg font-medium text-emerald-300/90 animate-pulse">
                  Listening...
                </p>
                <p className="text-xs text-slate-400">
                  Pause when finished, or tap the orb to get your answer now
                </p>
              </div>
            ) : sessionState === "speaking" ? (
              <p className="text-lg font-medium text-sky-300/90 animate-pulse">
                Speaking...
              </p>
            ) : sessionState === "thinking" || sessionState === "connecting" ? (
              <p className="text-lg font-medium text-sky-300/90 animate-pulse">
                Thinking...
              </p>
            ) : null}
          </div>
        )}
      </main>

      {/* Bottom Natural Thumb-Zone: Tegra Orb & Minimal Controls */}
      <footer className="relative z-20 pb-8 pt-2 px-6 flex flex-col items-center max-w-xl w-full mx-auto">
        {showKeyboard && (
          <form
            onSubmit={handleTextFormSubmit}
            className="w-full mb-5 flex items-center gap-2 bg-white/[0.06] border border-white/15 rounded-2xl p-1.5 backdrop-blur-md"
          >
            <input
              type="text"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="Ask Tegra anything..."
              autoFocus
              className="flex-1 bg-transparent px-3.5 py-2 text-sm text-white placeholder:text-slate-400 focus:outline-none"
            />
            <button
              type="submit"
              data-haptic="success"
              disabled={!textInput.trim() || sessionState === "thinking"}
              aria-label="Send message"
              className="min-h-[40px] px-4 py-2 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold text-xs disabled:opacity-40 transition-colors whitespace-nowrap cursor-pointer"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        )}

        <div className="flex items-center justify-center gap-6 sm:gap-10">
          {/* Left Button: Mute / Unmute Mic */}
          <button
            type="button"
            data-haptic="medium"
            onClick={() => {
              triggerHaptic("medium");
              if (isLiveConnected) {
                setIsMuted((m) => !m);
              } else {
                startLiveSession();
              }
            }}
            aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
            title={
              isLiveConnected
                ? isMuted
                  ? "Unmute microphone"
                  : "Mute microphone"
                : "Start microphone"
            }
            className={`min-w-[48px] min-h-[48px] rounded-full flex items-center justify-center border transition-colors cursor-pointer ${
              isLiveConnected && isMuted
                ? "bg-amber-500/20 border-amber-400/50 text-amber-300"
                : isLiveConnected
                ? "bg-emerald-500/20 border-emerald-400/40 text-emerald-300"
                : "bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 hover:text-white"
            }`}
          >
            {isMuted ? (
              <MicOff className="w-5 h-5" />
            ) : (
              <Mic className="w-5 h-5" />
            )}
          </button>

          {/* Center: The Tegra Fluid Orb */}
          <VoiceOrbVisualizer
            state={sessionState}
            inputLevel={inputLevel}
            outputLevel={outputLevel}
            isMuted={isMuted}
            onPrimaryToggle={handleOrbToggle}
          />

          {/* Right Button: Toggle Type to Tegra */}
          <button
            type="button"
            data-haptic="light"
            onClick={() => {
              triggerHaptic("light");
              setShowKeyboard((k) => !k);
            }}
            aria-label="Type to Tegra"
            title="Type to Tegra"
            className={`min-w-[48px] min-h-[48px] rounded-full flex items-center justify-center border transition-colors cursor-pointer ${
              showKeyboard
                ? "bg-sky-500/20 border-sky-400/50 text-sky-300"
                : "bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 hover:text-white"
            }`}
          >
            <Keyboard className="w-5 h-5" />
          </button>
        </div>
      </footer>

      {/* Tegra Settings Modal (Responsive Mobile Bottom Sheet + Desktop Dialog) */}
      {showSettingsModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="tegra-settings-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              triggerHaptic("light");
              setShowSettingsModal(false);
            }
          }}
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-end sm:items-center justify-center sm:p-4"
        >
          <div className="w-full sm:max-w-md bg-[#0E1320] border-t sm:border border-white/15 rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[88dvh] sm:max-h-[82vh]">
            {/* Mobile Drag Handle Affordance */}
            <div className="w-10 h-1.5 bg-white/20 rounded-full mx-auto mt-2.5 mb-0.5 sm:hidden shrink-0" />

            {/* Modal Header */}
            <div className="flex items-center justify-between px-4 sm:px-6 py-3.5 border-b border-white/10 shrink-0">
              <div className="flex items-center gap-2">
                <Settings className="w-4 h-4 text-sky-400 shrink-0" />
                <h2
                  id="tegra-settings-title"
                  className="text-base font-semibold text-white truncate"
                >
                  Tegra Settings
                </h2>
              </div>
              <button
                type="button"
                data-haptic="light"
                onClick={() => {
                  triggerHaptic("light");
                  setShowSettingsModal(false);
                }}
                aria-label="Close settings modal"
                className="min-w-[44px] min-h-[44px] -mr-2 flex items-center justify-center rounded-xl text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Segmented Navigation: Voices & History Button */}
            <div className="px-4 sm:px-6 pt-3 pb-1 shrink-0">
              <div className="grid grid-cols-2 gap-1.5 p-1 bg-white/[0.05] rounded-xl border border-white/10">
                <button
                  type="button"
                  data-haptic="selection"
                  onClick={() => {
                    triggerHaptic("selection");
                    setSettingsTab("voices");
                  }}
                  className={`min-h-[42px] flex items-center justify-center gap-1.5 px-3 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                    settingsTab === "voices"
                      ? "bg-sky-500 text-slate-950"
                      : "text-slate-300 hover:text-white"
                  }`}
                >
                  <Volume2 className="w-3.5 h-3.5 shrink-0" />
                  <span>Voices ({VOICE_OPTIONS.length})</span>
                </button>
                <button
                  type="button"
                  data-haptic="selection"
                  onClick={() => {
                    triggerHaptic("selection");
                    setSettingsTab("history");
                  }}
                  className={`min-h-[42px] flex items-center justify-center gap-1.5 px-3 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                    settingsTab === "history"
                      ? "bg-sky-500 text-slate-950"
                      : "text-slate-300 hover:text-white"
                  }`}
                >
                  <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                  <span>History ({history.length})</span>
                </button>
              </div>
            </div>

            {/* Scrollable Modal Body */}
            <div className="flex-1 overflow-y-auto overscroll-contain px-4 sm:px-6 py-3 space-y-2.5">
              {settingsTab === "voices" ? (
                <>
                  <p className="text-xs text-slate-400">
                    Tap a voice to select it for Tegra, or preview a sample.
                  </p>
                  <div className="space-y-2">
                    {VOICE_OPTIONS.map((v) => {
                      const isSelected = selectedVoice === v.id;
                      const isSamplePlaying = playingId === `sample-${v.id}`;
                      return (
                        <div
                          key={v.id}
                          data-haptic="selection"
                          onClick={() => {
                            triggerHaptic("selection");
                            setSelectedVoice(v.id);
                            if (isLiveConnected) stopLiveSession();
                          }}
                          className={`p-3 rounded-2xl border transition-colors cursor-pointer ${
                            isSelected
                              ? "bg-sky-500/12 border-sky-400/50"
                              : "bg-white/[0.03] border-white/10 hover:border-white/20"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold text-white truncate">
                                  {v.name}
                                </span>
                                <span className="text-xs text-slate-400 truncate">
                                  · {v.tone}
                                </span>
                              </div>
                              <p className="mt-0.5 text-xs text-slate-400 truncate">
                                {v.cadence}
                              </p>
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                data-haptic="medium"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  triggerHaptic("medium");
                                  handleReplayText(
                                    v.samplePhrase,
                                    v.id,
                                    undefined,
                                    `sample-${v.id}`
                                  );
                                }}
                                aria-label={`Sample ${v.name} voice`}
                                className="min-h-[38px] px-2.5 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-medium text-slate-200 inline-flex items-center gap-1 transition-colors whitespace-nowrap cursor-pointer"
                              >
                                {isSamplePlaying ? (
                                  <>
                                    <Square className="w-3 h-3 text-sky-400 shrink-0" />
                                    <span>Stop</span>
                                  </>
                                ) : (
                                  <>
                                    <Play className="w-3 h-3 text-sky-400 shrink-0" />
                                    <span>Sample</span>
                                  </>
                                )}
                              </button>

                              <button
                                type="button"
                                data-haptic="selection"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  triggerHaptic("selection");
                                  setSelectedVoice(v.id);
                                  if (isLiveConnected) stopLiveSession();
                                }}
                                className={`min-h-[38px] px-3 py-1.5 rounded-xl text-xs font-semibold inline-flex items-center gap-1 transition-colors whitespace-nowrap cursor-pointer ${
                                  isSelected
                                    ? "bg-sky-500 text-slate-950"
                                    : "bg-white/10 hover:bg-white/15 text-white"
                                }`}
                              >
                                {isSelected ? (
                                  <>
                                    <Check className="w-3.5 h-3.5 shrink-0" />
                                    <span>Active</span>
                                  </>
                                ) : (
                                  <span>Use</span>
                                )}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Quick History Access Row */}
                  <div className="pt-3 mt-2 border-t border-white/10 flex items-center justify-between gap-2">
                    <span className="text-xs text-slate-400 truncate">
                      {history.length}{" "}
                      {history.length === 1
                        ? "saved exchange"
                        : "saved exchanges"}
                    </span>
                    <button
                      type="button"
                      data-haptic="selection"
                      onClick={() => {
                        triggerHaptic("selection");
                        setSettingsTab("history");
                      }}
                      className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-medium text-sky-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                      <span>View History</span>
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {history.length === 0 ? (
                    <div className="py-10 text-center space-y-2">
                      <MessageSquare className="w-7 h-7 text-slate-500 mx-auto" />
                      <p className="text-sm font-medium text-slate-300">
                        No conversation history yet
                      </p>
                      <p className="text-xs text-slate-500 max-w-xs mx-auto">
                        Questions you ask Tegra will appear here during your
                        session.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {history.map((item) => (
                        <div
                          key={item.id}
                          className="p-3.5 rounded-2xl bg-white/[0.04] border border-white/10 space-y-1.5"
                        >
                          <div className="flex items-center justify-between text-xs text-slate-400">
                            <span>{item.voiceName} Voice</span>
                            <span className="font-mono tabular-nums">
                              {item.timestamp}
                            </span>
                          </div>
                          <p className="text-xs text-slate-300 break-words">
                            “{item.userText}”
                          </p>
                          <p className="text-sm font-medium text-white leading-relaxed break-words">
                            {item.agentText}
                          </p>
                          {item.agentText && (
                            <button
                              type="button"
                              data-haptic="medium"
                              onClick={() => {
                                triggerHaptic("medium");
                                handleReplayText(
                                  item.agentText,
                                  item.voiceName,
                                  item.audioBase64,
                                  item.id
                                );
                              }}
                              className="min-h-[36px] inline-flex items-center gap-1.5 text-xs font-medium text-sky-400 hover:text-sky-300 pt-1 cursor-pointer"
                            >
                              {playingId === item.id ? (
                                <>
                                  <Square className="w-3 h-3" />
                                  <span>Stop</span>
                                </>
                              ) : (
                                <>
                                  <Play className="w-3 h-3" />
                                  <span>Replay</span>
                                </>
                              )}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-4 sm:px-6 py-3.5 pb-5 sm:pb-3.5 border-t border-white/10 bg-white/[0.02] flex items-center justify-between gap-3 shrink-0">
              {settingsTab === "history" && history.length > 0 ? (
                <button
                  type="button"
                  data-haptic="warning"
                  onClick={() => {
                    triggerHaptic("warning");
                    setHistory([]);
                  }}
                  className="min-h-[42px] inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-xs font-medium text-red-300 transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5 shrink-0" />
                  <span>Clear History</span>
                </button>
              ) : (
                <span className="text-xs text-slate-400 truncate">
                  Active Voice:{" "}
                  <strong className="text-white">{selectedVoice}</strong>
                </span>
              )}

              <button
                type="button"
                data-haptic="light"
                onClick={() => {
                  triggerHaptic("light");
                  setShowSettingsModal(false);
                }}
                className="min-h-[42px] px-5 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-semibold text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
