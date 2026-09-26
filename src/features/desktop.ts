import { dispatch, hyprJson, type Client, type Monitor } from "../hypr";

export type Window = {
  address: string;
  title: string;
  app: string;
  workspace: number;
  focused: boolean;
};

/** `name` is the id as text unless the workspace was given a name in Hyprland. */
export type Workspace = { id: number; name: string; windows: number; monitor: string };

export type DesktopSnapshot = {
  workspaces: Workspace[];
  activeWorkspace: number | null;
  activeWindow: string | null;
  windows: Window[];
  monitors: { name: string; focused: boolean; workspace: number }[];
};

export async function readDesktop(): Promise<DesktopSnapshot> {
  const [workspaces, active, clients, monitors] = await Promise.all([
    hyprJson<Workspace[]>("workspaces"),
    hyprJson<{ id: number }>("activeworkspace"),
    hyprJson<Client[]>("clients"),
    hyprJson<Monitor[]>("monitors"),
  ]);
  return toSnapshot(workspaces, active, clients, monitors);
}

/** Hyprland's replies, any of which may have failed, as the phone sees them. */
export function toSnapshot(
  workspaces: Workspace[] | null,
  active: { id: number } | null,
  clients: Client[] | null,
  monitors: Monitor[] | null,
): DesktopSnapshot {
  const windows = (clients ?? [])
    // Negative ids are special workspaces (scratchpads); not reachable here.
    .filter((client) => client.workspace.id > 0 && client.title !== "")
    .sort((a, b) => a.workspace.id - b.workspace.id || a.focusHistoryID - b.focusHistoryID)
    .map((client) => ({
      address: client.address,
      title: client.title,
      app: client.class,
      workspace: client.workspace.id,
      focused: client.focusHistoryID === 0,
    }));

  return {
    workspaces: (workspaces ?? [])
      .filter((workspace) => workspace.id > 0)
      .map(({ id, name, windows, monitor }) => ({ id, name, windows, monitor }))
      .sort((a, b) => a.id - b.id),
    activeWorkspace: active?.id ?? null,
    activeWindow: windows.find((window) => window.focused)?.title ?? null,
    windows,
    monitors: (monitors ?? []).map((monitor) => ({
      name: monitor.name,
      focused: monitor.focused,
      workspace: monitor.activeWorkspace.id,
    })),
  };
}

/**
 * With `binds:workspace_back_and_forth` on, switching to the workspace you're
 * already on jumps back to the previous one — from a remote, that reads as the
 * button doing something random. So the current workspace is a no-op.
 */
export async function switchWorkspace(id: number) {
  const active = await hyprJson<{ id: number }>("activeworkspace");
  if (active?.id === id) return;
  await dispatch(`workspace ${id}`);
}

/** Addresses are validated as 0x-hex by the action schema before arriving here. */
export async function windowCommand(
  op: "focus" | "close" | "move",
  address: string,
  workspace?: number,
) {
  if (op === "focus") await dispatch(`focuswindow address:${address}`);
  if (op === "close") await dispatch(`closewindow address:${address}`);
  if (op === "move" && workspace) {
    await dispatch(`movetoworkspacesilent ${workspace},address:${address}`);
  }
}
