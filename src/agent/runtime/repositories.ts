import { RepositoryManager, type RepositoryHealthSummary } from "../repository/RepositoryManager.js";

export const repositoryManager = new RepositoryManager();

export const getWorkspaceRepository = () => repositoryManager.getWorkspaceRepository();
export const getExecutionRepository = () => repositoryManager.getExecutionRepository();
export const getArtifactRepository = () => repositoryManager.getArtifactRepository();
export const getLearningRepository = () => repositoryManager.getLearningRepository();
export const getUsageRepository = () => repositoryManager.getUsageRepository();
export const getRepositoryHealth = (): Promise<RepositoryHealthSummary> => repositoryManager.getRepositoryHealth();
