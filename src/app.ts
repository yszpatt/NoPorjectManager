import { PlanService } from './core/plan-service.ts';
import { ProjectService } from './core/project-service.ts';
import { Store, type StoreOptions } from './store/repo.ts';

export interface App {
  store: Store;
  projects: ProjectService;
  plans: PlanService;
}

/** 组合根：所有入口（MCP / CLI / HTTP）共用同一套服务装配 */
export function createApp(opts: StoreOptions = {}): App {
  const store = new Store(opts);
  store.ensureIndex();
  const projects = new ProjectService(store);
  const plans = new PlanService(store, projects);
  return { store, projects, plans };
}
