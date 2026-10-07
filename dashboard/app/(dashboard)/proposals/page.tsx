"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { useAuth } from "@/lib/auth-context";
import { api, type AiDecisionProposal } from "@/lib/api";
import {
  BasisBadge,
  Button,
  Card,
  ConfidenceBar,
  EmptyState,
  PageHeader,
  RiskBadge,
  SeverityBadge,
  Spinner,
} from "@/components/ui";

export default function ProposalsPage() {
  const { selectedStoreId } = useAuth();
  const [proposals, setProposals] = useState<AiDecisionProposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actioningId, setActioningId] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!selectedStoreId) return;

    setError(null);
    api
      .listProposals({ storeId: selectedStoreId, status: "PROPOSED" })
      .then((res) => setProposals(res.proposals))
      .catch(() => setError("Couldn't load proposals."));
  }, [selectedStoreId]);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(proposalId: string, decision: "approve" | "reject") {
    if (!selectedStoreId) return;

    setActioningId(proposalId);

    try {
      if (decision === "approve") {
        await api.approveProposal({ proposalId, storeId: selectedStoreId, actorId: "dashboard-user" });
      } else {
        await api.rejectProposal({ proposalId, storeId: selectedStoreId, actorId: "dashboard-user" });
      }
      load();
    } finally {
      setActioningId(null);
    }
  }

  return (
    <>
      <PageHeader
        title="AI Proposals"
        description="Every recommendation TechMart's AI has made that's still waiting for a decision."
      />

      {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}

      {!proposals ? (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      ) : proposals.length === 0 ? (
        <Card>
          <EmptyState title="Inbox zero" description="No AI proposals are waiting for review." />
        </Card>
      ) : (
        <div className="space-y-3">
          {proposals.map((proposal) => (
            <Card key={proposal.id} className="px-5 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-2">
                    <Link
                      href={`/exceptions/${proposal.exceptionId}`}
                      className="text-sm font-semibold text-slate-800 hover:underline"
                    >
                      {proposal.actionType.replace(/_/g, " ")}
                    </Link>
                    <RiskBadge riskTier={proposal.riskTier} />
                    <BasisBadge basis={proposal.basis} />
                    {proposal.exception ? (
                      <SeverityBadge severity={proposal.exception.severity} />
                    ) : null}
                  </div>
                  <p className="mb-1 truncate text-xs text-slate-400">
                    {proposal.exception?.title}
                  </p>
                  <p className="text-sm text-slate-600">{proposal.reasoningSummary}</p>
                  <div className="mt-2">
                    <ConfidenceBar confidence={proposal.confidence} />
                  </div>
                </div>

                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="secondary"
                    disabled={actioningId === proposal.id}
                    onClick={() => decide(proposal.id, "reject")}
                  >
                    Reject
                  </Button>
                  <Button
                    disabled={actioningId === proposal.id}
                    onClick={() => decide(proposal.id, "approve")}
                  >
                    {actioningId === proposal.id ? "Working…" : "Approve"}
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
