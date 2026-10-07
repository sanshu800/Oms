"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Card, EmptyState, PageHeader, Spinner } from "@/components/ui";
import { api, type InventoryItem, type PaginatedResponse } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

export default function InventoryPage() {
  const { selectedStoreId, stores } = useAuth();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<PaginatedResponse<InventoryItem> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedStoreId) {
      setResult(null);
      return;
    }

    let active = true;
    setResult(null);
    setError(null);
    api
      .listInventory({
        storeId: selectedStoreId,
        query: query.trim() || undefined,
        page,
        limit: 25,
      })
      .then((response) => {
        if (active) setResult(response);
      })
      .catch(() => {
        if (active) setError("Couldn't load inventory. Please try again.");
      });

    return () => {
      active = false;
    };
  }, [selectedStoreId, query, page]);

  function totals(item: InventoryItem) {
    return item.balances.reduce(
      (total, balance) => ({
        available: total.available + balance.availableQty,
        reserved: total.reserved + balance.reservedQty,
        committed: total.committed + balance.committedQty,
      }),
      { available: 0, reserved: 0, committed: 0 },
    );
  }

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Canonical stock by SKU and warehouse, including reserved and committed quantities."
        action={
          <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-500">
            {result ? `${result.total} SKUs` : "Stock position"}
          </span>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <label className="relative block w-full max-w-sm">
          <span className="sr-only">Search inventory by SKU or product</span>
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="Search SKU or product name…"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none placeholder:text-slate-400 focus:border-slate-400"
          />
        </label>
        {result ? (
          <p className="text-xs text-slate-400">
            Page {result.page} of {Math.max(result.totalPages, 1)}
          </p>
        ) : null}
      </div>

      <Card>
        {stores.length === 0 ? (
          <EmptyState
            title="No store connected yet"
            description="Connect a store to view its linked inventory references."
          />
        ) : error ? (
          <p className="p-6 text-sm text-red-600">{error}</p>
        ) : !result ? (
          <div className="flex justify-center py-14">
            <Spinner />
          </div>
        ) : result.items.length === 0 ? (
          <EmptyState
            title="No inventory items found"
            description="Try a different search, or add inventory through your existing stock workflow."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-xs text-slate-400">
                    <th className="px-5 py-3 font-medium">SKU / product</th>
                    <th className="px-5 py-3 text-right font-medium">Available</th>
                    <th className="px-5 py-3 text-right font-medium">Reserved</th>
                    <th className="px-5 py-3 text-right font-medium">Committed</th>
                    <th className="px-5 py-3 text-right font-medium">On hand</th>
                    <th className="px-5 py-3 text-right font-medium">Locations</th>
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((item) => {
                    const quantity = totals(item);
                    const onHand = quantity.available + quantity.reserved + quantity.committed;

                    return (
                      <tr key={item.id} className="border-b border-slate-50 last:border-0">
                        <td className="px-5 py-3">
                          <Link
                            href={`/inventory/${encodeURIComponent(item.sku)}`}
                            className="font-semibold text-slate-800 hover:text-indigo-700 hover:underline"
                          >
                            {item.sku}
                          </Link>
                          <p className="mt-0.5 text-xs text-slate-400">{item.name}</p>
                        </td>
                        <QuantityCell value={quantity.available} tone="text-emerald-700" />
                        <QuantityCell value={quantity.reserved} tone="text-amber-700" />
                        <QuantityCell value={quantity.committed} tone="text-indigo-700" />
                        <QuantityCell value={onHand} tone="text-slate-800" />
                        <td className="px-5 py-3 text-right text-xs text-slate-500">
                          {item.balances.length}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3">
              <button
                type="button"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={page <= 1}
                className="text-xs font-medium text-slate-500 hover:text-slate-900 disabled:cursor-not-allowed disabled:text-slate-300"
              >
                ← Previous
              </button>
              <span className="text-xs text-slate-400">
                {result.total === 0 ? 0 : (result.page - 1) * result.limit + 1}–
                {Math.min(result.page * result.limit, result.total)} of {result.total}
              </span>
              <button
                type="button"
                onClick={() => setPage((current) => current + 1)}
                disabled={page >= result.totalPages}
                className="text-xs font-medium text-slate-500 hover:text-slate-900 disabled:cursor-not-allowed disabled:text-slate-300"
              >
                Next →
              </button>
            </div>
          </>
        )}
      </Card>
    </>
  );
}

function QuantityCell({ value, tone }: { value: number; tone: string }) {
  return <td className={`px-5 py-3 text-right font-semibold tabular-nums ${tone}`}>{value}</td>;
}
