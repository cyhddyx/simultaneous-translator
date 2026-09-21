import { useEffect, useRef } from "react";

interface AmbientVisualizerProps {
  active: boolean;
  strength?: number;
  label?: string;
}

interface NoteParticle {
  x: number;
  y: number;
  symbol: string;
  size: number;
  speedY: number;
  speedX: number;
  alpha: number;
  maxAlpha: number;
  rot: number;
  rotSpeed: number;
  color: string;
}

interface SparkleParticle {
  x: number;
  y: number;
  size: number;
  phase: number;
  speed: number;
  color: string;
}

export function AmbientVisualizer({
  active,
  strength = 0.5,
  label = "",
}: AmbientVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({ active, strength, label });
  const repaintRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    stateRef.current = { active, strength, label };
    repaintRef.current?.();
  }, [active, strength, label]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    let animFrame = 0;
    let frame = 0;
    let disposed = false;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    // Musical notes and sparkles that float up
    const noteSymbols = ["♪", "♫", "✦", "♬", "•"];
    const noteColors = ["#0284c7", "#0ea5e9", "#38bdf8", "#f59e0b", "#06b6d4"];
    const notes: NoteParticle[] = Array.from({ length: 8 }, (_, i) => ({
      x: 0.25 + ((i * 0.08) % 0.5) + (Math.random() * 0.1 - 0.05),
      y: 0.3 + ((i * 0.1) % 0.6),
      symbol: noteSymbols[i % noteSymbols.length],
      size: 14 + (i % 3) * 5,
      speedY: 0.0008 + (i % 3) * 0.0005,
      speedX: (Math.random() - 0.5) * 0.0004,
      alpha: 0.2 + Math.random() * 0.3,
      maxAlpha: 0.5 + (i % 3) * 0.2,
      rot: (Math.random() - 0.5) * 0.4,
      rotSpeed: (Math.random() - 0.5) * 0.01,
      color: noteColors[i % noteColors.length],
    }));

    const sparkles: SparkleParticle[] = Array.from({ length: 10 }, (_, i) => ({
      x: 0.2 + ((i * 0.07) % 0.6) + Math.random() * 0.06,
      y: 0.15 + ((i * 0.08) % 0.7),
      size: 10 + (i % 4) * 5,
      phase: Math.random() * Math.PI * 2,
      speed: 0.02 + Math.random() * 0.025,
      color: i % 2 === 0 ? "#fde047" : "#7dd3fc",
    }));

    function draw4PointStar(
      cx: number,
      cy: number,
      spikes: number,
      outerR: number,
      innerR: number,
      rot: number,
      fillColor: string,
      glowColor?: string,
    ) {
      ctx!.save();
      ctx!.translate(cx, cy);
      ctx!.rotate(rot);
      ctx!.beginPath();
      const step = Math.PI / spikes;
      for (let i = 0; i < spikes * 2; i++) {
        const r = i % 2 === 0 ? outerR : innerR;
        const x = Math.cos(i * step) * r;
        const y = Math.sin(i * step) * r;
        if (i === 0) ctx!.moveTo(x, y);
        else ctx!.lineTo(x, y);
      }
      ctx!.closePath();
      ctx!.fillStyle = fillColor;
      if (glowColor) {
        ctx!.shadowColor = glowColor;
        ctx!.shadowBlur = 10;
      }
      ctx!.fill();
      ctx!.restore();
    }

    const paint = () => {
      const { active, strength, label } = stateRef.current;
      const bounds = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(bounds.width * dpr));
      const height = Math.max(1, Math.round(bounds.height * dpr));

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = bounds.width;
      const h = bounds.height;
      ctx.clearRect(0, 0, w, h);

      const time = reducedMotion ? 0 : frame * 0.028;
      const effectiveStrength = active ? Math.max(0.4, strength) : 0;
      const bounce = active ? Math.sin(time * 4) * 0.12 * effectiveStrength : 0;

      // Base scaling to fit the panel cleanly
      const scale = Math.max(0.01, Math.min(2.4, w / 240, h / 245));

      const cx = w * 0.5;
      const cy = h * 0.44;

      // Only the capsule tilts; its supporting frame stays attached to the base.
      const tilt = reducedMotion
        ? 0
        : Math.sin(time * 1.2) * (active ? 0.05 : 0.025);

      const micX = cx;
      const micY = cy;
      const micWidth = 58 * scale;
      const micHeight = 88 * scale;
      const halfW = micWidth / 2;
      const halfH = micHeight / 2;
      const cradleR = halfW + 12 * scale;
      const swivelY = 10 * scale;
      const baseY = cy + 68 * scale;
      const stemTop = micY + swivelY + cradleR - 2.5 * scale;

      // -------------------------------------------------------------
      // 1. Soft Ambient Halo Glow behind the character
      // -------------------------------------------------------------
      ctx.save();
      const haloRadius = 110 * scale * (1 + (active ? 0.25 : 0.08));
      const haloGrad = ctx.createRadialGradient(
        micX,
        micY - 10 * scale,
        15 * scale,
        micX,
        micY - 10 * scale,
        haloRadius,
      );
      haloGrad.addColorStop(
        0,
        active ? "rgba(56, 189, 248, 0.48)" : "rgba(186, 230, 253, 0.45)",
      );
      haloGrad.addColorStop(
        0.5,
        active ? "rgba(14, 165, 233, 0.22)" : "rgba(125, 211, 252, 0.2)",
      );
      haloGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.beginPath();
      ctx.arc(micX, micY - 10 * scale, haloRadius, 0, Math.PI * 2);
      ctx.fillStyle = haloGrad;
      ctx.fill();
      ctx.restore();

      // -------------------------------------------------------------
      // 2. Soundwave Ripples (when listening/active)
      // -------------------------------------------------------------
      if (active) {
        ctx.save();
        const rippleCount = 3;
        for (let r = 0; r < rippleCount; r++) {
          const progress = (frame * 0.016 + r / rippleCount) % 1;
          const rRadius = (60 + progress * 80) * scale;
          const rAlpha = (1 - progress) * 0.42;

          ctx.beginPath();
          ctx.arc(micX, micY - 15 * scale, rRadius, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(14, 165, 233, ${rAlpha})`;
          ctx.lineWidth = 2.5 * scale;
          ctx.stroke();
        }
        ctx.restore();
      }

      // -------------------------------------------------------------
      // 3. Floating Notes and Sparkles
      // -------------------------------------------------------------
      notes.forEach((n) => {
        if (!reducedMotion) {
          n.y -= n.speedY * (active ? 1.6 : 1);
          n.x += Math.sin(time * 1.5 + n.y * 10) * n.speedX;
          n.rot += n.rotSpeed;
          if (n.y < 0.05) {
            n.y = 0.85;
            n.x = 0.25 + Math.random() * 0.5;
          }
        }
        const nx = n.x * w;
        const ny = n.y * h;

        ctx.save();
        ctx.translate(nx, ny);
        ctx.rotate(n.rot);
        ctx.font = `bold ${n.size * scale}px "Segoe UI Symbol", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = n.color;
        ctx.globalAlpha = n.alpha * (active ? 1.2 : 0.85);
        ctx.shadowColor = n.color;
        ctx.shadowBlur = 6;
        ctx.fillText(n.symbol, 0, 0);
        ctx.restore();
      });

      sparkles.forEach((s) => {
        const sx = s.x * w;
        const sy = s.y * h;
        const starBreathe = 1 + Math.sin(time * 2.5 + s.phase) * 0.25;
        const outerR = s.size * 0.5 * starBreathe * scale;
        const innerR = outerR * 0.28;
        const rot = time * s.speed * 2 + s.phase;
        draw4PointStar(
          sx,
          sy,
          4,
          outerR,
          innerR,
          rot,
          s.color,
          "rgba(253, 224, 71, 0.4)",
        );
      });

      // -------------------------------------------------------------
      // 4. Desktop Base & Stem (Under the mic)
      // -------------------------------------------------------------
      ctx.save();
      ctx.translate(micX, baseY);

      // Base drop shadow
      ctx.beginPath();
      ctx.ellipse(0, 14 * scale, 50 * scale, 11 * scale, 0, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(15, 23, 42, 0.12)";
      ctx.fill();

      // Weighted metallic disc base
      const baseGrad = ctx.createLinearGradient(
        -46 * scale,
        0,
        46 * scale,
        14 * scale,
      );
      baseGrad.addColorStop(0, "#e2e8f0");
      baseGrad.addColorStop(0.3, "#cbd5e1");
      baseGrad.addColorStop(0.7, "#94a3b8");
      baseGrad.addColorStop(1, "#64748b");

      ctx.beginPath();
      ctx.ellipse(0, 10 * scale, 44 * scale, 10 * scale, 0, 0, Math.PI * 2);
      ctx.fillStyle = baseGrad;
      ctx.shadowColor = "rgba(148, 163, 184, 0.4)";
      ctx.shadowBlur = 8;
      ctx.fill();

      // Base top inner ring
      ctx.beginPath();
      ctx.ellipse(0, 8.5 * scale, 36 * scale, 7.5 * scale, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#f8fafc";
      ctx.fill();

      // Vertical stem
      const stemGrad = ctx.createLinearGradient(-5 * scale, 0, 5 * scale, 0);
      stemGrad.addColorStop(0, "#cbd5e1");
      stemGrad.addColorStop(0.5, "#ffffff");
      stemGrad.addColorStop(1, "#94a3b8");

      ctx.beginPath();
      ctx.rect(-4 * scale, stemTop - baseY, 8 * scale, baseY + 8 * scale - stemTop);
      ctx.fillStyle = stemGrad;
      ctx.fill();
      ctx.restore();

      // Dynamic Audio Equalizer Bars at base
      ctx.save();
      const barCount = 6;
      const barWidth = 4.5 * scale;
      const barGap = 3.5 * scale;
      const barBaseY = cy + 74 * scale;

      for (let b = 0; b < barCount; b++) {
        const barIndexOffset = Math.abs(b - (barCount - 1) / 2);
        const barHeight = active
          ? (8 +
              Math.sin(time * 6 + b * 1.1) * 7 +
              effectiveStrength * 9 -
              barIndexOffset * 2) *
            scale
          : (4 + Math.sin(time * 2 + b * 0.8) * 2.5) * scale;
        const clampedH = Math.max(3 * scale, barHeight);

        // Leave the center clear so the stem reads as one uninterrupted piece.
        const column = b < barCount / 2 ? b - barCount / 2 : b - barCount / 2 + 1;
        const bx = micX + column * (barWidth + barGap);
        const barGrad = ctx.createLinearGradient(
          bx,
          barBaseY - clampedH,
          bx,
          barBaseY,
        );
        barGrad.addColorStop(0, "#38bdf8");
        barGrad.addColorStop(1, "#0284c7");

        ctx.beginPath();
        ctx.roundRect(
          bx - barWidth / 2,
          barBaseY - clampedH,
          barWidth,
          clampedH,
          3 * scale,
        );
        ctx.fillStyle = barGrad;
        ctx.shadowColor = "rgba(56, 189, 248, 0.45)";
        ctx.shadowBlur = active ? 6 : 2;
        ctx.fill();
      }
      ctx.restore();

      // -------------------------------------------------------------
      // 5. Fixed cradle with a capsule that tilts about its swivel
      // -------------------------------------------------------------
      ctx.save();
      ctx.translate(micX, micY);

      // --- A. U-Shaped Shockmount Frame ---
      ctx.save();
      ctx.beginPath();
      // Arc around the bottom of the mic
      ctx.arc(0, swivelY, cradleR, 0, Math.PI, false);
      ctx.lineWidth = 5 * scale;
      ctx.strokeStyle = "#64748b";
      ctx.lineCap = "round";
      ctx.stroke();

      // Left & right swivel adjustment knobs
      [-cradleR, cradleR].forEach((kx) => {
        ctx.beginPath();
        ctx.arc(kx, 10 * scale, 5 * scale, 0, Math.PI * 2);
        ctx.fillStyle = "#334155";
        ctx.fill();

        ctx.beginPath();
        ctx.arc(kx, 10 * scale, 2.5 * scale, 0, Math.PI * 2);
        ctx.fillStyle = "#94a3b8";
        ctx.fill();

        // Connecting pin into mic body
        ctx.beginPath();
        ctx.moveTo(kx, 10 * scale);
        ctx.lineTo(kx > 0 ? halfW : -halfW, 10 * scale);
        ctx.lineWidth = 3 * scale;
        ctx.strokeStyle = "#94a3b8";
        ctx.stroke();
      });
      ctx.restore();

      ctx.translate(0, swivelY);
      ctx.rotate(tilt);
      ctx.translate(0, -swivelY);

      // --- B. Microphone Capsule Outer Contour ---
      // We clip or draw the body in two halves: Upper Grille (Metal Mesh) & Lower Body (Glossy Cyan)
      const capsuleRadius = halfW;

      // Drop shadow for the capsule
      ctx.save();
      ctx.shadowColor = active
        ? "rgba(14, 165, 233, 0.38)"
        : "rgba(30, 58, 138, 0.16)";
      ctx.shadowBlur = 18 * scale;

      // Entire capsule container path
      ctx.beginPath();
      ctx.roundRect(-halfW, -halfH, micWidth, micHeight, [
        capsuleRadius,
        capsuleRadius,
        capsuleRadius * 0.85,
        capsuleRadius * 0.85,
      ]);
      ctx.fillStyle = "#0f172a";
      ctx.fill();
      ctx.restore();

      // --- C. Lower Body (Pastel Azure/Cyan with 3D volume) ---
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(-halfW, -6 * scale, micWidth, halfH + 6 * scale, [
        0,
        0,
        capsuleRadius * 0.85,
        capsuleRadius * 0.85,
      ]);
      const bodyGrad = ctx.createLinearGradient(-halfW, 0, halfW, halfH);
      bodyGrad.addColorStop(0, "#38bdf8"); // bright cyan
      bodyGrad.addColorStop(0.35, "#0ea5e9"); // electric blue
      bodyGrad.addColorStop(0.75, "#0284c7");
      bodyGrad.addColorStop(1, "#0369a1");
      ctx.fillStyle = bodyGrad;
      ctx.fill();

      // Specular highlight streak on left side
      ctx.beginPath();
      ctx.roundRect(
        -halfW + 5 * scale,
        -2 * scale,
        6 * scale,
        halfH - 2 * scale,
        3 * scale,
      );
      ctx.fillStyle = "rgba(255, 255, 255, 0.42)";
      ctx.fill();
      ctx.restore();

      // --- D. Upper Mesh Grille (Metallic Studio Texture) ---
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(-halfW, -halfH, micWidth, halfH + 4 * scale, [
        capsuleRadius,
        capsuleRadius,
        0,
        0,
      ]);
      ctx.clip();

      // Grille dark base
      const grilleGrad = ctx.createLinearGradient(-halfW, -halfH, halfW, 0);
      grilleGrad.addColorStop(0, "#475569");
      grilleGrad.addColorStop(0.4, "#334155");
      grilleGrad.addColorStop(1, "#1e293b");
      ctx.fillStyle = grilleGrad;
      ctx.fill();

      // Active inner glow inside grille
      if (active) {
        const innerGlow = ctx.createRadialGradient(
          0,
          -halfH * 0.4,
          5 * scale,
          0,
          -halfH * 0.4,
          28 * scale,
        );
        innerGlow.addColorStop(0, "rgba(56, 189, 248, 0.75)");
        innerGlow.addColorStop(0.7, "rgba(14, 165, 233, 0.35)");
        innerGlow.addColorStop(1, "rgba(2, 132, 199, 0)");
        ctx.fillStyle = innerGlow;
        ctx.fill();
      }

      // Grille grid lines (horizontal & vertical lines for studio mic mesh)
      ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
      ctx.lineWidth = 1 * scale;
      const stepY = 5 * scale;
      for (let gy = -halfH; gy <= 2 * scale; gy += stepY) {
        ctx.beginPath();
        ctx.moveTo(-halfW, gy);
        ctx.lineTo(halfW, gy);
        ctx.stroke();
      }
      const stepX = 5.5 * scale;
      for (let gx = -halfW; gx <= halfW; gx += stepX) {
        ctx.beginPath();
        ctx.moveTo(gx, -halfH);
        ctx.lineTo(gx, 2 * scale);
        ctx.stroke();
      }

      // Specular sheen over the dome top
      ctx.beginPath();
      ctx.ellipse(
        -halfW * 0.35,
        -halfH + 10 * scale,
        14 * scale,
        7 * scale,
        -Math.PI / 6,
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
      ctx.fill();
      ctx.restore();

      // --- E. Chrome Waist Band / Collar ---
      ctx.save();
      const collarGrad = ctx.createLinearGradient(
        -halfW,
        -4 * scale,
        halfW,
        2 * scale,
      );
      collarGrad.addColorStop(0, "#e2e8f0");
      collarGrad.addColorStop(0.3, "#ffffff");
      collarGrad.addColorStop(0.7, "#cbd5e1");
      collarGrad.addColorStop(1, "#64748b");

      ctx.beginPath();
      ctx.roundRect(
        -halfW - 1.5 * scale,
        -4 * scale,
        micWidth + 3 * scale,
        6 * scale,
        2 * scale,
      );
      ctx.fillStyle = collarGrad;
      ctx.shadowColor = "rgba(255, 255, 255, 0.6)";
      ctx.shadowBlur = 4;
      ctx.fill();
      ctx.restore();

      // --- F. Cute Headphone Set over the Mic ---
      ctx.save();
      // Headphone headband arching over the mic
      ctx.beginPath();
      ctx.arc(
        0,
        -halfH * 0.3,
        halfW + 7 * scale,
        1.05 * Math.PI,
        1.95 * Math.PI,
        false,
      );
      ctx.lineWidth = 5 * scale;
      ctx.strokeStyle = "#0284c7";
      ctx.lineCap = "round";
      ctx.stroke();

      // Headphone top cushion pad
      ctx.beginPath();
      ctx.arc(
        0,
        -halfH * 0.3,
        halfW + 7 * scale,
        1.32 * Math.PI,
        1.68 * Math.PI,
        false,
      );
      ctx.lineWidth = 8 * scale;
      ctx.strokeStyle = "#38bdf8";
      ctx.lineCap = "round";
      ctx.stroke();

      // Left & Right Earcups
      [-halfW - 6 * scale, halfW + 6 * scale].forEach((ex, idx) => {
        // Earcup outer shell
        ctx.save();
        ctx.translate(ex, -halfH * 0.25);
        ctx.beginPath();
        ctx.roundRect(
          -4.5 * scale,
          -12 * scale,
          9 * scale,
          24 * scale,
          4 * scale,
        );
        ctx.fillStyle = "#0369a1";
        ctx.fill();

        // Earcup cushion
        ctx.beginPath();
        ctx.roundRect(
          idx === 0 ? 0 : -5 * scale,
          -10 * scale,
          5 * scale,
          20 * scale,
          3 * scale,
        );
        ctx.fillStyle = "#bae6fd";
        ctx.fill();
        ctx.restore();
      });
      ctx.restore();

      // --- G. Cute Expressive Face (Eyes, Cheeks, Smile) ---
      ctx.save();
      // Eye blinking calculation: blink every ~3.6s (frame % 130)
      const blinkCycle = frame % 140;
      const isBlinking = !reducedMotion && blinkCycle > 132 && blinkCycle < 138;

      const eyeDistance = 11 * scale;
      const eyeCenterY = 12 * scale;
      const eyeRadius = 4.5 * scale;

      [-eyeDistance, eyeDistance].forEach((ex) => {
        if (isBlinking) {
          // Closed happy blinking arc `^_^`
          ctx.beginPath();
          ctx.arc(
            ex,
            eyeCenterY,
            eyeRadius * 0.9,
            Math.PI * 0.15,
            Math.PI * 0.85,
          );
          ctx.lineWidth = 2.5 * scale;
          ctx.strokeStyle = "#082f49";
          ctx.lineCap = "round";
          ctx.stroke();
        } else if (active) {
          // Active listening sparkly starry eyes
          ctx.beginPath();
          ctx.arc(ex, eyeCenterY, eyeRadius * 1.1, 0, Math.PI * 2);
          ctx.fillStyle = "#082f49";
          ctx.fill();

          // Golden spark inside pupil
          draw4PointStar(
            ex,
            eyeCenterY,
            4,
            3.5 * scale,
            1.2 * scale,
            time * 2,
            "#fde047",
            "rgba(253, 224, 71, 0.8)",
          );

          // Specular white highlight
          ctx.beginPath();
          ctx.arc(
            ex - 1.5 * scale,
            eyeCenterY - 1.5 * scale,
            1.6 * scale,
            0,
            Math.PI * 2,
          );
          ctx.fillStyle = "#ffffff";
          ctx.fill();
        } else {
          // Normal idle cute round glossy eye
          ctx.beginPath();
          ctx.arc(ex, eyeCenterY, eyeRadius, 0, Math.PI * 2);
          ctx.fillStyle = "#082f49";
          ctx.fill();

          // Big glossy primary highlight
          ctx.beginPath();
          ctx.arc(
            ex - 1.5 * scale,
            eyeCenterY - 1.5 * scale,
            1.8 * scale,
            0,
            Math.PI * 2,
          );
          ctx.fillStyle = "#ffffff";
          ctx.fill();

          // Tiny secondary highlight
          ctx.beginPath();
          ctx.arc(
            ex + 1.2 * scale,
            eyeCenterY + 1.2 * scale,
            0.9 * scale,
            0,
            Math.PI * 2,
          );
          ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
          ctx.fill();
        }

        // Rosy blush under eye
        ctx.beginPath();
        ctx.ellipse(
          ex,
          eyeCenterY + 6 * scale,
          4.5 * scale,
          2.5 * scale,
          0,
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = "rgba(244, 114, 182, 0.55)";
        ctx.fill();
      });

      // Cute Mouth
      const mouthY = eyeCenterY + 7 * scale;
      if (active) {
        // Open animated talking/singing mouth responding to audio
        const mouthOpen = (4 + bounce * 25) * scale;
        ctx.beginPath();
        ctx.ellipse(0, mouthY, 4.5 * scale, mouthOpen, 0, 0, Math.PI, false);
        ctx.lineTo(3.5 * scale, mouthY);
        ctx.fillStyle = "#e11d48";
        ctx.fill();

        // Tiny rosy tongue
        ctx.beginPath();
        ctx.arc(0, mouthY + 2.5 * scale, 2.5 * scale, 0, Math.PI, false);
        ctx.fillStyle = "#fda4af";
        ctx.fill();
      } else {
        // Idle gentle smile
        ctx.beginPath();
        ctx.arc(0, mouthY, 4 * scale, 0.18 * Math.PI, 0.82 * Math.PI, false);
        ctx.lineWidth = 1.8 * scale;
        ctx.strokeStyle = "#0c4a6e";
        ctx.lineCap = "round";
        ctx.stroke();
      }
      ctx.restore();

      ctx.restore(); // end mic transform

      // -------------------------------------------------------------
      // 6. Label under Mascot (e.g. AI 同传 / LIVE TRANSLATE)
      // -------------------------------------------------------------
      if (label) {
        ctx.save();
        ctx.font = `bold ${12 * scale}px "Segoe UI", system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(14, 116, 144, 0.6)";
        ctx.fillText(label, cx, cy + 105 * scale);
        ctx.restore();
      }
    };

    const tick = () => {
      animFrame = 0;
      if (disposed) return;
      frame += 1;
      paint();
      schedule();
    };

    const schedule = () => {
      if (disposed || reducedMotion || animFrame !== 0) return;
      animFrame = window.requestAnimationFrame(tick);
    };

    const render = () => {
      if (disposed) return;
      paint();
      schedule();
    };

    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    repaintRef.current = render;
    render();

    return () => {
      disposed = true;
      repaintRef.current = null;
      observer.disconnect();
      if (animFrame) window.cancelAnimationFrame(animFrame);
      animFrame = 0;
    };
  }, []);

  return (
    <div className="ambient-visualizer-container" aria-hidden="true">
      <canvas ref={canvasRef} className="ambient-visualizer-canvas" />
    </div>
  );
}
