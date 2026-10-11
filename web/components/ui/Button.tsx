import { cn } from "@/lib/cn";
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "accent" | "ghost";
type Size = "lg" | "md" | "sm";

const variants: Record<Variant, string> = {
  // Both fills and both hovers are tokens now. `bg-cocoa` lightens in dark
  // mode because it is also the secondary-text colour, so white type on it
  // dropped to roughly 2:1 — on Pay, Place order and Book ride. The secondary
  // hover was a fixed light beige, so in dark mode hovering turned near-white
  // ink onto a near-white band.
  primary: "bg-btn text-white hover:bg-btn-hover disabled:bg-btn/50",
  secondary: "bg-beige text-ink hover:bg-beige-hover disabled:opacity-50",
  accent: "bg-accent text-white hover:bg-[#d4570f] disabled:bg-accent/50",
  ghost: "bg-transparent text-ink hover:bg-beige/60 disabled:opacity-50",
};

const sizes: Record<Size, string> = {
  lg: "h-14 px-6 text-[17px]",
  md: "h-11 px-5 text-[15px]",
  sm: "h-9 px-4 text-[13px]",
};

export function Button({
  variant = "primary",
  size = "lg",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
}) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-pill font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
