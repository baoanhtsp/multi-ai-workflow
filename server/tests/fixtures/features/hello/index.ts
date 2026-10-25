import type { MawFeature } from '../../../../lib/feature.ts';

export const feature: MawFeature = {
  name: 'hello',
  routes: {
    hello_ping: {
      method: 'GET',
      handler: async (ctx, req) => {
        const msg = req.url.searchParams.get('msg') ?? 'pong';
        const dataDir = ctx.paths.featureDataDir('hello');
        return {
          ok: true,
          feature: 'hello',
          echo: msg,
          data_dir: dataDir,
        };
      },
    },
  },
  status: async (ctx) => ({
    greeting: 'Hello from F0 plugin!',
    data_dir: ctx.paths.featureDataDir('hello'),
  }),
  ui: {
    script: 'feat-hello.js',
    style: 'feat-hello.css',
  },
};
