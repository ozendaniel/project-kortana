import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { getItemModifiers, type ModifierSelection } from '../api/client';

function formatCents(cents: number): string {
  return cents === 0 ? '' : `+$${(cents / 100).toFixed(2)}`;
}

interface ModifierModalProps {
  itemId: string;
  itemName: string;
  onConfirm: (selections: ModifierSelection[], summary: string) => void;
  onClose: () => void;
}

export default function ModifierModal({ itemId, itemName, onConfirm, onClose }: ModifierModalProps) {
  const { data: groups, isLoading } = useQuery({
    queryKey: ['modifiers', itemId],
    queryFn: () => getItemModifiers(itemId),
  });

  // Map of groupId → selected optionIds
  const [selections, setSelections] = useState<Record<string, string[]>>({});

  // Pre-fill defaults when groups load
  useEffect(() => {
    if (!groups || groups.length === 0) return;
    const defaults: Record<string, string[]> = {};
    for (const group of groups) {
      const defaultOpts = group.options.filter(o => o.isDefault);
      if (defaultOpts.length > 0) {
        defaults[group.id] = defaultOpts.map(o => o.id);
      } else if (!group.isOptional && group.options[0]) {
        defaults[group.id] = [group.options[0].id];
      }
    }
    setSelections(defaults);
  }, [groups]);

  const handleSingleSelect = (groupId: string, optionId: string) => {
    setSelections(prev => ({ ...prev, [groupId]: [optionId] }));
  };

  const handleMultiSelect = (groupId: string, optionId: string, maxSelection: number) => {
    setSelections(prev => {
      const current = prev[groupId] || [];
      if (current.includes(optionId)) {
        return { ...prev, [groupId]: current.filter(id => id !== optionId) };
      }
      if (current.length >= maxSelection) return prev;
      return { ...prev, [groupId]: [...current, optionId] };
    });
  };

  const handleConfirm = () => {
    if (!groups) return;
    const modSelections: ModifierSelection[] = [];
    const summaryParts: string[] = [];

    for (const group of groups) {
      const selected = selections[group.id] || [];
      if (selected.length > 0) {
        modSelections.push({ groupId: group.id, optionIds: selected });
        const names = selected
          .map(id => group.options.find(o => o.id === id)?.name)
          .filter(Boolean);
        summaryParts.push(...names as string[]);
      }
    }

    onConfirm(modSelections, summaryParts.join(', '));
  };

  // Check if all required groups have valid selections
  const isValid = groups?.every(group => {
    if (group.isOptional) return true;
    const selected = selections[group.id] || [];
    return selected.length >= group.minSelection;
  }) ?? false;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/70" />

      {/* Modal */}
      <div
        className="relative z-10 w-full max-w-md max-h-[80vh] bg-surface-hover border border-border rounded-sm overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-border-subtle">
          <div className="flex items-start justify-between gap-3">
            <h2 className="font-display text-xl text-text-primary italic leading-tight">{itemName}</h2>
            <button
              onClick={onClose}
              className="shrink-0 w-7 h-7 flex items-center justify-center text-text-muted hover:text-text-primary transition-colors text-lg"
            >
              &times;
            </button>
          </div>
          <p className="text-xs text-text-muted mt-1 font-mono tracking-wide">CUSTOMIZE YOUR ORDER</p>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {isLoading && (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="skeleton h-20 rounded-sm" />
              ))}
            </div>
          )}

          {groups?.map(group => (
            <div key={group.id}>
              <div className="flex items-baseline justify-between mb-2">
                <h3 className="text-sm font-medium text-text-primary">{group.name}</h3>
                <span className="text-[10px] font-mono text-text-muted tracking-wide">
                  {group.isOptional ? 'OPTIONAL' : 'REQUIRED'}
                  {group.maxSelection > 1 && ` \u00b7 UP TO ${group.maxSelection}`}
                </span>
              </div>

              <div className="space-y-1">
                {group.options.map(option => {
                  const isSelected = (selections[group.id] || []).includes(option.id);
                  const isSingle = group.selectionMode === 'single_select';

                  return (
                    <button
                      key={option.id}
                      onClick={() =>
                        isSingle
                          ? handleSingleSelect(group.id, option.id)
                          : handleMultiSelect(group.id, option.id, group.maxSelection)
                      }
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-sm text-left transition-colors ${
                        isSelected
                          ? 'bg-lime/10 border border-lime/30'
                          : 'bg-base border border-transparent hover:border-border-subtle'
                      }`}
                    >
                      {/* Radio / Checkbox indicator */}
                      <span className={`shrink-0 w-4 h-4 rounded-${isSingle ? 'full' : 'sm'} border flex items-center justify-center ${
                        isSelected ? 'border-lime bg-lime/20' : 'border-text-muted'
                      }`}>
                        {isSelected && (
                          <span className={`block ${isSingle ? 'w-2 h-2 rounded-full' : 'w-2.5 h-2.5 rounded-px'} bg-lime`} />
                        )}
                      </span>

                      <span className="flex-1 min-w-0">
                        <span className="text-sm text-text-primary">{option.name}</span>
                      </span>

                      {option.priceDeltaCents !== 0 && (
                        <span className="shrink-0 text-xs font-mono text-text-muted">
                          {formatCents(option.priceDeltaCents)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-border-subtle">
          <button
            onClick={handleConfirm}
            disabled={!isValid}
            className={`w-full py-2.5 text-sm font-semibold rounded-sm transition-colors tracking-wide ${
              isValid
                ? 'bg-lime text-base hover:bg-lime-dim'
                : 'bg-border text-text-muted cursor-not-allowed'
            }`}
          >
            Add to Cart
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
