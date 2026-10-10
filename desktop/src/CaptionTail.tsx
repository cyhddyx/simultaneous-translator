import { useLayoutEffect, useRef, type ComponentPropsWithoutRef } from "react";

type CaptionTailProps = Omit<ComponentPropsWithoutRef<"p">, "children"> & {
  children: string;
  lines: number;
};

/** Keep the newest wrapped lines visible without shortening the stored text. */
export function CaptionTail({ children, lines, style, ...props }: CaptionTailProps) {
  const viewportRef = useRef<HTMLParagraphElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  const followTail = () => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  };

  useLayoutEffect(followTail, [children, lines, style?.fontSize]);

  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text) return;
    // Observe the unbounded text, including font loading and window resizing.
    const observer = new ResizeObserver(followTail);
    observer.observe(text);
    if (viewportRef.current) observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <p
      {...props}
      ref={viewportRef}
      style={{
        ...style,
        display: "block",
        maxHeight: `calc(var(--caption-tail-lines, ${lines}) * 1lh)`,
        overflow: "hidden",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        textOverflow: "clip",
        WebkitLineClamp: "unset",
        scrollBehavior: "auto",
        overflowAnchor: "none",
      }}
    >
      <span ref={textRef} style={{ display: "block" }}>{children}</span>
    </p>
  );
}
