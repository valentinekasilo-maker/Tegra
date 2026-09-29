import "dotenv/config";
import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured in environment.");
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

/**
 * Ultra-fast single-turn voice + text generator using Gemini Live (gemini-3.8-live).
 * Returns both the spoken transcript and 24kHz PCM audio in a single pass (~1.5s),
 * avoiding 503 high-demand errors on standard text endpoints.
 */
async function generateFastLiveTurn(options: {
  promptText: string;
  history?: Array<{ role: string; text: string }>;
  voiceName: string;
  systemInstruction: string;
}): Promise<{ replyText: string; audioBase64: string }> {
  const ai = getAiClient();
  const { promptText, history = [], voiceName, systemInstruction } = options;

  // Build context-aware prompt if recent turns exist
  let contextualInput = promptText;
  if (Array.isArray(history) && history.length > 0) {
    const recent = history
      .slice(-6)
      .map(
        (h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.text}`
      )
      .join("\n");
    contextualInput = `Recent conversation context:\n${recent}\n\nUser: ${promptText}`;
  }

  return new Promise<{ replyText: string; audioBase64: string }>(
    async (resolve, reject) => {
      const pcmChunks: Buffer[] = [];
      let transcript = "";
      let settled = false;

      const finish = (sessionRef?: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          sessionRef?.close();
        } catch {}
        const combinedPcm =
          pcmChunks.length > 0
            ? Buffer.concat(pcmChunks).toString("base64")
            : "";
        resolve({
          replyText:
            transcript.trim() ||
            "I'm here and listening. What else can I help you with?",
          audioBase64: combinedPcm,
        });
      };

      const timeout = setTimeout(() => {
        if (!settled) {
          if (pcmChunks.length > 0 || transcript.trim()) {
            finish();
          } else {
            settled = true;
            reject(new Error("Voice assistant timed out. Please try again."));
          }
        }
      }, 14000);

      try {
        const session = await ai.live.connect({
          model: "gemini-3.8-live",
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: voiceName || "Zephyr" },
              },
            },
            systemInstruction,
            outputAudioTranscription: {},
          },
          callbacks: {
            onopen: () => {},
            onmessage: (message: LiveServerMessage) => {
              const sc = message.serverContent as any;
              if (!sc) return;

              const parts = sc.modelTurn?.parts;
              if (Array.isArray(parts)) {
                for (const part of parts) {
                  if (part.inlineData?.data) {
                    pcmChunks.push(Buffer.from(part.inlineData.data, "base64"));
                  }
                  if (part.text) {
                    transcript += part.text;
                  }
                }
              }

              if (sc.outputTranscription?.text) {
                transcript += sc.outputTranscription.text;
              }

              if (sc.turnComplete) {
                finish(session);
              }
            },
            onerror: (err: any) => {
              if (!settled) {
                if (pcmChunks.length > 0 || transcript.trim()) {
                  finish(session);
                } else {
                  settled = true;
                  clearTimeout(timeout);
                  reject(err);
                }
              }
            },
            onclose: () => {
              if (!settled) {
                finish();
              }
            },
          },
        });

        session.sendRealtimeInput({ text: contextualInput });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(err);
        }
      }
    }
  );
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const PORT = 3000;

  app.use(express.json({ limit: "25mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Fast Voice Turn Endpoint (powered by gemini-3.8-live with TTS fallback)
  app.post("/api/voice-turn", async (req, res) => {
    try {
      const {
        text,
        audioBase64,
        audioMimeType,
        history = [],
        voiceName = "Zephyr",
        systemInstruction = "You are Tegra, a warm, natural, Siri-like voice assistant. Always respond in 1 to 2 concise, conversational sentences designed to be spoken out loud. Never use markdown bullet points, asterisks, or formatting symbols.",
      } = req.body;

      const ai = getAiClient();
      let userText = (text || "").trim();

      if (!userText && audioBase64) {
        const transcribeResponse = await ai.models.generateContent({
          model: "gemini-3.5-transcribe",
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: audioMimeType || "audio/webm",
                  data: audioBase64,
                },
              },
              {
                text: "Transcribe the spoken words accurately. Return only the spoken transcript without commentary.",
              },
            ],
          },
        });
        userText = (transcribeResponse.text || "").trim();
      }

      if (!userText) {
        res.status(400).json({
          error:
            "Could not detect spoken words or text input. Please try speaking again.",
        });
        return;
      }

      const { replyText, audioBase64: replyAudioBase64 } =
        await generateFastLiveTurn({
          promptText: userText,
          history,
          voiceName,
          systemInstruction,
        });

      res.json({
        userText,
        replyText,
        audioBase64: replyAudioBase64,
        audioMimeType: "audio/pcm;rate=24000",
      });
    } catch (error: any) {
      console.error("Error in /api/voice-turn:", error);
      res.status(500).json({
        error:
          error?.message ||
          "Failed to process voice turn. Check your API key in Settings > Secrets.",
      });
    }
  });

  // On-demand Text-to-Speech endpoint (for message replay & voice preview)
  app.post("/api/tts", async (req, res) => {
    try {
      const {
        text,
        voiceName = "Zephyr",
        voiceStyle = "Clear, warm, natural conversational tone",
      } = req.body;

      if (!text || typeof text !== "string") {
        res
          .status(400)
          .json({ error: "Text is required for speech synthesis." });
        return;
      }

      const ai = getAiClient();
      const ttsResponse = await ai.models.generateContent({
        model: "gemini-3.8-flash-lite-tts",
        contents: [
          {
            role: "user",
            parts: [
              {
                text: text.slice(0, 1200),
                speechMetadata: {
                  style: voiceStyle,
                },
              },
            ],
          } as any,
        ],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      });

      const inlineData =
        ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (!inlineData?.data) {
        res.status(500).json({ error: "No audio returned by TTS model." });
        return;
      }

      res.json({
        audioBase64: inlineData.data,
        audioMimeType: inlineData.mimeType || "audio/pcm;rate=24000",
      });
    } catch (error: any) {
      console.error("Error in /api/tts:", error);
      res.status(500).json({
        error: error?.message || "Speech synthesis failed.",
      });
    }
  });

  // WebSocket Server for Real-Time Gemini Live API (gemini-3.8-live)
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "", `http://${request.headers.host}`);
    if (url.pathname === "/api/live-ws") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
  });

  wss.on("connection", (clientWs: WebSocket, request: http.IncomingMessage) => {
    const url = new URL(request.url || "", `http://${request.headers.host}`);
    const voiceName = url.searchParams.get("voice") || "Zephyr";
    const systemInstruction =
      url.searchParams.get("instruction") ||
      "You are Tegra, a warm, natural, Siri-like voice assistant. Keep spoken answers concise (1 to 2 sentences), helpful, and natural.";

    let isClosed = false;
    const safeSend = (payload: Record<string, unknown>) => {
      if (!isClosed && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    let ai: GoogleGenAI;
    try {
      ai = getAiClient();
    } catch (err: any) {
      safeSend({
        type: "error",
        message: err?.message || "Failed to initialize Gemini API client.",
      });
      clientWs.close();
      return;
    }

    const sessionPromise = ai.live.connect({
      model: "gemini-3.8-live",
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
        systemInstruction,
        outputAudioTranscription: {},
        inputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => {},
        onmessage: (message: LiveServerMessage) => {
          const serverContent = message.serverContent as any;
          if (!serverContent) return;

          const parts = serverContent.modelTurn?.parts;
          if (Array.isArray(parts)) {
            for (const part of parts) {
              if (part.inlineData?.data) {
                safeSend({
                  type: "audio",
                  audio: part.inlineData.data,
                });
              }
              if (part.text) {
                safeSend({
                  type: "modelText",
                  text: part.text,
                });
              }
            }
          }

          if (serverContent.outputTranscription?.text) {
            safeSend({
              type: "outputTranscript",
              text: serverContent.outputTranscription.text,
            });
          }

          if (serverContent.inputTranscription?.text) {
            safeSend({
              type: "inputTranscript",
              text: serverContent.inputTranscription.text,
            });
          }

          if (serverContent.interrupted) {
            safeSend({ type: "interrupted" });
          }

          if (serverContent.turnComplete) {
            safeSend({ type: "turnComplete" });
          }
        },
        onerror: (err: any) => {
          console.error("Gemini Live session error:", err);
          safeSend({
            type: "error",
            message: err?.message || "Live voice stream encountered an error.",
          });
        },
        onclose: () => {
          safeSend({ type: "closed" });
        },
      },
    });

    sessionPromise
      .then(() => {
        safeSend({ type: "connected", voiceName });
      })
      .catch((err: any) => {
        console.error("Failed to connect to Gemini Live:", err);
        safeSend({
          type: "error",
          message:
            err?.message ||
            "Could not establish Gemini Live voice session. Verify your API key in Settings > Secrets.",
        });
        clientWs.close();
      });

    clientWs.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.audio) {
          sessionPromise
            .then((session) => {
              session.sendRealtimeInput({
                audio: {
                  data: msg.audio,
                  mimeType: "audio/pcm;rate=16000",
                },
              });
            })
            .catch(() => {});
        } else if (msg.endAudioTurn) {
          // Send trailing digital silence frames so server-side VAD triggers immediately
          sessionPromise
            .then(async (session) => {
              const silenceChunk = Buffer.alloc(6400).toString("base64");
              for (let i = 0; i < 6; i++) {
                session.sendRealtimeInput({
                  audio: {
                    data: silenceChunk,
                    mimeType: "audio/pcm;rate=16000",
                  },
                });
              }
            })
            .catch(() => {});
        } else if (msg.text) {
          sessionPromise
            .then((session) => {
              session.sendRealtimeInput({
                text: msg.text,
              });
            })
            .catch(() => {});
        }
      } catch (e) {
        // Ignore malformed JSON frames
      }
    });

    clientWs.on("close", () => {
      isClosed = true;
      sessionPromise
        .then((session) => {
          session.close();
        })
        .catch(() => {});
    });
  });

  const distPath = path.join(__dirname, "dist");
  const hasDist = fs.existsSync(path.join(distPath, "index.html"));

  if (process.env.NODE_ENV === "production" && hasDist) {
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  } else {
    // Dynamic Vite middleware (handles dev or when dist wasn't prebuilt)
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
