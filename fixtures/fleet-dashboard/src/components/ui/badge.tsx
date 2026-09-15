import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib_utils";

const badgeVariants = cva("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", {
  variants: {
    status: {
      active: "bg-emerald-100 text-emerald-800",
      idle: "bg-slate-100 text-slate-600",
      alert: "bg-red-100 text-red-800",
    },
  },
  defaultVariants: { status: "idle" },
});

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, status, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ status }), className)} {...props} />;
}
