/**
 * useFactoryRun.ts
 *
 * TanStack Query hook that encapsulates all DB-backed Factory operations.
 * factory.tsx consumes this hook and becomes a thin renderer.
 *
 * Responsibilities:
 *   - Load persisted runs from SQLite via useQuery
 *   - Probe system status (OpenAI key presence) via useQuery
 *   - Expose mutations for saveRun, updateRunStatus, clearRuns, exportRuns
 *   - Manage optimistic local state for freshly generated ideas (not yet in DB)
 *   - Track duplicate-warning state from the collision-guard in saveRun
 *   - One-time migration: legacy localStorage history → DB
 */

import { useState, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { factoryClient } from "@/ipc/types/factory";
import type { IdeaEvaluationResult, RunStatus } from "@/ipc/types/factory";
import { queryKeys } from "@/lib/queryKeys";
import { LEGACY_HISTORY_KEY } from "@/core/factory/storage";

// =============================================================================
// Hook
// =============================================================================

export function useFactoryRun() {
  const queryClient = useQueryClient();

  // --------------------------------------------------------------------------
  // Optimistic local state — ideas generated in this session that haven't yet
  // been confirmed saved to DB (or whose runId hasn't been injected back yet)
  // --------------------------------------------------------------------------
  const [localIdeas, setLocalIdeas] = useState<IdeaEvaluationResult[]>([]);
  const [duplicateWarning, setDuplicateWarning] = useState<{
    id: number;
    existing: IdeaEvaluationResult;
  } | null>(null);

  // --------------------------------------------------------------------------
  // Queries
  // --------------------------------------------------------------------------

  const runsQuery = useQuery({
    queryKey: queryKeys.factory.runs,
    queryFn: async () => {
      // One-time migration: localStorage → DB. Runs here because the first
      // listRuns call is the right time to drain the legacy store.
      if (!localStorage.getItem("factory-v3-migrated")) {
        try {
          const raw = localStorage.getItem(LEGACY_HISTORY_KEY);
          if (raw) {
            const legacy = JSON.parse(raw) as IdeaEvaluationResult[];
            if (legacy.length === 0) {
              localStorage.removeItem(LEGACY_HISTORY_KEY);
              localStorage.setItem("factory-v3-migrated", "1");
            } else {
              const results = await Promise.allSettled(
                legacy.map((idea) => factoryClient.saveRun({ idea })),
              );
              const migrationSucceeded = results.every(
                (result) => result.status === "fulfilled",
              );
              if (migrationSucceeded) {
                localStorage.removeItem(LEGACY_HISTORY_KEY);
                localStorage.setItem("factory-v3-migrated", "1");
              }
            }
          } else {
            localStorage.setItem("factory-v3-migrated", "1");
          }
        } catch {
          // ignore migration errors
        }
      }

      const { runs } = await factoryClient.listRuns({});
      return runs;
    },
  });

  const systemStatusQuery = useQuery({
    queryKey: queryKeys.factory.systemStatus,
    queryFn: () => factoryClient.getSystemStatus({}),
  });

  // --------------------------------------------------------------------------
  // Merged history: local (optimistic) prepended to DB rows, de-duped by name
  // --------------------------------------------------------------------------
  const history = useMemo(() => {
    const dbRuns = runsQuery.data ?? [];
    const localNames = new Set(localIdeas.map((i) => i.name));
    return [
      ...localIdeas,
      ...dbRuns.filter((r) => !localNames.has(r.name)),
    ].slice(0, 200);
  }, [localIdeas, runsQuery.data]);

  // --------------------------------------------------------------------------
  // Mutations
  // --------------------------------------------------------------------------

  const saveRunMutation = useMutation({
    mutationFn: (idea: IdeaEvaluationResult) => factoryClient.saveRun({ idea }),
  });

  const updateRunStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: RunStatus }) =>
      factoryClient.updateRunStatus({ id, status }),
    onSuccess: (_, { id, status }) => {
      // Patch local optimistic state
      setLocalIdeas((prev) =>
        prev.map((h) => (h.runId === id ? { ...h, runStatus: status } : h)),
      );
      // Patch the query cache so the DB view is also immediately consistent
      queryClient.setQueryData<IdeaEvaluationResult[]>(
        queryKeys.factory.runs,
        (old) =>
          old?.map((r) => (r.runId === id ? { ...r, runStatus: status } : r)) ??
          [],
      );
    },
  });

  const clearRunsMutation = useMutation({
    mutationFn: () => factoryClient.clearRuns({}),
    onSuccess: () => {
      setLocalIdeas([]);
      queryClient.setQueryData(queryKeys.factory.runs, []);
    },
  });

  const exportRunsMutation = useMutation({
    mutationFn: (filter: "BUILD" | "all") =>
      factoryClient.exportRuns({ filter }),
  });

  // --------------------------------------------------------------------------
  // addToHistory — used by tab components when new ideas are generated
  // --------------------------------------------------------------------------
  const addToHistory = useCallback(
    (items: IdeaEvaluationResult | IdeaEvaluationResult[]) => {
      const arr = Array.isArray(items) ? items : [items];

      // Persist each item to DB; track runId injection and duplicate warnings
      for (const idea of arr) {
        saveRunMutation
          .mutateAsync(idea)
          .then(({ id, duplicate }) => {
            if (duplicate) {
              setDuplicateWarning({ id, existing: duplicate });
              // Keep the optimistic entry visible; patch it with the existing
              // run's id so UI controls (status, export) work correctly.
              setLocalIdeas((prev) =>
                prev.map((p) =>
                  p.name === idea.name
                    ? {
                        ...p,
                        runId: id,
                        runStatus:
                          duplicate.runStatus ?? ("DECIDED" as RunStatus),
                      }
                    : p,
                ),
              );
            } else {
              // Inject runId back into the local entry
              setLocalIdeas((prev) =>
                prev.map((p) =>
                  p.name === idea.name
                    ? { ...p, runId: id, runStatus: "DECIDED" as RunStatus }
                    : p,
                ),
              );
            }
          })
          .catch(() => {});
      }

      // Add to local state immediately (optimistic)
      setLocalIdeas((prev) => {
        const names = new Set(arr.map((i) => i.name));
        return [...arr, ...prev.filter((p) => !names.has(p.name))].slice(
          0,
          200,
        );
      });
    },
    [saveRunMutation],
  );

  // --------------------------------------------------------------------------
  // Public callbacks
  // --------------------------------------------------------------------------

  const handleRunStatusChange = useCallback(
    (runId: number, status: RunStatus) => {
      updateRunStatusMutation
        .mutateAsync({ id: runId, status })
        .catch(() => {});
    },
    [updateRunStatusMutation],
  );

  const clearHistory = useCallback(() => {
    clearRunsMutation.mutateAsync().catch(() => {});
  }, [clearRunsMutation]);

  const exportRuns = useCallback(
    (filter: "BUILD" | "all") => {
      exportRunsMutation.mutateAsync(filter).catch(() => {});
    },
    [exportRunsMutation],
  );

  const dismissDuplicateWarning = useCallback(() => {
    setDuplicateWarning(null);
  }, []);

  return {
    history,
    systemStatus: systemStatusQuery.data ?? null,
    duplicateWarning,
    dismissDuplicateWarning,
    addToHistory,
    handleRunStatusChange,
    clearHistory,
    exportRuns,
  };
}
