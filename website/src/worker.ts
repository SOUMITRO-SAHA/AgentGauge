export interface WorkerEnv {
  readonly ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return env.ASSETS.fetch(request);
  },
};
