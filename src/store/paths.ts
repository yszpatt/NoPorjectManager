import fs from 'node:fs';
import path from 'node:path';

export interface Paths {
  /** 工作区根目录 */
  root: string;
  /** 数据根目录，默认 <root>/.projectmanager */
  dataDir: string;
  projectsDir: string;
  eventsDir: string;
  plansDir: string;
  configFile: string;
  indexPath: string;
}

export const DEFAULT_DATA_DIR_NAME = '.projectmanager';

export function resolvePaths(root?: string): Paths {
  const resolvedRoot = path.resolve(root ?? process.env.PM_ROOT ?? process.cwd());
  const dataDir = path.resolve(
    process.env.PM_DATA_DIR ?? path.join(resolvedRoot, DEFAULT_DATA_DIR_NAME),
  );
  return {
    root: resolvedRoot,
    dataDir,
    projectsDir: path.join(dataDir, 'projects'),
    eventsDir: path.join(dataDir, 'events'),
    plansDir: path.join(dataDir, 'plans'),
    configFile: path.join(dataDir, 'config.json'),
    indexPath: path.join(dataDir, 'index.sqlite'),
  };
}

export function ensureDirs(paths: Paths): void {
  for (const dir of [paths.dataDir, paths.projectsDir, paths.eventsDir, paths.plansDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function projectFile(paths: Paths, id: string): string {
  return path.join(paths.projectsDir, `${id}.md`);
}

export function eventsFile(paths: Paths, id: string): string {
  return path.join(paths.eventsDir, `${id}.jsonl`);
}

export function planFile(paths: Paths, date: string): string {
  return path.join(paths.plansDir, `${date}.md`);
}
