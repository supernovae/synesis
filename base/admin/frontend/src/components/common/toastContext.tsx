import { createContext } from "react";

export interface ToastMessage {
  id: number;
  type: "success" | "error" | "info";
  message: string;
}

export interface ToastContextType {
  toast: (type: ToastMessage["type"], message: string) => void;
}

export const ToastContext = createContext<ToastContextType | null>(null);
