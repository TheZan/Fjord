import { useCallback, useEffect, useState } from "react";
import type { GitAuthPrompt } from "@/domain/generated";
import {
  answerGitAuthPrompt,
  cancelGitAuthPrompt,
  listenGitAuthPrompts,
  listenOperationProgress,
} from "@/infrastructure/tauriClient";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

export function useGitAuthPrompts() {
  const [prompts, setPrompts] = useState<GitAuthPrompt[]>([]);

  const removePrompt = useCallback((operationId: string, promptId: string) => {
    setPrompts((current) =>
      current.filter(
        (prompt) => prompt.operationId !== operationId || prompt.promptId !== promptId,
      ),
    );
  }, []);

  useEffect(() => {
    let active = true;
    const cleanups: Array<() => void> = [];
    void listenGitAuthPrompts((prompt) => {
      setPrompts((current) => {
        const duplicate = current.some(
          (item) =>
            item.operationId === prompt.operationId && item.promptId === prompt.promptId,
        );
        return duplicate ? current : [...current, prompt];
      });
    }).then((unlisten) => (active ? cleanups.push(unlisten) : unlisten()));
    void listenOperationProgress((event) => {
      if (TERMINAL_STATUSES.has(event.status)) {
        setPrompts((current) =>
          current.filter((prompt) => prompt.operationId !== event.operationId),
        );
      }
    }).then((unlisten) => (active ? cleanups.push(unlisten) : unlisten()));

    return () => {
      active = false;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, []);

  const answerPrompt = useCallback(
    async (prompt: GitAuthPrompt, value: string) => {
      try {
        await answerGitAuthPrompt(prompt.operationId, prompt.promptId, value);
      } finally {
        removePrompt(prompt.operationId, prompt.promptId);
      }
    },
    [removePrompt],
  );

  const cancelPrompt = useCallback(
    async (prompt: GitAuthPrompt) => {
      try {
        await cancelGitAuthPrompt(prompt.operationId, prompt.promptId);
      } finally {
        removePrompt(prompt.operationId, prompt.promptId);
      }
    },
    [removePrompt],
  );

  return {
    activePrompt: prompts[0] ?? null,
    queuedCount: Math.max(0, prompts.length - 1),
    answerPrompt,
    cancelPrompt,
  };
}
