import { launchJob, type JobMeta } from '../../actions/jobs.ts';
import { psq } from '../../lib/commands.ts';
import type { ServerPaths } from '../../lib/paths.ts';
import type { LoadedRegistry } from '../../lib/registry.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { detectRegistryAgents } from '../../lib/versions.ts';

export type SteerLauncherFn = (runnerFile: string) => Promise<number>;

export async function launchSteerJob(options: {
  parentJobId: string;
  agent: string;
  role: string;
  model?: string;
  effort?: string;
  projectPath: string;
  prompt: string;
  commandExe: string;
  commandArgs: string[];
  promptVia?: 'stdin' | 'file_arg';
  paths: ServerPaths;
  registry: LoadedRegistry;
  strategy: 'resume' | 'summary';
  customLauncher?: SteerLauncherFn;
  skipAgentDetection?: boolean;
}): Promise<{ job_id: string; pid: number; meta: JobMeta & { parent_job_id: string; steer_strategy: string } }> {
  const {
    parentJobId,
    agent,
    role,
    model,
    effort,
    projectPath,
    prompt,
    commandExe,
    commandArgs,
    promptVia,
    paths,
    registry,
    strategy,
    customLauncher,
    skipAgentDetection,
  } = options;

  // 1. Verify agent is installed
  if (!skipAgentDetection) {
    const detectedMap = await detectRegistryAgents(paths, registry.agents);
    const detected = detectedMap.get(agent);
    const agentEntry = registry.agents.find((a) => a.id === agent);
    const label = agentEntry?.label ?? agent;

    if (detected && !detected.installed) {
      throw new ApiValidationError(`${label} is not installed.`, 400);
    }
  }

  const res = await launchJob({
    meta: {
      mode: 'steer',
      agent,
      role,
      model,
      effort,
      project_path: projectPath,
      parent_job_id: parentJobId,
      steer_strategy: strategy,
    },
    commandLine: ({ promptFile }) => {
      const effectiveArgs = commandArgs.map((a) => (a === '{prompt_file}' ? promptFile : a));
      const formattedArgs = effectiveArgs.map((a) => psq(a)).join(' ');
      if (promptVia === 'file_arg') {
        return (
          `Set-Location -LiteralPath ${psq(projectPath)}; ` +
          `& ${psq(commandExe)}${formattedArgs ? ' ' + formattedArgs : ''}`
        );
      }
      return (
        `Set-Location -LiteralPath ${psq(projectPath)}; ` +
        `Get-Content -Raw -Encoding UTF8 -LiteralPath ${psq(promptFile)} | & ${psq(commandExe)}${formattedArgs ? ' ' + formattedArgs : ''}`
      );
    },
    prompt,
    paths,
    headerExtraLines: [`Parent: ${parentJobId} | Strategy: ${strategy}`],
    customLauncher,
  });

  return {
    job_id: res.job_id,
    pid: res.pid,
    meta: res.meta as JobMeta & { parent_job_id: string; steer_strategy: string },
  };
}
