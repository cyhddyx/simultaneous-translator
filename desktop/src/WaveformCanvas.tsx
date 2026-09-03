import { useEffect, useRef } from "react";

interface WaveformCanvasProps {
  active: boolean;
  strength?: number;
}

export function WaveformCanvas({ active, strength = 0.45 }: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const context = canvas.getContext("2d");
    if (!context) return undefined;

    let frame = 0;
    let animationFrame = 0;
    let disposed = false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animated = active && !reducedMotion;

    const paint = () => {
      const bounds = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(bounds.width * dpr));
      const height = Math.max(1, Math.round(bounds.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, bounds.width, bounds.height);
      const center = bounds.height / 2;
      const bars = Math.max(28, Math.floor(bounds.width / 8));
      const step = bounds.width / bars;
      const phase = reducedMotion ? 0 : frame / 17;

      for (let index = 0; index < bars; index += 1) {
        const wave = Math.sin(index * 0.43 + phase) * 0.42 + Math.sin(index * 0.14 - phase * 0.65) * 0.28;
        const idle = 1.5 + (index % 5) * 0.2;
        const amplitude = active
          ? Math.max(3, 5 + Math.abs(wave) * bounds.height * (0.24 + strength * 0.46))
          : idle;
        const x = index * step + step * 0.22;
        const barWidth = Math.max(1.5, step * 0.46);
        const alpha = active ? 0.48 + Math.abs(wave) * 0.42 : 0.24;
        context.fillStyle = `rgba(98, 213, 166, ${alpha})`;
        context.fillRect(x, center - amplitude / 2, barWidth, amplitude);
      }
    };

    const tick = () => {
      animationFrame = 0;
      if (disposed) return;
      frame += 1;
      paint();
      schedule();
    };

    // Both the mount-time paint and the ResizeObserver's initial callback want to
    // draw. Keeping a single outstanding handle stops them from starting two
    // parallel chains, of which cleanup could only ever cancel the newer one.
    const schedule = () => {
      if (disposed || !animated || animationFrame !== 0) return;
      animationFrame = window.requestAnimationFrame(tick);
    };

    const render = () => {
      if (disposed) return;
      paint();
      schedule();
    };

    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    render();

    return () => {
      disposed = true;
      observer.disconnect();
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    };
  }, [active, strength]);

  return <canvas ref={canvasRef} className="waveform-canvas" aria-hidden="true" />;
}
