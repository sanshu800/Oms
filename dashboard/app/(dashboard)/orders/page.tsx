"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Card, EmptyState, PageHeader, Spinner, StatusBadge } from "@/components/ui";
import { api, type PaginatedResponse, type Order } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

const STATUS_FILTERS = [
  { value: "", label: "All orders" },
  { value: "NEW", label: "New" },
  { value: "CONFIRMED", label: "Confirmed" },
  { value: "PROCESSING", label: "Processing" },
  { value: "READY_TO_FULFILL", label: "Ready to fulfill" },
  { value: "FULFILLING", label: "Fulfilling" },
  { value: "FULFILLED", label: "Fulfilled" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "FAILED", label: "Failed" },
];

export default function OrdersPage() {
  const { selectedStoreId, stores } = useAuth();
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<PaginatedResponse<Order> | null>(null);
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
      .listOrders({ storeId: selectedStoreId, status: status || undefined, page, limit: 25 })
      .then((response) => {
        if (active) setResult(response);
      })
      .catch(() => {
        if (active) setError("Couldn't load orders. Please try again.");
      });

    return () => {
      active = false;
    };
  }, [selectedStoreId, status, page]);

  function changeStatus(value: string) {
    setStatus(value);
    setPage(1);
  }

  return (
    <>
      <PageHeader
        title="Orders"
        description="Shopify orders with reservation and fulfillment lifecycle status."
        action={
          <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-500">
            {result ? `${result.total} total` : "Live order feed"}
          </span>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-xs font-medium text-slate-500">
          Status
          <select
            value={status}
            onChange={(event) => changeStatus(event.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-slate-400"
          >
            {STATUS_FILTERS.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
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
            description="Connect a Shopify store to start receiving orders."
          />
        ) : error ? (
          <p className="p-6 text-sm text-red-600">{error}</p>
        ) : !result ? (
          <div className="flex justify-center py-14">
            <Spinner />
          </div>
        ) : result.items.length === 0 ? (
          <EmptyState
            title="No orders found"
            description="Orders received from the selected store will appear here."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-xs text-slate-400">
                    <th className="px-5 py-3 font-medium">Order</th>
                    <th className="px-5 py-3 font-medium">Placed</th>
                    <th className="px-5 py-3 font-medium">Total</th>
                    <th className="px-5 py-3 font-medium">Payment</th>
                    <th className="px-5 py-3 font-medium">Fulfillment</th>
                    <th className="px-5 py-3 font-medium">OMS status</th>
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((order) => (
                    <tr key={order.id} className="border-b border-slate-50 last:border-0">
                      <td className="px-5 py-3">
                        <Link
                          href={`/orders/${order.id}`}
                          className="font-semibold text-slate-800 hover:text-indigo-700 hover:underline"
                        >
                          {order.orderNumber}
                        </Link>
                        <p className="mt-0.5 font-mono text-[11px] text-slate-400">
                          Shopify #{order.externalOrderId}
                        </p>
                      </td>
                      <td className="px-5 py-3 text-xs text-slate-500">
                        {new Date(order.orderedAt).toLocaleString()}
                      </td>
                      <td className="px-5 py-3 font-medium text-slate-700">
                        {formatMoney(order.totalAmount, order.currency)}
                      </td>
                      <td className="px-5 py-3 text-xs capitalize text-slate-500">
                        {order.paymentStatus.replace(/_/g, " ")}
                      </td>
                      <td className="px-5 py-3 text-xs capitalize text-slate-500">
                        {order.fulfillmentStatus.replace(/_/g, " ")}
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge status={order.status} />
                      </td>
                    </tr>
                  ))}
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

function formatMoney(amount: string, currency: string): string {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(numericAmount);
  } catch {
    return `${amount} ${currency}`;
  }
}
