import fs from 'node:fs';
import type { Paths } from './paths.ts';

export interface CustomFieldDef {
  label: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum';
  options?: string[];
}

/** 全量配置：决定健康度判定、日程生成、扩展适配器与自定义字段 */
export interface PMConfig {
  version: number;
  projectName: string;
  /** 健康度规则 */
  health: {
    /** 超过多少天无任何事件即视为 stale */
    staleAfterDays: number;
    /** 距 deadline 多少天内开始评估风险 */
    atRiskWindowDays: number;
    /** 实际进度落后于"时间轴预期进度"多少个百分点判定 at_risk */
    atRiskProgressGap: number;
  };
  /** 日程生成策略 */
  planning: {
    maxTasksPerDay: number;
  };
  /**
   * 进度来源：
   * - declared：人工/Agent 显式声明（默认，语义最准但需要维护）
   * - auto：按路线图里程碑完成度自动推导（几乎零维护；无里程碑时回退到 declared）
   */
  progress: {
    mode: 'declared' | 'auto';
  };
  /**
   * 提醒规则。
   * 独立开发场景下值得打断你的是「有明确想做的事但很久没动」，
   * 而不是「进度落后于排期」——后者需要维护排期，前者只需要想法。
   */
  reminders: {
    /** 有未完成的后续计划，但超过这么多天没有任何新记录 → 计划停滞 */
    planStalledAfterDays: number;
  };
  /** 扩展：自定义字段 */
  customFields: Record<string, CustomFieldDef>;
  /** 扩展：启用的适配器 */
  adapters: {
    sources: string[];
    exporters: string[];
  };
  /** Git 采集器 */
  git: {
    enabled: boolean;
    intervalMinutes: number;
    /** commit message 中提取进度指令，如 `[pm:slug] +10` */
    messagePattern: string;
    /** 自动把未绑定仓库映射到同名项目 */
    autoMap: boolean;
    /** 被视为「发布」的 tag 命名规则（默认匹配 v1 / v1.2 / 0.3.1 这类版本号） */
    releaseTagPattern: string;
    /**
     * 把提交自动并入时间上邻近的汇报记录，避免同一件事在看板上出现两次。
     * 只做「一对一」配对，拿不准就保持两条——错并比不并更难发现。
     * 汇报里显式写了 `refs.commit` 时不受此开关影响，一定会合并。
     */
    autoLinkReports: boolean;
    /** 自动配对的容差窗口（分钟） */
    autoLinkWindowMinutes: number;
  };
}

export const DEFAULT_CONFIG: PMConfig = {
  version: 1,
  projectName: '项目看板',
  health: {
    staleAfterDays: 14,
    atRiskWindowDays: 14,
    atRiskProgressGap: 15,
  },
  planning: {
    maxTasksPerDay: 5,
  },
  progress: {
    mode: 'declared',
  },
  reminders: {
    planStalledAfterDays: 10,
  },
  customFields: {},
  adapters: {
    sources: ['git'],
    exporters: [],
  },
  git: {
    enabled: true,
    intervalMinutes: 30,
    messagePattern: '\\[pm:(?<id>[\\w-]+)\\]\\s*(?<delta>[+-]\\d+)?',
    autoMap: true,
    releaseTagPattern: '^v?\\d+(\\.\\d+)*$',
    autoLinkReports: true,
    autoLinkWindowMinutes: 120,
  },
};

function merge<T>(base: T, override: unknown): T {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object') {
    return (override as T) ?? base;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b !== undefined && b !== null && typeof b === 'object' && !Array.isArray(b)
      ? merge(b, v)
      : v;
  }
  return out as T;
}

/** 深合并配置补丁，供 pm_update_config 使用 */
export function mergeConfig(base: PMConfig, patch: unknown): PMConfig {
  return merge(base, patch);
}

export function loadConfig(paths: Paths): PMConfig {
  if (!fs.existsSync(paths.configFile)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(paths.configFile, 'utf8')) as unknown;
    return merge(DEFAULT_CONFIG, raw);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(paths: Paths, config: PMConfig): void {
  fs.writeFileSync(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
