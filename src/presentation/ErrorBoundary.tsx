import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/presentation/ui";

/**
 * Catches render exceptions so a bug in one view can't blank the whole
 * window (docs/tasks.md P4-10). Mounted globally in `main.tsx` and around
 * each main view in `App.tsx` — the per-view instance is keyed by the
 * current view, so navigating away resets it.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled render error", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorFallback
          error={this.state.error}
          onRetry={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}

function ErrorFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full min-h-[240px] w-full flex-1 items-center justify-center p-6">
      <div
        className="flex w-[420px] max-w-full flex-col gap-3 rounded-lg border p-5"
        style={{
          borderWidth: "0.5px",
          borderColor: "var(--hairline-strong)",
          background: "var(--paper)",
        }}
      >
        <h2 className="text-[15px] font-medium" style={{ color: "var(--rust-ink)" }}>
          {t("errorBoundary.title")}
        </h2>
        <p className="text-sm" style={{ color: "var(--slate)" }}>
          {t("errorBoundary.body")}
        </p>
        <pre
          className="overflow-x-auto rounded-lg p-2 text-xs"
          style={{ background: "var(--page-bg)", color: "var(--mist)" }}
        >
          {error.message}
        </pre>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
            {t("errorBoundary.reload")}
          </Button>
          <Button size="sm" onClick={onRetry}>
            {t("errorBoundary.retry")}
          </Button>
        </div>
      </div>
    </div>
  );
}
