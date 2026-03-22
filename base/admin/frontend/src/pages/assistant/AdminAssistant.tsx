import { useState, useRef, useEffect } from "react";
import { useLocation, Link } from "react-router-dom";
import { useAssistantChat } from "../../api/hooks";
import { Send, Bot, User, Loader2 } from "lucide-react";
import MarkdownContent from "../../components/common/MarkdownContent";
import RichContent from "../../components/common/RichContent";

interface Message {
  role: "user" | "assistant";
  content: string;
  tokens?: number;
}

export default function AdminAssistant() {
  const location = useLocation();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [context, setContext] = useState("");
  const chatMutation = useAssistantChat();
  const endRef = useRef<HTMLDivElement>(null);

  // Accept context passed from trace assistant via navigation state
  useEffect(() => {
    const navState = location.state as { context?: string } | null;
    if (navState?.context) {
      setContext(navState.context);
      // Clear navigation state so refresh doesn't re-apply
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = () => {
    if (!input.trim()) return;
    const userMsg = input.trim();
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setInput("");

    chatMutation.mutate(
      { message: userMsg, context: context || undefined },
      {
        onSuccess: (data) => {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: data.response,
              tokens: data.tokens,
            },
          ]);
        },
        onError: () => {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: "Failed to get a response." },
          ]);
        },
      },
    );
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          Admin Assistant
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Ask questions about traces, costs, taxonomy, or system behavior.{" "}
          <Link to="/models/overview" className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
            Models &amp; Costs overview
          </Link>{" "}
          for system-wide usage (this chat only shows tokens for the assistant request itself).
        </p>
      </div>

      <div className="flex-1 overflow-y-auto rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-gray-400">
            <div className="text-center">
              <Bot className="mx-auto mb-2 h-8 w-8" />
              <p>Ask me anything about your Synesis deployment.</p>
              <p className="mt-1 text-xs">
                Paste trace JSON, config snippets, or error logs in the context
                box below.
              </p>
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`mb-3 flex gap-3 ${msg.role === "user" ? "justify-end" : ""}`}
          >
            {msg.role === "assistant" && (
              <Bot className="mt-1 h-5 w-5 flex-shrink-0 text-indigo-500" />
            )}
            <div
              className={`max-w-[75%] rounded-lg px-4 py-2 ${
                msg.role === "user"
                  ? "text-sm bg-indigo-600 text-white"
                  : "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200"
              }`}
            >
              {msg.role === "assistant" ? (
                <MarkdownContent content={msg.content} />
              ) : (
                <RichContent content={msg.content} maxHeight="max-h-96" />
              )}
              {msg.tokens != null && msg.tokens > 0 && (
                <span className="mt-1 block text-xs opacity-60">
                  {msg.tokens} tokens
                </span>
              )}
            </div>
            {msg.role === "user" && (
              <User className="mt-1 h-5 w-5 flex-shrink-0 text-gray-400" />
            )}
          </div>
        ))}
        {chatMutation.isPending && (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Thinking...
          </div>
        )}
        <div ref={endRef} />
      </div>

      <details
        className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900"
        open={!!context}
      >
        <summary className="cursor-pointer px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-400">
          Context
          {context
            ? ` (${context.length.toLocaleString()} chars loaded)`
            : " (optional — paste trace, config, or error data)"}
        </summary>
        <textarea
          rows={context ? 8 : 4}
          value={context}
          onChange={(e) => setContext(e.target.value)}
          placeholder="Paste JSON trace, config snippet, error log..."
          className="w-full border-t border-gray-200 px-4 py-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-800 dark:text-white"
        />
      </details>

      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
          placeholder="Ask about traces, costs, config..."
          className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
        />
        <button
          onClick={handleSend}
          disabled={chatMutation.isPending || !input.trim()}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
