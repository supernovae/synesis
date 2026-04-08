import { Suspense } from "react";
import { Hexagon } from "lucide-react";
import { RouterProvider } from "react-router-dom";
import { router } from "./router";

function RouterFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900">
      <div className="flex flex-col items-center gap-4">
        <Hexagon className="h-12 w-12 animate-pulse text-blue-500" />
        <div className="text-slate-400">Loading...</div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<RouterFallback />}>
      <RouterProvider router={router} />
    </Suspense>
  );
}
