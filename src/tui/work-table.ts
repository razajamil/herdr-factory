const MAX_WORK_WIDTH = 44;
const MAX_STEP_WIDTH = 18;

export interface WorkTableRow {
  id: string;
  description: string | null;
  statuses: string[];
}

export interface WorkTable {
  header: string;
  divider: string;
  rows: string[];
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

/** Format a compact table while keeping long summaries and status names from dominating the TUI. */
export function formatWorkTable(steps: string[], rows: WorkTableRow[]): WorkTable {
  const workCells = rows.map((row) => row.description ? `${row.id} ${row.description}` : row.id);
  const workWidth = Math.min(MAX_WORK_WIDTH, Math.max("WORK".length, ...workCells.map((cell) => cell.length)));
  const stepWidths = steps.map((step, index) => Math.min(
    MAX_STEP_WIDTH,
    Math.max(step.length, ...rows.map((row) => row.statuses[index]?.length ?? 0)),
  ));
  const join = (cells: string[]) => cells.map((cell, index) => truncate(cell, index === 0 ? workWidth : stepWidths[index - 1]!).padEnd(index === 0 ? workWidth : stepWidths[index - 1]!)).join(" | ");
  const header = join(["WORK", ...steps]);

  return {
    header,
    divider: [workWidth, ...stepWidths].map((width) => "-".repeat(width)).join("-+-"),
    rows: rows.map((row, index) => join([workCells[index]!, ...steps.map((_, stepIndex) => row.statuses[stepIndex] ?? "pending")])),
  };
}
