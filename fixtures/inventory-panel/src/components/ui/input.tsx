import * as React from "react";
import { cn } from "../../lib_utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, ...props }, ref) => {
  return (
    <input
      ref={ref}
      className={cn("h-9 rounded-md border border-neutral-300 px-3 text-sm", className)}
      {...props}
    />
  );
});
Input.displayName = "Input";
