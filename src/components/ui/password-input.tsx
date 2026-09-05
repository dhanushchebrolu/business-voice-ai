import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

export interface PasswordInputProps extends Omit<React.ComponentProps<"input">, "type"> {
  /** Defaults to "Password" — used only to build the toggle button's aria-label. */
  fieldLabel?: string;
}

/**
 * A password field with a visibility toggle. Hidden by default; the raw
 * value is never rendered or logged anywhere else — only this input's own
 * `type` attribute changes between "password" and "text".
 */
export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, fieldLabel = "password", ...props }, ref) => {
    const [visible, setVisible] = React.useState(false);

    return (
      <div className="relative">
        <Input
          {...props}
          ref={ref}
          type={visible ? "text" : "password"}
          className={cn("pr-10", className)}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? `Hide ${fieldLabel}` : `Show ${fieldLabel}`}
          aria-pressed={visible}
          tabIndex={-1}
          className="absolute inset-y-0 right-0 grid w-9 place-items-center text-muted-foreground hover:text-foreground"
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = "PasswordInput";
