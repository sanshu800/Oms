"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

import { useAuth } from "@/lib/auth-context";
import {
  api,
  ApiError,
  type AiDecisionProposal,
  type InvestigationContext,
} from "@/lib/api";
import {
  BasisBadge,
  Button,
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

export default function ExceptionDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { selectedStoreId } = useAuth();

  const [context, setContext] = useState<InvestigationContext | null>(null);
  const [proposals, setProposals] = useState<AiDecisionProposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!selectedStoreId) return;

    setError(null);

    Promise.all([
      api.getInvestigationContext({ exceptionId: params.id, storeId: selectedStoreId }),
      api.getExceptionProposals({ exceptionId: params.id, storeId: selectedStoreId }),
    ])
      .then(([ctx, proposalsRes]) => {
        setContext(ctx);
        setProposals(proposalsRes.proposals);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          setError("This exception doesn't exist, or belongs to a different store.");
        } else {
          setError("Couldn't load this exception.");
        }
      });
  }, [params.id, selectedStoreId]);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(proposalId: string, decision: "approve" | "reject") {
    if (!selectedStoreId) return;

    const note =
      decision === "reject"
        ? window.prompt("Optional note for why you're rejecting this (visible in the audit trail):") ?? undefined
        : undefined;

    setActioningId(proposalId);
    setActionError(null);

    try {
      if (decision === "approve") {
        await api.approveProposal({
          proposalId,
          storeId: selectedStoreId,
          actorId: "dashboard-user",
        });
      } else {
        await api.rejectProposal({
          proposalId,
          storeId: selectedStoreId,
          actorId: "dashboard-user",
          note,
        });
      }

      load();
    } catch {
      setActionError("That decision didn't go through. Try again.");
    } finally {
      setActioningId(null);
    }
  }

  if (error) {
    return (
      <>
        <button
          onClick={() => router.push("/exceptions")}
          className="mb-4 text-xs font-medium text-slate-500 hover:text-slate-800"
        >
          ← Back to exceptions
        </button>
        <Card>
          <EmptyState title="Not found" description={error} />
        </Card>
      </>
    );
  }

  if (!context) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }

  const { exception } = context;

  return (
    <>
      <Link href="/exceptions" className="mb-4 inline-block text-xs font-medium text-slate-500 hover:text-slate-800">
        ← Back to exceptions
      </Link>

      <PageHeader
        title={exception.title}
        description={`${exception.category} · detected ${new Date(exception.detectedAt).toLocaleString()}`}
        action={
          <div className="flex items-center gap-2">
            <SeverityBadge severity={exception.severity} />
            <StatusBadge status={exception.status} />
          </div>
        }
      />

      <div className="grid grid-cols-3 gap-5">
        <div className="col-span-2 space-y-5">
          <Card>
            <CardHeader title="What TechMart's AI recommends" />
            {!proposals ? (
              <div className="flex justify-center py-10">
                <Spinner />
              </div>
            ) : proposals.length === 0 ? (
              <EmptyState
                title="No AI proposal yet"
                description="An investigation may still be running, or this category isn't wired up for AI review."
              />
            ) : (
              <div className="divide-y divide-slate-100">
                {proposals.map((proposal) => (
                  <div key={proposal.id} className="px-5 py-4">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-slate-800">
                          {proposal.actionType.replace(/_/g, " ")}
                        </span>
                        <RiskBadge riskTier={proposal.riskTier} />
                        <BasisBadge basis={proposal.basis} />
                      </div>
                      <StatusBadge status={proposal.status} />
                    </div>

                    <p className="text-sm leading-relaxed text-slate-600">
                      {proposal.reasoningSummary}
                    </p>

                    <div className="mt-3 flex items-center justify-between">
                      <ConfidenceBar confidence={proposal.confidence} />

                      {proposal.status === "PROPOSED" ? (
                        <div className="flex gap-2">
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
                      ) : (
                        <p className="text-xs text-slate-400">
                          {proposal.decidedBy ? `Decided by ${proposal.decidedBy}` : null}
                        </p>
                      )}
                    </div>

                    {proposal.investigation ? (
                      <ToolTrace investigation={proposal.investigation} />
                    ) : null}
                  </div>
                ))}
              </div>
            )}
            {actionError ? <p className="px-5 pb-4 text-xs text-red-600">{actionError}</p> : null}
          </Card>

          <Card>
            <CardHeader title="Evidence" subtitle="Raw facts the deterministic engine recorded" />
            <pre className="max-h-64 overflow-auto bg-slate-50 px-5 py-4 text-xs text-slate-600">
              {JSON.stringify(exception.evidence, null, 2)}
            </pre>
          </Card>
        </div>

        <div className="space-y-5">
          {context.order ? (
            <Card>
              <CardHeader title="Order" />
              <dl className="space-y-2 px-5 py-4 text-sm">
                <Row label="Number" value={context.order.orderNumber} />
                <Row label="Status" value={context.order.status} />
                <Row label="Payment" value={context.order.paymentStatus} />
                <Row label="Fulfillment" value={context.order.fulfillmentStatus} />
                <Row
                  label="Total"
                  value={`${context.order.totalAmount} ${context.order.currency}`}
                />
              </dl>
            </Card>
          ) : null}

          {context.inventory ? (
            <Card>
              <CardHeader title="Inventory" subtitle={context.inventory.sku} />
              <dl className="space-y-2 px-5 py-4 text-sm">
                <Row label="Available" value={context.inventory.availableQty} />
                <Row label="Reserved" value={context.inventory.reservedQty} />
                <Row label="Committed" value={context.inventory.committedQty} />
                {context.inventory.isStale ? (
                  <p className="text-xs font-medium text-amber-600">⚠ Data may be stale</p>
                ) : null}
              </dl>
              {context.inventory.locations.length > 0 ? (
                <div className="border-t border-slate-100 px-5 py-3">
                  <p className="mb-2 text-xs font-medium text-slate-500">By location</p>
                  {context.inventory.locations.map((loc) => (
                    <div key={loc.locationCode} className="flex justify-between py-1 text-xs">
                      <span className="text-slate-500">{loc.locationName}</span>
                      <span className="font-medium text-slate-700">{loc.availableQty} avail.</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Recommended next step" />
            <p className="px-5 py-4 text-sm text-slate-600">{exception.recommendedNextStep}</p>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-800">{value}</dd>
    </div>
  );
}

function ToolTrace({
  investigation,
}: {
  investigation: NonNullable<AiDecisionProposal["investigation"]>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-slate-500"
      >
        <span>
          How the AI investigated this ({investigation.toolCallCount} tool call
          {investigation.toolCallCount === 1 ? "" : "s"}, {investigation.model})
        </span>
        <span>{open ? "▲" : "▼"}</span>
      </button>

      {open ? (
        <ol className="space-y-2 border-t border-slate-100 px-3 py-3">
          {investigation.toolCalls.map((call) => (
            <li key={call.id} className="text-xs">
              <p className="font-mono font-medium text-slate-700">
                {call.sequence}. {call.toolName}
              </p>
              <pre className="mt-1 max-h-32 overflow-auto rounded bg-white p-2 text-[11px] text-slate-500">
                {JSON.stringify(call.output, null, 2)}
              </pre>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
