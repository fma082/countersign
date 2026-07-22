/**
 * Pending-gate store.
 *
 * When a destructive op parks at the gate, the server remembers *what it
 * offered* — the tool and its arguments — keyed by gate id. On approval the
 * client sends back only the gate id and the IDs it wants excluded. The server
 * re-resolves the preview from this stored spec and re-intersects: the client
 * can shrink the effect, never define it, never point it somewhere new.
 *
 * A module-level Map is the right scope here — gate creation and gate approval
 * are two requests against the same route module instance in one server process.
 */

export interface PendingGate {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

const gates = new Map<string, PendingGate>();

export const putGate = (gate: PendingGate): void => {
  gates.set(gate.id, gate);
};

export const takeGate = (id: string): PendingGate | undefined => {
  const gate = gates.get(id);
  if (gate) gates.delete(id); // a gate is decided exactly once
  return gate;
};
