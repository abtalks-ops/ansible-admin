"use client";
import { useEffect, useRef } from "react";

// Subtle digital-rain background. Dims itself and pauses when the tab is hidden
// or the user prefers reduced motion.
export default function MatrixRain({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !enabled) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const glyphs = "アァカサタナハマヤャラワガザダバパイィキシチニヒミリヰギジヂビピウゥクスツヌフムユュルグズブヅプエェケセテネヘメレヱゲゼデベペオォコソトノホモヨョロヲゴゾドボポヴッン0123456789{}[]<>:=-$#";
    const size = 16;
    let cols = 0;
    let drops: number[] = [];
    let raf = 0;
    let last = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(window.innerWidth / size);
      drops = Array.from({ length: cols }, () => Math.floor((Math.random() * -window.innerHeight) / size));
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    };

    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (t - last < 55 || document.hidden) return;
      last = t;
      ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.font = `${size}px "Share Tech Mono", monospace`;
      for (let i = 0; i < cols; i++) {
        const y = drops[i] * size;
        if (y > 0) {
          const ch = glyphs[(Math.random() * glyphs.length) | 0];
          ctx.fillStyle = Math.random() > 0.975 ? "#d9ffe0" : "#00ff41";
          ctx.fillText(ch, i * size, y);
        }
        if (y > window.innerHeight && Math.random() > 0.975) drops[i] = 0;
        drops[i]++;
      }
    };

    resize();
    window.addEventListener("resize", resize);
    if (!reduce) raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [enabled]);

  return <canvas ref={ref} className="matrix-rain" aria-hidden="true" />;
}
