import { InMemoryExecutionStore } from "../../workspace/executionStore.js";
import type { ExecutionRepository } from "../interfaces/ExecutionRepository.js";

export class MemoryExecutionRepository extends InMemoryExecutionStore implements ExecutionRepository {}
