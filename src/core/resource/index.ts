export type {
  ResourceCategory,
  UserMemoryEntry,
  AgentEntry,
  AgentFrontmatter,
  ResourceEntry,
  SearchResult,
} from './types';
export {
  loadUserMemory,
  readUserMemoryContent,
  createUserMemory,
  removeUserMemory,
  copyUserMemoryToProfile,
} from './user-memory';
export {
  validateNewAgentName,
  listAgents,
  loadAgent,
  readAgentContent,
  createAgent,
  removeAgent,
  copyAgentToProfile,
  updateAgentFrontmatter,
} from './agent';
export { parseFrontmatter, serializeFrontmatter } from './frontmatter';
export type { FrontmatterResult } from './frontmatter';
export { lineDiff, countChanges } from './diff';
export type { DiffLine, DiffCounts } from './diff';
export { diffUserMemory, diffAgents } from './diff';
export type { UserMemoryDiff, AgentsDiff, AgentFileDiff } from './diff';
export { searchUserMemory, searchAgents, searchAllResources } from './search';
