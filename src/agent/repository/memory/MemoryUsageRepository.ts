import { InMemoryModelUsageStore } from "../../observability/modelUsageStore.js";
import type { UsageRepository } from "../interfaces/UsageRepository.js";

export class MemoryUsageRepository extends InMemoryModelUsageStore implements UsageRepository {}
