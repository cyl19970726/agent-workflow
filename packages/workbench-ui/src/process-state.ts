import type { OccurrenceDto } from '@signal-room/workflow-space-api/contracts';

const activeStates = new Set(['pending', 'queued', 'running', 'in_progress', 'starting']);

export function isActiveRun(state: string): boolean {
  return activeStates.has(state);
}

export function needsFinalProcessRefresh(previous: { id: string; state: string } | undefined, current: { id: string; state: string }, viewingProcess: boolean): boolean {
  return viewingProcess && previous?.id === current.id && isActiveRun(previous.state) && !isActiveRun(current.state);
}

export function latestOccurrence(occurrences: readonly OccurrenceDto[], selectedId?: string): OccurrenceDto | undefined {
  return occurrences.find(item => item.id === selectedId) || occurrences.reduce<OccurrenceDto | undefined>((latest, item) =>
    !latest || (item.round ?? -1) >= (latest.round ?? -1) ? item : latest, undefined);
}
