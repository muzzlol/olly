import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  title: string;
  body: string;
  onClose: () => void;
}

/**
 * A zero-dependency modal used for placeholders whose backend wiring does not
 * exist yet. Kept minimal on purpose — real product flows should use a proper
 * dialog component.
 */
export function StubModal({ title, body, onClose }: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="text-base font-semibold">{title}</div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{body}</p>
        <div className="mt-5 flex justify-end">
          <Button size="sm" onClick={onClose}>
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}
