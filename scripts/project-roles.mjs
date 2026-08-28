import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_ROLES = {
  schema_version: 1,
  project_manager: {
    person: "Zac",
    agent_id: "zac-agent",
    role: "project_manager"
  }
};

export async function loadProjectRoles(workspaceRoot) {
  const filePath = path.join(workspaceRoot, "03-decisions", "project-roles.json");
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    const manager = parsed?.project_manager || {};
    if (!String(manager.person || "").trim() || !String(manager.agent_id || "").trim()) {
      throw new Error("project_manager requires person and agent_id");
    }
    return { ...DEFAULT_ROLES, ...parsed, project_manager: { ...DEFAULT_ROLES.project_manager, ...manager } };
  } catch (error) {
    if (error.code === "ENOENT") return DEFAULT_ROLES;
    throw error;
  }
}

export function projectManager(roles) {
  return roles?.project_manager || DEFAULT_ROLES.project_manager;
}
