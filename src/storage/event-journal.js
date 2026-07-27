import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink
} from "node:fs/promises";
import {
  basename,
  dirname,
  join
} from "node:path";
import { tmpdir } from "node:os";

const IMPORT_BATCH_RECORD_BYTE_LIMIT =
  3 * 1024 * 1024;
const JOURNAL_RECORD_BYTE_LIMIT =
  4 * 1024 * 1024;
const JSON_TOKEN_CAPTURE_LIMIT = 512;
const CAPTURED_RECORD_TYPE_FIELDS = new Set([
  "recordType"
]);

export class FileEventJournal {
  #filePath;
  #failureInjector;
  #atomicReplaceProbe;
  #atomicSupportPromise;

  constructor({
    filePath,
    failureInjector,
    atomicReplaceProbe
  }) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new TypeError("Event journal filePath must be a non-empty string.");
    }

    if (
      failureInjector !== undefined &&
      typeof failureInjector !== "function"
    ) {
      throw new TypeError(
        "Event journal failureInjector must be a function."
      );
    }

    if (
      atomicReplaceProbe !== undefined &&
      typeof atomicReplaceProbe !== "function"
    ) {
      throw new TypeError(
        "Event journal atomicReplaceProbe must be a function."
      );
    }

    this.#filePath = filePath;
    this.#failureInjector = failureInjector;
    this.#atomicReplaceProbe = atomicReplaceProbe;
    this.#atomicSupportPromise = null;
  }

  async readAll() {
    const filePath = this.#filePath;
    const records = [];
    let lineNumber = 0;
    let sourceHandle;

    try {
      sourceHandle = await open(filePath, "r");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return [];
      }

      throw new JournalError(
        "JOURNAL_READ_FAILED",
        "TaskSeal could not open the local event journal.",
        { cause: error }
      );
    }

    try {
      for await (const entry of readJournalLines(sourceHandle)) {
        lineNumber += 1;
        const {
          line,
          byteLength,
          recordType
        } = entry;

        if (line.trim().length === 0) {
          continue;
        }

        if (
          recordType === "import.batch" &&
          byteLength >
            IMPORT_BATCH_RECORD_BYTE_LIMIT
        ) {
          throw new JournalError(
            "JOURNAL_CORRUPT",
            `TaskSeal event journal line ${lineNumber} exceeds the import batch byte limit.`
          );
        }

        let record;

        try {
          record = JSON.parse(line);
        } catch (error) {
          throw new JournalError(
            "JOURNAL_CORRUPT",
            `TaskSeal event journal contains invalid JSON at line ${lineNumber}.`,
            { cause: error }
          );
        }

        if (
          record?.recordType === "import.batch" &&
          byteLength >
            IMPORT_BATCH_RECORD_BYTE_LIMIT
        ) {
          throw new JournalError(
            "JOURNAL_CORRUPT",
            `TaskSeal event journal line ${lineNumber} exceeds the import batch byte limit.`
          );
        }

        records.push(record);
      }
    } catch (error) {
      if (error instanceof JournalError) {
        throw error;
      }

      throw new JournalError(
        "JOURNAL_READ_FAILED",
        "TaskSeal could not read the local event journal.",
        { cause: error }
      );
    } finally {
      await closeIgnoringErrors(sourceHandle);
    }

    return records;
  }

  async append(event) {
    const filePath = this.#filePath;
    let handle;
    let writeStarted = false;

    try {
      const serialized = JSON.stringify(event);

      if (typeof serialized !== "string") {
        throw new TypeError(
          "Journal records must be JSON values."
        );
      }

      if (
        Buffer.byteLength(serialized, "utf8") >
        JOURNAL_RECORD_BYTE_LIMIT
      ) {
        throw new TypeError(
          "Journal record exceeds the byte limit."
        );
      }

      const recordTypeScanner =
        new TopLevelRecordTypeScanner();
      recordTypeScanner.write(serialized);

      if (
        recordTypeScanner.recordType ===
        "import.batch"
      ) {
        throw new TypeError(
          "Import batches require the atomic batch commit path."
        );
      }

      await mkdir(dirname(filePath), {
        recursive: true
      });
      handle = await open(filePath, "a");
      await this.injectFailure("beforeWrite", "event");
      writeStarted = true;
      await handle.writeFile(`${serialized}\n`, "utf8");
      await this.injectFailure("afterWrite", "event");
      await this.injectFailure("beforeSync", "event");
      await handle.sync();
      await this.injectFailure("afterSync", "event");
      await this.injectFailure("beforeClose", "event");
      await handle.close();
      handle = null;
    } catch (error) {
      await closeIgnoringErrors(handle);
      handle = null;

      if (writeStarted) {
        throw new JournalError(
          "JOURNAL_COMMIT_OUTCOME_UNKNOWN",
          "TaskSeal started writing an event but could not confirm the append outcome.",
          { cause: error }
        );
      }

      throw new JournalError(
        "JOURNAL_WRITE_FAILED",
        "TaskSeal could not append to the local event journal.",
        { cause: error }
      );
    } finally {
      await closeIgnoringErrors(handle);
    }
  }

  async commitBatch(record) {
    const filePath = this.#filePath;
    await this.ensureAtomicBatchCommitSupported(filePath);
    await this.replaceWithAppendedRecord(
      record,
      "batch",
      filePath
    );
  }

  async ensureAtomicBatchCommitSupported(filePath) {
    if (!this.#atomicSupportPromise) {
      this.#atomicSupportPromise =
        this.probeAtomicReplaceSupport(filePath);
    }

    return this.#atomicSupportPromise;
  }

  async probeAtomicReplaceSupport(filePath) {
    let supported = false;

    try {
      supported = this.#atomicReplaceProbe
        ? await this.#atomicReplaceProbe()
        : await runAtomicReplaceProbe(
            dirname(filePath)
          );
    } catch (error) {
      throw new JournalError(
        "JOURNAL_ATOMIC_COMMIT_UNSUPPORTED",
        "TaskSeal could not verify atomic journal replacement on this filesystem.",
        { cause: error }
      );
    }

    if (!supported) {
      throw new JournalError(
        "JOURNAL_ATOMIC_COMMIT_UNSUPPORTED",
        "TaskSeal could not verify atomic journal replacement on this filesystem."
      );
    }
  }

  async replaceWithAppendedRecord(
    record,
    operation,
    filePath
  ) {
    const directory = dirname(filePath);
    const temporaryPath = join(
      directory,
      `.${basename(filePath)}.${randomUUID()}.tmp`
    );
    let handle;
    let commitPointReached = false;

    try {
      await mkdir(directory, { recursive: true });
      const original = await readJournalBytes(filePath);
      const serialized = JSON.stringify(record);

      if (typeof serialized !== "string") {
        throw new TypeError(
          "Journal records must be JSON values."
        );
      }

      if (
        Buffer.byteLength(serialized, "utf8") >
        IMPORT_BATCH_RECORD_BYTE_LIMIT
      ) {
        throw new TypeError(
          "Journal record exceeds the byte limit."
        );
      }

      const separator =
        original.length === 0 ||
        original.endsWith("\n") ||
        original.endsWith("\r")
          ? ""
          : "\n";
      const nextContent =
        `${original}${separator}${serialized}\n`;
      const mode = await readJournalMode(filePath);

      handle = await open(
        temporaryPath,
        "wx",
        mode
      );
      await this.injectFailure("beforeWrite", operation);
      await handle.writeFile(nextContent, "utf8");
      await this.injectFailure("afterWrite", operation);
      await this.injectFailure("beforeSync", operation);
      await handle.sync();
      await this.injectFailure("afterSync", operation);
      await this.injectFailure("beforeClose", operation);
      await handle.close();
      handle = null;
      await this.injectFailure("beforeReplace", operation);
      await rename(temporaryPath, filePath);
      commitPointReached = true;
      await this.injectFailure("afterReplace", operation);
      await syncDirectoryIfSupported(directory);
    } catch (error) {
      if (commitPointReached) {
        throw new JournalError(
          "JOURNAL_COMMIT_OUTCOME_UNKNOWN",
          "TaskSeal replaced the journal but could not confirm the commit outcome.",
          { cause: error }
        );
      }

      if (
        error?.code ===
        "JOURNAL_ATOMIC_COMMIT_UNSUPPORTED"
      ) {
        throw error;
      }

      throw new JournalError(
        "JOURNAL_WRITE_FAILED",
        "TaskSeal could not atomically append to the local event journal.",
        { cause: error }
      );
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // The original journal is still authoritative before replace.
        }
      }

      if (!commitPointReached) {
        try {
          await unlink(temporaryPath);
        } catch (error) {
          if (error.code !== "ENOENT") {
            // A leftover temp file is never part of journal replay.
          }
        }
      }
    }
  }

  async injectFailure(stage, operation) {
    await this.#failureInjector?.(stage, operation);
  }
}

async function* readJournalLines(sourceHandle) {
  const stream = sourceHandle.createReadStream({
    encoding: "utf8",
    autoClose: false
  });
  let lineNumber = 1;
  let accumulator =
    new JournalLineAccumulator(lineNumber);

  try {
    for await (const chunk of stream) {
      let start = 0;
      let newlineIndex;

      while (
        (newlineIndex = chunk.indexOf("\n", start)) !==
        -1
      ) {
        await accumulator.append(
          chunk.slice(start, newlineIndex),
          { lineEnd: true }
        );
        yield await accumulator.finish();
        lineNumber += 1;
        accumulator =
          new JournalLineAccumulator(lineNumber);
        start = newlineIndex + 1;
      }

      if (start < chunk.length) {
        await accumulator.append(chunk.slice(start));
      }
    }

    if (accumulator.hasContent) {
      yield await accumulator.finish();
    }
  } finally {
    stream.destroy();
    await accumulator.dispose();
  }
}

class JournalLineAccumulator {
  #lineNumber;
  #parts;
  #byteLength;
  #scanner;
  #spoolHandle;
  #spoolPath;
  #pendingCarriageReturn;

  constructor(lineNumber) {
    this.#lineNumber = lineNumber;
    this.#parts = [];
    this.#byteLength = 0;
    this.#scanner = new TopLevelRecordTypeScanner();
    this.#spoolHandle = null;
    this.#spoolPath = null;
    this.#pendingCarriageReturn = false;
  }

  get hasContent() {
    return (
      this.#byteLength > 0 ||
      this.#parts.length > 0 ||
      this.#spoolHandle !== null
    );
  }

  async append(segment, {
    lineEnd = false
  } = {}) {
    if (this.#pendingCarriageReturn) {
      if (lineEnd && segment.length === 0) {
        this.#pendingCarriageReturn = false;
      } else {
        this.#pendingCarriageReturn = false;
        await this.#appendContent("\r");
      }
    }

    let content = segment;

    if (lineEnd && content.endsWith("\r")) {
      content = content.slice(0, -1);
    } else if (
      !lineEnd &&
      content.endsWith("\r")
    ) {
      content = content.slice(0, -1);
      this.#pendingCarriageReturn = true;
    }

    await this.#appendContent(content);
  }

  async #appendContent(segment) {
    if (segment.length === 0) {
      return;
    }

    this.#scanner.write(segment);
    const nextByteLength =
      this.#byteLength +
      Buffer.byteLength(segment, "utf8");

    if (
      this.#scanner.recordType === "import.batch" &&
      nextByteLength >
        IMPORT_BATCH_RECORD_BYTE_LIMIT
    ) {
      throw importBatchLineTooLarge(
        this.#lineNumber
      );
    }

    if (
      nextByteLength > JOURNAL_RECORD_BYTE_LIMIT
    ) {
      throw journalRecordLineTooLarge(
        this.#lineNumber
      );
    }

    if (
      !this.#spoolHandle &&
      nextByteLength >
        IMPORT_BATCH_RECORD_BYTE_LIMIT
    ) {
      await this.#startSpool();
    }

    if (this.#spoolHandle) {
      await this.#spoolHandle.writeFile(
        segment,
        "utf8"
      );
    } else {
      this.#parts.push(segment);
    }

    this.#byteLength = nextByteLength;
  }

  async finish() {
    if (this.#pendingCarriageReturn) {
      this.#pendingCarriageReturn = false;
      await this.#appendContent("\r");
    }

    let line;

    if (this.#spoolHandle) {
      line = await readSpoolHandle(
        this.#spoolHandle
      );
      await this.#spoolHandle.close();
      this.#spoolHandle = null;
      await unlinkIgnoringMissing(this.#spoolPath);
      this.#spoolPath = null;
    } else {
      line = this.#parts.join("");
    }

    return {
      line,
      byteLength: this.#byteLength,
      recordType: this.#scanner.recordType
    };
  }

  async dispose() {
    await closeIgnoringErrors(this.#spoolHandle);
    this.#spoolHandle = null;

    if (this.#spoolPath) {
      await unlinkIgnoringMissing(this.#spoolPath);
      this.#spoolPath = null;
    }
  }

  async #startSpool() {
    this.#spoolPath = join(
      tmpdir(),
      `taskseal-journal-line-${randomUUID()}.tmp`
    );
    this.#spoolHandle = await open(
      this.#spoolPath,
      "wx+",
      0o600
    );

    for (const part of this.#parts) {
      await this.#spoolHandle.writeFile(
        part,
        "utf8"
      );
    }

    this.#parts = [];
  }
}

class TopLevelRecordTypeScanner {
  #depth;
  #inString;
  #escaped;
  #stringContext;
  #lastSignificant;
  #pendingProperty;
  #capture;
  #captureOverflow;
  #token;
  #stringValues;

  constructor() {
    this.#depth = 0;
    this.#inString = false;
    this.#escaped = false;
    this.#stringContext = null;
    this.#lastSignificant = null;
    this.#pendingProperty = null;
    this.#capture = false;
    this.#captureOverflow = false;
    this.#token = "";
    this.#stringValues = new Map();
  }

  get recordType() {
    return this.#stringValues.get("recordType");
  }

  write(segment) {
    for (const character of segment) {
      if (this.#inString) {
        this.#captureCharacter(character);

        if (this.#escaped) {
          this.#escaped = false;
          continue;
        }

        if (character === "\\") {
          this.#escaped = true;
          continue;
        }

        if (character !== "\"") {
          continue;
        }

        this.#inString = false;
        this.#finishString();
        this.#lastSignificant = "\"";
        continue;
      }

      if (character === "\"") {
        this.#beginString();
        continue;
      }

      if (
        this.#depth === 1 &&
        this.#lastSignificant === ":" &&
        this.#pendingProperty ===
          "recordType" &&
        !isJsonWhitespace(character)
      ) {
        this.#stringValues.delete("recordType");
      }

      if (character === "{" || character === "[") {
        this.#depth += 1;
      } else if (
        character === "}" ||
        character === "]"
      ) {
        this.#depth -= 1;
      } else if (
        character === "," &&
        this.#depth === 1
      ) {
        this.#pendingProperty = null;
      }

      if (!isJsonWhitespace(character)) {
        this.#lastSignificant = character;
      }
    }
  }

  #beginString() {
    this.#inString = true;
    this.#escaped = false;
    this.#stringContext = this.#lastSignificant;
    this.#capture =
      this.#depth === 1 &&
      (this.#stringContext === "{" ||
        this.#stringContext === "," ||
        (this.#stringContext === ":" &&
          CAPTURED_RECORD_TYPE_FIELDS.has(
            this.#pendingProperty
          )));
    this.#captureOverflow = false;
    this.#token = this.#capture ? "\"" : "";
  }

  #captureCharacter(character) {
    if (!this.#capture) {
      return;
    }

    if (this.#captureOverflow) {
      return;
    }

    if (
      this.#token.length + character.length >
      JSON_TOKEN_CAPTURE_LIMIT
    ) {
      this.#captureOverflow = true;
      this.#token = "";
      return;
    }

    this.#token += character;
  }

  #finishString() {
    if (
      this.#depth !== 1 ||
      !this.#capture
    ) {
      return;
    }

    if (this.#captureOverflow) {
      if (
        this.#stringContext === ":" &&
        this.#pendingProperty === "recordType"
      ) {
        this.#stringValues.delete("recordType");
      } else if (
        this.#stringContext === "{" ||
        this.#stringContext === ","
      ) {
        this.#pendingProperty = null;
      }

      return;
    }

    let value;

    try {
      value = JSON.parse(this.#token);
    } catch {
      return;
    }

    if (
      this.#stringContext === "{" ||
      this.#stringContext === ","
    ) {
      this.#pendingProperty = value;
    } else if (
      this.#stringContext === ":" &&
      this.#pendingProperty === "recordType"
    ) {
      this.#stringValues.set("recordType", value);
    }
  }
}

function isJsonWhitespace(character) {
  return (
    character === " " ||
    character === "\t" ||
    character === "\r" ||
    character === "\n"
  );
}

function importBatchLineTooLarge(lineNumber) {
  return new JournalError(
    "JOURNAL_CORRUPT",
    `TaskSeal event journal line ${lineNumber} exceeds the import batch byte limit.`
  );
}

function journalRecordLineTooLarge(lineNumber) {
  return new JournalError(
    "JOURNAL_CORRUPT",
    `TaskSeal event journal line ${lineNumber} exceeds the journal record byte limit.`
  );
}

async function readSpoolHandle(handle) {
  const stream = handle.createReadStream({
    encoding: "utf8",
    start: 0,
    autoClose: false
  });
  const parts = [];

  try {
    for await (const chunk of stream) {
      parts.push(chunk);
    }
  } finally {
    stream.destroy();
  }

  return parts.join("");
}

async function readJournalBytes(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

async function readJournalMode(filePath) {
  try {
    const fileStat = await stat(filePath);
    return fileStat.mode & 0o777;
  } catch (error) {
    if (error.code === "ENOENT") {
      return 0o600;
    }

    throw error;
  }
}

async function runAtomicReplaceProbe(directory) {
  await mkdir(directory, { recursive: true });
  const probeId = randomUUID();
  const targetPath = join(
    directory,
    `.taskseal-atomic-probe-${probeId}`
  );
  const replacementPath = `${targetPath}.tmp`;
  let targetHandle;
  let replacementHandle;

  try {
    targetHandle = await open(
      targetPath,
      "wx",
      0o600
    );
    await targetHandle.writeFile("before", "utf8");
    await targetHandle.sync();
    await targetHandle.close();
    targetHandle = null;

    replacementHandle = await open(
      replacementPath,
      "wx",
      0o600
    );
    await replacementHandle.writeFile("after", "utf8");
    await replacementHandle.sync();
    await replacementHandle.close();
    replacementHandle = null;

    await rename(replacementPath, targetPath);
    return (
      (await readFile(targetPath, "utf8")) === "after"
    );
  } finally {
    await closeIgnoringErrors(targetHandle);
    await closeIgnoringErrors(replacementHandle);
    await unlinkIgnoringMissing(replacementPath);
    await unlinkIgnoringMissing(targetPath);
  }
}

async function syncDirectoryIfSupported(directory) {
  let handle;

  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (
      ["EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(
        error.code
      )
    ) {
      return;
    }

    throw error;
  } finally {
    await closeIgnoringErrors(handle);
  }
}

async function closeIgnoringErrors(handle) {
  if (!handle) {
    return;
  }

  try {
    await handle.close();
  } catch {
    // Cleanup cannot change the already classified commit outcome.
  }
}

async function unlinkIgnoringMissing(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

export class JournalError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "JournalError";
    this.code = code;
  }
}
