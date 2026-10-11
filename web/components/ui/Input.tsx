import { cn } from "@/lib/cn";
import type { InputHTMLAttributes, ReactNode } from "react";

export function Input({
  label,
  error,
  className,
  id,
  icon,
  trailing,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  error?: string;
  icon?: ReactNode; // leading icon inside the field
  trailing?: ReactNode; // trailing control (e.g. password eye toggle)
}) {
  return (
    <label className="block w-full text-left">
      {label && (
        <span className="mb-1.5 block text-[13px] font-medium text-cocoa">
          {label}
        </span>
      )}
      <div className="relative">
        {icon && (
          <span className="pointer-events-none absolute left-[18px] top-1/2 -translate-y-1/2 text-cocoa/55">
            {icon}
          </span>
        )}
        <input
          id={id}
          className={cn(
            // Pill field with a faint warm border on a soft surface — matches
            // Figma. The border is the `line` token, not the literal it was:
            // a fixed near-white hairline kept its light value in dark mode,
            // so every field on the join-group, address, budget and shared-ride
            // screens was ringed in white against a #191919 fill.
            "h-[52px] w-full rounded-full border border-line bg-surface text-[15px] text-ink placeholder:text-cocoa/45",
            icon ? "pl-[46px]" : "pl-5",
            trailing ? "pr-[46px]" : "pr-5",
            "outline-none transition-colors focus:border-accent/60 focus:ring-2 focus:ring-accent/10",
            error && "border-danger focus:border-danger focus:ring-danger/20",
            className,
          )}
          {...props}
        />
        {trailing && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2">
            {trailing}
          </span>
        )}
      </div>
      {error && <span className="mt-1 block text-[12px] text-danger">{error}</span>}
    </label>
  );
}
