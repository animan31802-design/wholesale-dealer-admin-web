import { useEffect } from "react";
 
interface Options {
  onClose: () => void;
  onConfirm?: () => void;
  disabled?: boolean;       // set true while saving/loading to prevent double-fire
  confirmOnEnter?: boolean; // default true
}
 
export function useModalKeyboard({ onClose, onConfirm, disabled = false, confirmOnEnter = true }: Options) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't fire if focus is inside a textarea (multiline input — Enter is a newline there)
      const tag = (e.target as HTMLElement)?.tagName;
      const isTextarea = tag === "TEXTAREA";
 
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
 
      if (e.key === "Enter" && confirmOnEnter && onConfirm && !disabled && !isTextarea) {
        // Don't intercept Enter inside a <select> or when a button already has focus
        // (the button's own click handler will fire)
        if (tag === "BUTTON" || tag === "SELECT") return;
        e.preventDefault();
        onConfirm();
      }
    };
 
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, onConfirm, disabled, confirmOnEnter]);
}