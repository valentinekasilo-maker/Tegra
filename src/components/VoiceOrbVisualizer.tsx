import React, { useEffect, useRef } from "react";

export type AgentSessionState =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking";

interface VoiceOrbVisualizerProps {
  state: AgentSessionState;
  inputLevel: number;
  outputLevel: number;
  isMuted: boolean;
  onPrimaryToggle: () => void;
}

export const VoiceOrbVisualizer: React.FC<VoiceOrbVisualizerProps> = ({
  state,
  inputLevel,
  outputLevel,
  isMuted,
  onPrimaryToggle,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const smoothedLevelRef = useRef<number>(0);
  const phaseRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    const ribbons = [
      { color: "56, 189, 248", speed: 1.3, freq: 2, offset: 0 }, // Sky cyan
      { color: "99, 102, 241", speed: -1.1, freq: 3, offset: 1.5 }, // Indigo
      { color: "236, 72, 153", speed: 0.9, freq: 2, offset: 3.1 }, // Rose pink
      { color: "52, 211, 153", speed: -1.4, freq: 4, offset: 4.7 }, // Emerald
    ];

    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      const cx = width / 2;
      const cy = height / 2;
      const baseRadius = Math.min(width, height) * 0.29;

      const rawTarget =
        state === "speaking"
          ? Math.max(0.28, outputLevel * 1.35)
          : state === "listening" && !isMuted
          ? Math.max(0.14, inputLevel * 1.4)
          : state === "thinking" || state === "connecting"
          ? 0.22
          : 0.04;

      smoothedLevelRef.current +=
        (rawTarget - smoothedLevelRef.current) * 0.15;
      const level = smoothedLevelRef.current;

      if (!prefersReducedMotion) {
        phaseRef.current +=
          state === "speaking"
            ? 0.055 + level * 0.06
            : state === "thinking" || state === "connecting"
            ? 0.05
            : state === "listening"
            ? 0.035 + level * 0.05
            : 0.014;
      }
      const phase = phaseRef.current;

      // Ambient outer glow
      const glowRadius = baseRadius * (1.45 + level * 0.55);
      const ambientGrad = ctx.createRadialGradient(
        cx,
        cy,
        baseRadius * 0.2,
        cx,
        cy,
        glowRadius
      );
      if (state === "idle") {
        ambientGrad.addColorStop(0, "rgba(99, 102, 241, 0.22)");
        ambientGrad.addColorStop(0.6, "rgba(56, 189, 248, 0.08)");
        ambientGrad.addColorStop(1, "rgba(15, 23, 42, 0)");
      } else if (state === "listening" && isMuted) {
        ambientGrad.addColorStop(0, "rgba(148, 163, 184, 0.18)");
        ambientGrad.addColorStop(1, "rgba(15, 23, 42, 0)");
      } else {
        ambientGrad.addColorStop(
          0,
          `rgba(56, 189, 248, ${0.32 + level * 0.25})`
        );
        ambientGrad.addColorStop(
          0.5,
          `rgba(168, 85, 247, ${0.18 + level * 0.15})`
        );
        ambientGrad.addColorStop(1, "rgba(15, 23, 42, 0)");
      }
      ctx.fillStyle = ambientGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, glowRadius, 0, Math.PI * 2);
      ctx.fill();

      // Clip inside the spherical Siri lens
      ctx.save();
      const sphereRadius = baseRadius * (1 + level * 0.12);
      ctx.beginPath();
      ctx.arc(cx, cy, sphereRadius, 0, Math.PI * 2);
      ctx.clip();

      // Deep dark glass sphere interior
      const coreBg = ctx.createRadialGradient(
        cx - sphereRadius * 0.3,
        cy - sphereRadius * 0.3,
        sphereRadius * 0.1,
        cx,
        cy,
        sphereRadius
      );
      coreBg.addColorStop(0, "#1e293b");
      coreBg.addColorStop(1, "#090d16");
      ctx.fillStyle = coreBg;
      ctx.fillRect(
        cx - sphereRadius,
        cy - sphereRadius,
        sphereRadius * 2,
        sphereRadius * 2
      );

      // Multi-layered Siri fluid ribbons
      ctx.globalCompositeOperation = "screen";
      for (const ribbon of ribbons) {
        ctx.beginPath();
        const steps = 90;
        for (let i = 0; i <= steps; i++) {
          const theta = (i / steps) * Math.PI * 2;
          const wave1 = Math.sin(
            theta * ribbon.freq + phase * ribbon.speed + ribbon.offset
          );
          const wave2 = Math.cos(
            theta * (ribbon.freq + 1) - phase * ribbon.speed * 0.7
          );
          const deform =
            (wave1 * 0.6 + wave2 * 0.4) *
            sphereRadius *
            (0.14 + level * 0.36);
          const r = sphereRadius * (0.62 + level * 0.15) + deform;
          const x = cx + Math.cos(theta) * r;
          const y = cy + Math.sin(theta) * r;
          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.closePath();

        const lobeGrad = ctx.createRadialGradient(
          cx,
          cy,
          0,
          cx,
          cy,
          sphereRadius
        );
        lobeGrad.addColorStop(0, "rgba(255, 255, 255, 0.65)");
        lobeGrad.addColorStop(0.45, `rgba(${ribbon.color}, 0.75)`);
        lobeGrad.addColorStop(1, `rgba(${ribbon.color}, 0.05)`);

        ctx.fillStyle = lobeGrad;
        ctx.fill();
      }

      // Horizontal Siri sine wave filaments across the equator when active
      if (state !== "idle") {
        for (let w = 0; w < 3; w++) {
          ctx.beginPath();
          const sliceWidth = sphereRadius * 2;
          const startX = cx - sphereRadius;
          for (let x = 0; x <= sliceWidth; x += 3) {
            const norm = x / sliceWidth; // 0..1
            const envelope = Math.sin(norm * Math.PI); // 0 at edges, 1 in center
            const yOffset =
              Math.sin(norm * Math.PI * (3 + w) + phase * (2.5 + w * 0.7)) *
              envelope *
              sphereRadius *
              (0.12 + level * 0.45);
            const px = startX + x;
            const py = cy + yOffset;
            if (x === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.strokeStyle =
            w === 0
              ? "rgba(255, 255, 255, 0.85)"
              : w === 1
              ? "rgba(56, 189, 248, 0.7)"
              : "rgba(236, 72, 153, 0.65)";
          ctx.lineWidth = w === 0 ? 2.2 : 1.5;
          ctx.stroke();
        }
      }

      ctx.restore();

      // Subtle glass rim highlight around the sphere
      ctx.beginPath();
      ctx.arc(cx, cy, sphereRadius, 0, Math.PI * 2);
      ctx.strokeStyle =
        state === "idle"
          ? "rgba(255, 255, 255, 0.16)"
          : "rgba(255, 255, 255, 0.38)";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.restore();
      animationFrameId = requestAnimationFrame(render);
    };

    animationFrameId = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [state, inputLevel, outputLevel, isMuted]);

  const statusText =
    state === "connecting"
      ? "Connecting..."
      : state === "listening"
      ? isMuted
        ? "Muted · Tap to end"
        : "Listening... go ahead"
      : state === "thinking"
      ? "Thinking..."
      : state === "speaking"
      ? "Speaking · Tap to stop"
      : "Tap the orb to talk";

  return (
    <div className="flex flex-col items-center justify-center select-none">
      <button
        type="button"
        onClick={onPrimaryToggle}
        data-haptic="heavy"
        aria-label={
          state === "idle" ? "Tap to talk to voice assistant" : "Stop session"
        }
        className="relative w-44 h-44 sm:w-52 sm:h-52 flex items-center justify-center rounded-full focus:outline-none focus-visible:ring-4 focus-visible:ring-sky-400/50 transition-transform duration-150 active:scale-95 cursor-pointer"
      >
        <canvas ref={canvasRef} className="w-full h-full pointer-events-none" />
      </button>
      <p className="mt-2 text-xs font-medium text-slate-400 tracking-wide">
        {statusText}
      </p>
    </div>
  );
};
