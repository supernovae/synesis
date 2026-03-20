import { useContext } from "react";
import { ToastContext, type ToastContextType } from "./toastContext";

export function useToast(): ToastContextType {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
