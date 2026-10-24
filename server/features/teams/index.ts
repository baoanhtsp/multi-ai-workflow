import fs from 'node:fs';
import path from 'node:path';
import type { MawFeature } from '../../lib/feature.ts';
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
import { appendAuditLog, readJsonStore, writeJsonStore } from '../agents-ws/lib/store.ts';
import type { Agent, Group } from '../agents-ws/types.ts';
import { BUILTIN_EMPTY_TEMPLATE, BUILTIN_FULL_TEMPLATE } from './defaults.ts';
import type { RoleProfile, Team, TeamRole, TeamTemplate } from './types.ts';

const ALLOWED_EXEC_ROLES = ['architect', 'backend', 'frontend', 'reviewer', 'tester'];
const ALLOWED_WORKING_STYLES = ['persistent', 'per_task', 'new_chat_per_task'];

function getTeamFilePath(projectPath: string): string {
  return path.win32.join(projectPath, '.maw', 'team.json');
}

function getRolesDir(projectPath: string): string {
  return path.win32.join(projectPath, '.maw', 'roles');
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
            const rFile = path.win32.join(rolesDir, `${role.key}.md`);
            if (isFileSafe(rFile)) {
              try {
                const parsed = parseRoleMarkdown(fs.readFileSync(rFile, 'utf8'));
                rolesMd[role.key] = parsed.sections;
              } catch {
                rolesMd[role.key] = { responsibility: '', delegation: '', output: '', permissions: '' };
              }
            } else {
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
        const body = ctx.body ?? {};
        const rawProj = String(body.project_path ?? '').trim();
        const validPath = resolveProjectPath(rawProj, ctx.paths.projectsRoot);
        if (!validPath) {
          throw new ApiValidationError('Invalid or missing project_path.', 400);
        }

        const rawTeam = body.team;
        if (!rawTeam || typeof rawTeam !== 'object' || Array.isArray(rawTeam)) {
          throw new ApiValidationError('Invalid team object.', 400);
        }
        const t = rawTeam as Partial<Team>;

        const name = String(t.name ?? '').trim();
        if (!name || name.length > 60) {
          throw new ApiValidationError('Team name must be between 1 and 60 characters.', 400);
        }

        const teamId = String(t.id ?? '').trim() || generateTeamId();
        const template = String(t.template ?? 'full').trim();

        const rawShared = t.shared ?? ({} as Partial<Team['shared']>);
        const maxParallel = Math.max(1, Math.min(6, Number(rawShared.max_parallel) || 3));
        const shared = {
          workdir: String(rawShared.workdir ?? '').trim(),
          platform: String(rawShared.platform ?? 'claude').trim() || 'claude',
          model: String(rawShared.model ?? '').trim(),
          effort: String(rawShared.effort ?? '').trim(),
          write_scope: Array.isArray(rawShared.write_scope)
            ? rawShared.write_scope.map((x) => String(x ?? '').trim()).filter((x) => x.length > 0)
            : ['**'],
          writable_dirs: Array.isArray(rawShared.writable_dirs)
            ? rawShared.writable_dirs.map((x) => String(x ?? '').trim()).filter((x) => x.length > 0)
            : [],
          isolate: rawShared.isolate !== false,
          max_parallel: maxParallel,
          auto_continue: rawShared.auto_continue !== false,
        };

        if (shared.write_scope.length > 30) {
          throw new ApiValidationError('shared.write_scope cannot have more than 30 globs.', 400);
        }
        if (shared.writable_dirs.length > 10) {
          throw new ApiValidationError('shared.writable_dirs cannot have more than 10 dirs.', 400);
        }

        if (!Array.isArray(t.roles) || t.roles.length === 0) {
          throw new ApiValidationError('Team must have at least one role.', 400);
        }

        const roles: TeamRole[] = [];
        const seenKeys = new Set<string>();

        for (let i = 0; i < t.roles.length; i++) {
          const r = t.roles[i]!;
          const key = String(r.key ?? '').trim().toLowerCase();
          if (!ROLE_KEY_REGEX.test(key)) {
            throw new ApiValidationError(
              `Invalid role key '${key}'. Must match ^[a-z][a-z0-9-]{1,23}$.`,
              400
            );
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
            throw new ApiValidationError(
              `Invalid working_style '${style}' for role '${key}'. Must be persistent|per_task|new_chat_per_task.`,
              400
            );
          }

          const execRole = String(r.exec_role ?? 'backend').trim().toLowerCase();
          if (!ALLOWED_EXEC_ROLES.includes(execRole)) {
            throw new ApiValidationError(
              `Invalid exec_role '${execRole}' for role '${key}'. Must be architect|backend|frontend|reviewer|tester.`,
              400
            );
          }

          roles.push({
            key,
            name: rName,
            enabled: r.enabled !== false,
            working_style: style as TeamRole['working_style'],
            persona: String(r.persona ?? '').trim().slice(0, 4000),
            may_delegate: Boolean(r.may_delegate),
            exec_role: execRole,
            override: r.override ? { ...r.override } : undefined,
            agent_id: String(r.agent_id ?? '').trim(),
          });
        }

        const team: Team = {
          version: 1,
          id: teamId,
          name,
          template,
          shared,
          roles,
        };

        const teamFile = getTeamFilePath(validPath);
        const rolesDir = getRolesDir(validPath);
        if (!fs.existsSync(rolesDir)) {
          fs.mkdirSync(rolesDir, { recursive: true });
        }

        fs.writeFileSync(teamFile, JSON.stringify(team, null, 2), 'utf8');

        // Write roles_md and clean up removed roles
        const rawRolesMd = (body.roles_md ?? {}) as Record<string, Partial<RoleSections>>;
        const currentFiles = fs.readdirSync(rolesDir).filter((f) => f.endsWith('.md'));
        const activeFileNames = new Set(roles.map((r) => `${r.key}.md`));

        for (const file of currentFiles) {
          if (!activeFileNames.has(file)) {
            try {
              fs.unlinkSync(path.win32.join(rolesDir, file));
            } catch {
              // Ignore unlink error
            }
          }
        }

        for (const role of roles) {
          const rFile = path.win32.join(rolesDir, `${role.key}.md`);
          const sec = rawRolesMd[role.key] ?? {};
          const fullSec: RoleSections = {
            responsibility: String(sec.responsibility ?? '').slice(0, 6000),
            delegation: String(sec.delegation ?? '').slice(0, 6000),
            output: String(sec.output ?? '').slice(0, 6000),
            permissions: String(sec.permissions ?? '').slice(0, 6000),
            extra: typeof sec.extra === 'string' ? sec.extra.slice(0, 6000) : undefined,
          };
          const mdContent = renderRoleMarkdown(role.name, fullSec);
          fs.writeFileSync(rFile, mdContent, 'utf8');
        }

        return {
          ok: true,
          team,
        };
      },
    },

    team_apply: {
      method: 'POST',
      handler: async (ctx) => {
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

        // Find or create group for team
        let group = groupsData.groups.find(
          (g) => (g.team_id && g.team_id === team.id) || g.name.toLowerCase() === team.name.toLowerCase()
        );
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

          let agent = agentsData.agents.find((a) => a.id === role.agent_id && a.deleted_at === null);
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
          } else {
            // Pick a unique name among live agents
            let candidateName = role.name;
            let counter = 1;
            while (
              agentsData.agents.some(
                (a) => a.deleted_at === null && a.name.toLowerCase() === candidateName.toLowerCase()
              )
            ) {
              counter++;
              candidateName = `${role.name} ${counter}`;
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

        // Save updated agents store
        await writeJsonStore(agentsFile, agentsData);

        // Update team.json with agent_ids
        fs.writeFileSync(teamFile, JSON.stringify(team, null, 2), 'utf8');

        return {
          ok: true,
          team,
          agents: appliedAgents,
          group,
        };
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
            const rFile = path.win32.join(rolesDir, `${role.key}.md`);
            if (isFileSafe(rFile)) {
              rolesMd[role.key] = parseRoleMarkdown(fs.readFileSync(rFile, 'utf8')).sections;
            }
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

        const rawTeam = bundle.team as Team;
        if (!rawTeam || typeof rawTeam !== 'object') {
          throw new ApiValidationError('Bundle is missing team definition.', 400);
        }

        // Regenerate team id and clear agent_id
        const newTeam: Team = {
          ...rawTeam,
          id: generateTeamId(),
          roles: Array.isArray(rawTeam.roles)
            ? rawTeam.roles.map((r) => ({ ...r, agent_id: '' }))
            : [],
        };

        const rolesDir = getRolesDir(validPath);
        if (!fs.existsSync(rolesDir)) {
          fs.mkdirSync(rolesDir, { recursive: true });
        }
        fs.writeFileSync(teamFile, JSON.stringify(newTeam, null, 2), 'utf8');

        const rolesMd = (bundle.roles_md ?? {}) as Record<string, RoleSections>;
        for (const role of newTeam.roles) {
          const rFile = path.win32.join(rolesDir, `${role.key}.md`);
          const sec = rolesMd[role.key] ?? { responsibility: '', delegation: '', output: '', permissions: '' };
          const mdContent = renderRoleMarkdown(role.name, sec);
          fs.writeFileSync(rFile, mdContent, 'utf8');
        }

        return {
          ok: true,
          team: newTeam,
        };
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
        const body = ctx.body ?? {};
        const id = String(body.id ?? '').trim();
        if (id === 'full' || id === 'empty') {
          throw new ApiValidationError(`Built-in template '${id}' cannot be modified.`, 400);
        }

        const name = String(body.name ?? '').trim();
        if (!name || name.length > 60) {
          throw new ApiValidationError('Template name must be between 1 and 60 characters.', 400);
        }

        const rawTeam = body.team as Team | undefined;
        if (!rawTeam || typeof rawTeam !== 'object') {
          throw new ApiValidationError('Template is missing team definition.', 400);
        }

        const tplFile = path.win32.join(ctx.paths.featureDataDir('teams'), 'templates.json');
        const data = await readJsonStore<{ version: number; templates: TeamTemplate[] }>(tplFile, {
          version: 1,
          templates: [],
        });

        const targetId = id || generateTemplateId();
        const existingIdx = data.templates.findIndex((t) => t.id === targetId);

        const savedTeam = {
          ...rawTeam,
          id: '',
          roles: Array.isArray(rawTeam.roles)
            ? rawTeam.roles.map((r) => ({ ...r, agent_id: '' }))
            : [],
        };

        const template: TeamTemplate = {
          id: targetId,
          name,
          team: savedTeam,
          roles_md: (body.roles_md ?? {}) as Record<string, RoleSections>,
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
      },
    },

    team_template_delete: {
      method: 'POST',
      handler: async (ctx) => {
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
      },
    },

    team_profile_delete: {
      method: 'POST',
      handler: async (ctx) => {
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
      },
    },
  },
};
