"use client";

import { useMemo, useState } from "react";
import { DollarSign } from "lucide-react";
import type { CallRecord } from "@/lib/pricing";

interface Props {
  calls: CallRecord[];
}

export function CostTracker({ calls }: Props) {
  const [open, setOpen] = useState(false);

  const totalCost = calls.reduce((sum, c) => sum + c.cost_usd, 0);

  const byModel = useMemo(() => {
    const acc: Record<string, CallRecord[]> = {};
    for (const c of calls) (acc[c.model] ??= []).push(c);
    return acc;
  }, [calls]);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-background border border-border text-xs font-semibold text-navy cursor-pointer hover:bg-[#EEF1F5] transition-colors"
      >
        <DollarSign className="h-3.5 w-3.5" />${totalCost.toFixed(4)}
        <span className="text-muted font-normal">({calls.length} calls)</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 w-80 bg-surface border border-border rounded-xl shadow-md z-50 p-4">
            <p className="text-[10px] font-bold text-muted uppercase tracking-widest mb-3">Cost Breakdown</p>
            {calls.length === 0 ? (
              <p className="text-xs text-muted">No extraction calls yet this session.</p>
            ) : (
              <div className="space-y-3">
                {Object.entries(byModel).map(([model, records]) => {
                  const inputTokens = records.reduce((s, r) => s + r.input_tokens, 0);
                  const outputTokens = records.reduce((s, r) => s + r.output_tokens, 0);
                  const cost = records.reduce((s, r) => s + r.cost_usd, 0);
                  const avgLatency = records.reduce((s, r) => s + r.latency_ms, 0) / records.length;
                  return (
                    <div key={model} className="border-b border-[#F0F3F7] last:border-0 pb-2 last:pb-0">
                      <p className="text-xs font-semibold text-text mb-1">{model}</p>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-muted">
                        <span>Calls</span>
                        <span className="text-right text-text">{records.length}</span>
                        <span>Input tokens</span>
                        <span className="text-right text-text">{inputTokens.toLocaleString()}</span>
                        <span>Output tokens</span>
                        <span className="text-right text-text">{outputTokens.toLocaleString()}</span>
                        <span>Avg latency</span>
                        <span className="text-right text-text">{(avgLatency / 1000).toFixed(1)}s</span>
                        <span>Cost</span>
                        <span className="text-right text-text font-semibold">${cost.toFixed(4)}</span>
                      </div>
                    </div>
                  );
                })}
                <div className="flex items-center justify-between pt-1">
                  <p className="text-xs font-bold text-navy">Total</p>
                  <p className="text-xs font-bold text-navy">${totalCost.toFixed(4)}</p>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
