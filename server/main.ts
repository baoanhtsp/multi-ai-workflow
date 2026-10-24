import type { AddressInfo } from 'node:net';
import { reconcileJobsOnStartup } from './actions/jobs.ts';
import { createMawHttpServer } from './http.ts';

interface CliOptions {
  port: number;
  projectsRoot?: string;
}

function parseCliArgs(argv: readonly string[]): CliOptions {
  let port = Number.parseInt(process.env.MAW_PORT ?? '4317', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    port = 4317;
  }
  let projectsRoot: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--port' && i + 1 < argv.length) {
      const p = Number.parseInt(argv[++i]!, 10);
      if (Number.isInteger(p) && p >= 0 && p <= 65535) {
        port = p;
      }
    } else if (arg.startsWith('--port=')) {
      const p = Number.parseInt(arg.slice(7), 10);
      if (Number.isInteger(p) && p >= 0 && p <= 65535) {
        port = p;
      }
    } else if (arg === '--projects-root' && i + 1 < argv.length) {
      projectsRoot = argv[++i]!;
    } else if (arg.startsWith('--projects-root=')) {
      projectsRoot = arg.slice(16);
    }
  }

  return { port, projectsRoot };
}

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const { server, getPaths } = createMawHttpServer({
    projectsRoot: cli.projectsRoot,
  });

  const paths = getPaths();
  await reconcileJobsOnStartup(paths.jobsDir);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cli.port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  console.log(
    `[MAW v3.0] Mission Control Server listening on http://127.0.0.1:${addr.port}/ (projectsRoot: ${paths.projectsRoot})`
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[MAW v3.0] Received ${signal}, shutting down gracefully...`);
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => {
      process.exit(0);
    }, 3000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main().catch((err: unknown) => {
  console.error('[MAW v3.0] Fatal startup error:', err);
  process.exit(1);
});
