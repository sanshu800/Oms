"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { useAuth } from "@/lib/auth-context";
import {
  api,
  type AiDecisionProposal,
  type OperationalException,
} from "@/lib/api";
import {
  Card,
  CardHeader,
  ConfidenceBar,
  EmptyState,
  PageHeader,
  RiskBadge,
  SeverityBadge,
  Spinner,
  StatusBadge,
} from "@/components/ui";

export default function OverviewPage() {
  const { selectedStoreId, stores } = useAuth();
  const [exceptions, setExceptions] = useState<OperationalException[] | null>(null);
  const [proposals, setProposals] = useState<AiDecisionProposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedStoreId) return;

    setExceptions(null);
    setProposals(null);
    setError(null);

    Promise.all([
      api.listExceptions({ storeId: selectedStoreId }),
      api.listProposals({ storeId: selectedStoreId, status: "PROPOSED" }),
    ])
      .then(([exceptionsRes, proposalsRes]) => {
        setExceptions(exceptionsRes.exceptions);
        setProposals(proposalsRes.proposals);
      })
      .catch(() => setError("Couldn't load your operational data."));
  }, [selectedStoreId]);

  if (stores.length === 0) {
    return (
      <>
        <PageHeader title="Overview" />
        <Card>
          <EmptyState
            title="No store connected yet"
            description="Connect a Shopify store to start seeing operational exceptions and AI recommendations here."
          />
        </Card>
      </>
    );
  }

  const criticalCount = exceptions?.filter((e) => e.severity === "CRITICAL").length ?? 0;
  const openCount = exceptions?.length ?? 0;
  const pendingCount = proposals?.length ?? 0;

  return (
    <>
      <PageHeader
        title="Overview"
        description="What TechMart's AI thinks deserves your attention right now."
      />

      {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}

      <div className="mb-6 grid grid-cols-3 gap-4">
        <StatCard label="Open exceptions" value={openCount} loading={!exceptions} />
        <StatCard
          label="Critical"
          value={criticalCount}
          loading={!exceptions}
          tone={criticalCount > 0 ? "critical" : "default"}
        />
        <StatCard
          label="AI proposals awaiting review"
          value={pendingCount}
          loading={!proposals}
          tone={pendingCount > 0 ? "attention" : "default"}
        />
      </div>

      <div className="grid grid-cols-2 gap-5">
        <Card>
          <CardHeader
            title="Needs attention"
            subtitle="Open operational exceptions, most recent first"
            action={
              <Link href="/exceptions" className="text-xs font-medium text-slate-500 hover:text-slate-800">
                View all →
              </Link>
            }
          />
          {!exceptions ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : exceptions.length === 0 ? (
            <EmptyState title="All clear" description="No open exceptions right now." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {exceptions.slice(0, 6).map((exception) => (
                <li key={exception.id}>
                  <Link
                    href={`/exceptions/${exception.id}`}
                    className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-slate-50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-800">
                        {exception.title}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-400">{exception.category}</p>
                    </div>
                    <SeverityBadge severity={exception.severity} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="AI recommendations"
            subtitle="Proposals waiting for your decision"
            action={
              <Link href="/proposals" className="text-xs font-medium text-slate-500 hover:text-slate-800">
                View all →
              </Link>
            }
          />
          {!proposals ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : proposals.length === 0 ? (
            <EmptyState
              title="Nothing pending"
              description="TechMart's AI has no recommendations waiting for review."
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {proposals.slice(0, 6).map((proposal) => (
                <li key={proposal.id}>
                  <Link
                    href={`/exceptions/${proposal.exceptionId}`}
                    className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-slate-50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-800">
                        {proposal.actionType.replace(/_/g, " ").toLowerCase()}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-slate-400">
                        {proposal.exception?.title}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <RiskBadge riskTier={proposal.riskTier} />
                      <ConfidenceBar confidence={proposal.confidence} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function StatCard({
  label,
  value,
  loading,
  tone = "default",
}: {
  label: string;
  value: number;
  loading: boolean;
  tone?: "default" | "critical" | "attention";
}) {
  const toneClasses =
    tone === "critical"
      ? "text-red-600"
      : tone === "attention"
        ? "text-indigo-600"
        : "text-slate-900";

  return (
    <Card className="px-5 py-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={`mt-1.5 text-2xl font-semibold ${toneClasses}`}>
        {loading ? <Spinner className="mt-1" /> : value}
      </p>
    </Card>
  );
}
