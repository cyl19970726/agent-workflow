import type { ProcessDto } from '@signal-room/workflow-space-api/contracts';

type Metrics = ProcessDto['stepMetrics'][number];
type Timed = Pick<Metrics, 'wallDurationMs' | 'elapsedSoFarMs'>;
type Used = Pick<Metrics, 'usage' | 'reportedTokens' | 'usageCoverage'>;

function duration(ms: number): string {
  if (ms < 1000) return `${ms} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')} 秒`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor(ms % 60_000 / 1000);
  return `${minutes} 分 ${seconds} 秒`;
}

export function stepDurationLabel(value: Timed): string {
  if (value.wallDurationMs !== null) return `耗时 ${duration(value.wallDurationMs)}`;
  if (value.elapsedSoFarMs !== null) return `已运行 ${duration(value.elapsedSoFarMs)}`;
  return '耗时未记录';
}

export function attemptDurationLabel(value: { durationMs: number | null; elapsedSoFarMs: number | null }): string {
  return stepDurationLabel({ wallDurationMs: value.durationMs, elapsedSoFarMs: value.elapsedSoFarMs });
}

export function stepTokenLabel(value: Used): string {
  if (value.usageCoverage === 'not_applicable') return '无模型调用';
  const tokens = value.usageCoverage === 'complete' ? value.usage : value.reportedTokens;
  if (!tokens) return 'Token 未记录';
  const number = (count: number | null) => count === null ? '未记录' : count.toLocaleString('zh-CN');
  const prefix = value.usageCoverage === 'partial' ? 'Token 已上报下限' : 'Token';
  return `${prefix}：输入 ${number(tokens.inputTokens)} · 输出 ${number(tokens.outputTokens)} · 缓存输入 ${number(tokens.cachedInputTokens)}`;
}
