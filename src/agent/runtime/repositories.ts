import { RepositoryManager, type RepositoryHealthSummary } from "../repository/RepositoryManager.js";
import { conductorCache } from "../workspace/conductor.js";

let manager: RepositoryManager | undefined;

const usesBlobBackend = (env: NodeJS.ProcessEnv = process.env): boolean => (env.WORKSPACE_STORE ?? "memory") === "blobs";

// Lazily build and memoize the process-wide RepositoryManager. Construction is deferred to first
// use — never module-evaluation time — so the Blob backend's getStore() is not called at import.
// Lambda handlers must connect Netlify Blobs (see connectLambdaBlobs) before the first access.
export const getRepositoryManager = (): RepositoryManager => (manager ??= new RepositoryManager());

// Drop the memoized manager so the next access rebuilds it (used by tests and per-request refresh).
// The per-run conductor cache is cleared alongside it so a rebuilt manager never serves a run
// context memoized against stale project/registry state.
export const resetRepositoryManager = (): void => { manager = undefined; conductorCache.clear(); };

// Per-request hook for Lambda handlers, called after connectLambda(event). Blob-backed stores
// capture their credentials when getStore() runs, so we rebuild the manager each request to bind
// to the current invocation's Blobs context. Memory/JSON backends keep their shared in-process
// state, so dev/test behavior is unchanged.
export const refreshRepositoryManagerForRequest = (): void => {
  if (usesBlobBackend()) resetRepositoryManager();
};

// Backward-compatible facade: existing callers and tests use `repositoryManager.getX()`. The Proxy
// forwards to the lazily-built singleton, so no construction (and no getStore()) happens until the
// first property access at request time.
export const repositoryManager: RepositoryManager = new Proxy({} as RepositoryManager, {
  get: (_target, property) => {
    const target = getRepositoryManager();
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  }
});

export const getWorkspaceRepository = () => getRepositoryManager().getWorkspaceRepository();
export const getExecutionRepository = () => getRepositoryManager().getExecutionRepository();
export const getArtifactRepository = () => getRepositoryManager().getArtifactRepository();
export const getLearningRepository = () => getRepositoryManager().getLearningRepository();
export const getUsageRepository = () => getRepositoryManager().getUsageRepository();
export const getProjectRepository = () => getRepositoryManager().getProjectRepository();
export const getChangeRepository = () => getRepositoryManager().getChangeRepository();
export const getRepositoryHealth = (): Promise<RepositoryHealthSummary> => getRepositoryManager().getRepositoryHealth();
