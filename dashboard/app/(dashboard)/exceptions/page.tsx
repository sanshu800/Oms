"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { useAuth } from "@/lib/auth-context";
import { api, type OperationalException } from "@/lib/api";
import { Card, EmptyState, PageHeader, SeverityBadge, Spinner, StatusBadge } from "@/components/ui";

const STATUS_FILTERS = [
  { value: "", label: "Needs attention" },
  { value: "OPEN", label: "Open" },
  { value: "INVESTIGATING", label: "Investigating" },
  { value: "RESOLVED", label: "Resolved" },
];

export default function ExceptionsPage() {
  const { selectedStoreId, stores } = useAuth();
  const [status, setStatus] = useState("");
  const [exceptions, setExceptions] = useState<OperationalException[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedStoreId) return;

    setExceptions(null);
    setError(null);

    api
      .listExceptions({ storeId: selectedStoreId, status: status || undefined })
      .then((res) => setExceptions(res.exceptions))
      .catch(() => setError("Couldn't load exceptions."));
  }, [selectedStoreId, status]);

  return (
    <>
      <PageHeader
        title="Exceptions"
        description="Every operational integrity issue TechMart's deterministic engine has detected."
      />

      <div className="mb-4 flex gap-1.5">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setStatus(f.value)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              status === f.value
                ? "bg-slate-900 text-white"
                : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <Card>
        {stores.length === 0 ? (
          <EmptyState title="No store connected yet" />
        ) : error ? (
          <p className="p-6 text-sm text-red-600">{error}</p>
        ) : !exceptions ? (
          <div className="flex justify-center py-14">
            <Spinner />
          </div>
        ) : exceptions.length === 0 ? (
          <EmptyState title="Nothing here" description="No exceptions match this filter." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs text-slate-400">
                <th className="px-5 py-3 font-medium">Exception</th>
                <th className="px-5 py-3 font-medium">Category</th>
                <th className="px-5 py-3 font-medium">Severity</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Detected</th>
              </tr>
            </thead>
            <tbody>
              {exceptions.map((exception) => (
                <tr key={exception.id} className="border-b border-slate-50 last:border-0">
                  <td className="px-5 py-3">
                    <Link
                      href={`/exceptions/${exception.id}`}
                      className="font-medium text-slate-800 hover:text-slate-950 hover:underline"
                    >
                      {exception.title}
                    </Link>
                  </td>
                  <td className="px-5 py-3 text-slate-500">{exception.category}</td>
                  <td className="px-5 py-3">
                    <SeverityBadge severity={exception.severity} />
                  </td>
                  <td className="px-5 py-3">
                    <StatusBadge status={exception.status} />
                  </td>
                  <td className="px-5 py-3 text-slate-400">
                    {new Date(exception.detectedAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
