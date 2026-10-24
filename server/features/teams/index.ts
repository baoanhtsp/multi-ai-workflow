import fs from 'node:fs';
import path from 'node:path';
import type { MawFeature, MawFeatureContext } from '../../lib/feature.ts';
import { isFileSafe, resolveProjectPath } from '../../lib/paths.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import {
  generateAgentId,
  generateGroupId,
  generateProfileId,
  generateTeamId,
  generateTemplateId,
  ROLE_KEY_REGEX,
} from '../agents-ws/lib/ids.ts';
import {
  parseRoleMarkdown,
  renderRoleMarkdown,
  type RoleSections,
} from '../agents-ws/lib/markdown-roles.ts';
import { withS6State } from '../agents-ws/lib/mutex.ts';
import { appendAuditLog, readJsonStore, writeJsonStore } from '../agents-ws/lib/store.ts';
import type { Agent, Group } from '../agents-ws/types.ts';
import { BUILTIN_EMPTY_TEMPLATE, BUILTIN_FULL_TEMPLATE } from './defaults.ts';
import type { RoleProfile, Team, TeamRole, TeamRoleOverride, TeamTemplate } from './types.ts';

const ALLOWED_EXEC_ROLES = ['architect', 'backend', 'frontend', 'reviewer', 'tester'];
const ALLOWED_WORKING_STYLES = ['persistent', 'per_task', 'new_chat_per_task'];

function getTeamFilePath(projectPath: string): string {
  return path.win32.join(projectPath, '.maw', 'team.json');
}

function getRolesDir(projectPath: string): string {
  return path.win32.join(projectPath, '.maw', 'roles');
}

export function getSafeRoleFilePath(rolesDir: string, roleKey: string): string {
  const normalizedRolesDir = path.resolve(rolesDir);
  const rFile = path.resolve(normalizedRolesDir, `${roleKey}.md`);
  if (!rFile.startsWith(normalizedRolesDir + path.sep)) {
    throw new ApiValidationError(`Role path traversal detected for key '${roleKey}'.`, 400);
  }
  return rFile;
}

export function validateTeam(
  raw: unknown,
  ctx: MawFeatureContext,
  options?: { isTemplate?: boolean; rolesMd?: Record<string, unknown>; forceTeamId?: string }
): { team: Team; rolesMd?: Record<string, RoleSections> } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiValidationError('Invalid team object.', 400);
  }
  const t = raw as Partial<Team>;

  const name = String(t.name ?? '').trim();
  if (!name || name.length > 60) {
    throw new ApiValidationError('Team name must be between 1 and 60 characters.', 400);
  }

  const teamId = options?.forceTeamId || String(t.id ?? '').trim() || generateTeamId();
  const template = String(t.template ?? 'full').trim();

  const rawShared = t.shared ?? ({} as Partial<Team['shared']>);

  const platform = String(rawShared.platform ?? 'claude').trim() || 'claude';
  const regAgent = ctx.registry.agents.find((a) => a.id === platform.toLowerCase());
  if (!regAgent) {
    throw new ApiValidationError(`Invalid shared.platform '${platform}'. Must be an enabled registry agent.`, 400);
  }

  const model = String(rawShared.model ?? '').trim();
  if (model && !regAgent.models.includes(model)) {
    throw new ApiValidationError(`Invalid shared.model '${model}' for platform '${platform}'.`, 400);
  }

  const effort = String(rawShared.effort ?? '').trim();
  if (effort && !regAgent.efforts.includes(effort)) {
    throw new ApiValidationError(`Invalid shared.effort '${effort}' for platform '${platform}'.`, 400);
  }

  let sharedWorkdir = '';
  const rawWorkdir = String(rawShared.workdir ?? '').trim();
  if (rawWorkdir) {
    const resolved = resolveProjectPath(rawWorkdir, ctx.paths.projectsRoot);
    if (!resolved) {
      throw new ApiValidationError(`Invalid shared.workdir '${rawWorkdir}'. Must be strictly inside projectsRoot.`, 400);
    }
    sharedWorkdir = resolved;
  }

  const validatedWritableDirs: string[] = [];
  if (Array.isArray(rawShared.writable_dirs)) {
    if (rawShared.writable_dirs.length > 10) {
      throw new ApiValidationError('shared.writable_dirs cannot have more than 10 dirs.', 400);
    }
    for (const d of rawShared.writable_dirs) {
      const dStr = String(d ?? '').trim();
      if (!dStr) continue;
      const resDir = resolveProjectPath(dStr, ctx.paths.projectsRoot);
      if (!resDir) {
        throw new ApiValidationError(`Invalid writable_dir '${dStr}'.`, 400);
      }
      validatedWritableDirs.push(resDir);
    }
  }

  const validatedWriteScope: string[] = [];
  if (Array.isArray(rawShared.write_scope)) {
    if (rawShared.write_scope.length > 30) {
      throw new ApiValidationError('shared.write_scope cannot have more than 30 globs.', 400);
    }
    for (const ws of rawShared.write_scope) {
      const s = String(ws ?? '').trim();
      if (!s) continue;
      if (s.length > 200 || /[\0\r\n]/.test(s)) {
        throw new ApiValidationError(`write_scope glob '${s}' exceeds 200 chars or contains invalid characters.`, 400);
      }
      validatedWriteScope.push(s);
    }
  } else {
    validatedWriteScope.push('**');
  }

  const maxParallel = Math.max(1, Math.min(6, Number(rawShared.max_parallel) || 3));
  const shared = {
    workdir: sharedWorkdir,
    platform,
    model,
    effort,
    write_scope: validatedWriteScope,
    writable_dirs: validatedWritableDirs,
    isolate: rawShared.isolate !== false,
    max_parallel: maxParallel,
    auto_continue: rawShared.auto_continue !== false,
  };

  if (!Array.isArray(t.roles) || t.roles.length === 0) {
    throw new ApiValidationError('Team must have at least one role.', 400);
  }

  const roles: TeamRole[] = [];
  const seenKeys = new Set<string>();

  for (let i = 0; i < t.roles.length; i++) {
    const r = t.roles[i]!;
    const key = String(r.key ?? '').trim().toLowerCase();
    if (!ROLE_KEY_REGEX.test(key)) {
      throw new ApiValidationError(`Invalid role key '${key}'. Must match ^[a-z][a-z0-9-]{1,23}$.`, 400);
    }
    if (seenKeys.has(key)) {
      throw new ApiValidationError(`Duplicate role key '${key}'.`, 400);
    }
    seenKeys.add(key);

    const rName = String(r.name ?? '').trim();
    if (!rName || rName.length > 40) {
      throw new ApiValidationError(`Role name for '${key}' must be 1-40 chars.`, 400);
    }

    const style = String(r.working_style ?? 'persistent').trim();
    if (!ALLOWED_WORKING_STYLES.includes(style)) {
      throw new ApiValidationError(`Invalid working_style '${style}' for role '${key}'.`, 400);
    }

    const execRole = String(r.exec_role ?? 'backend').trim().toLowerCase();
    if (!ALLOWED_EXEC_ROLES.includes(execRole)) {
      throw new ApiValidationError(`Invalid exec_role '${execRole}' for role '${key}'.`, 400);
    }

    let override: TeamRoleOverride | undefined;
    if (r.override && typeof r.override === 'object') {
      override = {};
      if (r.override.workdir) {
        const rawOvWorkdir = String(r.override.workdir).trim();
        const ovWorkdir = resolveProjectPath(rawOvWorkdir, ctx.paths.projectsRoot);
        if (!ovWorkdir) {
          throw new ApiValidationError(`Invalid override.workdir '${rawOvWorkdir}' for role '${key}'.`, 400);
        }
        override.workdir = ovWorkdir;
      }

      let ovAgent = regAgent;
      if (r.override.platform) {
        const ovPlatform = String(r.override.platform).trim().toLowerCase();
        const found = ctx.registry.agents.find((a) => a.id === ovPlatform);
        if (!found) {
          throw new ApiValidationError(`Invalid override.platform '${ovPlatform}' for role '${key}'.`, 400);
        }
        override.platform = ovPlatform;
        ovAgent = found;
      }

      if (r.override.model) {
        const ovModel = String(r.override.model).trim();
        if (!ovAgent.models.includes(ovModel)) {
          throw new ApiValidationError(`Invalid override.model '${ovModel}' for role '${key}'.`, 400);
        }
        override.model = ovModel;
      }

      if (r.override.effort) {
        const ovEffort = String(r.override.effort).trim();
        if (!ovAgent.efforts.includes(ovEffort)) {
          throw new ApiValidationError(`Invalid override.effort '${ovEffort}' for role '${key}'.`, 400);
        }
        override.effort = ovEffort;
      }

      if (Array.isArray(r.override.write_scope)) {
        override.write_scope = r.override.write_scope.map((ws) => {
          const s = String(ws ?? '').trim();
          if (s.length > 200 || /[\0\r\n]/.test(s)) {
            throw new ApiValidationError(`override.write_scope glob exceeds 200 chars for role '${key}'.`, 400);
          }
          return s;
        });
      }
    }

    roles.push({
      key,
      name: rName,
      enabled: r.enabled !== false,
      working_style: style as TeamRole['working_style'],
      persona: String(r.persona ?? '').trim().slice(0, 4000),
      may_delegate: Boolean(r.may_delegate),
      exec_role: execRole,
      override,
      agent_id: String(r.agent_id ?? '').trim(),
    });
  }

  let validatedRolesMd: Record<string, RoleSections> | undefined;
  if (options?.rolesMd && typeof options.rolesMd === 'object') {
    validatedRolesMd = {};
    for (const [rKey, rSec] of Object.entries(options.rolesMd)) {
      const lowerKey = rKey.trim().toLowerCase();
      if (!ROLE_KEY_REGEX.test(lowerKey)) {
        throw new ApiValidationError(`Invalid role markdown key '${rKey}'. Must match ^[a-z][a-z0-9-]{1,23}$.`, 400);
      }
      if (rSec && typeof rSec === 'object') {
        const secObj = rSec as Record<string, unknown>;
        const secFields = ['responsibility', 'delegation', 'output', 'permissions', 'extra'] as const;
        for (const f of secFields) {
          const val = secObj[f];
          if (typeof val === 'string' && val.length > 6000) {
            throw new ApiValidationError(`Role markdown section '${f}' exceeds 6000 characters for role '${rKey}'.`, 400);
          }
        }
        validatedRolesMd[lowerKey] = {
          responsibility: String(secObj.responsibility ?? '').slice(0, 6000),
          delegation: String(secObj.delegation ?? '').slice(0, 6000),
          output: String(secObj.output ?? '').slice(0, 6000),
          permissions: String(secObj.permissions ?? '').slice(0, 6000),
          extra: typeof secObj.extra === 'string' ? secObj.extra.slice(0, 6000) : undefined,
        };
      }
    }
  }

  const team: Team = {
    version: 1,
    id: teamId,
    name,
    template,
    shared,
    roles,
  };

  return { team, rolesMd: validatedRolesMd };
}

export const feature: MawFeature = {
  name: 'teams',
  ui: {
    script: 'feat-teams.js',
    style: 'feat-teams.css',
  },
  routes: {
    team_get: {
      method: 'GET',
      handler: async (ctx) => {
        const rawProj = String(ctx.query?.get('project_path') ?? '').trim();
        const validPath = resolveProjectPath(rawProj, ctx.paths.projectsRoot);
        if (!validPath) {
          throw new ApiValidationError('Invalid or missing project_path.', 400);
        }

        const teamFile = getTeamFilePath(validPath);
        if (!isFileSafe(teamFile)) {
          return {
            ok: true,
            team: null,
            roles_md: {},
            path: teamFile,
          };
        }

        let team: Team;
        try {
          team = JSON.parse(fs.readFileSync(teamFile, 'utf8')) as Team;
        } catch {
          return {
            ok: true,
            team: null,
            roles_md: {},
            path: teamFile,
          };
        }

        const rolesMd: Record<string, RoleSections> = {};
        const rolesDir = getRolesDir(validPath);
        if (Array.isArray(team.roles)) {
          for (const role of team.roles) {
            try {
              const rFile = getSafeRoleFilePath(rolesDir, role.key);
              if (isFileSafe(rFile)) {
                const parsed = parseRoleMarkdown(fs.readFileSync(rFile, 'utf8'));
                rolesMd[role.key] = parsed.sections;
              } else {
                rolesMd[role.key] = { responsibility: '', delegation: '', output: '', permissions: '' };
              }
            } catch {
              rolesMd[role.key] = { responsibility: '', delegation: '', output: '', permissions: '' };
            }
          }
        }

        return {
          ok: true,
          team,
          roles_md: rolesMd,
          path: teamFile,
        };
      },
    },

    team_save: {
      method: 'POST',
      handler: async (ctx) => {
        return withS6State(async () => {
          const body = ctx.body ?? {};
          const rawProj = String(body.project_path ?? '').trim();
          const validPath = resolveProjectPath(rawProj, ctx.paths.projectsRoot);
          if (!validPath) {
            throw new ApiValidationError('Invalid or missing project_path.', 400);
          }

          const teamFile = getTeamFilePath(validPath);
          let existingProjectTeamId = '';
          if (isFileSafe(teamFile)) {
            try {
              const existingTeam = JSON.parse(fs.readFileSync(teamFile, 'utf8')) as Team;
              existingProjectTeamId = existingTeam.id || '';
            } catch {}
          }

          const rawId = String((body.team as Record<string, unknown> | undefined)?.id ?? '').trim();
          const isTemplateOrBuiltin =
            !rawId ||
            rawId === 'full' ||
            rawId === 'empty' ||
            rawId === 'tm_builtin_full' ||
            rawId === 'tm_builtin_empty' ||
            rawId.startsWith('tt_');

          let teamId = rawId;
          if (isTemplateOrBuiltin) {
            teamId = existingProjectTeamId || generateTeamId();
          } else {
            // Check if already used by another project
            const agentsDir = ctx.paths.featureDataDir('agents-ws');
            const agentsFile = path.win32.join(agentsDir, 'agents.json');
            const agentsData = await readJsonStore<{ version: number; agents: Agent[] }>(agentsFile, {
              version: 1,
              agents: [],
            });
            const usedElsewhere = agentsData.agents.some(
              (a) =>
                a.team_id === rawId &&
                a.deleted_at === null &&
                a.workdir.toLowerCase() !== validPath.toLowerCase()
            );
            if (usedElsewhere && rawId !== existingProjectTeamId) {
              teamId = generateTeamId();
            }
          }

          const validated = validateTeam(body.team, ctx, {
            forceTeamId: teamId,
            rolesMd: body.roles_md as Record<string, unknown> | undefined,
          });
          const team = validated.team;
          const rawRolesMd = validated.rolesMd ?? {};
          const rolesDir = getRolesDir(validPath);
          if (!fs.existsSync(rolesDir)) {
            fs.mkdirSync(rolesDir, { recursive: true });
          }

          // Item 20: write team.json atomically
          await writeJsonStore(teamFile, team);

          // Write roles_md and clean up removed roles
          const currentFiles = fs.readdirSync(rolesDir).filter((f) => f.endsWith('.md'));
          const activeFileNames = new Set(team.roles.map((r) => `${r.key}.md`));

          for (const file of currentFiles) {
            if (!activeFileNames.has(file)) {
              try {
                fs.unlinkSync(path.win32.join(rolesDir, file));
              } catch {}
            }
          }

          for (const role of team.roles) {
            const rFile = getSafeRoleFilePath(rolesDir, role.key);
            const sec = rawRolesMd[role.key] ?? {
              responsibility: '',
              delegation: '',
              output: '',
              permissions: '',
            };
            const mdContent = renderRoleMarkdown(role.name, sec);
            fs.writeFileSync(rFile, mdContent, 'utf8');
          }

          return {
            ok: true,
            team,
          };
        });
      },
    },

    team_apply: {
      method: 'POST',
      handler: async (ctx) => {
        return withS6State(async () => {
          const body = ctx.body ?? {};
          const rawProj = String(body.project_path ?? '').trim();
          const validPath = resolveProjectPath(rawProj, ctx.paths.projectsRoot);
          if (!validPath) {
            throw new ApiValidationError('Invalid or missing project_path.', 400);
          }

          const teamFile = getTeamFilePath(validPath);
          if (!isFileSafe(teamFile)) {
            throw new ApiValidationError('Team configuration not found. Please save a team first.', 404);
          }

          const team = JSON.parse(fs.readFileSync(teamFile, 'utf8')) as Team;
          const agentsDir = ctx.paths.featureDataDir('agents-ws');
          const groupsFile = path.win32.join(agentsDir, 'groups.json');
          const agentsFile = path.win32.join(agentsDir, 'agents.json');

          const groupsData = await readJsonStore<{ version: number; groups: Group[] }>(groupsFile, {
            version: 1,
            groups: [],
          });
          const agentsData = await readJsonStore<{ version: number; agents: Agent[] }>(agentsFile, {
            version: 1,
            agents: [],
          });

          let group = groupsData.groups.find((g) => g.team_id && g.team_id === team.id);
          if (!group) {
            group = {
              id: generateGroupId(),
              name: team.name,
              order: groupsData.groups.length,
              collapsed: false,
              team_id: team.id,
            };
            groupsData.groups.push(group);
            await writeJsonStore(groupsFile, groupsData);
          }

          const enabledRoles = team.roles.filter((r) => r.enabled);
          const appliedAgents: Agent[] = [];

          for (let i = 0; i < enabledRoles.length; i++) {
            const role = enabledRoles[i]!;
            const platform = role.override?.platform || team.shared.platform || 'claude';
            const model = role.override?.model || team.shared.model || '';
            const effort = role.override?.effort || team.shared.effort || '';
            const workdir = role.override?.workdir || team.shared.workdir || validPath;

            let agent: Agent | undefined;

            // 1. Try finding by role.agent_id ONLY when workdir equals project path and team_id matches or empty
            if (role.agent_id) {
              const candidate = agentsData.agents.find((a) => a.id === role.agent_id && a.deleted_at === null);
              if (
                candidate &&
                candidate.workdir.toLowerCase() === validPath.toLowerCase() &&
                (!candidate.team_id || candidate.team_id === team.id)
              ) {
                agent = candidate;
              }
            }

            // 2. If not found (fresh save, import overwrite), reuse a live agent in THIS project with same workdir + team_role
            if (!agent) {
              const matching = agentsData.agents.filter(
                (a) =>
                  a.deleted_at === null &&
                  a.workdir.toLowerCase() === validPath.toLowerCase() &&
                  a.team_role === role.key
              );
              if (matching.length > 0) {
                agent = matching.find((a) => a.team_id === team.id) ?? matching[0];
              }
            }

            const nowIso = new Date().toISOString();

            if (agent) {
              agent.name = role.name;
              agent.platform = platform;
              agent.model = model;
              agent.effort = effort;
              agent.workdir = workdir;
              agent.role = role.exec_role;
              agent.persona = role.persona;
              agent.team_id = team.id;
              agent.team_role = role.key;
              agent.group_id = group.id;
              agent.order = i;
              agent.updated_at = nowIso;
              role.agent_id = agent.id;
            } else {
              let candidateName = role.name;
              let counter = 1;
              while (
                agentsData.agents.some(
                  (a) => a.deleted_at === null && a.name.toLowerCase() === candidateName.toLowerCase()
                )
              ) {
                counter++;
                candidateName = `${role.name} (${counter})`;
              }

              agent = {
                id: generateAgentId(),
                name: candidateName,
                group_id: group.id,
                order: i,
                platform,
                model,
                effort,
                workdir,
                role: role.exec_role,
                persona: role.persona,
                team_id: team.id,
                team_role: role.key,
                cli_args: [],
                env: {},
                hooks: { before: '', after: '' },
                retry_policy: { max_attempts: 0, backoff_sec: 30 },
                bookmark: false,
                created_at: nowIso,
                updated_at: nowIso,
                deleted_at: null,
              };
              agentsData.agents.push(agent);
              role.agent_id = agent.id;
            }
            appliedAgents.push(agent);
          }

          await writeJsonStore(agentsFile, agentsData);
          await writeJsonStore(teamFile, team);

          return {
            ok: true,
            team,
            agents: appliedAgents,
            group,
          };
        });
      },
    },

    team_export: {
      method: 'GET',
      handler: async (ctx) => {
        const rawProj = String(ctx.query?.get('project_path') ?? '').trim();
        const validPath = resolveProjectPath(rawProj, ctx.paths.projectsRoot);
        if (!validPath) {
          throw new ApiValidationError('Invalid or missing project_path.', 400);
        }

        const teamFile = getTeamFilePath(validPath);
        if (!isFileSafe(teamFile)) {
          throw new ApiValidationError('No team found for project.', 404);
        }

        const team = JSON.parse(fs.readFileSync(teamFile, 'utf8')) as Team;
        const rolesMd: Record<string, RoleSections> = {};
        const rolesDir = getRolesDir(validPath);
        if (Array.isArray(team.roles)) {
          for (const role of team.roles) {
            try {
              const rFile = getSafeRoleFilePath(rolesDir, role.key);
              if (isFileSafe(rFile)) {
                rolesMd[role.key] = parseRoleMarkdown(fs.readFileSync(rFile, 'utf8')).sections;
              }
            } catch {}
          }
        }

        return {
          ok: true,
          bundle: {
            kind: 'maw-team',
            version: 1,
            team,
            roles_md: rolesMd,
          },
        };
      },
    },

    team_import: {
      method: 'POST',
      handler: async (ctx) => {
        return withS6State(async () => {
          const body = ctx.body ?? {};
          const rawProj = String(body.project_path ?? '').trim();
          const validPath = resolveProjectPath(rawProj, ctx.paths.projectsRoot);
          if (!validPath) {
            throw new ApiValidationError('Invalid or missing project_path.', 400);
          }

          const bundle = body.bundle as Record<string, unknown> | undefined;
          if (!bundle || bundle.kind !== 'maw-team' || bundle.version !== 1) {
            throw new ApiValidationError('Invalid bundle: must have kind "maw-team" and version 1.', 400);
          }

          const teamFile = getTeamFilePath(validPath);
          const overwrite = Boolean(body.overwrite);
          if (isFileSafe(teamFile) && !overwrite) {
            throw new ApiValidationError(
              'A team already exists for this project. Pass overwrite: true to replace it.',
              409
            );
          }

          // Item 1: Validate bundle team and roles_md BEFORE creating directories or writing any files!
          const validated = validateTeam(bundle.team, ctx, {
            rolesMd: bundle.roles_md as Record<string, unknown> | undefined,
          });

          const newTeam: Team = {
            ...validated.team,
            id: generateTeamId(),
            roles: validated.team.roles.map((r) => ({ ...r, agent_id: '' })),
          };

          const rolesDir = getRolesDir(validPath);
          if (!fs.existsSync(rolesDir)) {
            fs.mkdirSync(rolesDir, { recursive: true });
          }
          await writeJsonStore(teamFile, newTeam);

          const rolesMd = validated.rolesMd ?? {};
          for (const role of newTeam.roles) {
            const rFile = getSafeRoleFilePath(rolesDir, role.key);
            const sec = rolesMd[role.key] ?? { responsibility: '', delegation: '', output: '', permissions: '' };
            const mdContent = renderRoleMarkdown(role.name, sec);
            fs.writeFileSync(rFile, mdContent, 'utf8');
          }

          return {
            ok: true,
            team: newTeam,
          };
        });
      },
    },

    team_templates: {
      method: 'GET',
      handler: async (ctx) => {
        const tplFile = path.win32.join(ctx.paths.featureDataDir('teams'), 'templates.json');
        const data = await readJsonStore<{ version: number; templates: TeamTemplate[] }>(tplFile, {
          version: 1,
          templates: [],
        });

        const allTemplates = [BUILTIN_FULL_TEMPLATE, BUILTIN_EMPTY_TEMPLATE, ...data.templates];
        return {
          ok: true,
          templates: allTemplates,
        };
      },
    },

    team_template_save: {
      method: 'POST',
      handler: async (ctx) => {
        return withS6State(async () => {
          const body = ctx.body ?? {};
          const id = String(body.id ?? '').trim();
          if (id === 'full' || id === 'empty') {
            throw new ApiValidationError(`Built-in template '${id}' cannot be modified.`, 400);
          }

          const name = String(body.name ?? '').trim();
          if (!name || name.length > 60) {
            throw new ApiValidationError('Template name must be between 1 and 60 characters.', 400);
          }

          const validated = validateTeam(body.team, ctx, {
            isTemplate: true,
            rolesMd: body.roles_md as Record<string, unknown> | undefined,
          });

          const tplFile = path.win32.join(ctx.paths.featureDataDir('teams'), 'templates.json');
          const data = await readJsonStore<{ version: number; templates: TeamTemplate[] }>(tplFile, {
            version: 1,
            templates: [],
          });

          const targetId = id || generateTemplateId();
          const existingIdx = data.templates.findIndex((t) => t.id === targetId);

          const savedTeam = {
            ...validated.team,
            id: '',
            roles: validated.team.roles.map((r) => ({ ...r, agent_id: '' })),
          };

          const template: TeamTemplate = {
            id: targetId,
            name,
            team: savedTeam,
            roles_md: (validated.rolesMd ?? {}) as Record<string, RoleSections>,
            updated_at: new Date().toISOString(),
          };

          if (existingIdx !== -1) {
            data.templates[existingIdx] = template;
          } else {
            data.templates.push(template);
          }

          await writeJsonStore(tplFile, data);

          return {
            ok: true,
            template,
          };
        });
      },
    },

    team_template_delete: {
      method: 'POST',
      handler: async (ctx) => {
        return withS6State(async () => {
          const body = ctx.body ?? {};
          const id = String(body.id ?? '').trim();
          if (id === 'full' || id === 'empty') {
            throw new ApiValidationError(`Built-in template '${id}' cannot be deleted.`, 400);
          }

          const tplFile = path.win32.join(ctx.paths.featureDataDir('teams'), 'templates.json');
          const data = await readJsonStore<{ version: number; templates: TeamTemplate[] }>(tplFile, {
            version: 1,
            templates: [],
          });

          const idx = data.templates.findIndex((t) => t.id === id);
          if (idx === -1) {
            throw new ApiValidationError(`Template '${id}' not found.`, 404);
          }

          data.templates.splice(idx, 1);
          await writeJsonStore(tplFile, data);

          await appendAuditLog(ctx.paths.featureDataDir('teams'), {
            action: 'team_template_delete',
            target: id,
          });

          return {
            ok: true,
          };
        });
      },
    },

    team_profiles: {
      method: 'GET',
      handler: async (ctx) => {
        const profFile = path.win32.join(ctx.paths.featureDataDir('teams'), 'profiles.json');
        const data = await readJsonStore<{ version: number; profiles: RoleProfile[] }>(profFile, {
          version: 1,
          profiles: [],
        });
        return {
          ok: true,
          profiles: data.profiles,
        };
      },
    },

    team_profile_save: {
      method: 'POST',
      handler: async (ctx) => {
        return withS6State(async () => {
          const body = ctx.body ?? {};
          const id = String(body.id ?? '').trim();
          const name = String(body.name ?? '').trim();
          if (!name || name.length > 60) {
            throw new ApiValidationError('Profile name must be between 1 and 60 characters.', 400);
          }

          const role = (body.role ?? {}) as Partial<TeamRole>;
          const sections = (body.sections ?? {}) as RoleSections;

          const profFile = path.win32.join(ctx.paths.featureDataDir('teams'), 'profiles.json');
          const data = await readJsonStore<{ version: number; profiles: RoleProfile[] }>(profFile, {
            version: 1,
            profiles: [],
          });

          const targetId = id || generateProfileId();
          const existingIdx = data.profiles.findIndex((p) => p.id === targetId);

          const profile: RoleProfile = {
            id: targetId,
            name,
            role,
            sections,
            updated_at: new Date().toISOString(),
          };

          if (existingIdx !== -1) {
            data.profiles[existingIdx] = profile;
          } else {
            data.profiles.push(profile);
          }

          await writeJsonStore(profFile, data);

          return {
            ok: true,
            profile,
          };
        });
      },
    },

    team_profile_delete: {
      method: 'POST',
      handler: async (ctx) => {
        return withS6State(async () => {
          const body = ctx.body ?? {};
          const id = String(body.id ?? '').trim();
          if (!id) {
            throw new ApiValidationError('Missing profile id.', 400);
          }

          const profFile = path.win32.join(ctx.paths.featureDataDir('teams'), 'profiles.json');
          const data = await readJsonStore<{ version: number; profiles: RoleProfile[] }>(profFile, {
            version: 1,
            profiles: [],
          });

          const idx = data.profiles.findIndex((p) => p.id === id);
          if (idx === -1) {
            throw new ApiValidationError(`Role profile '${id}' not found.`, 404);
          }

          data.profiles.splice(idx, 1);
          await writeJsonStore(profFile, data);

          await appendAuditLog(ctx.paths.featureDataDir('teams'), {
            action: 'team_profile_delete',
            target: id,
          });

          return {
            ok: true,
          };
        });
      },
    },
  },
};
