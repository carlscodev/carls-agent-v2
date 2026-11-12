import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Text edits from a language server.
 *
 * A rename or a quick fix arrives as a `WorkspaceEdit`: ranges in UTF-16 code
 * units per line, possibly across files. Applying them here — instead of asking
 * the model to re-derive the change — is what makes `lsp_edit` worth having.
 */

export interface EditPosition {
  line: number;
  character: number;
}

export interface EditRange {
  start: EditPosition;
  end: EditPosition;
}

export interface TextEdit {
  range: EditRange;
  newText: string;
}

export interface WorkspaceEdit {
  /** uri → edits, the classic form. */
  changes?: Record<string, TextEdit[]>;
  /** The versioned form; entries may also carry file operations we ignore. */
  documentChanges?: { textDocument?: { uri?: string }; edits?: TextEdit[] }[];
}

/** Offset of an LSP position in a UTF-16 string, clamped to the document. */
export function offsetAt(text: string, position: EditPosition): number {
  let line = 0;
  let index = 0;
  while (line < position.line && index < text.length) {
    const next = text.indexOf("\n", index);
    if (next === -1) {
      index = text.length;
      break;
    }
    index = next + 1;
    line += 1;
  }
  return Math.min(text.length, index + Math.max(0, position.character));
}

/**
 * Applies edits to one document. They are applied back to front so earlier
 * offsets stay valid; overlapping edits are applied in the order the server
 * sent them, which is what every editor does.
 */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  const ordered = edits
    .map((edit) => ({
      start: offsetAt(text, edit.range.start),
      end: offsetAt(text, edit.range.end),
      newText: edit.newText,
    }))
    .sort((a, b) => b.start - a.start || b.end - a.end);
  let result = text;
  let lowest = Number.POSITIVE_INFINITY;
  for (const edit of ordered) {
    // Sorting descending means each edit must end before the previous start.
    if (edit.end > lowest) continue;
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
    lowest = edit.start;
  }
  return result;
}

export interface PlannedEdit {
  path: string;
  edits: number;
  /** Full new contents of the file. */
  text: string;
}

/** What a workspace edit would do, without writing anything. */
export async function planWorkspaceEdit(
  edit: WorkspaceEdit,
  resolve: (path: string) => string,
): Promise<PlannedEdit[]> {
  const perFile = new Map<string, TextEdit[]>();
  const add = (uri: string, edits: TextEdit[] | undefined): void => {
    if (edits === undefined || edits.length === 0) return;
    const path = resolve(uri.startsWith("file:") ? fileURLToPath(uri) : uri);
    const list = perFile.get(path) ?? [];
    list.push(...edits);
    perFile.set(path, list);
  };

  for (const [uri, edits] of Object.entries(edit.changes ?? {})) add(uri, edits);
  for (const change of edit.documentChanges ?? []) {
    if (change.textDocument?.uri !== undefined) add(change.textDocument.uri, change.edits);
  }

  const planned: PlannedEdit[] = [];
  for (const [path, edits] of perFile) {
    const original = await readFile(path, "utf8");
    planned.push({ path, edits: edits.length, text: applyTextEdits(original, edits) });
  }
  return planned;
}
