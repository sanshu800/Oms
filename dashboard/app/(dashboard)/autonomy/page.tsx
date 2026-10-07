"use client";

import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/lib/auth-context";
import { api, type AutonomyPolicy } from "@/lib/api";
import { Button, Card, CardHeader, PageHeader, Spinner } from "@/components/ui";

const EXECUTABLE_ACTION_TYPES = [
  {
    actionType: "RELEASE_ORDER_RESERVATION",
    label: "Release order reservation",
    description:
      "Frees inventory held for an order that's failed/cancelled but still shows an active reservation. Fully internal, fully reversible.",
  },
  {
    actionType: "ADD_ORDER_NOTE",
    label: "Add order note",
    description:
      "Writes a note directly onto the order in your real Shopify store. Purely informational — never touches money, inventory, or fulfillment.",
  },
];

export default function AutonomyPage() {
  const { selectedStoreId } = useAuth();
  const [policies, setPolicies] = useState<Record<string, AutonomyPolicy> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!selectedStoreId) return;

    api
      .listAutonomyPolicies()
      .then((list) => {
        const map: Record<string, AutonomyPolicy> = {};
        for (const p of list) map[p.actionType] = p;
        setPolicies(map);
      })
      .catch(() => setError("Couldn't load autonomy policies."));
  }, [selectedStoreId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <PageHeader
        title="Autonomy"
        description="Let proven, low-risk AI recommendations execute automatically instead of waiting for your review — earned one action type at a time, never all at once."
      />

      {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}

      {!policies ? (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-5">
          {EXECUTABLE_ACTION_TYPES.map((action) => (
            <PolicyCard
              key={action.actionType}
              action={action}
              policy={policies[action.actionType]}
              onSaved={load}
            />
          ))}
        </div>
      )}
    </>
  );
}

function PolicyCard({
  action,
  policy,
  onSaved,
}: {
  action: (typeof EXECUTABLE_ACTION_TYPES)[number];
  policy: AutonomyPolicy | undefined;
  onSaved: () => void;
}) {
  const [enabled, setEnabled] = useState(policy?.enabled ?? false);
  const [threshold, setThreshold] = useState(policy?.confidenceThreshold ?? 0.9);
  const [maxPerHour, setMaxPerHour] = useState(policy?.maxActionsPerHour ?? 5);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setEnabled(policy?.enabled ?? false);
    setThreshold(policy?.confidenceThreshold ?? 0.9);
    setMaxPerHour(policy?.maxActionsPerHour ?? 5);
  }, [policy]);

  async function save() {
    setSaving(true);
    try {
      await api.upsertAutonomyPolicy({
        actionType: action.actionType,
        autonomyLevel: enabled ? "AUTO_BELOW_THRESHOLD" : "RECOMMEND_ONLY",
        confidenceThreshold: threshold,
        maxActionsPerHour: maxPerHour,
        enabled,
      });
      setSavedAt(Date.now());
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={action.label}
        subtitle={action.description}
        action={
          <label className="flex cursor-pointer items-center gap-2">
            <span className="text-xs font-medium text-slate-500">
              {enabled ? "Auto-execute" : "Recommend only"}
            </span>
            <button
              onClick={() => setEnabled(!enabled)}
              className={`relative h-6 w-11 rounded-full transition-colors ${
                enabled ? "bg-emerald-500" : "bg-slate-200"
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  enabled ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </label>
        }
      />

      <div className="grid grid-cols-2 gap-6 px-5 py-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600">
            Minimum confidence to auto-execute
          </label>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0.5}
              max={1}
              step={0.01}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              disabled={!enabled}
              className="flex-1"
            />
            <span className="w-10 text-sm font-medium text-slate-700">
              {Math.round(threshold * 100)}%
            </span>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600">
            Max auto-executions per hour
          </label>
          <input
            type="number"
            min={0}
            value={maxPerHour}
            onChange={(e) => setMaxPerHour(Number(e.target.value))}
            disabled={!enabled}
            className="w-24 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm disabled:bg-slate-50 disabled:text-slate-400"
          />
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3">
        <p className="text-xs text-slate-400">
          {savedAt ? "Saved." : "Only ever applies to LOW-risk proposals — that rule can't be changed here."}
        </p>
        <Button variant="secondary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </Card>
  );
}
