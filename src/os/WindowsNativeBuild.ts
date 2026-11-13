import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/**
 * Single-file Windows build.
 *
 * A CLI spread over `dist/` plus `node_modules` pays for every `.js` file twice
 * on Windows: NTFS metadata reads and Defender's real-time scan of each open.
 * The fix is to ship one CommonJS bundle, optionally embedded in a copy of
 * `node.exe` as a Node Single Executable Application (SEA).
 *
 * The SEA half is implemented here rather than delegated to postject because
 * the build must also work on a machine with no npm registry: this writes the
 * blob into a new `.rsrc` section, keeps Node's original resources (manifest,
 * icon, version info), and flips the SEA fuse the runtime looks for. When
 * postject happens to be installed it is preferred, since it is the reference
 * implementation.
 */

export const SEA_BLOB_RESOURCE_NAME = "NODE_SEA_BLOB";
export const SEA_BLOB_RESOURCE_TYPE = 10;
export const SEA_FUSE_PREFIX = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

export interface BuildLayout {
  root: string;
  releaseDir: string;
  bundleFile: string;
  seaConfigFile: string;
  blobFile: string;
  exeFile: string;
  cmdFile: string;
}

export function buildLayout(root: string = process.cwd()): BuildLayout {
  const absolute = resolve(root);
  const releaseDir = join(absolute, "release");
  return {
    root: absolute,
    releaseDir,
    bundleFile: join(releaseDir, "carls.bundle.cjs"),
    seaConfigFile: join(releaseDir, "sea-config.json"),
    blobFile: join(releaseDir, "sea-prep.blob"),
    exeFile: join(releaseDir, "carls.exe"),
    cmdFile: join(releaseDir, "carls.cmd"),
  };
}

export interface SeaConfig {
  main: string;
  output: string;
  disableExperimentalSEAWarning: boolean;
  useCodeCache: boolean;
}

function relativePosix(root: string, target: string): string {
  return relative(root, target).split(sep).join("/");
}

export function createSeaConfig(layout: BuildLayout): SeaConfig {
  return {
    main: relativePosix(layout.root, layout.bundleFile),
    output: relativePosix(layout.root, layout.blobFile),
    disableExperimentalSEAWarning: true,
    useCodeCache: true,
  };
}

/** Writes `release/sea-config.json` deterministically and returns its content. */
export function writeSeaConfig(layout: BuildLayout): SeaConfig {
  const config = createSeaConfig(layout);
  mkdirSync(layout.releaseDir, { recursive: true });
  writeFileSync(layout.seaConfigFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

export function readPackageVersion(root: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * The builtin skills as `relative/path.md -> contents`, embedded through an
 * esbuild define. Keeping the catalog inside the bundle means an installed exe
 * behaves the same when it is copied to a directory with no `skills/` beside it.
 */
export function readBuiltinSkillSources(root: string): Record<string, string> {
  const skillsDir = join(root, "skills");
  const sources: Record<string, string> = {};
  if (!existsSync(skillsDir)) return sources;

  const walk = (directory: string, prefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const full = join(directory, entry);
      let isDirectory = false;
      try {
        isDirectory = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) {
        walk(full, `${prefix}${entry}/`);
      } else if (entry.toLowerCase().endsWith(".md")) {
        try {
          sources[`${prefix}${entry}`] = readFileSync(full, "utf8");
        } catch {
          // A skill that cannot be read is simply not embedded.
        }
      }
    }
  };

  walk(skillsDir, "");
  return sources;
}

export interface BuildBundleOptions {
  /** Defaults to `dist/src/index.js`; tests may point at the TypeScript entry. */
  entry?: string;
  /** Extra esbuild defines, merged after the build metadata. */
  define?: Record<string, string>;
  log?: (line: string) => void;
}

export interface BundleArtifact {
  bundleFile: string;
  bytes: number;
  version: string;
  inputs: string[];
}

interface EsbuildOutputFile {
  contents: Uint8Array;
  text?: string;
}

interface EsbuildResult {
  outputFiles?: EsbuildOutputFile[];
  metafile?: { inputs?: Record<string, unknown> };
}

interface EsbuildModule {
  build: (options: Record<string, unknown>) => Promise<EsbuildResult>;
}

async function loadEsbuild(): Promise<EsbuildModule> {
  // A variable specifier keeps TypeScript and esbuild from trying to resolve
  // the build tool as a runtime dependency of the bundle itself.
  const specifier = "esbuild";
  try {
    return (await import(specifier)) as EsbuildModule;
  } catch {
    throw new Error(
      "esbuild is required to bundle carls. Install dependencies with `npm install` " +
        "(it is already present through the development toolchain).",
    );
  }
}

/**
 * Bundles the compiled tree and every runtime dependency into one CJS file.
 * `write: false` keeps the output in memory so the caller controls the write
 * and the build stays atomic.
 */
export async function buildBundle(
  layout: BuildLayout,
  options: BuildBundleOptions = {},
): Promise<BundleArtifact> {
  const log = options.log ?? (() => undefined);
  const entry = options.entry ?? join(layout.root, "dist", "src", "index.js");
  if (!existsSync(entry)) {
    throw new Error(
      `Cannot bundle: ${entry} does not exist. Run \`npm run build\` first ` +
        "(or use `npm run build:exe`, which builds before bundling).",
    );
  }

  const version = readPackageVersion(layout.root);
  const skills = readBuiltinSkillSources(layout.root);
  const esbuild = await loadEsbuild();
  log(`bundling ${relativePosix(layout.root, entry)} (${Object.keys(skills).length} builtin skills)`);

  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    absWorkingDir: layout.root,
    outfile: layout.bundleFile,
    write: false,
    metafile: true,
    logLevel: "silent",
    legalComments: "none",
    sourcemap: false,
    minify: false,
    keepNames: true,
    treeShaking: true,
    define: {
      // `packageVersion()` reads this expression; esbuild replaces it with the
      // literal, so the bundle needs no package.json at runtime.
      "process.env.CARLS_EMBEDDED_VERSION": JSON.stringify(version),
      __CARLS_EMBEDDED_SKILLS__: JSON.stringify(skills),
      ...options.define,
    },
  });

  const output = result.outputFiles?.[0];
  if (output === undefined) throw new Error("esbuild produced no output file.");
  const body = `${output.text ?? Buffer.from(output.contents).toString("utf8")}`;
  const banner = `/* carls-code ${version} single-file bundle */\n`;
  const compiled = `${banner}${body}`;
  mkdirSync(dirname(layout.bundleFile), { recursive: true });
  writeFileSync(layout.bundleFile, compiled, "utf8");

  return {
    bundleFile: layout.bundleFile,
    bytes: Buffer.byteLength(compiled),
    version,
    inputs: Object.keys(result.metafile?.inputs ?? {}),
  };
}

// ---------------------------------------------------------------------------
// PE / SEA injection
// ---------------------------------------------------------------------------

const PE_SIGNATURE = 0x00004550; // "PE\0\0"
const RESOURCE_DIRECTORY_INDEX = 2;
const CERTIFICATE_DIRECTORY_INDEX = 4;
const IMAGE_SCN_CNT_INITIALIZED_DATA = 0x00000040;
const IMAGE_SCN_MEM_READ = 0x40000000;

interface PeSection {
  headerOffset: number;
  name: string;
  virtualSize: number;
  virtualAddress: number;
  rawSize: number;
  rawPointer: number;
}

interface PeInfo {
  peOffset: number;
  numberOfSections: number;
  optionalHeaderOffset: number;
  optionalHeaderSize: number;
  sectionTableOffset: number;
  magic: number;
  sectionAlignment: number;
  fileAlignment: number;
  sizeOfHeaders: number;
  checksumOffset: number;
  sizeOfImageOffset: number;
  dataDirectoryOffset: number;
  numberOfRvaAndSizes: number;
  sections: PeSection[];
  resourceRva: number;
  resourceSize: number;
  certificateOffset: number;
  certificateSize: number;
}

function parsePe(executable: Buffer): PeInfo {
  if (executable.length < 0x40 || executable.readUInt16LE(0) !== 0x5a4d) {
    throw new Error("Not a PE executable: the DOS header is missing.");
  }
  const peOffset = executable.readUInt32LE(0x3c);
  if (peOffset + 24 > executable.length || executable.readUInt32LE(peOffset) !== PE_SIGNATURE) {
    throw new Error("Not a PE executable: the PE signature is missing.");
  }
  const numberOfSections = executable.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = executable.readUInt16LE(peOffset + 20);
  const optionalHeaderOffset = peOffset + 24;
  const magic = executable.readUInt16LE(optionalHeaderOffset);
  if (magic !== 0x10b && magic !== 0x20b) {
    throw new Error(`Unsupported PE optional header magic 0x${magic.toString(16)}.`);
  }
  const isPe32Plus = magic === 0x20b;
  const minimumOptional = isPe32Plus ? 112 : 96;
  if (optionalHeaderSize < minimumOptional) {
    throw new Error("Truncated PE optional header.");
  }
  const sectionAlignment = executable.readUInt32LE(optionalHeaderOffset + 32);
  const fileAlignment = executable.readUInt32LE(optionalHeaderOffset + 36);
  const sizeOfHeaders = executable.readUInt32LE(optionalHeaderOffset + 60);
  const numberOfRvaAndSizes = executable.readUInt32LE(optionalHeaderOffset + (isPe32Plus ? 108 : 92));
  const dataDirectoryOffset = optionalHeaderOffset + (isPe32Plus ? 112 : 96);
  const sectionTableOffset = optionalHeaderOffset + optionalHeaderSize;

  const sections: PeSection[] = [];
  for (let index = 0; index < numberOfSections; index++) {
    const headerOffset = sectionTableOffset + index * 40;
    if (headerOffset + 40 > executable.length) throw new Error("Truncated PE section table.");
    sections.push({
      headerOffset,
      name: executable.toString("latin1", headerOffset, headerOffset + 8).replace(/\0.*$/, ""),
      virtualSize: executable.readUInt32LE(headerOffset + 8),
      virtualAddress: executable.readUInt32LE(headerOffset + 12),
      rawSize: executable.readUInt32LE(headerOffset + 16),
      rawPointer: executable.readUInt32LE(headerOffset + 20),
    });
  }

  const directory = (index: number): { rva: number; size: number } => {
    if (index >= numberOfRvaAndSizes) return { rva: 0, size: 0 };
    const offset = dataDirectoryOffset + index * 8;
    if (offset + 8 > optionalHeaderOffset + optionalHeaderSize) return { rva: 0, size: 0 };
    return { rva: executable.readUInt32LE(offset), size: executable.readUInt32LE(offset + 4) };
  };

  const resource = directory(RESOURCE_DIRECTORY_INDEX);
  const certificate = directory(CERTIFICATE_DIRECTORY_INDEX);

  return {
    peOffset,
    numberOfSections,
    optionalHeaderOffset,
    optionalHeaderSize,
    sectionTableOffset,
    magic,
    sectionAlignment: sectionAlignment > 0 ? sectionAlignment : 0x1000,
    fileAlignment: fileAlignment > 0 ? fileAlignment : 0x200,
    sizeOfHeaders,
    checksumOffset: optionalHeaderOffset + 64,
    sizeOfImageOffset: optionalHeaderOffset + 56,
    dataDirectoryOffset,
    numberOfRvaAndSizes,
    sections,
    resourceRva: resource.rva,
    resourceSize: resource.size,
    certificateOffset: certificate.rva,
    certificateSize: certificate.size,
  };
}

function alignUp(value: number, alignment: number): number {
  if (alignment <= 1) return value;
  return Math.ceil(value / alignment) * alignment;
}

function rvaToFileOffset(info: PeInfo, rva: number): number {
  for (const section of info.sections) {
    const span = Math.max(section.rawSize, section.virtualSize);
    if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
      return section.rawPointer + (rva - section.virtualAddress);
    }
  }
  throw new Error(`RVA 0x${rva.toString(16)} is outside every PE section.`);
}

export function findSeaFuseOffset(executable: Buffer): number {
  return executable.indexOf(Buffer.from(`${SEA_FUSE_PREFIX}:`, "latin1"));
}

function patchSeaFuse(executable: Buffer): boolean {
  const needle = Buffer.from(`${SEA_FUSE_PREFIX}:0`, "latin1");
  let patched = false;
  let offset = executable.indexOf(needle);
  while (offset >= 0) {
    // The byte after the ':' is the fuse state; 1 means "this is a SEA".
    executable.write("1", offset + needle.length - 1, "latin1");
    patched = true;
    offset = executable.indexOf(needle, offset + needle.length);
  }
  // A binary that already has the fuse armed (re-injecting into a SEA) is fine.
  return patched || findSeaFuseOffset(executable) >= 0;
}

export interface SignatureStripResult {
  buffer: Buffer;
  stripped: boolean;
}

/**
 * Removes an Authenticode signature. Any edit invalidates the signature, and a
 * loader that still sees the certificate directory may reject the image, so the
 * directory is zeroed and the certificate table (a file offset, not an RVA) is
 * cut off.
 */
export function stripAuthenticode(executable: Buffer): SignatureStripResult {
  const info = parsePe(executable);
  if (info.certificateOffset === 0 || info.certificateSize === 0) {
    return { buffer: executable, stripped: false };
  }
  const end = Math.min(info.certificateOffset, executable.length);
  const copy = Buffer.from(executable.subarray(0, end));
  copy.writeUInt32LE(0, info.checksumOffset);
  const certificateDirectory = info.dataDirectoryOffset + CERTIFICATE_DIRECTORY_INDEX * 8;
  copy.writeUInt32LE(0, certificateDirectory);
  copy.writeUInt32LE(0, certificateDirectory + 4);
  return { buffer: copy, stripped: true };
}

type ResourceName = { kind: "id"; id: number } | { kind: "string"; value: string };

interface ResourceData {
  rva: number;
  size: number;
  codePage: number;
  reserved: number;
}

interface ResourceNode {
  name: ResourceName;
  child?: ResourceDirectory;
  data?: ResourceData;
}

export interface ResourceDirectory {
  named: ResourceNode[];
  ids: ResourceNode[];
}

const MAX_RESOURCE_DEPTH = 8;

function readResourceName(section: Buffer, offset: number): string {
  if (offset + 2 > section.length) throw new Error("Truncated PE resource name.");
  const length = section.readUInt16LE(offset);
  const end = offset + 2 + length * 2;
  if (end > section.length) throw new Error("Truncated PE resource name.");
  return section.toString("utf16le", offset + 2, end);
}

/**
 * Parses the existing resource tree into a model so it can be laid out again
 * with the root at offset 0. Every offset in a resource directory is relative
 * to the directory root, which is why the original bytes cannot simply be kept
 * when a new top-level type is added: the root moved, so every child offset
 * would point at the wrong structure.
 */
export function parseResourceTree(section: Buffer): ResourceDirectory {
  const parseDirectory = (
    offset: number,
    depth: number,
    ancestors: Set<number>,
  ): ResourceDirectory => {
    if (depth > MAX_RESOURCE_DEPTH) throw new Error("PE resource tree is too deep.");
    if (offset + 16 > section.length) throw new Error("Truncated PE resource directory.");
    if (ancestors.has(offset)) throw new Error("Cyclic PE resource directory.");
    ancestors.add(offset);
    const namedCount = section.readUInt16LE(offset + 12);
    const idCount = section.readUInt16LE(offset + 14);
    const total = namedCount + idCount;
    if (offset + 16 + total * 8 > section.length) {
      throw new Error("Truncated PE resource directory.");
    }

    const named: ResourceNode[] = [];
    const ids: ResourceNode[] = [];
    for (let index = 0; index < total; index++) {
      const at = offset + 16 + index * 8;
      const rawName = section.readUInt32LE(at);
      const rawData = section.readUInt32LE(at + 4);
      const name: ResourceName =
        (rawName & 0x80000000) !== 0
          ? { kind: "string", value: readResourceName(section, rawName & 0x7fffffff) }
          : { kind: "id", id: rawName };
      let node: ResourceNode;
      if ((rawData & 0x80000000) !== 0) {
        node = { name, child: parseDirectory(rawData & 0x7fffffff, depth + 1, ancestors) };
      } else {
        if (rawData + 16 > section.length) throw new Error("Truncated PE resource data entry.");
        node = {
          name,
          data: {
            rva: section.readUInt32LE(rawData),
            size: section.readUInt32LE(rawData + 4),
            codePage: section.readUInt32LE(rawData + 8),
            reserved: section.readUInt32LE(rawData + 12),
          },
        };
      }
      if (index < namedCount) named.push(node);
      else ids.push(node);
    }
    ancestors.delete(offset);
    return { named, ids };
  };

  if (section.length < 16) return { named: [], ids: [] };
  return parseDirectory(0, 0, new Set<number>());
}

export interface ResourceSectionResult {
  section: Buffer;
  /** Offset of the resource root inside `section`; always 0. */
  rootOffset: number;
}

/**
 * Builds the replacement `.rsrc` payload.
 *
 * Node's manifest, icon and version information are kept: each payload is
 * copied into the new section and its RVA rebased. Only the directory tree —
 * whose offsets are relative — is re-laid-out, with the SEA blob added as type
 * 10 (`RT_RCDATA`) named `NODE_SEA_BLOB`, which is what `FindResource` looks up.
 */
export function buildResourceSection(
  oldResourceSection: Buffer,
  blob: Buffer,
  sectionRva: number,
  oldResourceRva?: number,
): ResourceSectionResult {
  const root = parseResourceTree(oldResourceSection);
  const existing = root.ids.findIndex(
    (node) => node.name.kind === "id" && node.name.id === SEA_BLOB_RESOURCE_TYPE,
  );
  if (existing >= 0) root.ids.splice(existing, 1);

  const seaData: ResourceData = { rva: 0, size: blob.length, codePage: 0, reserved: 0 };
  const seaNode: ResourceNode = {
    name: { kind: "id", id: SEA_BLOB_RESOURCE_TYPE },
    child: {
      named: [
        {
          name: { kind: "string", value: SEA_BLOB_RESOURCE_NAME },
          child: {
            named: [],
            ids: [{ name: { kind: "id", id: 0 }, data: seaData }],
          },
        },
      ],
      ids: [],
    },
  };
  root.ids.push(seaNode);
  root.ids.sort((left, right) => {
    const leftId = left.name.kind === "id" ? left.name.id : 0;
    const rightId = right.name.kind === "id" ? right.name.id : 0;
    return leftId - rightId;
  });

  const directoryOffsets = new Map<ResourceDirectory, number>();
  const nodeOffsets = new Map<
    ResourceNode,
    { nameOffset: number; childOffset: number; dataOffset: number }
  >();

  let cursor = 0;
  const allocate = (directory: ResourceDirectory): number => {
    const offset = cursor;
    directoryOffsets.set(directory, offset);
    cursor += 16 + (directory.named.length + directory.ids.length) * 8;
    for (const node of [...directory.named, ...directory.ids]) {
      const offsets = { nameOffset: 0, childOffset: 0, dataOffset: 0 };
      if (node.name.kind === "string") {
        offsets.nameOffset = cursor;
        cursor += alignUp(2 + node.name.value.length * 2, 4);
      }
      if (node.child !== undefined) {
        offsets.childOffset = allocate(node.child);
      } else if (node.data !== undefined) {
        offsets.dataOffset = cursor;
        cursor += 16;
      }
      nodeOffsets.set(node, offsets);
    }
    return offset;
  };

  const rootOffset = allocate(root);

  // Resource data (manifest, icons, version, ...) is copied into the new
  // section too. Windows resolves a data entry's RVA through the section that
  // holds the resource directory, so leaving the payload in the old section
  // makes GetFileVersionInfo return nothing and can make the loader reject the
  // image even though the directory tree itself is valid.
  interface DataCopy {
    data: ResourceData;
    sourceOffset: number;
    targetOffset: number;
    size: number;
  }
  const copies: DataCopy[] = [];
  if (oldResourceRva !== undefined) {
    const collect = (directory: ResourceDirectory): void => {
      for (const node of [...directory.named, ...directory.ids]) {
        if (node.data !== undefined) {
          const sourceOffset = node.data.rva - oldResourceRva;
          if (
            node.data.size > 0 &&
            sourceOffset >= 0 &&
            sourceOffset + node.data.size <= oldResourceSection.length
          ) {
            const targetOffset = alignUp(cursor, 8);
            cursor = targetOffset + alignUp(node.data.size, 8);
            copies.push({ data: node.data, sourceOffset, targetOffset, size: node.data.size });
          }
        }
        if (node.child !== undefined) collect(node.child);
      }
    };
    collect(root);
  }

  cursor = alignUp(cursor, 8);
  const blobOffset = cursor;
  cursor += blob.length;
  seaData.rva = sectionRva + blobOffset;
  for (const copy of copies) copy.data.rva = sectionRva + copy.targetOffset;

  const section = Buffer.alloc(cursor);
  const write = (directory: ResourceDirectory): void => {
    const offset = directoryOffsets.get(directory);
    if (offset === undefined) return;
    const entries = [...directory.named, ...directory.ids];
    section.writeUInt32LE(0, offset);
    section.writeUInt32LE(0, offset + 4);
    section.writeUInt16LE(0, offset + 8);
    section.writeUInt16LE(0, offset + 10);
    section.writeUInt16LE(directory.named.length, offset + 12);
    section.writeUInt16LE(directory.ids.length, offset + 14);

    for (let index = 0; index < entries.length; index++) {
      const node = entries[index];
      if (node === undefined) continue;
      const offsets = nodeOffsets.get(node);
      if (offsets === undefined) continue;
      const nameField =
        node.name.kind === "string"
          ? ((offsets.nameOffset | 0x80000000) >>> 0)
          : node.name.id;
      const dataField =
        node.child !== undefined
          ? ((offsets.childOffset | 0x80000000) >>> 0)
          : offsets.dataOffset;
      const at = offset + 16 + index * 8;
      section.writeUInt32LE(nameField, at);
      section.writeUInt32LE(dataField, at + 4);
      if (node.name.kind === "string") {
        section.writeUInt16LE(node.name.value.length, offsets.nameOffset);
        Buffer.from(node.name.value, "utf16le").copy(section, offsets.nameOffset + 2);
      }
    }

    for (const node of entries) {
      const offsets = nodeOffsets.get(node);
      if (offsets === undefined) continue;
      if (node.child !== undefined) {
        write(node.child);
      } else if (node.data !== undefined) {
        section.writeUInt32LE(node.data.rva, offsets.dataOffset);
        section.writeUInt32LE(node.data.size, offsets.dataOffset + 4);
        section.writeUInt32LE(node.data.codePage, offsets.dataOffset + 8);
        section.writeUInt32LE(node.data.reserved, offsets.dataOffset + 12);
      }
    }
  };

  write(root);
  for (const copy of copies) {
    oldResourceSection.copy(
      section,
      copy.targetOffset,
      copy.sourceOffset,
      copy.sourceOffset + copy.size,
    );
  }
  blob.copy(section, blobOffset);
  return { section, rootOffset };
}

function nextSectionVirtualAddress(info: PeInfo): number {
  let end = info.sectionAlignment;
  for (const section of info.sections) {
    end = Math.max(end, section.virtualAddress + alignUp(section.virtualSize, info.sectionAlignment));
  }
  return alignUp(end, info.sectionAlignment);
}

interface AppendSectionResult {
  buffer: Buffer;
  sectionRva: number;
}

function appendSection(
  executable: Buffer,
  info: PeInfo,
  name: string,
  content: Buffer,
  dataDirectoryOffset: number,
): AppendSectionResult {
  const sectionRva = nextSectionVirtualAddress(info);
  const rawPointer = alignUp(executable.length, info.fileAlignment);
  const rawSize = alignUp(content.length, info.fileAlignment);
  const headerOffset = info.sectionTableOffset + info.numberOfSections * 40;
  const firstRawPointer = info.sections.reduce(
    (lowest, section) => (section.rawPointer > 0 ? Math.min(lowest, section.rawPointer) : lowest),
    info.sizeOfHeaders,
  );
  if (headerOffset + 40 > firstRawPointer) {
    throw new Error("No room for another PE section header; refusing to corrupt the executable.");
  }

  const output = Buffer.alloc(rawPointer + rawSize);
  executable.copy(output, 0);
  content.copy(output, rawPointer);

  output.write(`${name}\0`, headerOffset, "latin1");
  output.writeUInt32LE(content.length, headerOffset + 8);
  output.writeUInt32LE(sectionRva, headerOffset + 12);
  output.writeUInt32LE(rawSize, headerOffset + 16);
  output.writeUInt32LE(rawPointer, headerOffset + 20);
  output.writeUInt32LE(0, headerOffset + 24);
  output.writeUInt32LE(0, headerOffset + 28);
  output.writeUInt16LE(0, headerOffset + 32);
  output.writeUInt16LE(0, headerOffset + 34);
  output.writeUInt32LE(IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ, headerOffset + 36);

  output.writeUInt16LE(info.numberOfSections + 1, info.peOffset + 6);
  output.writeUInt32LE(
    alignUp(sectionRva + content.length, info.sectionAlignment),
    info.sizeOfImageOffset,
  );
  // SizeOfInitializedData grows with the new section; loader and dumpers use it
  // to describe the image and a mismatch is a common cause of broken rebuilds.
  output.writeUInt32LE(
    output.readUInt32LE(info.optionalHeaderOffset + 8) + rawSize,
    info.optionalHeaderOffset + 8,
  );

  const directoryAt = info.dataDirectoryOffset + dataDirectoryOffset * 8;
  if (directoryAt + 8 <= info.optionalHeaderOffset + info.optionalHeaderSize) {
    output.writeUInt32LE(sectionRva, directoryAt);
    output.writeUInt32LE(content.length, directoryAt + 4);
  }
  output.writeUInt32LE(0, info.checksumOffset);
  output.writeUInt32LE(0, info.dataDirectoryOffset + CERTIFICATE_DIRECTORY_INDEX * 8);
  output.writeUInt32LE(0, info.dataDirectoryOffset + CERTIFICATE_DIRECTORY_INDEX * 8 + 4);

  return { buffer: output, sectionRva };
}

export interface SeaInjectionResult {
  buffer: Buffer;
  sectionRva: number;
  resourceSize: number;
  fusePatched: boolean;
}

/**
 * Embeds a SEA preparation blob in a copy of `node.exe` without postject.
 * Returns a new buffer; the input is never mutated.
 */
export function injectSeaBlob(executable: Buffer, blob: Buffer): SeaInjectionResult {
  if (blob.length === 0) throw new Error("The SEA preparation blob is empty.");
  const stripped = stripAuthenticode(executable);
  const info = parsePe(stripped.buffer);
  const sectionRva = nextSectionVirtualAddress(info);

  let oldResource: Buffer = Buffer.alloc(0);
  if (info.resourceRva !== 0 && info.resourceSize !== 0) {
    const offset = rvaToFileOffset(info, info.resourceRva);
    const containing = info.sections.find(
      (section) =>
        info.resourceRva >= section.virtualAddress &&
        info.resourceRva < section.virtualAddress + Math.max(section.rawSize, section.virtualSize),
    );
    const available = containing === undefined ? info.resourceSize : Math.max(containing.rawSize, info.resourceSize);
    const length = Math.max(0, Math.min(available, stripped.buffer.length - offset));
    oldResource = stripped.buffer.subarray(offset, offset + length);
  }

  const built = buildResourceSection(oldResource, blob, sectionRva, info.resourceRva);
  const appended = appendSection(
    stripped.buffer,
    info,
    ".rsrc2",
    built.section,
    RESOURCE_DIRECTORY_INDEX,
  );
  // The data directory must point at the new root directory, not at the start
  // of the section: the preserved copy of Node's tree occupies offset 0.
  const directoryAt = info.dataDirectoryOffset + RESOURCE_DIRECTORY_INDEX * 8;
  appended.buffer.writeUInt32LE(appended.sectionRva + built.rootOffset, directoryAt);
  appended.buffer.writeUInt32LE(built.section.length, directoryAt + 4);

  if (!patchSeaFuse(appended.buffer)) {
    throw new Error(
      `The SEA fuse (${SEA_FUSE_PREFIX}) was not found in the Node executable. ` +
        "This Node build may not support single-executable applications.",
    );
  }

  return {
    buffer: appended.buffer,
    sectionRva: appended.sectionRva,
    resourceSize: built.section.length,
    fusePatched: true,
  };
}

// ---------------------------------------------------------------------------
// Executable assembly
// ---------------------------------------------------------------------------

interface PostjectModule {
  inject: (
    filename: string,
    resourceName: string,
    resourceData: Buffer,
    options?: { sentinelFuse?: string },
  ) => Promise<void>;
}

async function loadPostject(): Promise<PostjectModule | undefined> {
  const specifier = "postject";
  try {
    const loaded = (await import(specifier)) as {
      inject?: PostjectModule["inject"];
      default?: { inject?: PostjectModule["inject"] };
    };
    const inject = loaded.inject ?? loaded.default?.inject;
    return typeof inject === "function" ? { inject } : undefined;
  } catch {
    return undefined;
  }
}

export interface BuildExecutableOptions {
  /** Rebuild the bundle even when one exists. */
  rebuildBundle?: boolean;
  /** "builtin" forces the offline PE injector; the default prefers postject. */
  injector?: "auto" | "builtin";
  log?: (line: string) => void;
}

export interface ExecutableArtifact {
  exeFile: string;
  bundleFile: string;
  blobFile: string;
  cmdFile: string;
  injectedBy: "postject" | "builtin";
  bytes: number;
  bundleBytes: number;
}

/**
 * Runs the whole SEA pipeline: bundle, config, blob, node.exe copy, injection,
 * and the fast `carls.cmd` launcher. Building on a non-Windows host is refused
 * because the injected binary would be a PE file for another platform.
 */
export async function buildExecutable(
  layout: BuildLayout,
  options: BuildExecutableOptions = {},
): Promise<ExecutableArtifact> {
  if (process.platform !== "win32") {
    throw new Error("carls.exe can only be built on Windows (the payload is a PE resource).");
  }
  const log = options.log ?? (() => undefined);
  let bundle: BundleArtifact;
  if (options.rebuildBundle === true || !existsSync(layout.bundleFile)) {
    bundle = await buildBundle(layout, options.log !== undefined ? { log: options.log } : {});
  } else {
    bundle = {
      bundleFile: layout.bundleFile,
      bytes: statSync(layout.bundleFile).size,
      version: readPackageVersion(layout.root),
      inputs: [],
    };
  }

  const config = writeSeaConfig(layout);
  log(`sea config: main=${config.main} output=${config.output} useCodeCache=${config.useCodeCache}`);
  mkdirSync(layout.releaseDir, { recursive: true });
  const configRelative = relativePosix(layout.root, layout.seaConfigFile);
  let buildOutput = "";
  try {
    buildOutput = execFileSync(process.execPath, ["--experimental-sea-config", configRelative], {
      cwd: layout.root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new Error(`SEA blob generation failed: ${stderr.trim() || (error as Error).message}`);
  }
  if (buildOutput.length > 0) log(buildOutput);
  if (!existsSync(layout.blobFile)) throw new Error("SEA blob was not written.");
  const blob = readFileSync(layout.blobFile);
  const nodeExecutable = readFileSync(process.execPath);

  let injectedBy: "postject" | "builtin" = "builtin";
  let executable: Buffer;
  const postject = options.injector === "builtin" ? undefined : await loadPostject();
  if (postject !== undefined) {
    try {
      const stripped = stripAuthenticode(nodeExecutable).buffer;
      writeFileSync(layout.exeFile, stripped);
      await postject.inject(layout.exeFile, SEA_BLOB_RESOURCE_NAME, blob, { sentinelFuse: SEA_FUSE_PREFIX });
      executable = readFileSync(layout.exeFile);
      injectedBy = "postject";
    } catch (error) {
      log(`postject injection failed (${(error as Error).message}); using the built-in PE injector.`);
      const injected = injectSeaBlob(nodeExecutable, blob);
      writeFileSync(layout.exeFile, injected.buffer);
      executable = injected.buffer;
      injectedBy = "builtin";
    }
  } else {
    const injected = injectSeaBlob(nodeExecutable, blob);
    writeFileSync(layout.exeFile, injected.buffer);
    executable = injected.buffer;
  }

  // Always emit a launcher without npm: cmd.exe parses this file far faster
  // than it resolves a .cmd shim under node_modules/.bin.
  writeFileSync(
    layout.cmdFile,
    `@echo off\r\n"%~dp0${basename(layout.exeFile)}" %*\r\n`,
    "utf8",
  );

  return {
    exeFile: layout.exeFile,
    bundleFile: layout.bundleFile,
    blobFile: layout.blobFile,
    cmdFile: layout.cmdFile,
    injectedBy,
    bytes: executable.length,
    bundleBytes: bundle.bytes,
  };
}

/** Writes a `.cmd` that starts the bundle with the current Node, for bundle-only builds. */
export function writeBundleLauncher(layout: BuildLayout, nodeExecutable: string = process.execPath): string {
  const launcher = `@echo off\r\n"${nodeExecutable}" "%~dp0${basename(layout.bundleFile)}" %*\r\n`;
  writeFileSync(layout.cmdFile, launcher, "utf8");
  return layout.cmdFile;
}
