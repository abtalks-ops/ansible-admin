// Subtle digital rain. Returns a stop function. Skipped for prefers-reduced-motion.
export function startRain(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx || matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};
  const glyphs = "アカサタナハマヤラワ0123456789{}[]<>:=-$#ガザダバパイキシチニヒミリ";
  const size = 16;
  let cols = 0, drops: number[] = [], raf = 0, last = 0;
  const resize = () => {
    const dpr = devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(innerWidth / size);
    drops = Array.from({ length: cols }, () => Math.floor((Math.random() * -innerHeight) / size));
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, innerWidth, innerHeight);
  };
  const draw = (t: number) => {
    raf = requestAnimationFrame(draw);
    if (t - last < 60 || document.hidden) return;
    last = t;
    ctx.fillStyle = "rgba(0,0,0,0.08)";
    ctx.fillRect(0, 0, innerWidth, innerHeight);
    ctx.font = `${size}px monospace`;
    for (let i = 0; i < cols; i++) {
      const y = drops[i] * size;
      if (y > 0) {
        ctx.fillStyle = Math.random() > 0.975 ? "#d9ffe0" : "#00ff41";
        ctx.fillText(glyphs[(Math.random() * glyphs.length) | 0], i * size, y);
      }
      if (y > innerHeight && Math.random() > 0.975) drops[i] = 0;
      drops[i]++;
    }
  };
  resize();
  addEventListener("resize", resize);
  raf = requestAnimationFrame(draw);
  return () => {
    cancelAnimationFrame(raf);
    removeEventListener("resize", resize);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };
}
