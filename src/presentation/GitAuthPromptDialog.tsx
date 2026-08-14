import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GitAuthPrompt } from "@/domain/generated";
import { Button, Input } from "@/presentation/ui";
import { useDialogFocusTrap } from "@/presentation/useDialogFocusTrap";

export function GitAuthPromptDialog({
  prompt,
  repositoryName,
  queuedCount,
  onAnswer,
  onCancel,
}: {
  prompt: GitAuthPrompt;
  repositoryName?: string | null;
  queuedCount: number;
  onAnswer: (value: string) => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmation = prompt.kind === "confirmation";
  useDialogFocusTrap(dialogRef, () => void cancel());

  useEffect(() => {
    setValue("");
    setPending(false);
    inputRef.current?.focus();
  }, [prompt.operationId, prompt.promptId]);

  async function submit() {
    const answer = confirmation ? "yes" : value;
    if (!confirmation && !answer) return;
    setValue("");
    setPending(true);
    try {
      await onAnswer(answer);
    } finally {
      setPending(false);
    }
  }

  async function cancel() {
    setValue("");
    setPending(true);
    try {
      await onCancel();
    } finally {
      setPending(false);
    }
  }

  const title = confirmation ? t("gitAuth.confirmTitle") : t("gitAuth.title");
  const inputType = prompt.kind === "username" ? "text" : "password";

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30 p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="desktop-popover w-full max-w-md rounded-lg border p-4"
        style={{ background: "var(--paper)", borderColor: "var(--hairline-strong)" }}
      >
        <h2 className="text-sm font-semibold" style={{ color: "var(--ink)" }}>{title}</h2>
        {(repositoryName || prompt.repositoryName || prompt.operationKind) && (
          <p className="mt-1 text-[11px]" style={{ color: "var(--mist)" }}>
            {[repositoryName ?? prompt.repositoryName, prompt.operationKind].filter(Boolean).join(" · ")}
          </p>
        )}
        <p className="mt-3 whitespace-pre-wrap break-words text-[13px]" style={{ color: "var(--slate)" }}>
          {prompt.prompt}
        </p>

        {!confirmation && (
          <label className="mt-4 flex flex-col gap-1.5 text-[12px]" style={{ color: "var(--slate)" }}>
            <span>{prompt.kind === "username" ? t("gitAuth.username") : t("gitAuth.secret")}</span>
            <Input
              ref={inputRef}
              type={inputType}
              autoComplete={prompt.kind === "username" ? "username" : "current-password"}
              value={value}
              disabled={pending}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
            />
          </label>
        )}

        {queuedCount > 0 && (
          <p className="mt-3 text-[11px]" style={{ color: "var(--mist)" }}>
            {t("gitAuth.queued", { count: queuedCount })}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button disabled={pending} onClick={() => void cancel()}>
            {confirmation ? t("gitAuth.reject") : t("gitAuth.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={pending || (!confirmation && !value)}
            onClick={() => void submit()}
          >
            {pending
              ? t("gitAuth.waiting")
              : confirmation
                ? t("gitAuth.confirm")
                : t("gitAuth.continue")}
          </Button>
        </div>
      </div>
    </div>
  );
}
