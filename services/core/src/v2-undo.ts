export type UndoWindowInput = {
  batchId: string;
  recentBatchIds: ReadonlySet<string>;
  undone: boolean;
  undoEligibleUntil: Date | null;
  mutationCount: number;
  now?: Date;
};

export function undoWindowBlockReason(input: UndoWindowInput) {
  if (input.undone) return "הפעולה כבר בוטלה.";
  if (!input.recentBatchIds.has(input.batchId)) return "Undo זמין רק ל-20 הפעולות האחרונות.";
  if (!input.undoEligibleUntil || input.undoEligibleUntil < (input.now ?? new Date())) return "חלון ה-Undo של הפעולה פג.";
  if (input.mutationCount === 0) return "אין שינויים שניתן לבטל בפעולה הזו.";
  return undefined;
}

export function orderMutationsForUndo<T extends { sequence: number }>(mutations: readonly T[]) {
  return [...mutations].sort((left, right) => right.sequence - left.sequence);
}
