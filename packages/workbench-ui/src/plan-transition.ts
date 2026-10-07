import type { PlanCommandReceiptDto } from '@signal-room/workflow-space-api/contracts';

export function shouldCollapsePlanAfterCommand(receipt: Pick<PlanCommandReceiptDto, 'status' | 'dispatchError'>): boolean {
  return !receipt.dispatchError && (receipt.status === 'running' || receipt.status === 'completed');
}
