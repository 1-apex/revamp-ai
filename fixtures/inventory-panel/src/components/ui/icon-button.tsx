import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib_utils";

// Single-argument cva() — no base class string, only a variants object.
// Real usage in the wild (icon-only buttons that have no shared base
// styling across tones, only per-tone ones) and, before this fixture,
// only ever exercised by hand-written snippets inline in validator.test.ts
// rather than a real file on disk.
const iconButtonVariants = cva({
  variants: {
    tone: {
      neutral: "bg-neutral-100 text-neutral-700 hover:bg-neutral-200",
      danger: "bg-red-50 text-danger hover:bg-red-100",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButtonVariants> {}

// React.memo(React.forwardRef(...)) — the double-wrap shadcn/ui and most
// real icon-button primitives use once they also want to skip re-renders
// when props are unchanged. A single forwardRef unwrap (as fleet-dashboard's
// Button already exercises) isn't enough to prove the unwrap recurses.
export const IconButton = React.memo(
  React.forwardRef<HTMLButtonElement, IconButtonProps>(({ className, tone, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        className={cn(iconButtonVariants({ tone }), className)}
        {...props}
      />
    );
  })
);
IconButton.displayName = "IconButton";
